/**
 * Salesforce.js
 *
 * BotKit hook module that hands a Kore.ai conversation off to a Salesforce
 * Omni-Channel live agent (via Messaging for In-App and Web / MIAW) and
 * pushes the prior bot<->user chat history into the new Messaging Session.
 *
 * Modeled on LiveChat.js. Flow:
 *   on_agent_transfer  -> open SF conversation, replay bot history, start SSE relay
 *   on_user_message    -> while a SF session is live, forward user text to the agent
 *   on_bot_message     -> (default) let the bot speak until handoff is active
 *   SSE stream         -> agent replies are pushed back to the user via sdk.sendUserMessage
 *
 * Logging: every action prints with the [SF] prefix via console.log so it
 * shows up directly in the Render (build/runtime) logs -- no DEBUG env needed.
 */

var sdk = require("./lib/sdk");
var Promise = require("bluebird");
var _ = require("lodash");
var https = require("https");
var config = require("./config");
var api = require("./SalesforceAPI.js");
var attachments = require("./SalesforceAttachments.js");

var SF = config.salesforce || {};

// botId/botName come from config (config.json defaults, overridden by
// KORE_BOT_ID/KORE_BOT_NAME env vars via config.js) -- NOT hardcoded here,
// so the id used for inbound routing (this file) and the id used for
// outbound JWT signing (config.credentials, see config.js) can never drift
// apart the way they did before.
var botId = SF.botId;
var botName = SF.botName || "Bot";

if (!botId) {
  throw new Error(
    "Salesforce.js: config.salesforce.botId is not set -- set KORE_BOT_ID",
  );
}

// Per-visitor Salesforce session state -- set for BOTH agent-transfer and
// deflected sessions (see createSalesforceSession), but `routed` is what
// actually means "a live agent may show up" for message-routing purposes.
//   _map[visitorId] = { conversationId, accessToken, lastEventId, sse,
//                        messagingSessionId, routed }
var _map = {};
// Per-visitor copy of the last platform `data` object (needed to call
// sdk.sendUserMessage when an agent reply arrives outside a request cycle).
var userDataMap = {};
// Per-visitor inactivity tracking, used to auto-create a deflected case when
// a customer stops responding without explicitly ending the chat.
//   _activity[visitorId] = { data, timer }
var _activity = {};
var INACTIVITY_ENABLED = _.get(SF, "inactivity.enabled", true);
var INACTIVITY_TIMEOUT_MS = _.get(SF, "inactivity.timeoutMs", 15 * 60 * 1000);
var INACTIVITY_NUDGES = (_.get(SF, "inactivity.nudges") || []).filter(function (
  nudge,
) {
  return (
    nudge &&
    nudge.enabled !== false &&
    nudge.message &&
    nudge.delayMs > 0 &&
    nudge.delayMs < INACTIVITY_TIMEOUT_MS
  );
});
// Grace period after an agent is removed from the conversation before we
// treat it as "the chat has genuinely ended". Salesforce sends the exact
// same PARTICIPANT_CHANGED(remove) signal both when an agent truly ends the
// chat AND when they transfer it to another agent -- the only way to tell
// them apart is whether a replacement agent's PARTICIPANT_CHANGED(add)
// shows up within a short window afterward. See handleSseEvent.
var AGENT_TRANSFER_GRACE_MS = _.get(SF, "agentTransferGraceMs", 10000);

/* ------------------------------------------------------------------ */
/* logging helpers                                                     */
/* ------------------------------------------------------------------ */

function ts() {
  try {
    return new Date().toISOString();
  } catch (e) {
    return "";
  }
}
// Always-on logger -> visible in Render logs.
function log() {
  var args = Array.prototype.slice.call(arguments);
  console.log.apply(console, ["[SF " + ts() + "]"].concat(args));
}
function logErr() {
  var args = Array.prototype.slice.call(arguments);
  console.error.apply(console, ["[SF " + ts() + "][ERROR]"].concat(args));
}
// Safe stringify (handles circular refs in the big platform `data` object).
function jstr(obj) {
  try {
    var seen = [];
    return JSON.stringify(obj, function (k, v) {
      if (typeof v === "object" && v !== null) {
        if (seen.indexOf(v) !== -1) {
          return "[Circular]";
        }
        seen.push(v);
      }
      return v;
    });
  } catch (e) {
    return String(obj);
  }
}
// Mask a secret/token so logs are useful but not a credential leak.
function mask(t) {
  if (!t) {
    return "<none>";
  }
  t = String(t);
  if (t.length <= 12) {
    return "*** (len " + t.length + ")";
  }
  return t.slice(0, 6) + "..." + t.slice(-4) + " (len " + t.length + ")";
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function getVisitorId(data) {
  return (
    _.get(data, "channel.channelInfos.from") || _.get(data, "channel.from")
  );
}

/**
 * buildRoutingAttributes
 * Pre-chat fields sent to Salesforce when the conversation is created.
 *   - static fields (REGION_CODE, IS_CHAT_BUTTON_CLICKED) come from config
 *   - per-user fields (name, email) are read live from the Kore conversation
 */
function buildRoutingAttributes(data) {
  var ctx = data.context || {};

  // User identity captured by the Automation0001 node in the JBL Assistant bot.
  var firstName = _.get(ctx, "firstname");
  var lastName = _.get(ctx, "lastname");
  var email = _.get(ctx, "email");

  log(
    "user identity from context.steps.Automation0001 ->",
    "Name=",
    firstName,
    "| LastName=",
    lastName,
    "| Email=",
    email,
  );

  var dynamic = {};
  if (firstName) {
    dynamic.Bot_First_Name = firstName;
  }
  if (lastName) {
    dynamic.Bot_Last_Name = lastName;
  }
  if (email) {
    dynamic.Bot_Email = email;
  }

  if (!firstName && !lastName && !email) {
    log(
      "WARNING: no name/email found at context.steps.Automation0001.* " +
      "-- dumping full context so you can find the right path:",
    );
    log("context =", jstr(ctx));
  }

  // static config first, then live user values, then explicit dialog overrides
  var merged = _.merge(
    {},
    SF.routingAttributes,
    dynamic,
    _.get(ctx, "salesforceRouting"),
  );
  log("routingAttributes built ->", jstr(merged));
  return merged;
}

// Accepted session_details.deflection_status values (Craftware "Kore Create
// Case" API update, 2026-08-26) -- required whenever is_deflected is true.
var DEFLECTION_STATUSES = [
  "Successful Deflection",
  "Assumed Deflection",
  "Not deflected",
  "Escalation needed",
  "Sent to Agent",
  "Session-End Detection",
];
// Default used when a deflected-case caller doesn't specify one (shouldn't
// normally happen -- both current call sites pass an explicit value, see
// createDeflectedCase). Falling back here rather than letting the request
// go out without the field at all, which the API now rejects outright.
var DEFAULT_DEFLECTION_STATUS = "Assumed Deflection";

/**
 * buildCreateCaseBody
 * Assembles the body for the "Kore Create Case" Apex REST endpoint
 * (POST .../kore/create-case). See Craftware "Kore Create Case
 * Documentation v1.0" for the full contract.
 *
 *   - messaging_session_id = the actual Salesforce MessagingSession record Id
 *     (e.g. "0MwV900000EL6f3") -- NOT our own MIAW conversationId UUID. MIAW's
 *     createConversation response carries no body, so this has to be resolved
 *     off the SSE stream first; see waitForMessagingSessionId().
 *   - opts.routed          = session_should_be_routed (agent-transfer scenario)
 *   - opts.deflected        = is_deflected (bot resolved the query, no agent)
 *   - opts.deflectionStatus = session_details.deflection_status, one of
 *     DEFLECTION_STATUSES -- required by Salesforce whenever is_deflected is
 *     true (added 2026-08-26); ignored otherwise.
 *   - country_code / region come from live context when available, falling
 *     back to config defaults; customer_country_unknown is set whenever we
 *     had to fall back, so Salesforce can see the value wasn't provided.
 *   - context.salesforceCase (dialog override) is merged in last.
 */
function buildCreateCaseBody(data, messagingSessionId, opts) {
  var ctx = data.context || {};
  var defaults = _.get(SF, "case.defaults") || {};

  var countryCode = _.get(ctx, "countryCode") || _.get(ctx, "country_code");
  var countryUnknown = !countryCode;
  countryCode = countryCode || defaults.countryCode;

  var body = {
    messaging_session_id: messagingSessionId,
    customer_details: {
      email: _.get(ctx, "email"),
      first_name: _.get(ctx, "firstname"),
      last_name: _.get(ctx, "lastname"),
    },
    relevant_details: {
      order_number: _.get(ctx, "orderNumber") || defaults.orderNumber,
      product_name: _.get(ctx, "productName") || defaults.productName,
    },
    session_details: {
      country_code: countryCode,
      language: defaults.language || "English",
      session_should_be_routed: !!(opts && opts.routed),
      is_deflected: !!(opts && opts.deflected),
      customer_country_unknown: countryUnknown,
    },
    additional_params: {
      botSessionId: getVisitorId(data),
    },
  };
  if (opts && opts.routed) {
    body.session_details.region = _.get(ctx, "region") || defaults.region;
  }
  if (opts && opts.deflected) {
    var deflectionStatus = (opts && opts.deflectionStatus) || DEFAULT_DEFLECTION_STATUS;
    if (DEFLECTION_STATUSES.indexOf(deflectionStatus) === -1) {
      logErr(
        "buildCreateCaseBody: unrecognized deflectionStatus",
        jstr(deflectionStatus),
        "-> sending anyway, but check DEFLECTION_STATUSES",
      );
    }
    body.session_details.deflection_status = deflectionStatus;
  }
  return _.merge({}, body, _.get(ctx, "salesforceCase"));
}

/**
 * submitCase
 * Calls the "Kore Create Case" endpoint for an already-created Messaging
 * Session, creating the Contact + Case and (for opts.routed) triggering
 * Omni-Channel routing in the same call.
 *
 * Uses the Salesforce OAuth token (Connected App), NOT the MIAW token.
 * Best-effort with retry (e.g. SESSION_NOT_FOUND if the session isn't
 * indexed yet); CASE_ALREADY_EXISTS (409) is treated as success, not a
 * failure, since it means the work is already done. A failure never aborts
 * the agent handoff / deflected-session cleanup.
 */
function submitCase(data, messagingSessionId, opts, attempt) {
  if (!_.get(SF, "case.enabled")) {
    log("case creation disabled in config -> skipping");
    return Promise.resolve();
  }
  var maxAttempts = _.get(SF, "case.retry.maxAttempts", 3);
  var delayMs = _.get(SF, "case.retry.delayMs", 4000);
  attempt = attempt || 1;

  var body = buildCreateCaseBody(data, messagingSessionId, opts);
  log(
    "creating Salesforce Case (attempt " + attempt + "/" + maxAttempts + ") ->",
    jstr(body),
  );
  return api
    .getOAuthToken()
    .then(function (oauth) {
      return api.createCase(oauth.access_token, body);
    })
    .then(function (res) {
      log("Salesforce Case created ->", jstr(res));
      return res;
    })
    .catch(function (e) {
      var status = _.get(e, "response.status");
      var errorCode = _.get(e, "response.data.errorCode");
      if (status === 409 || errorCode === "CASE_ALREADY_EXISTS") {
        log(
          "Salesforce Case already exists for this session -> treating as success",
        );
        return _.get(e, "response.data");
      }
      logErr(
        "Salesforce Case creation attempt",
        attempt,
        "failed | status:",
        status,
        "| errorCode:",
        errorCode,
        "|",
        (e && e.message) || e,
      );
      if (attempt < maxAttempts) {
        log("retrying Salesforce Case creation in", delayMs, "ms...");
        return Promise.delay(delayMs).then(function () {
          return submitCase(data, messagingSessionId, opts, attempt + 1);
        });
      }
      logErr(
        "Salesforce Case creation giving up after",
        maxAttempts,
        "attempts",
      );
    });
}

/**
 * fetchHistory
 * Pulls the bot<->user transcript from the Kore platform. getMessages returns
 * newest-first, so we reverse to chronological order before replaying.
 */
function fetchHistory(data) {
  return new Promise(function (resolve) {
    data.limit = SF.historyLimit || 100;
    // The SDK's getMessages() falls back to `channel.channelInfos.from`
    // when userId isn't set, but that field is never populated on our
    // payload objects and not every channel shape even has a nested
    // channelInfos (some carry a flat channel.from instead) -- it throws
    // synchronously in that case. Always set userId ourselves via the
    // same dual-shape lookup getVisitorId() already uses, so that
    // crashing fallback path is never hit.
    data.userId = data.userId || getVisitorId(data);
    log("fetchHistory: requesting last", data.limit, "messages from Kore");
    sdk.getMessages(data, function (err, resp) {
      if (err) {
        var status = _.get(err, "response.status");
        var body = _.get(err, "response.data");
        logErr(
          "getMessages failed | status:",
          status,
          "| Kore says:",
          body ? jstr(body) : err.message,
          "| url:",
          _.get(err, "config.url"),
        );
        return resolve([]);
      }
      var messages = resp && resp.messages ? resp.messages.slice() : [];
      log("fetchHistory: received", messages.length, "messages from Kore");

      // One-time raw dump so we can confirm the exact message schema
      // (direction field + where the text lives for each side).
      if (messages.length) {
        log("fetchHistory: RAW sample[0] =", jstr(messages[0]));
        if (messages.length > 1) {
          log("fetchHistory: RAW sample[1] =", jstr(messages[1]));
        }
      }

      // Deterministic chronological order (oldest -> newest). Kore may
      // return either direction depending on endpoint, so sort by an
      // actual timestamp rather than blindly reversing.
      messages.sort(function (a, b) {
        return msgTime(a) - msgTime(b);
      });
      resolve(messages);
    });
  });
}

/**
 * formatHistoryLine
 * Normalizes one platform message record into "Speaker: text".
 */
// Best-effort timestamp for ordering. Handles epoch numbers and ISO strings.
function msgTime(m) {
  var t =
    m.createdOn ||
    m.lastModifiedOn ||
    m.timestampValue ||
    m.sentOn ||
    m.timestamp;
  if (t == null) {
    return 0;
  }
  if (typeof t === "number") {
    return t;
  }
  var parsed = Date.parse(t);
  return isNaN(parsed) ? 0 : parsed;
}

// Pull the human-readable text out of a Kore message, trying every known
// location so BOTH bot and user messages survive (not just one side).
function extractText(m) {
  var paths = [
    "components[0].data.text",
    "components[0].data.payload.text",
    "components[0].cInfo.body",
    "component.data.text",
    "data.text",
    "message",
    "text",
  ];
  for (var i = 0; i < paths.length; i++) {
    var v = _.get(m, paths[i]);
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  // Some bot messages nest a JSON string in data.text -> try to unwrap.
  var raw = _.get(m, "components[0].data.text");
  if (typeof raw === "string") {
    try {
      var obj = JSON.parse(raw);
      var t =
        _.get(obj, "text") ||
        _.get(obj, "message") ||
        _.get(obj, "payload.text");
      if (t) {
        return String(t).trim();
      }
    } catch (e) {
      /* not JSON */
    }
  }
  return "";
}

function formatHistoryLine(m) {
  // Direction: Kore uses incoming (user) / outgoing (bot). Cover variants.
  var t = (m.type || m.direction || "").toString().toLowerCase();
  var who = /out|bot|outgoing/.test(t) ? "Bot" : "Customer";
  var text = extractText(m);
  return text ? who + ": " + text : null;
}

/* ------------------------------------------------------------------ */
/* agent -> user relay (SSE)                                           */
/* ------------------------------------------------------------------ */

function startSseRelay(visitorId) {
  var entry = _map[visitorId];
  if (!entry) {
    return;
  }

  var url = new URL(api.sseUrl());
  var headers = api.sseHeaders(entry.accessToken, entry.lastEventId);

  log(
    "SSE: opening stream",
    url.href,
    "for visitor",
    visitorId,
    "| token",
    mask(entry.accessToken),
    "| lastEventId",
    entry.lastEventId,
  );

  var req = https.request(
    {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "GET",
      headers: headers,
    },
    function (res) {
      log(
        "SSE: stream connected, status",
        res.statusCode,
        "for visitor",
        visitorId,
      );
      res.setEncoding("utf8");
      var buffer = "";
      res.on("data", function (chunk) {
        buffer += chunk;
        var blocks = buffer.split("\n\n");
        buffer = blocks.pop();
        blocks.forEach(function (block) {
          handleSseEvent(visitorId, block);
        });
      });
      res.on("end", function () {
        log("SSE: stream ended for visitor", visitorId);
      });
    },
  );
  req.on("error", function (e) {
    logErr("SSE error for", visitorId, ":", e.message);
  });
  req.end();

  entry.sse = req;
}



function handleSseEvent(visitorId, block) {
  var entry = _map[visitorId];
  var data = userDataMap[visitorId];
  if (!entry || !data) {
    return;
  }
  if (!block || !block.trim()) {
    return;
  }

  var eventName = null,
    payload = null,
    lastEventId = null;
  block.split("\n").forEach(function (line) {
    if (line.indexOf("event:") === 0) {
      eventName = line.slice(6).trim();
    } else if (line.indexOf("id:") === 0) {
      lastEventId = line.slice(3).trim();
    } else if (line.indexOf("data:") === 0) {
      try {
        payload = JSON.parse(line.slice(5).trim());
      } catch (e) {
        /* keep raw */
      }
    }
  });
  if (lastEventId) {
    entry.lastEventId = lastEventId;
  }
  if (!eventName) {
    return;
  }

  log(
    "SSE event <-",
    eventName,
    "| visitor",
    visitorId,
    "| payload",
    jstr(payload),
  );

  var entry2 = _.get(payload, "conversationEntry") || {};

  // entryPayload arrives as a JSON *string* -> must be parsed before reading.
  var ep = entry2.entryPayload;
  if (typeof ep === "string") {
    try {
      ep = JSON.parse(ep);
    } catch (e) {
      logErr("SSE: could not parse entryPayload:", e.message);
      ep = {};
    }
  }
  ep = ep || {};

  var senderRole =
    _.get(entry2, "sender.role") || _.get(payload, "sender.role") || "";
  var entryType = ep.entryType || entry2.entryType || "";

  // ---------------------------------------------------------------
  // AGENT TYPING STARTED
  // ---------------------------------------------------------------
  if (
    /CONVERSATION_TYPING_STARTED_INDICATOR/i.test(eventName) ||
    /TypingStartedIndicator/i.test(entryType)
  ) {
    log(
      "SSE: AGENT TYPING STARTED | visitor:",
      visitorId,
      "| senderRole:",
      senderRole,
      "| entryType:",
      entryType,
    );

    data.message = "";

    data.overrideMessagePayload = {
      isTemplate: true,
      body: JSON.stringify({
        type: "template",
        payload: {
          template_type: "custom",
          custom_type: "agent_typing",
          typing: "started",
        },
      }),
    };

    sdk.sendUserMessage(data, function (err) {
      if (err) {
        logErr("sendUserMessage (agent typing started) failed:", jstr(err));
      } else {
        log("Agent typing STARTED sent to Kore");
      }
    });

    return;
  }

  // ---------------------------------------------------------------
  // AGENT TYPING STOPPED
  // ---------------------------------------------------------------
  if (
    /CONVERSATION_TYPING_STOPPED_INDICATOR/i.test(eventName) ||
    /TypingStoppedIndicator/i.test(entryType)
  ) {
    log(
      "SSE: AGENT TYPING STOPPED | visitor:",
      visitorId,
      "| senderRole:",
      senderRole,
      "| entryType:",
      entryType,
    );

    data.message = "";

    data.overrideMessagePayload = {
      isTemplate: true,
      body: JSON.stringify({
        type: "template",
        payload: {
          template_type: "custom",
          custom_type: "agent_typing",
          typing: "stopped",
        },
      }),
    };

    sdk.sendUserMessage(data, function (err) {
      if (err) {
        logErr("sendUserMessage (agent typing stopped) failed:", jstr(err));
      } else {
        log("Agent typing STOPPED sent to Kore");
      }
    });

    return;
  }

  // MIAW's createConversation response has no body -- the only way to learn
  // the actual Salesforce MessagingSession record Id (which the Kore Create
  // Case endpoint requires as messaging_session_id, NOT our client-generated
  // conversationId UUID) is to read it off a conversationEntry's
  // relatedRecords once real traffic (e.g. the history push) flows through.
  // Captured once, as a side effect, regardless of event type.
  var relatedRecords = _.get(entry2, "relatedRecords");
  if (
    !entry.messagingSessionId &&
    _.isArray(relatedRecords) &&
    relatedRecords.length
  ) {
    entry.messagingSessionId = relatedRecords[0];
    log(
      "SSE: captured Salesforce MessagingSession record Id ->",
      entry.messagingSessionId,
      "for",
      visitorId,
    );
  }

  // Informational only: the Case + routing trigger now happen synchronously
  // in createSalesforceSession() (submitCase) BEFORE the SSE relay is even
  // started, via the Kore Create Case endpoint's session_should_be_routed
  // flag -- no need to react to this event separately anymore.
  if (/ROUTING_RESULT/i.test(eventName) || /RoutingResult/i.test(entryType)) {
    log(
      "SSE: routing result for",
      visitorId,
      "(case/routing already handled up-front)",
    );
    return;
  }

  if (/CONVERSATION_MESSAGE/i.test(eventName) || /^Message$/i.test(entryType)) {
    // Relay messages from the agent AND Salesforce auto-generated/System
    // messages (e.g. the auto-greeting / auto-responses).
    // Skip only our own EndUser echoes so we don't loop the user's text back.
    if (/enduser/i.test(senderRole)) {
      log("SSE: ignoring our own EndUser message echo");
      return;
    }

    var text =
      _.get(ep, "abstractMessage.staticContent.text") ||
      _.get(ep, "staticContent.text") ||
      _.get(ep, "text");

    var files = attachments.fromSalesforcePayload(ep);
    var agentName = entry.agentName || "Unknown Agent";


    if (text) {
      log("SSE: relaying AGENT (" + senderRole + ") message to user ->", text);

      data.message = text;
      _.set(data, "_originalPayload.message", text);

      data.overrideMessagePayload = {
        isTemplate: true,
        body: JSON.stringify({
          type: "template",
          payload: {
            template_type: "custom",
            custom_type: "agent_info",
            text: text,
            extra_fields: {
              agentName: agentName,
            },
          },
        }),
      };

      log("Using Agent Name ->", agentName);

      sdk.sendUserMessage(data, function (err) {
        if (err) {
          logErr("sendUserMessage failed:", jstr(err));
        } else {
          log("Agent message sent successfully");
        }
      });
    }

    if (files.length) {
      log("SSE: relaying", files.length, "AGENT file(s) to Kore");
      var work = Promise.resolve();
      files.forEach(function (att) {
        work = work.then(function () {
          return attachments.forwardToKore(sdk, data, att, agentName);
        });
      });
      work.catch(function (e) {
        logErr("forward agent file(s) failed:", e.message);
      });
    }

    if (!text && !files.length) {
      log("SSE: message event had no text or files. parsed entryPayload =", jstr(ep));
    }
  } else if (
    /PARTICIPANT_CHANGED/i.test(eventName) ||
    /ParticipantChanged/i.test(entryType)
  ) {
    var participants = _.isArray(ep.entries) ? ep.entries : [ep];

    participants.forEach(function (p) {
      var role =
        _.get(p, "participant.role") || p.role || _.get(p, "sender.role") || "";

      if (!/agent/i.test(role)) {
        log(
          "SSE: participant change ignored (role=" + role + ") | raw:",
          jstr(p),
        );
        return;
      }

      var name =
        _.get(p, "displayName") ||
        _.get(p, "participant.displayName") ||
        p.name ||
        "An agent";

      var operation = (p.operation || p.operationType || "").toLowerCase();

      var text;

      if (operation === "add") {
        text = name + " has joined the conversation.";
      } else if (operation === "remove") {
        text = name + " has left the conversation.";
      } else {
        log(
          "SSE: participant change with unrecognized operation:",
          operation,
          "| raw:",
          jstr(p),
        );
        return;
      }

      // A warm transfer to another agent fires the exact same
      // PARTICIPANT_CHANGED(remove) signal as the agent genuinely ending
      // the chat -- the two are indistinguishable at this point. If this
      // is an "add", it's the replacement agent showing up: cancel any
      // pending teardown scheduled by that agent's earlier removal so the
      // session (and the underlying SSE connection) stays alive.
      if (operation === "add" && entry.pendingRemovalTimer) {
        clearTimeout(entry.pendingRemovalTimer);
        entry.pendingRemovalTimer = null;
        log(
          "SSE: replacement agent joined within grace period -> cancelling session teardown for",
          visitorId,
        );
      }
      entry.agentName = name;

      log("SSE: relaying participant-change message ->", text);

      // Remove any previous custom payload/template
      delete data.overrideMessagePayload;

      data.message = text;

      _.set(data, "_originalPayload.message", text);

      data.metaTags = {
        type: operation === "add" ? "agent_joined" : "agent_left",
        agentName: name,
      };

      sdk.sendUserMessage(data, function (err) {
        if (err) {
          logErr("sendUserMessage (participant-change) failed:", jstr(err));
        } else {
          log("SSE: participant-change message delivered to user", visitorId);
        }
      });

      // Session cleanup must not depend on whether the "agent has left"
      // notification to the customer succeeded -- an agent leaving is
      // authoritative regardless of a transient send failure. Fired
      // alongside (not nested inside) the notification above, matching the
      // guarantee this already had before: see CLAUDE.md gotchas for why a
      // send failure gating cleanup previously caused customers to get
      // stuck with no bot response after an agent ended the chat.
      //
      // Don't tear down immediately, though -- wait AGENT_TRANSFER_GRACE_MS
      // for a replacement agent's "add" (warm transfer) to cancel this. If
      // none shows up, this genuinely was the agent ending the chat.
      if (operation === "remove") {
        log(
          "SSE: agent left -> arming",
          AGENT_TRANSFER_GRACE_MS,
          "ms grace period before ending session for",
          visitorId,
        );
        if (entry.pendingRemovalTimer) {
          clearTimeout(entry.pendingRemovalTimer);
        }
        entry.pendingRemovalTimer = setTimeout(function () {
          if (_map[visitorId] !== entry) {
            return;
          }
          entry.pendingRemovalTimer = null;
          log(
            "SSE: no replacement agent joined within grace period -> ending session for",
            visitorId,
          );
          endSession(visitorId);
          clearAgentSessionSafe(visitorId, userDataMap[visitorId] || data);
        }, AGENT_TRANSFER_GRACE_MS);
      }
    });
  } else if (
    /CLOSE_CONVERSATION|CONVERSATION_CLOSED/i.test(eventName) ||
    /ConversationEnded|CloseConversation/i.test(entryType)
  ) {
    log(
      "SSE: conversation closed by Salesforce -> ending session for",
      visitorId,
    );
    endSession(visitorId);
    clearAgentSessionSafe(visitorId, data);
  }
}

function endSession(visitorId) {
  log("endSession for visitor", visitorId);
  var entry = _map[visitorId];
  if (entry && entry.sse) {
    try {
      entry.sse.destroy();
    } catch (e) {
      /* noop */
    }
  }
  if (entry && entry.pendingRemovalTimer) {
    clearTimeout(entry.pendingRemovalTimer);
  }
  delete _map[visitorId];
  delete userDataMap[visitorId];
}

/**
 * clearAgentSessionSafe
 * sdk.clearAgentSession tells the Kore platform the live-agent hand-off is
 * over so it resumes dispatching this visitor's messages through the normal
 * bot dialog (on_user_message/on_bot_message). Previously this was called
 * fire-and-forget with no callback, so a failure (e.g. a stale/expired
 * requestId on the cached `data`) was silently swallowed -- the customer's
 * messages kept forwarding into thin air with the platform never told to
 * hand control back to the bot. Always log the outcome so this is visible.
 */
function clearAgentSessionSafe(visitorId, data) {
  return new Promise(function (resolve) {
    sdk.clearAgentSession(data, function (err) {
      if (err) {
        logErr(
          "clearAgentSession failed for",
          visitorId,
          "->",
          jstr(err),
          "| bot may not resume responding until this succeeds",
        );
      } else {
        log("clearAgentSession OK for", visitorId);
      }
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* handoff                                                             */
/* ------------------------------------------------------------------ */

/**
 * waitForMessagingSessionId
 * Polls _map[visitorId].messagingSessionId (set by handleSseEvent as soon as
 * a relatedRecords-bearing conversationEntry arrives -- typically almost
 * immediately once history starts flowing, since Salesforce replays
 * everything since the token's lastEventId on connect). Rejects on timeout
 * or if the session was torn down first.
 */
function waitForMessagingSessionId(visitorId, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 8000);
  return new Promise(function (resolve, reject) {
    (function poll() {
      var entry = _map[visitorId];
      if (!entry) {
        return reject(
          new Error("session ended before MessagingSession Id was resolved"),
        );
      }
      if (entry.messagingSessionId) {
        return resolve(entry.messagingSessionId);
      }
      if (Date.now() > deadline) {
        return reject(
          new Error(
            "timed out waiting for Salesforce MessagingSession record Id",
          ),
        );
      }
      setTimeout(poll, 200);
    })();
  });
}

/**
 * createSalesforceSession
 * Shared session lifecycle for BOTH scenarios described in the new Case API
 * requirement:
 *   - opts.routed    (Scenario B, agent transfer): creates the Messaging
 *     Session, pushes history, then submits the Case with
 *     session_should_be_routed=true -- which triggers Omni-Channel routing
 *     as part of that same call. The SSE relay (opened up-front, see below)
 *     keeps running afterwards so agent replies flow back to the customer.
 *   - opts.deflected (Scenario A, bot resolved the conversation): same
 *     Messaging Session + history push, but submits the Case with
 *     is_deflected=true and no routing, then closes the conversation since
 *     no agent will ever join it.
 *
 * The SSE relay is opened right after createConversation (not after
 * submitCase, as originally) for BOTH scenarios: the Kore Create Case
 * endpoint requires the actual Salesforce MessagingSession record Id, but
 * MIAW's createConversation response carries no body at all, so that Id can
 * only be read off the SSE stream's conversationEntry.relatedRecords once
 * traffic (the history push) flows. Pushing history is itself harmless to
 * run through the relay for a deflected session: our own history lines echo
 * back with sender.role=EndUser, which handleSseEvent already filters out
 * as "our own echo" -- nothing gets relayed to the customer.
 */
function createSalesforceSession(visitorId, data, opts) {
  var label = opts.routed ? "agent-transfer" : "deflected";
  log("=== SF SESSION START (" + label + ") === visitor:", visitorId);
  log("incoming channel:", jstr(data.channel));

  var accessToken, lastEventId, conversationId;
  log(
    "step 1/5: requesting MIAW access token from",
    SF.miaw && SF.miaw.scrtBaseUrl,
  );
  return api
    .getAccessToken()
    .then(function (tok) {
      accessToken = tok.accessToken;
      lastEventId = tok.lastEventId || null;
      log(
        "step 1/5 OK: got access token",
        mask(accessToken),
        "| lastEventId",
        lastEventId,
      );

      var routing = buildRoutingAttributes(data);
      log("step 2/5: creating SF conversation (Messaging Session)...");
      return api.createConversation(accessToken, routing);
    })
    .then(function (conv) {
      conversationId = conv.conversationId;
      log(
        "step 2/5 OK: conversation created, conversationId =",
        conversationId,
      );

      userDataMap[visitorId] = data;
      _map[visitorId] = {
        conversationId: conversationId,
        accessToken: accessToken,
        lastEventId: lastEventId,
        sse: null,
        messagingSessionId: null,
        // `routed` distinguishes "a live agent may show up" (agent
        // transfer) from "just here briefly to resolve the
        // MessagingSession Id for a deflected case" -- message
        // routing (onUserMessage/onBotMessage/noteActivity) must NOT
        // treat a deflected setup-in-progress visitor as having a
        // live agent session, or the customer would get no bot
        // replies during this brief window.
        routed: !!opts.routed,
      };
      startSseRelay(visitorId);

      log("step 3/5: fetching + pushing chat history...");
      return fetchHistory(data)
        .then(function (messages) {
          return pushHistory(visitorId, conversationId, accessToken, messages);
        })
        .then(function () {
          log("step 4/5: waiting for Salesforce MessagingSession record Id...");
          return waitForMessagingSessionId(visitorId);
        })
        .then(function (messagingSessionId) {
          log("step 4/5 OK: messagingSessionId =", messagingSessionId);
          log(
            "step 5/5: submitting Salesforce Case (routed=" +
            !!opts.routed +
            ", deflected=" +
            !!opts.deflected +
            ")...",
          );
          return submitCase(data, messagingSessionId, opts);
        })
        .catch(function (e) {
          logErr(
            "could not resolve/submit Salesforce Case for",
            visitorId,
            "->",
            (e && e.message) || e,
          );
          return null; // best-effort: a Case failure never aborts the handoff/close
        })
        .then(function (caseRes) {
          if (opts.routed) {
            log(
              "=== SF SESSION COMPLETE (agent-transfer) === visitor:",
              visitorId,
            );
          } else {
            log(
              "deflected case handled -> closing SF conversation",
              conversationId,
            );
            endSession(visitorId);
            return api
              .closeConversation(accessToken, conversationId)
              .catch(function (e) {
                logErr("closeConversation (deflected) failed:", e.message);
              })
              .then(function () {
                log(
                  "=== SF SESSION COMPLETE (deflected) === visitor:",
                  visitorId,
                );
                return caseRes;
              });
          }
          return caseRes;
        });
    });
}

function connectToAgent(requestId, data, cb) {
  var visitorId = getVisitorId(data);
  log("on_agent_transfer: visitor", visitorId, "| requestId:", requestId);

  userDataMap[visitorId] = data;
  disarmInactivityTimer(visitorId);

  data.message = "Connecting you to an agent. Please hold on...";
  sdk.sendUserMessage(data, cb);

  if (typeof sdk.extendRequestId === "function") {
    try {
      sdk.extendRequestId(data, _.noop);
      log("extendRequestId called (keep request alive)");
    } catch (e) {
      logErr("extendRequestId failed:", e.message);
    }
  }

  return createSalesforceSession(visitorId, data, {
    routed: true,
    deflected: false,
  })
    .then(function () {
      /* discard the Case-API result; runComponentHandler expects no payload back */
    })
    .catch(function (e) {
      logErr("=== AGENT TRANSFER FAILED === visitor:", visitorId);
      logErr("reason:", (e && e.message) || e);
      if (e && e.response) {
        logErr(
          "HTTP status:",
          e.response.status,
          "| body:",
          jstr(e.response.data),
        );
      }
      endSession(visitorId);
      data.message = "Sorry, we could not connect you to an agent right now.";
      sdk.sendUserMessage(data, _.noop);
    });
}

/**
 * createDeflectedCase
 * Scenario A: the customer's conversation ends (explicitly or via inactivity
 * timeout) without ever needing a live agent. Skipped if a live-agent
 * session is already active (that path creates its own routed Case) or if
 * the visitor never actually said anything to deflect.
 *
 * @param {string} deflectionStatus one of DEFLECTION_STATUSES -- caller
 *   should pass the value matching how this deflection was triggered (e.g.
 *   "Assumed Deflection" for an inactivity timeout vs. "Successful
 *   Deflection" for an explicit customer end-chat). Falls back to
 *   DEFAULT_DEFLECTION_STATUS if omitted.
 */
function createDeflectedCase(visitorId, data, deflectionStatus) {
  if (_map[visitorId] && _map[visitorId].routed) {
    log(
      "skip deflected case -> live agent session already active for",
      visitorId,
    );
    return Promise.resolve();
  }
  if (_obhDone[visitorId]) {
    log("skip deflected case -> OBH case already created for", visitorId);
    return Promise.resolve();
  }
  if (!data) {
    log("skip deflected case -> no tracked conversation data for", visitorId);
    return Promise.resolve();
  }
  disarmInactivityTimer(visitorId);
  return createSalesforceSession(visitorId, data, {
    routed: false,
    deflected: true,
    deflectionStatus: deflectionStatus || DEFAULT_DEFLECTION_STATUS,
  }).catch(function (e) {
    logErr(
      "=== DEFLECTED CASE FAILED === visitor:",
      visitorId,
      "|",
      (e && e.message) || e,
    );
  });
}

function pushHistory(visitorId, conversationId, accessToken, messages) {
  log("pushHistory:", messages.length, "Kore messages to replay into SF");
  if (!messages.length) {
    return Promise.resolve();
  }

  var replay = Promise.resolve();
  var idx = 0;

  messages.forEach(function (m) {
    replay = replay.then(function () {
      idx += 1;
      var i = idx;
      var line = formatHistoryLine(m);
      var files = attachments.fromHistoryMessage(m);
      var p = Promise.resolve();

      if (line) {
        p = p.then(function () {
          log("pushHistory: line", i, "->", line);
          return api.sendMessage(accessToken, conversationId, line);
        });
      }

      files.forEach(function (att) {
        p = p.then(function () {
          log("pushHistory: file", i, "->", att.fileName || att.fileUrl);
          return attachments.forwardToSalesforce(
            accessToken,
            conversationId,
            att,
            att.fileName
          );
        });
      });

      return p.catch(function (e) {
        logErr("pushHistory item", i, "failed:", e.message);
      });
    });
  });

  return replay;
}

function writeTranscriptBlob(conversationId, transcriptText) {
  return api.getOAuthToken().then(function (oauth) {
    var recordId = null; // TODO: resolve from conversationId via SOQL
    if (!recordId) {
      log("transcript blob: recordId lookup not yet wired; skipping");
      return Promise.resolve();
    }
    return api.writeTranscriptField(oauth, recordId, transcriptText);
  });
}

/* ------------------------------------------------------------------ */
/* inactivity timer (Scenario A.2: customer goes idle without ending chat) */
/* ------------------------------------------------------------------ */

/**
 * noteActivity
 * (Re)arms the per-visitor inactivity timer on every bot-side customer
 * message. Not armed while a live-agent session is active -- that path has
 * its own lifecycle (agent join/leave/close), unrelated to bot deflection.
 */

function clearNudgeTimers(entry) {
  if (!entry || !entry.nudgeTimers) {
    return;
  }
  entry.nudgeTimers.forEach(clearTimeout);
  entry.nudgeTimers = [];
}
function sendInactivityNudge(visitorId, nudge, stepKey) {
  var entry = _activity[visitorId];
  if (!entry || !entry.data) {
    return;
  }
  if (entry.sentNudges && entry.sentNudges[stepKey]) {
    return;
  }
  if (_map[visitorId] && _map[visitorId].routed) {
    return;
  }
  entry.sentNudges = entry.sentNudges || {};
  entry.sentNudges[stepKey] = true;
  var payload = _.assign({}, entry.data);
  payload.message = nudge.message;
  log(
    "inactivity nudge (" + nudge.delayMs + "ms / " + stepKey + ") ->",
    visitorId,
  );
  sdk.sendUserMessage(payload, function (err) {
    if (err) {
      logErr("inactivity nudge failed:", stepKey, jstr(err));
      entry.sentNudges[stepKey] = false;
    }
  });
}


function noteActivity(visitorId, data) {
  if (_map[visitorId] && _map[visitorId].routed) {
    return;
  }
  if (!INACTIVITY_ENABLED && !INACTIVITY_NUDGES.length) {
    return;
  }
  var entry = _activity[visitorId] || {};
  entry.data = data;
  entry.sentNudges = {};
  clearTimeout(entry.timer);
  clearNudgeTimers(entry);
  entry.nudgeTimers = INACTIVITY_NUDGES.map(function (nudge, i) {
    var stepKey = "nudge-" + i;
    return setTimeout(function () {
      sendInactivityNudge(visitorId, nudge, stepKey);
    }, nudge.delayMs);
  });
  if (INACTIVITY_ENABLED) {
    entry.timer = setTimeout(function () {
      log(
        "inactivity timeout (" +
        INACTIVITY_TIMEOUT_MS +
        "ms) -> creating deflected case for",
        visitorId,
      );
      createDeflectedCase(visitorId, entry.data, "Assumed Deflection");
    }, INACTIVITY_TIMEOUT_MS);
  }
  _activity[visitorId] = entry;
}

function disarmInactivityTimer(visitorId) {
  var entry = _activity[visitorId];
  if (entry) {
    clearTimeout(entry.timer);
    clearNudgeTimers(entry);
  }
  delete _activity[visitorId];

}

/* ------------------------------------------------------------------ */
/* customer-initiated end of chat (Scenario A.1 and requirement #4)    */
/* ------------------------------------------------------------------ */

/**
 * handleCustomerEndChat
 * Single entry point for "the customer explicitly ended the chat", covering
 * both cases from the requirement:
 *   - a live-agent session is active -> tell the agent, close the SF
 *     session, and clear the platform-side agent session (requirement #4).
 *     No new Case: the routed Case was already created at transfer time.
 *   - no live-agent session -> the conversation is bot-only, so create the
 *     deflected Case immediately instead of waiting for the inactivity
 *     timeout (Scenario A.1).
 *
 * Wired from on_event below when data.event.eventType === 'sessionClosure'
 * -- observed (not officially documented) to fire when the widget's "end
 * chat" action calls the Kore RTM resource /bot.closeConversationSession.
 * See CLAUDE.md gotchas if this turns out to also fire for other client
 * disconnects (browser close, page nav) and needs narrowing.
 */
function handleCustomerEndChat(visitorId, data) {
  log("handleCustomerEndChat for visitor", visitorId);

  disarmInactivityTimer(visitorId);
  if (_obhDone[visitorId]) {
    log("end chat -> OBH case already created, skip for", visitorId);
    return Promise.resolve();
  }

  var entry = _map[visitorId];
  if (!entry || !entry.routed) {
    log("no live agent session -> treating as deflected case for", visitorId);
    return createDeflectedCase(visitorId, data, "Successful Deflection");
  }

  log(
    "live agent session active -> notifying agent + closing SF session for",
    visitorId,
  );
  return api
    .sendMessage(
      entry.accessToken,
      entry.conversationId,
      "Customer has ended the chat.",
    )
    .catch(function (e) {
      logErr("notify-agent (customer ended chat) failed:", e.message);
    })
    .then(function () {
      return api.closeConversation(entry.accessToken, entry.conversationId);
    })
    .catch(function (e) {
      logErr("closeConversation (customer ended chat) failed:", e.message);
    })
    .then(function () {
      endSession(visitorId);
      return clearAgentSessionSafe(visitorId, data);
    });
}

/* ------------------------------------------------------------------ */
/* hooks                                                               */
/* ------------------------------------------------------------------ */

function onUserMessage(requestId, data, cb) {
  var visitorId = getVisitorId(data);
  var entry = _map[visitorId];
  var liveAgent = entry && entry.routed;
  var files = attachments.fromPayload(data);

  log(
    "on_user_message: visitor",
    visitorId,
    "| liveAgentSession:",
    !!liveAgent,
    "| message:",
    data.message,
    "| attachments:",
    files.length
  );

  if (liveAgent) {
    userDataMap[visitorId] = data;

    var work = Promise.resolve();

    if (files.length) {
      files.forEach(function (att, i) {
        work = work.then(function () {
          log(
            "forwarding USER file -> Salesforce |",
            att.fileName,
            "| conv",
            entry.conversationId
          );
          return attachments.forwardToSalesforce(
            entry.accessToken,
            entry.conversationId,
            att,
            i === 0 ? data.message : ""
          );
        });
      });
    } else if (data.message) {
      work = api.sendMessage(
        entry.accessToken,
        entry.conversationId,
        data.message
      );
    }

    return work
      .then(function () {
        log("user message/file delivered to agent");
      })
      .catch(function (e) {
        logErr(
          "forward to agent failed:",
          e.message,
          "-> ending session, falling back to bot"
        );
        endSession(visitorId);
        return sdk.sendBotMessage(data, cb);
      });
  }

  noteActivity(visitorId, data);

  // File-only event: message is undefined. sendBotMessage of that
  // stalls the Kore dialog, so the next typed line never gets a bot reply.
  if (files.length && !data.message) {
    data.message = files[0].fileName
      ? "Attachment uploaded: " + files[0].fileName
      : "Attachment uploaded";
    log("attachment-only -> set message so bot dialog can continue:", data.message);
  }

  log("no live agent -> routing message to bot");
  return sdk.sendBotMessage(data, function (err) {
    if (err) {
      logErr("sendBotMessage failed:", err);
    }
    if (typeof cb === "function") {
      cb(err, data);
    }
  });
}

function handleObhFormCase(visitorId, data, cb) {
  log("OBH form submitted -> creating case for", visitorId);
  disarmInactivityTimer(visitorId); // do not also fire a deflected case later

  // data.message = "Submitting your case. Please wait...";
  // sdk.sendUserMessage(data, cb);

  return createSalesforceSession(visitorId, data, {
    routed: false,      // no live agent
    deflected: true,    // confirm this flag with Salesforce (see below)
    deflectionStatus: "Escalation needed",
  })
    .then(function (caseRes) {
      var caseNumber = _.get(caseRes, "caseNumber");
      var session = _.get(data, "context.session.BotUserSession") || {};

      data.message = caseNumber
        ? "A case has been logged for you, and a representative will contact you within 24 hours. Your case number is " + caseNumber + "."
        : "A case has been logged for you, and a representative will contact you within 24 hours.";
      session.caseCreatedMsg = data.message;
      sdk.sendUserMessage(data, _.noop);
    })
    .catch(function (e) {
      logErr("=== OBH CASE FAILED === visitor:", visitorId, "|", (e && e.message) || e);
      data.message = "Sorry, we could not log your case right now. Please try again later.";
      sdk.sendUserMessage(data, _.noop);
    });
}

var _obhDone = {}; // visitorId -> true after we handle the form once
function isObhFormSubmit(data) {
  return _.get(data, "context.session.BotUserSession.formSubmitted") === true;
}

function onBotMessage(requestId, data, cb) {
  var visitorId = getVisitorId(data);
  var entry = _map[visitorId];
  if (entry && entry.routed) {
    log(
      "on_bot_message: live agent active for",
      visitorId,
      "-> suppressing bot message",
    );
    return;
  }
  log(
    "on_bot_message: visitor",
    visitorId,
    "-> delivering bot message to user"
  );

  // NEW: after-hours form — create Case, then send confirmation
  // Check both in-memory flag AND session flag (survives BotKit restart)
  var obhAlreadyDone = _obhDone[visitorId] ||
    _.get(data, "context.session.BotUserSession.caseCreatedMsg");

  if (isObhFormSubmit(data) && !obhAlreadyDone) {
    _obhDone[visitorId] = true;
    return handleObhFormCase(visitorId, data, cb);
  }
  // if (isObhFormSubmit(data) && _obhDone[visitorId]) {
  //   data.context.obhCaseCreated = true;
  //   data.message = "A case has already been logged for you.";
  //   return sdk.sendUserMessage(data, cb);
  // }

  return sdk.sendUserMessage(data, cb);
}

function onAgentTransfer(requestId, data, cb) {
  return connectToAgent(requestId, data, cb);
}

/**
 * onEvent
 * data.event.eventType === 'sessionClosure' is what we've observed fired
 * when the widget's "end chat" action calls the Kore RTM resource
 * /bot.closeConversationSession -- not officially documented by Kore, so
 * treat this as best-effort until confirmed. If it turns out to also fire
 * for other client disconnects (not just an explicit end-chat click), this
 * will need narrowing -- see CLAUDE.md.
 */
function onEvent(requestId, data, cb) {
  var visitorId = getVisitorId(data);
  var eventType = _.get(data, "event.eventType");
  var resourceId = _.get(data, "resourceid");

  log(
    "on_event:",
    "visitor=",
    visitorId,
    "| eventType=",
    eventType,
    "| resourceid=",
    resourceId,
  );

  if (
    eventType === "sessionClosure" ||
    resourceId === "/bot.closeConversationSession"
  ) {
    log("Customer end chat detected:", visitorId);

    handleCustomerEndChat(visitorId, data).catch(function (e) {
      logErr("handleCustomerEndChat failed:", (e && e.message) || e);
    });
  }

  return cb(null, data);
}

module.exports = {
  botId: botId,
  botName: botName,
  on_user_message: function (requestId, data, callback) {
    onUserMessage(requestId, data, callback);
  },
  on_bot_message: function (requestId, data, callback) {
    onBotMessage(requestId, data, callback);
  },
  on_agent_transfer: function (requestId, data, callback) {
    log("on_agent_transfer event received");
    onAgentTransfer(requestId, data, callback);
  },
  on_event: function (requestId, data, callback) {
    onEvent(requestId, data, callback);
  },
};
