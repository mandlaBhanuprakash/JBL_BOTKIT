/**
 * SalesforceAPI.js
 *
 * Thin REST wrapper for Salesforce "Messaging for In-App and Web" (MIAW).
 * Mirrors the role of LiveChatAPI.js, but talks to Salesforce Omni-Channel
 * instead of LiveChat.com.
 *
 * Two credential sets are used (see config.json -> salesforce):
 *   1. miaw  : the MIAW "custom client" REST API. Lets BotKit act as a
 *              messaging visitor: get a token, open a conversation, send
 *              messages, and stream agent replies (SSE). This is enough to
 *              create the Messaging Session and exchange messages.
 *   2. oauth : a Connected App (client-credentials) used ONLY when you also
 *              want to write the full bot transcript into a custom field /
 *              record on the Salesforce side. Optional (oauth.enabled).
 *
 * NOTE: Endpoint paths below follow Salesforce's documented MIAW v2 API.
 * Confirm the exact paths/version against your org before going live --
 * they are marked with TODO where org-specific values are required.
 */
var axios = require("axios");
var Promise          = require('bluebird');
var crypto           = require('crypto');
var config           = require('./config');
var { makeHttpCall } = require('./makeHttpCall');

var SF      = config.salesforce || {};
var MIAW    = SF.miaw || {};
var OAUTH   = SF.oauth || {};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

// RFC4122 v4 UUID (crypto.randomUUID isn't guaranteed on Node 10).
function uuidv4() {
    var b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString('hex');
    return h.substr(0, 8) + '-' + h.substr(8, 4) + '-' + h.substr(12, 4) +
           '-' + h.substr(16, 4) + '-' + h.substr(20);
}

function miawHeaders(accessToken) {
    var headers = { 'Content-Type': 'application/json' };
    if (accessToken) {
        headers['Authorization'] = 'Bearer ' + accessToken;
    }
    return headers;
}

function ts() { try { return new Date().toISOString(); } catch (e) { return ''; } }
function apilog() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ['[SF-API ' + ts() + ']'].concat(args));
}
function apierr(label, err) {
    var status = err && err.response && err.response.status;
    var body   = err && err.response && err.response.data;
    console.error('[SF-API ' + ts() + '][ERROR] ' + label,
        '| status:', status,
        '| body:', body ? JSON.stringify(body) : (err && err.message));
}

/* ------------------------------------------------------------------ */
/* 1. MIAW messaging                                                   */
/* ------------------------------------------------------------------ */

/**
 * getAccessToken
 * Exchanges the deployment config for an unauthenticated messaging token.
 * POST {scrt}/iamessage/api/v2/authorization/unauthenticated/access-token
 *
 * @returns {Promise<{accessToken, lastEventId}>}
 */
function getAccessToken() {
    var url  = MIAW.scrtBaseUrl + '/iamessage/api/v2/authorization/unauthenticated/access-token';
    var body = {
        orgId               : MIAW.orgId,
        esDeveloperName     : MIAW.esDeveloperName,
        capabilitiesVersion : MIAW.capabilitiesVersion,
        platform            : MIAW.platform
        // TODO: if your deployment uses authenticated/customer-identity tokens,
        // switch to the .../authorization/authenticated/access-token endpoint
        // and pass the customer identity JWT here.
    };
    apilog('POST getAccessToken ->', url, '| body:', JSON.stringify(body));
    return makeHttpCall('post', url, body, miawHeaders())
        .then(function (res) {
            apilog('getAccessToken OK | status', res.status, '| accessToken?', !!(res.data && res.data.accessToken));
            return res.data;
        })
        .catch(function (err) { apierr('getAccessToken', err); return Promise.reject(err); });
}

/**
 * createConversation
 * Opens a new Messaging Session that Omni-Channel will route to an agent.
 * POST {scrt}/iamessage/api/v2/conversation
 *
 * @param {string} accessToken
 * @param {object} routingAttributes  pre-chat / routing fields (optional)
 * @returns {Promise<{conversationId}>}
 */
function createConversation(accessToken, routingAttributes) {
    var conversationId = uuidv4();
    var url  = MIAW.scrtBaseUrl + '/iamessage/api/v2/conversation';
    var body = {
        conversationId  : conversationId,
        esDeveloperName : MIAW.esDeveloperName,
        language        : SF.language || 'en_US',
        routingAttributes: routingAttributes || SF.routingAttributes || {}
    };
    apilog('POST createConversation ->', url, '| conversationId:', conversationId,
        '| routingAttributes:', JSON.stringify(body.routingAttributes));
    return makeHttpCall('post', url, body, miawHeaders(accessToken))
        .then(function (res) {
            // Confirmed via testing: this response body is always empty --
            // the actual Salesforce MessagingSession record Id is NOT
            // available here at all. It has to be read off the SSE stream's
            // conversationEntry.relatedRecords instead; see Salesforce.js
            // waitForMessagingSessionId() / CLAUDE.md gotchas.
            apilog('createConversation OK | status', res.status, '| conversationId', conversationId);
            return { conversationId: conversationId };
        })
        .catch(function (err) { apierr('createConversation', err); return Promise.reject(err); });
}

/**
 * sendMessage
 * Sends one text message into the conversation (used both to replay history
 * and to forward live end-user messages).
 * POST {scrt}/iamessage/api/v2/conversation/{conversationId}/message
 */
function sendMessage(accessToken, conversationId, text) {
    var url  = MIAW.scrtBaseUrl + '/iamessage/api/v2/conversation/' + conversationId + '/message';
    var body = {
        message: {
            id          : uuidv4(),
            messageType : 'StaticContentMessage',
            staticContent: {
                formatType: 'Text',
                text      : text
            }
        },
        esDeveloperName: MIAW.esDeveloperName
    };
    apilog('POST sendMessage ->', 'conv', conversationId, '| text:', text);
    return makeHttpCall('post', url, body, miawHeaders(accessToken))
        .then(function (res) {
            apilog('sendMessage OK | status', res.status, '| conv', conversationId);
            return res.data;
        })
        .catch(function (err) { apierr('sendMessage', err); return Promise.reject(err); });
}

var SF_FILE_MAX_BYTES = 5 * 1024 * 1024;

function sendFile(accessToken, conversationId, opts) {
    var buffer = opts.buffer;
    var fileName = opts.fileName || "attachment";
    var mimeType = opts.mimeType || "application/octet-stream";
    var caption = opts.caption || "";

    if (!buffer || !buffer.length) {
        return Promise.reject(new Error("sendFile: empty buffer"));
    }
    if (buffer.length > SF_FILE_MAX_BYTES) {
        return Promise.reject(new Error("sendFile: file exceeds 5 MB"));
    }

    var url = MIAW.scrtBaseUrl + "/iamessage/api/v2/conversation/" + conversationId + "/file";
    var messageEntry = {
        esDeveloperName: MIAW.esDeveloperName,
        message: {
            id: uuidv4(),
            fileId: uuidv4(),
            text: caption
        }
    };

    var form = new FormData();
    form.append(
        "messageEntry",
        new Blob([JSON.stringify(messageEntry)], { type: "application/json" })
    );
    form.append("fileData", new Blob([buffer], { type: mimeType }), fileName);

    apilog("POST sendFile -> conv", conversationId, "|", fileName, "| bytes:", buffer.length);

    return axios({
        method: "post",
        url: url,
        data: form,
        headers: { Authorization: "Bearer " + accessToken },
        maxBodyLength: SF_FILE_MAX_BYTES + 1024 * 1024,
        maxContentLength: SF_FILE_MAX_BYTES + 1024 * 1024
    })
        .then(function (res) {
            apilog("sendFile OK | status", res.status, "| conv", conversationId);
            return res.data;
        })
        .catch(function (err) {
            apierr("sendFile", err);
            return Promise.reject(err);
        });
}

/**
 * closeConversation
 * Ends the Messaging Session.
 * DELETE {scrt}/iamessage/api/v2/conversation/{conversationId}?esDeveloperName=...
 */
function closeConversation(accessToken, conversationId) {
    var url = MIAW.scrtBaseUrl + '/iamessage/api/v2/conversation/' + conversationId +
              '?esDeveloperName=' + encodeURIComponent(MIAW.esDeveloperName);
    return makeHttpCall('delete', url, null, miawHeaders(accessToken))
        .then(function (res) { return res.data; })
        .catch(function (err) { return Promise.reject(err); });
}

/**
 * sseUrl / sseHeaders
 * The Server-Sent Events stream that delivers agent -> user messages.
 * Consume this with an SSE client in Salesforce.js (relayMode = "sse").
 * GET {scrt}/eventrouter/v1/sse
 */
function sseUrl() {
    return MIAW.scrtBaseUrl + '/eventrouter/v1/sse';
}
function sseHeaders(accessToken, lastEventId) {
    var headers = {
        'Authorization' : 'Bearer ' + accessToken,
        'X-Org-Id'      : MIAW.orgId,
        'Accept'        : 'text/event-stream'
    };
    if (lastEventId) {
        headers['Last-Event-Id'] = lastEventId;
    }
    return headers;
}

/* ------------------------------------------------------------------ */
/* 2. OAuth (optional) - write transcript blob to a record/field      */
/* ------------------------------------------------------------------ */

/**
 * getOAuthToken
 * Client-credentials flow against a Connected App.
 * POST {tokenUrl}  (application/x-www-form-urlencoded)
 *
 * @returns {Promise<{access_token, instance_url}>}
 */
function getOAuthToken() {
    if (!OAUTH.enabled) {
        return Promise.reject(new Error('Salesforce OAuth is disabled in config'));
    }
    var body = 'grant_type=' + encodeURIComponent(OAUTH.grantType || 'client_credentials') +
               '&client_id=' + encodeURIComponent(OAUTH.clientId) +
               '&client_secret=' + encodeURIComponent(OAUTH.clientSecret);
    var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    apilog('POST getOAuthToken ->', OAUTH.tokenUrl, '| grant_type:', OAUTH.grantType || 'client_credentials');
    return makeHttpCall('post', OAUTH.tokenUrl, body, headers)
        .then(function (res) {
            apilog('getOAuthToken OK | status', res.status,
                '| access_token?', !!(res.data && res.data.access_token),
                '| instance_url:', res.data && res.data.instance_url);
            return res.data;
        })
        .catch(function (err) { apierr('getOAuthToken', err); return Promise.reject(err); });
}

/**
 * writeTranscriptField
 * PATCHes a single field on a record (e.g. the MessagingSession) with the
 * concatenated bot transcript. Requires the record Id, which you typically
 * resolve from the conversationId via a SOQL query once the session exists.
 *
 * PATCH {instance_url}/services/data/{apiVersion}/sobjects/{object}/{recordId}
 */
function writeTranscriptField(oauth, recordId, transcriptText) {
    var url = oauth.instance_url + '/services/data/' + (OAUTH.apiVersion || 'v61.0') +
              '/sobjects/' + OAUTH.transcriptObject + '/' + recordId;
    var body = {};
    body[OAUTH.transcriptField] = transcriptText;
    var headers = {
        'Authorization': 'Bearer ' + oauth.access_token,
        'Content-Type' : 'application/json'
    };
    return makeHttpCall('patch', url, body, headers)
        .then(function (res) { return res.data; })
        .catch(function (err) { return Promise.reject(err); });
}

/**
 * createCase
 * Creates the Contact + Case for an already-existing Messaging Session via the
 * "Kore Create Case" Apex REST endpoint, and optionally hands the session over
 * to the Omni-Channel routing flow (Kore Create Case RestService v1.0).
 * POST {caseUrl}  with Authorization: Bearer {salesforce-oauth-access-token}
 *
 * Body shape: { messaging_session_id, customer_details: {email, first_name,
 * last_name}, relevant_details: {order_number, product_name}, session_details:
 * {region, country_code, language, session_should_be_routed, is_deflected,
 * customer_country_unknown}, additional_params }. See Salesforce.js
 * buildCreateCaseBody() for how this is assembled.
 *
 * Response: { status, caseId, caseNumber, timestamp } on success.
 * Notable error codes (in err.response.data.errorCode): SESSION_NOT_FOUND
 * (404, session not indexed yet -- retryable), CASE_ALREADY_EXISTS (409, not
 * an error -- treat as already-done), ROUTING_ERROR / INTERNAL_ERROR (500).
 *
 * @param {string} accessToken  Salesforce OAuth access token (NOT the MIAW token)
 * @param {object} caseBody     the JSON body (messaging_session_id, ...)
 * @param {string} [caseUrl]    override; defaults to config salesforce.case.url
 */
function createCase(accessToken, caseBody, caseUrl) {
    var url = caseUrl || (SF.case && SF.case.url);
    var headers = {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type' : 'application/json'
    };
    apilog('POST createCase ->', url, '| body:', JSON.stringify(caseBody));
    return makeHttpCall('post', url, caseBody, headers)
        .then(function (res) {
            apilog('createCase OK | status', res.status, '| body:', JSON.stringify(res.data));
            return res.data;
        })
        .catch(function (err) { apierr('createCase', err); return Promise.reject(err); });
}

module.exports = {
    uuidv4              : uuidv4,
    getAccessToken      : getAccessToken,
    createConversation  : createConversation,
    sendMessage         : sendMessage,
    sendFile            : sendFile,
    closeConversation   : closeConversation,
    sseUrl              : sseUrl,
    sseHeaders          : sseHeaders,
    getOAuthToken       : getOAuthToken,
    writeTranscriptField: writeTranscriptField,
    createCase          : createCase
};
