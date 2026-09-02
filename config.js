/**
 * config.js — single source of truth for all configuration.
 *
 * Loads config.json (non-sensitive defaults/structure) then overlays any
 * environment variables that are set.  This lets the same config.json be
 * committed safely while real secrets live in .env (local) or the Render
 * environment-variable dashboard (production).
 *
 * All other files should require('./config') — NOT './config.json' directly.
 */

require('dotenv').config();

var base = require('./config.json');

/* ------------------------------------------------------------------ */
/* Kore bot credentials                                                */
/* ------------------------------------------------------------------ */
// If KORE_BOT_ID + KORE_CLIENT_ID + KORE_CLIENT_SECRET are all set,
// inject them so the SDK can sign JWTs for the right bot.
var kBotId  = process.env.KORE_BOT_ID;
var kCid    = process.env.KORE_CLIENT_ID;
var kSecret = process.env.KORE_CLIENT_SECRET;
if (kBotId && kCid && kSecret) {
    base.credentials            = base.credentials || {};
    base.credentials[kBotId]    = { appId: kCid, apikey: kSecret };
}

/* ------------------------------------------------------------------ */
/* Salesforce                                                          */
/* ------------------------------------------------------------------ */
var sf    = base.salesforce || (base.salesforce = {});
var miaw  = sf.miaw         || (sf.miaw         = {});
var oauth = sf.oauth        || (sf.oauth        = {});
var sc    = sf.case         || (sf.case         = {});

// Reuse the SAME KORE_BOT_ID used for credentials above, so the bot's
// registered id (inbound routing) and its signing credentials (outbound
// calls) can never drift apart the way they did before.
if (kBotId)                             sf.botId               = kBotId;
if (process.env.KORE_BOT_NAME)          sf.botName             = process.env.KORE_BOT_NAME;

if (process.env.SF_SCRT_BASE_URL)       miaw.scrtBaseUrl      = process.env.SF_SCRT_BASE_URL;
if (process.env.SF_ORG_ID)              miaw.orgId             = process.env.SF_ORG_ID;
if (process.env.SF_ES_DEVELOPER_NAME)   miaw.esDeveloperName   = process.env.SF_ES_DEVELOPER_NAME;

if (process.env.SF_OAUTH_TOKEN_URL)     oauth.tokenUrl         = process.env.SF_OAUTH_TOKEN_URL;
if (process.env.SF_OAUTH_CLIENT_ID)     oauth.clientId         = process.env.SF_OAUTH_CLIENT_ID;
if (process.env.SF_OAUTH_CLIENT_SECRET) oauth.clientSecret     = process.env.SF_OAUTH_CLIENT_SECRET;

if (process.env.SF_CASE_URL)            sc.url                 = process.env.SF_CASE_URL;

module.exports = base;
