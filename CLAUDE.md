# CLAUDE.md — JBL Assistant ↔ Salesforce Omni-Channel (Kore BotKit)

Context for any new Claude Code session or teammate. This repo is the Kore.ai
**BotKit SDK** extended to hand off conversations from the **JBL Assistant** bot
to **Salesforce Omni-Channel** (live agents), with chat-history transfer and
Case creation. Read this first before changing the Salesforce integration.

## What this integration does

There are two ways a conversation reaches Salesforce, both funneled through
the same `createSalesforceSession()` in `Salesforce.js`:

**A. Agent transfer** (customer asks for a human, or reaches an **Agent
Transfer** dialog node):
1. Creates a Salesforce **Messaging Session** via *Messaging for In-App and Web*
   (MIAW).
2. Passes **pre-chat / routing attributes** (name, email, region, …) into the
   session.
3. Pushes the **prior bot↔customer chat history** into the session for agent
   context.
4. Calls the **Kore Create Case** Apex REST endpoint with
   `session_should_be_routed: true` — this creates the Contact + Case AND
   triggers Omni-Channel routing to a queue in the same call.
5. Relays messages **both ways** in real time (customer ↔ agent) using the MIAW
   **SSE** event stream.
6. Announces the agent **joining/leaving** to the customer (text + structured
   `metaTags`), and shows the agent's name (not the bot's) on agent chat
   messages.

**B. Deflected case** (bot resolves the conversation with no agent — customer
explicitly ends the chat, or 15 minutes of inactivity): same Messaging
Session + history push as above, but calls Kore Create Case with
`is_deflected: true` / `session_should_be_routed: false` (no routing), then
closes the Messaging Session since no agent will ever join it.

See "Pending Salesforce API work" below for remaining open items (the
auto-routing issue that used to block this is resolved as of 2026-08-14).

## Why BotKit (not the native platform agent-transfer)

The native Kore agent-transfer integration is config-driven and could not meet
our requirements; the **Kore.ai platform team reviewed this and recommended the
BotKit approach**. Native limitations that drove the decision:
- No support for the MIAW custom-client flow needed to create the Omni-Channel
  Messaging Session the way Salesforce expects.
- Cannot push the prior bot transcript into the Salesforce session.
- Cannot map our custom routing/pre-chat attributes to Salesforce's exact field
  contract.
- Cannot call our custom Apex REST endpoint for Case/contact creation.
- No place for custom orchestration (timing/provisioning handling, retries).

BotKit gives full lifecycle control (event hooks), arbitrary external API calls
with custom auth, payload enrichment, event-driven orchestration, and is an
independently deployable Node.js service.

## Architecture / flow

```
Customer ⇄ Kore JBL Assistant bot ⇄ BotKit (this app) ⇄ Salesforce (MIAW + Apex)

createSalesforceSession(visitorId, data, {routed, deflected})   [shared by both paths]
  ─► getAccessToken (MIAW) ─► createConversation (Messaging Session)
  ─► push chat history (getMessages → MIAW sendMessage, per line)
  ─► submitCase(): POST kore/create-case  (session_should_be_routed / is_deflected)
       routed=true  ─► _map[visitorId] set, open SSE stream (agent relay)
       routed=false ─► closeConversation (deflected -- no agent will join)

on_agent_transfer                 ─► createSalesforceSession({routed:true})
noteActivity() (every bot-handled  ─► (re)arms a 15-min setTimeout per visitor;
  on_user_message)                    fires createDeflectedCase() if idle
handleCustomerEndChat()            ─► wired from on_event when
  (customer explicitly ends chat)     data.event.eventType === 'sessionClosure'
                                       (observed, not officially documented --
                                       see Pending Salesforce API work) --
                                       branches to either requirement #4 (live
                                       agent active) or
                                       createSalesforceSession({deflected:true})

SSE: CONVERSATION_MESSAGE         ─► relay agent/system message → customer (sendUserMessage)
SSE: PARTICIPANT_CHANGED (Agent)  ─► "X has joined/left" → customer; on leave, ALSO
                                     end the session locally + clearAgentSessionSafe (see gotchas)
on_user_message  ─► forward customer message → MIAW conversation (or noteActivity() if bot-only)
SSE: CLOSE/CONVERSATION_CLOSED    ─► end session, clearAgentSessionSafe
```

## Key files

- `Salesforce.js` — the BotKit hook module (registered in `app.js`). Hooks:
  `on_agent_transfer`, `on_user_message`, `on_bot_message`, `on_event`.
  `createSalesforceSession()` is the shared pipeline (token → conversation →
  history push → submitCase) used by both `connectToAgent()` (routed) and
  `createDeflectedCase()` (deflected, called from the inactivity timer or
  `handleCustomerEndChat()`). `handleCustomerEndChat()` is wired from
  `on_event` (`data.event.eventType === 'sessionClosure'`) — see Pending
  Salesforce API work for confidence caveats. All actions
  log with the `[SF ...]` prefix. `botId`/`botName` are read from
  `config.salesforce` — **not hardcoded** (see Configuration below).
- `SalesforceAPI.js` — REST wrapper for Salesforce. MIAW calls
  (`getAccessToken`, `createConversation`, `sendMessage`, `closeConversation`,
  SSE headers) + OAuth (`getOAuthToken`) + `createCase` (now the "Kore Create
  Case" endpoint — see Configuration) + `writeTranscriptField`.
  Logs with the `[SF-API ...]` prefix.
- `makeHttpCall.js` — shared axios wrapper. Note: it intentionally omits the body
  on GET requests (see gotchas).
- `config.json` — all configuration under the `salesforce` key (see below).
- `app.js` — registers bots; `sdk.registerBot(require('./Salesforce.js'))`.
- `lib/` — the BotKit SDK framework (mostly untouched). Kore auth (JWT from
  Client ID/Secret) lives in `lib/sdk/lib/invokePlatformAPIs.js`.

## Configuration (`config.json` → `salesforce`)

- `credentials[<botId>]` — Kore **Client ID** (`appId`) + **Client Secret**
  (`apikey`) for the JBL Assistant bot. Used to sign the JWT BotKit sends to
  Kore. **Secret lives here — do not commit real values to a public repo.**
- `salesforce.botId` / `salesforce.botName` — the bot's identity. **Single
  source of truth is the `KORE_BOT_ID` env var** (optional `KORE_BOT_NAME`):
  `config.js` uses the same `KORE_BOT_ID` to populate both
  `credentials[botId]` (outbound JWT signing) and `salesforce.botId` (inbound
  routing key, read by `Salesforce.js`). Do **not** hardcode either value in
  `Salesforce.js` again — see gotchas below for why that broke the whole
  integration once already.
- `salesforce.miaw` — `scrtBaseUrl`, `orgId`, `esDeveloperName`,
  `capabilitiesVersion`, `platform`. From the MIAW deployment.
- `salesforce.oauth` — Connected App **client-credentials** flow, used for the
  Kore Create Case call: `enabled`, `tokenUrl`, `clientId`, `clientSecret`,
  `grantType`.
- `salesforce.case` — config for the **Kore Create Case** endpoint
  (`POST /services/apexrest/kore/create-case`, per Craftware's "Kore Create
  Case Documentation v1.0"): `enabled`, `url`, `retry` (`maxAttempts`,
  `delayMs`), and `defaults` (`countryCode`, `region`, `language`,
  `productName`, `orderNumber` — fallbacks used when live context values are
  missing). Body assembly is `Salesforce.js` `buildCreateCaseBody()`; the
  actual submit-with-retry call is `submitCase()`. A `409 CASE_ALREADY_EXISTS`
  response is treated as success, not a failure.
- `salesforce.inactivity` — `enabled`, `timeoutMs` (default 15 min = 900000).
  Drives the per-visitor idle timer (`noteActivity()` /
  `disarmInactivityTimer()`) that auto-creates a deflected case.
- `salesforce.agentTransferGraceMs` (default 10000) — how long
  `handleSseEvent`'s `PARTICIPANT_CHANGED` handler waits after an agent is
  removed before treating it as a genuine end-of-chat, in case it's actually
  a warm transfer to another agent (see gotcha below).
- `salesforce.routingAttributes` — static pre-chat attrs (`Region_Code`,
  `Is_Chat_Button_Clicked`) passed to MIAW `createConversation`. Unrelated to
  the Kore Create Case body's `session_details.region` — separate systems.
  Name/email are added live (see below).
- `salesforce.language`, `salesforce.historyLimit`, `salesforce.relayMode`.

### Live values read from Kore conversation context
- Routing attributes name/email — `Salesforce.js` `buildRoutingAttributes()`.
  Confirm the exact context path with the bot (was
  `context.steps.Automation0001.{Name,LastName,Email}`).
- Case fields (`buildCreateCaseBody()`) read `context.email/firstname/lastname/
  countryCode/region/orderNumber/productName` live, falling back to
  `salesforce.case.defaults`; falling back also sets
  `customer_country_unknown: true`. Override anything via
  `context.salesforceCase` in the dialog (merged in last).

## Important conventions / gotchas (learned the hard way)

- **Routing attribute names are Title_Case and case-sensitive** in Salesforce:
  `Bot_First_Name`, `Bot_Last_Name`, `Bot_Email`, `Region_Code`,
  `Is_Chat_Button_Clicked`. ALL_CAPS or other casing is **silently dropped**
  (request still returns 201, values just vanish).
- **`language` field** (e.g. `en_US`) is required in the createConversation body.
- **GET requests must not carry a body.** Kore's `getMessages` returns
  `400 "Malformed JSON"` if axios sends a `null` body — fixed in
  `makeHttpCall.js` (only attaches `data` when present).
- **SSE `entryPayload` is a JSON *string*** — must be `JSON.parse`-d before
  reading; agent text is at `abstractMessage.staticContent.text`.
- **SSE relay filters:** EndUser echoes are skipped; agent + System/auto-generated
  messages are relayed. Typing/routing/ack/ping events are ignored.
- **Case creation via the Kore Create Case endpoint is now synchronous and
  up-front**, not SSE-driven. The old flow raced Salesforce's automatic
  Contact-creation trigger (`getLastNameBasedOnEmail` NPE on a not-yet-
  provisioned end-user/email) by waiting for `CONVERSATION_ROUTING_RESULT`
  before calling the old Apex Case endpoint. The new endpoint creates the
  Contact itself explicitly, so that race is gone — `submitCase()` is called
  directly after the history push, before routing/SSE even starts. The retry
  that remains (`salesforce.case.retry`) is for `SESSION_NOT_FOUND` (the
  just-created session not indexed yet) and plain network flakiness, not the
  old provisioning race. `CONVERSATION_ROUTING_RESULT` on the SSE stream is
  now purely informational (see `handleSseEvent`).
- **History order/labeling:** `getMessages` order is normalized by timestamp
  (`msgTime`); text is extracted across multiple paths (`extractText`) so both
  Bot and Customer lines survive. All replayed history appears on the customer
  side in the agent view (inherent to MIAW custom-client injection) — the
  `Customer:` / `Bot:` text prefix distinguishes them. Fixing this properly
  (real per-message sender rendering) requires a Salesforce-side Apex endpoint
  that inserts `ConversationEntry` records with an explicit sender role — the
  MIAW custom-client API can't do this itself since every message is
  attributed to whichever identity holds the access token (see "Pending
  Salesforce API work" below).
- **`sdk.getMessages` (`lib/sdk/lib/invokeSendMessageAPIs.js`) crashes
  synchronously if `requestData.userId` is falsy AND the channel shape
  doesn't have a nested `channelInfos`** — it does
  `requestData.userId || requestData.channel.channelInfos.from`, no dual-path
  fallback like `getVisitorId()` has. Payloads sourced from an
  `ON_CONNECT_EVENT` (e.g. a visitor who never sent a real message before
  going idle) carry a **flat** `channel: {from: "..."}`, not
  `channel.channelInfos.from` — `.channelInfos` is `undefined` there, so
  `.from` throws `Cannot read properties of undefined (reading 'from')`.
  Since none of our payload classes ever set a plain `userId`, this reliably
  broke `fetchHistory()` for the deflected-case path (crash happens inside
  fetchHistory's Promise executor -> the promise rejects -> Case creation is
  silently skipped for that visitor, no retry). Fixed in `fetchHistory()` by
  setting `data.userId = data.userId || getVisitorId(data)` before calling
  `sdk.getMessages` — never remove that line, and don't assume `getMessages`
  is safe to call directly elsewhere without the same guard.
- **botId/botName must never be hardcoded in `Salesforce.js`.** They broke once
  already: `Salesforce.js` had a literal `botId` string that drifted out of
  sync with `KORE_BOT_ID`/`credentials`. Inbound routing (`bots[botId]` in
  `lib/sdk/index.js`) and outbound JWT signing (`credentials[botId]` in
  `invokePlatformAPIs.js`) both key off this same string but previously came
  from two different places — when they diverged, `on_agent_transfer` silently
  never fired (fell through to an unregistered `bots['default']`) with **no
  error at all**. Now both are derived from the single `KORE_BOT_ID` env var
  in `config.js` — never reintroduce a second source for this id.
- **Ending a live-agent session on agent-leave:** don't rely solely on the
  `CLOSE_CONVERSATION`/`CONVERSATION_CLOSED` SSE event to clear `_map[visitorId]`.
  When an agent ends the chat, Salesforce reliably fires `PARTICIPANT_CHANGED`
  (operation `remove`, role `Agent`) but does **not** reliably/promptly also
  fire a close event. If only the close event clears the session, the customer
  is left silently stuck: `onUserMessage` keeps forwarding their messages into
  the now-unattended MIAW conversation (which doesn't error), and
  `onBotMessage` suppresses bot replies whenever `_map[visitorId]` exists — so
  they get **no response at all**. Fix: call `endSession()` +
  `sdk.clearAgentSession()` directly from the `PARTICIPANT_CHANGED` (remove)
  handler too, not just from the close-event handler.
- **Agent-to-agent warm transfer looks identical to "the agent ended the
  chat"** — both are just `PARTICIPANT_CHANGED` with the current agent
  removed; there's no separate "transferred" signal to key off. Tearing the
  session down immediately on `remove` (the fix above) broke warm transfers:
  the old agent's removal destroyed the actual SSE connection and deleted
  `_map[visitorId]` before the replacement agent's `add` event (or any of
  their subsequent messages) could ever be processed — customer got no
  "agent joined" notice, and the new agent's messages silently vanished.
  Fixed with a grace period (`salesforce.agentTransferGraceMs`, default
  10s): `remove` arms a `setTimeout` instead of tearing down immediately;
  if a replacement agent's `add` arrives before it fires (same batch or a
  later SSE chunk — session/connection are still alive during the grace
  window either way), the pending teardown is cancelled via
  `entry.pendingRemovalTimer` and the session continues uninterrupted. Only
  if no replacement shows up in time does the original "genuinely ended"
  cleanup (`endSession` + `clearAgentSessionSafe`) actually run. **Not yet
  confirmed**: whether Salesforce always sends `remove(oldAgent)` +
  `add(newAgent)` for a warm transfer within the same `MessagingSession`/
  conversationId (assumed here), vs. some other event shape or a brand-new
  session — verify against real transfer logs if this doesn't fully resolve
  the symptom.
- **`session_details.deflection_status` is required whenever `is_deflected`
  is true** (Craftware API update, 2026-08-26 — despite their announcement
  calling it "optional," omitting it on a deflected request gets
  `400 VALIDATION_ERROR: session_details.deflection_status is required when
  session_details.is_deflected is true`). Accepted values: `Successful
  Deflection`, `Assumed Deflection`, `Not deflected`, `Escalation needed`,
  `Sent to Agent`, `Session-End Detection` (`DEFLECTION_STATUSES` in
  `Salesforce.js`). `createDeflectedCase(visitorId, data, deflectionStatus)`
  takes this as a third argument, threaded through
  `createSalesforceSession`/`submitCase`/`buildCreateCaseBody` as
  `opts.deflectionStatus`. Current mapping (our judgment call, not something
  Salesforce specified — revisit if their reporting expects something
  different): `"Assumed Deflection"` for the 15-min inactivity timeout
  (`noteActivity`'s `setTimeout` callback — we're assuming they're done,
  no explicit confirmation), `"Successful Deflection"` for an explicit
  customer end-chat with no live agent (`handleCustomerEndChat`'s no-agent
  branch — they explicitly ended without needing one). Falls back to
  `DEFAULT_DEFLECTION_STATUS` (`"Assumed Deflection"`) if a future call site
  forgets to pass one, rather than omitting the field and hitting this
  error again.
- **`messaging_session_id` for the Kore Create Case endpoint is a real
  Salesforce record Id (e.g. `0MwV900000EL6f3`, `0Mw` = `MessagingSession`
  prefix) — it is NOT the `conversationId` UUID we generate for MIAW's
  `createConversation`.** Sending our UUID gets a `400 VALIDATION_ERROR:
  messaging_session_id is not a valid record Id` on every attempt (retries
  don't help — the value never changes). Confirmed by testing: MIAW's
  `createConversation` response body is **empty** (`content-length: 0`), so
  there is no REST-response field to read the record Id from. The only place
  it appears is on the **SSE stream**, in `conversationEntry.relatedRecords`
  on message-type entries (not on e.g. `ConversationUpdated`, which has
  `relatedRecords: []`) — and only once real traffic flows through the
  conversation. Fix: `createSalesforceSession()` now opens the SSE relay
  immediately after `createConversation` (for BOTH routed and deflected
  sessions, not just routed), `handleSseEvent` captures the first non-empty
  `relatedRecords[0]` into `_map[visitorId].messagingSessionId` as a side
  effect, and `waitForMessagingSessionId()` polls for it (8s timeout) before
  `submitCase()` runs. In practice this resolves almost instantly, since
  Salesforce replays all buffered events since the token's `lastEventId` on
  connect — the very first `pushHistory()` line's EndUser-echo already
  carries it. If a conversation somehow has zero history to push, no
  message-type SSE entry will ever fire and this will time out — not
  currently handled with a synthetic fallback message.
- Because the SSE relay now opens up-front for deflected sessions too (not
  just routed ones), `_map[visitorId]` briefly exists during deflected-case
  setup. **`_map[visitorId].routed` is the actual "route messages to a live
  agent" flag** — `onUserMessage`/`onBotMessage`/`noteActivity`/
  `createDeflectedCase`/`handleCustomerEndChat` all gate on `entry.routed`,
  not on `_map[visitorId]` truthiness alone. Never go back to checking bare
  `_map[visitorId]` for "is a live agent involved" — that would wrongly
  suppress bot replies to a customer who messages again during the brief
  (~1-2s) window while a deflected case is being resolved.
- **`sdk.clearAgentSession()` was called fire-and-forget (no callback) —
  a failure was completely silent.** This matters more than it looks: this
  call is what tells the *Kore platform* (not just our local `_map`) that the
  live-agent hand-off is over, so it resumes normal bot dialog dispatch for
  that visitor. Local state (`_map`/`userDataMap`) was always cleared
  correctly, but if the platform-side call failed silently, the platform
  could keep treating the visitor as agent-transferred even though our side
  thought it was done — a plausible explanation for "bot doesn't respond
  after the agent ends the chat." Fixed via `clearAgentSessionSafe()`, which
  always logs success/failure with the `[SF ...]` prefix. If this bug
  resurfaces in UAT, check the logs for `clearAgentSession failed` first.
- **Agent messages/typing now use `overrideMessagePayload` (Kore's native
  template contract), not `metaTags`.** `metaTags` (see previous revision of
  this doc) was never confirmed to survive Kore's platform through to the
  widget. `handleSseEvent` now sends
  `data.overrideMessagePayload = { isTemplate: true, body: JSON.stringify({
  type: 'template', payload: { template_type: 'custom', custom_type: ...,
  ... } }) }` — the same `{type:'template', payload:{template_type:...}}`
  shape real bot template messages already use (confirmed working, e.g. the
  button-link template seen in transcripts), so this is Kore's actual
  contract rather than an ad-hoc field. Two `custom_type` values in use:
  `agent_info` (agent chat message, `text` + `extra_fields.agentName`) and
  `agent_typing` (`typing: 'started'|'stopped'`, sent on
  `CONVERSATION_TYPING_STARTED_INDICATOR`/`STOPPED_INDICATOR` SSE events).
  Plain-text `data.message` is still set alongside it as a fallback.
  `agentName` is captured once into `_map[visitorId].agentName` when the
  agent joins (`PARTICIPANT_CHANGED`, operation `add`), rather than
  re-derived per message. **Still worth confirming with the widget owner**:
  that `custom_type: agent_info`/`agent_typing` actually render (this
  replaces the old, also-unconfirmed `metaTags` approach — don't assume
  either is final until seen working live).
  Note: this wrapping currently applies to *any* non-EndUser message on the
  conversation, not just agent-sent ones — a Salesforce System/auto-message
  would also get wrapped as `agent_info` (with whatever `agentName` was last
  captured, possibly stale). Minor/cosmetic; narrow to `/agent/i.test(senderRole)`
  if this turns out to visibly mislabel system messages.
- **Session cleanup on agent-leave must never be gated on the "agent has
  left" notification succeeding.** A refactor (2026-08-14) briefly nested
  `endSession()`/`clearAgentSession()` inside the `sdk.sendUserMessage`
  success callback for the `PARTICIPANT_CHANGED` (remove) handler — if that
  one notification call failed for any reason, cleanup never ran, silently
  reintroducing the exact "customer stuck, no bot response after agent
  ends chat" bug documented earlier in this file. Fixed by firing
  `endSession`/`clearAgentSessionSafe` unconditionally, alongside (not
  nested inside) the notification's callback. If this bug resurfaces, check
  first whether cleanup got nested inside a callback again.
- **RESOLVED (2026-08-14): `createConversation` used to auto-route
  unconditionally.** Confirmed by testing: setting `Is_Chat_Button_Clicked:
  false` did **not** prevent routing; the org's **Omni-Channel Flow** ("Route
  Messaging Sessions with Omni-Channel Flows") ran on every session creation
  and unconditionally hit `Route Work` regardless of `session_should_be_
  routed`, leaving the `MessagingSession` in a failed-routing state
  (`CONVERSATION_ROUTING_RESULT` / `failureType: "RoutingError"`, empty
  `queueId`) that made every `create-case` call — routed AND deflected —
  fail with `500 INTERNAL_ERROR`. Salesforce added the Decision gate to the
  Omni-Channel Flow so `createConversation` no longer auto-routes; routing
  now only happens when `create-case` explicitly requests it via
  `session_should_be_routed: true`. If `500 INTERNAL_ERROR` on `create-case`
  resurfaces, re-check this Flow first before assuming it's a new issue.

## Pending Salesforce API work / new requirement

**Business requirement (now implemented in code, see `createSalesforceSession`
/ `createDeflectedCase` / `noteActivity` in `Salesforce.js`):** create the
Messaging Session as soon as the customer's conversation is resolvable by the
bot alone (not only at agent transfer), so bot-only conversations still get a
Case (marked deflected) instead of nothing. Two Case-creation paths, both via
the same **Kore Create Case** endpoint (`POST /services/apexrest/kore/create-
case`, Craftware "Kore Create Case Documentation v1.0"):
- **Deflected case** — `is_deflected: true`, `session_should_be_routed: false`.
  Triggered by `createDeflectedCase()`, called from either the 15-min
  inactivity timer (`noteActivity`/`setTimeout`) or `handleCustomerEndChat()`.
- **Real transfer** — `session_should_be_routed: true`, `is_deflected: false`.
  Triggered by `connectToAgent()` → `createSalesforceSession({routed:true})`,
  same as before but now via the new endpoint instead of the old Apex
  `/kore/case` one.

**Still open / not yet confirmed:**
1. ~~The Omni-Channel-Flow-no-longer-auto-routes assumption is unverified~~ —
   **resolved 2026-08-14**, see the gotcha above.
2. **The "customer explicitly ended the chat" signal is wired, but only on
   empirical observation, not an official Kore contract.** `on_event` fires
   with `data.event = {"eventType": "sessionClosure"}` when the widget's "end
   chat" action calls the Kore RTM resource `/bot.closeConversationSession`
   (confirmed by browser network trace, 2026-08-10) — `Salesforce.js`
   `onEvent()` branches on that and calls `handleCustomerEndChat(visitorId,
   data)`, which implements the full behavior (deflect if bot-only,
   notify-agent + close if live-agent — requirement #4). **Not yet verified**:
   whether `sessionClosure` fires *only* for the explicit end-chat click, or
   also for other client disconnects (browser close, tab nav, Kore's own
   client-side idle handling) — if the latter, this would create deflected
   cases (or close live-agent sessions) more eagerly than intended. Watch
   `[SF ...] on_event: ... sessionClosure` in the logs across a range of real
   user behaviors (not just deliberate end-chat clicks) before trusting this
   fully.
3. The Kore Create Case request body has no transcript/history field — the
   requirement's "push full chat history" is satisfied by the *existing*
   MIAW `sendMessage`-per-line push (`pushHistory()`, unchanged), which now
   also runs for deflected sessions, not just agent transfers.

## Deployment

- Runs as a **persistent Node.js service** (NOT serverless — it holds in-memory
  session state and long-lived SSE connections). Deployed on **Render**.
- `npm start` → `node app.js`. Binds `process.env.PORT` (Render injects it),
  falling back to `config.server.port`.
- Logs are plain `console.log` (no `DEBUG` env needed) — visible in Render logs.

### Verify a deployment
- `GET /history/index.html` → 200 (static serving works).
- `POST /sdk/bots/<KORE_BOT_ID>/on_user_message` → 401 (server + auth alive).
  Use the *current* `KORE_BOT_ID` value from Render's env — don't hardcode a
  bot id here, it has already changed once (see gotchas).

## Current status

- ✅ Handoff → Messaging Session created + Case created + routed, via the new
  Kore Create Case endpoint (`createSalesforceSession({routed:true})`).
- ✅ Routing attributes (name/email/region) populated (Title_Case + language fix).
- ✅ Customer → agent and agent/system → customer messaging (SSE).
- ✅ Chat history push (GET-body fix, order + both-sides fixes) — now runs for
  deflected sessions too, not just agent transfers.
- ✅ Case creation via the **Kore Create Case** endpoint (replaces the old
  Apex `/kore/case` flow entirely) — called synchronously up-front (no more
  SSE-driven timing race), with retry on `SESSION_NOT_FOUND`/network errors
  and `CASE_ALREADY_EXISTS` (409) treated as success.
- ✅ botId/botName config-driven (single source of truth: `KORE_BOT_ID`) —
  fixes a real bug where a hardcoded, drifted `botId` silently broke
  `on_agent_transfer` routing with no error.
- ✅ Agent join/leave announcements (SSE `PARTICIPANT_CHANGED`) + agent-name-
  on-messages, both with `metaTags` for future widget-side rendering (shape
  not yet confirmed against the live widget).
- ✅ Deflected-case flow implemented: 15-min in-memory inactivity timer
  (`noteActivity`/`salesforce.inactivity.timeoutMs`) auto-creates a deflected
  Case; `handleCustomerEndChat()` implements the immediate-end-chat version
  of the same thing, plus the "notify agent + close session" behavior when a
  live-agent session is active (requirement #4). Wired from `on_event`
  (`sessionClosure`) — see "Pending Salesforce API work" #2 for confidence
  caveats.
- ✅ Fixed a crash in the deflected-case path: `fetchHistory()` now sets
  `data.userId` before calling `sdk.getMessages` (see gotchas) — without it,
  any visitor whose channel payload has a flat `channel.from` instead of
  nested `channel.channelInfos.from` (observed on `ON_CONNECT_EVENT`-sourced
  payloads) crashed `getMessages` synchronously, silently skipping Case
  creation entirely for that visitor.
- ⚠️ **`clearAgentSession` failures are now logged instead of silently
  swallowed** (`clearAgentSessionSafe`) — the likely root cause of "bot
  doesn't respond after the agent ends the chat." Watch Render logs for
  `clearAgentSession failed` in UAT to confirm this was the actual bug.
- ✅ **RESOLVED (2026-08-14)**: the `500 INTERNAL_ERROR` on `create-case`
  (both routed and deflected) was the Omni-Channel Flow auto-routing on every
  `createConversation` regardless of `session_should_be_routed`, confirmed by
  a `CONVERSATION_ROUTING_RESULT` SSE event (`failureType: "RoutingError"`,
  empty `queueId`) firing before `create-case` was even called. Salesforce
  added the Decision gate to defer routing to `create-case`'s explicit
  request — see the gotcha above. Reported multiple recurring `errorId`s to
  Craftware/Salesforce across 2026-08-10 through 2026-08-12 before the fix
  landed.
- 🚧 **Unconfirmed**: whether `on_event sessionClosure` fires *only* for an
  explicit end-chat click or also for other client disconnects — see
  "Pending Salesforce API work" #2.

## Environment

- Salesforce org: **UAT sandbox** (`harman--uat.sandbox.my.salesforce.com`,
  SCRT `harman--uat.sandbox.my.salesforce-scrt.com`).
- MIAW deployment: `JBL_Support_Chat_Kore_Custom`.
- Kore Create Case endpoint: `/services/apexrest/kore/create-case` (replaces
  the old `/services/apexrest/kore/case`).
