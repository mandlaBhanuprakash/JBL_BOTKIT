var sdk            = require("../sdk");
var serviceHandler = require("./serviceHandler").serviceHandler;
var apiPrefix      = require("../../config").app.apiPrefix;
var livechat       = require("../../LiveChat.js");

function loadroutes(app) {
    app.post(apiPrefix + '/sdk/bots/:botId/components/:componentId/:eventName', function(req, res) {
        var reqBody     = req.body;
        var botId       = req.params.botId;
        var componentId = req.params.componentId;
        var eventName   = req.params.eventName;

        // TEMP diagnostic (access logging is disabled in config.app, so this
        // is otherwise invisible): identify unmapped eventNames causing
        // "NotFound: Event not found". Safe to remove once diagnosed.
        console.log('[ROUTE]', req.method, req.originalUrl, '| botId:', botId, '| componentId:', componentId, '| eventName:', eventName);

        serviceHandler(req, res, sdk.runComponentHandler(botId, componentId, eventName, reqBody));
    });
    app.post(apiPrefix + '/sdk/bots/:botId/:eventName', function(req, res) {
        var reqBody     = req.body;
        var botId       = req.params.botId;
        var eventName   = req.params.eventName;

        // TEMP diagnostic -- see comment above.
        console.log('[ROUTE]', req.method, req.originalUrl, '| botId:', botId, '| eventName:', eventName);

        serviceHandler(req, res, sdk.runComponentHandler(botId, 'default', eventName, reqBody));
    });

    app.get( apiPrefix + '/gethistory', livechat.gethistory);
}

module.exports = {
    load : loadroutes
};
