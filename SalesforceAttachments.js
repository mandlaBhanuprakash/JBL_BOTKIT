/**
 * SalesforceAttachments.js
 *
 * Kore file payload → download bytes → Salesforce MIAW sendFile.
 * Salesforce.js decides WHEN. SalesforceAPI.js does the SF HTTP.
 */

var axios = require("axios");
var Promise = require("bluebird");
var jwt = require("jwt-simple");
var _ = require("lodash");
var config = require("./config");
var api = require("./SalesforceAPI.js");

var SF = config.salesforce || {};
var botId = SF.botId;
var FILE_MAX_BYTES = 5 * 1024 * 1024;

function ts() {
    try {
        return new Date().toISOString();
    } catch (e) {
        return "";
    }
}
function log() {
    console.log.apply(console, ["[SF-ATT " + ts() + "]"].concat([].slice.call(arguments)));
}
function logErr() {
    console.error.apply(console, ["[SF-ATT " + ts() + "][ERROR]"].concat([].slice.call(arguments)));
}

function fromPayload(data) {
    var list =
        _.get(data, "channel.attachments") ||
        _.get(data, "_originalPayload.channel.attachments") ||
        [];
    return _.isArray(list) ? list : [];
}

function fromHistoryMessage(m) {
    var list =
        _.get(m, "components[0].data.attachments") ||
        _.get(m, "attachments") ||
        _.get(m, "channels[0].attachments") ||
        [];

    if ((!list || !list.length) && attachmentUrl(_.get(m, "components[0].data"))) {
        list = [_.get(m, "components[0].data")];
    }

    return _.isArray(list) ? list : [];
}

function attachmentUrl(att) {
    return att && (att.fileUrl || _.get(att, "url.fileUrl"));
}

function mimeFromFileName(name) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    var map = {
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        bmp: "image/bmp",
        tif: "image/tiff",
        tiff: "image/tiff",
        txt: "text/plain",
        csv: "text/csv",
        xml: "application/xml",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
    return map[ext] || "application/octet-stream";
}

function koreJwt() {
    var creds = config.credentials[botId] || config.credentials;
    var jwtCfg = (config.jwt && (config.jwt[botId] || config.jwt)) || {};
    var expiry = jwtCfg.jwtExpiry || jwtCfg["jwt-expiry"] || 60;
    return jwt.encode(
        { appId: creds.appId, exp: Date.now() / 1000 + expiry },
        creds.apikey,
        jwtCfg.jwtAlgorithm || "HS256"
    );
}

function downloadKoreFile(fileUrl) {
    if (!fileUrl) {
        return Promise.reject(new Error("downloadKoreFile: missing url"));
    }
    log("GET Kore media ->", fileUrl);
    return axios({
        method: "get",
        url: fileUrl,
        headers: { auth: koreJwt() },
        responseType: "arraybuffer",
        timeout: 30000,
        maxContentLength: FILE_MAX_BYTES,
    }).then(function (res) {
        var buf = Buffer.from(res.data);
        log("Kore media OK | bytes:", buf.length);
        return buf;
    });
}

function forwardToSalesforce(accessToken, conversationId, att, caption) {
    var fileName = (att && att.fileName) || "attachment";
    var fileUrl = attachmentUrl(att);

    if (!fileUrl) {
        logErr("no fileUrl on attachment:", JSON.stringify(att));
        return api.sendMessage(
            accessToken,
            conversationId,
            "Customer sent a file: " + fileName + " (no download URL)"
        );
    }

    return downloadKoreFile(fileUrl)
        .then(function (buffer) {
            return api.sendFile(accessToken, conversationId, {
                buffer: buffer,
                fileName: fileName,
                mimeType: mimeFromFileName(fileName),
                caption: caption || fileName,
            });
        })
        .then(function () {
            log("uploaded to Salesforce ->", fileName);
        })
        .catch(function (e) {
            logErr("upload failed:", fileName, (e && e.message) || e);
        });
}

function fromSalesforcePayload(ep) {
    var sc =
        _.get(ep, "abstractMessage.staticContent") ||
        _.get(ep, "staticContent") ||
        {};
    var list = sc.attachments || [];
    if ((!list || !list.length) && _.get(sc, "image.assetUrl")) {
        list = [{
            name: "image",
            mimeType: _.get(sc, "image.mimeType") || "image/png",
            url: sc.image.assetUrl
        }];
    }
    return _.isArray(list) ? list : [];
}

function isImage(att) {
    var mime = String((att && att.mimeType) || "").toLowerCase();
    var name = String((att && att.name) || "").toLowerCase();
    return mime.indexOf("image/") === 0 || /\.(png|jpe?g|gif|bmp|tiff?)$/.test(name);
}


function isTooLarge(e) {
    return (
        (e && e.code === "FILE_TOO_LARGE") ||
        (e && e.code === "ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED") ||
        /exceeds 5 MB|maxcontentlength/i.test(String((e && e.message) || e))
    );
}

function assertWithinFiveMb(fileUrl) {
    return axios({
        method: "head",
        url: fileUrl,
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: function (s) { return s >= 200 && s < 400; }
    }).then(function (res) {
        var n = parseInt(res.headers["content-length"], 10);
        if (!isNaN(n) && n > FILE_MAX_BYTES) {
            var err = new Error("file exceeds 5 MB");
            err.code = "FILE_TOO_LARGE";
            return Promise.reject(err);
        }
    }).catch(function (e) {
        if (isTooLarge(e)) return Promise.reject(e);
        return axios({
            method: "get",
            url: fileUrl,
            responseType: "arraybuffer",
            timeout: 30000,
            maxContentLength: FILE_MAX_BYTES
        });
    });
}

function sendAgentText(sdk, data, agentName, text) {
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
                extra_fields: { agentName: agentName || "Agent" }
            }
        })
    };
    return new Promise(function (resolve) {
        sdk.sendUserMessage(data, function (err) {
            if (err) logErr("sendAgentText failed:", err);
            resolve();
        });
    });
}

function decodeUrl(u) {
    return String(u || "").replace(/&amp;/g, "&");
  }
  
  function isAudio(att) {
    var mime = String((att && att.mimeType) || "").toLowerCase();
    var name = String((att && att.name) || "").toLowerCase();
    return mime.indexOf("audio/") === 0 || /\.(m4a|amr|wav|aac|mp3)$/.test(name);
  }
  
  function isVideo(att) {
    var mime = String((att && att.mimeType) || "").toLowerCase();
    var name = String((att && att.name) || "").toLowerCase();
    return mime.indexOf("video/") === 0 || /\.(mp4|mov|3gp|flv)$/.test(name);
  }
  
  function forwardToKore(sdk, data, att, agentName) {
    var fileName = (att && att.name) || "attachment";
    var fileUrl = decodeUrl(att && att.url);
    var mimeType = (att && att.mimeType) || "application/octet-stream";
  
    if (!fileUrl) return Promise.resolve();
  
    return assertWithinFiveMb(fileUrl)

      .then(function () {
        var body;
        var extra = {
            agentName: agentName || "Agent",
            fileName: fileName,
            fileUrl: fileUrl,
            mimeType: mimeType
          };
  
        if (isImage(att)) {
          body = { type: "image", payload: { url: fileUrl ,extra_fields: extra } };
        } else if (isAudio(att)) {
          body = { type: "message", payload: { text: "", audioUrl: fileUrl ,extra_fields: extra } };
        } else if (isVideo(att)) {
          body = { type: "message", payload: { text: "", videoUrl: fileUrl ,extra_fields: extra } };
        } else {
          // PDF/docs: Kore has no file card. Markdown link is the documented format.
          // Do NOT wrap this in agent_info — that skips Kore markdown.
          body = { text: "[" + fileName + "](" + fileUrl + ")" , extra_fields: extra };
        }
  
        data.message = "[" + fileName + "](" + fileUrl + ")";
        _.set(data, "_originalPayload.message", data.message);
        data.overrideMessagePayload = {
          isTemplate: true,
          body: JSON.stringify(body)
        };
  
        return new Promise(function (resolve) {
          sdk.sendUserMessage(data, function (err) {
            if (err) logErr("forwardToKore failed:", fileName, err);
            else log("forwardToKore OK ->", fileName);
            resolve();
          });
        });
      })
      .catch(function (e) {
        var msg = isTooLarge(e)
          ? "The agent sent \"" + fileName + "\", but it is larger than 5 MB and cannot be delivered."
          : "The agent sent a file (" + fileName + ") that could not be delivered.";
        return sendAgentText(sdk, data, agentName, msg);
      });
  }




module.exports = {
    fromPayload: fromPayload,
    fromHistoryMessage: fromHistoryMessage,
    forwardToSalesforce: forwardToSalesforce,
    fromSalesforcePayload: fromSalesforcePayload,
    forwardToKore: forwardToKore
};