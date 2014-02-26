var app,

    device,

    // cache object for larger MIDI transmissions
    messageCache = false,

    // runtime counter for config.remoteMeterInterval
    meterFilterCount = 0;



var init = function() {

    switch(process.argv[2]) {

        // MIDI over serial port, e.g. on the Raspberry Pi
        case 'serialport':
            console.log('[mixer] Using MIDI serial port adapter');
            device = require('../modules/mixer_serialport');
            break;

        // test dummy
        case 'dummy':
            console.log('[mixer] Using MIDI test dummy');
            device = require('../modules/mixer_dummy');
            break;

        // standard MIDI interface
        default:
            console.log('[mixer] Using standard MIDI controller');
            device = require('../modules/mixer_midi');

    }

    device.setListener(deviceMessageHandler);

    app.controllers.socket.addListener(clientMessageHandler);


    // periodical remote meter request
    setInterval(sendRemoteMeterRequest, 10000);
    sendRemoteMeterRequest();

};



/**
 * device-specific configuration
 */
var config = {

    channelCount: 32,
    auxCount: 8,
    auxSendCount: 2,
    busCount: 8,

    // sysEx message beginnings, general and device-specific
    sysExStart: [240,67,48,62],
    sysExStartSpecific: [240,67,16,62],

    // sysEx parameter change and parameter request
    parameterChange: function(arr, deviceSpecific) {
        return [240,67,16,62,(deviceSpecific ? 13 : 127),1].concat(arr, [247]);
    },

    parameterRequest: function(arr, deviceSpecific) {
        return [240,67,48,62,(deviceSpecific ? 13 : 127),1].concat(arr, [247]);
    },

    // sysEx message types (7th byte)
    sysExElements: {
        channelFader: 28,
        sumFader: 79,
        auxSendFader: 35,
        auxFader: 57,
        busFader: 43,

        channelOn: 26,
        sumOn: 77,
        auxOn: 54,
        busOn: 41
    },

    // aux send: 8th byte is used for aux determination
    auxSendParam: function(aux) {
        return 3*aux - 1;
    },

    // 10bit fader values are transmitted in 4 bytes
    // 00000000 00000000 00000nnn 0nnnnnnn
    fader2Data: function(value) {
        return [0, 0, value>>7, value&0x7F];
    },

    data2Fader: function(data) {
        return (data[2]<<7) + data[3];
    },

    // channel on values: last byte 1/0
    on2Data: function(on) {
        return [0, 0, 0, on ? 1 : 0];
    },

    data2On: function(data) {
        return !!data[3];
    },

    // request meter levels
    // sent every 50msec
    // request has to be sent every 10sec
    remoteMeterRequest: [
        0xF0,
        0x43,
        0x30,
        0x3E,
        0x0D,
        0x21,		// Remote Meter
        0x00,		// Address UL - up to 0x22 / 34
        0x00,		// Address LU - up to 5
        0x00,		// Address LL - up to 0x27 / 39
        0,			// Count H
        32,			// Count L
        0xF7
    ],

    // interval for remote meter level transmission to the client
    // value*50msec
    remoteMeterInterval: 4
};


/**
 * dispatch MIDI messages and execute server callback
 */
var deviceMessageHandler = function(message) {
    var outMessage = false,
        i,

        messageBeginsWith = function(search) {
            var length = search.length,
                i;

            if(message.length < search.length) {
                return false;
            }

            for(i = 0; i < length; i++) {
                if(message[i] !== search[i]) {
                    return false;
                }
            }

            return true;
        };

    // concatenate messages that are longer than the 1024 byte limit
    if(message[0] == 240 && message.length == 1024) {
        messageCache = message;
        return;
    }
    else if(messageCache && message[message.length-1] == 247) {
        message = messageCache.concat(message);
        messageCache = false;
    }
    else if(messageCache && message.length == 1024) {
        messageCache.concat(message);
        return;
    }
    else {
        messageCache = false;
    }

    // analyze message

    // sysEx message
    if(messageBeginsWith(config.sysExStartSpecific) || messageBeginsWith(config.sysExStart)) {

        // program change -> sync again
        if(message[5] == 16) {
            sendSyncRequest();
            return;
        }
        // remote meter - levels
        else if(message[5] == 33) {

            // echo messages from meter requests are accidentally
            // recognized as meter messages
            if(message.length < 71) {
                return;
            }

            // do not forward every meter level message
            meterFilterCount++;

            if(meterFilterCount === config.remoteMeterInterval) {
                meterFilterCount = 0;
            }

            if(meterFilterCount !== 0) {
                return;
            }

            outMessage = {
                type: "level",
                levels : {}
            };

            for(i = 0; i <= 31; i++) {
                outMessage.levels[i+1] = message[(9 + 2*i)];
            }
        }
        // fader or on-button messages
        else {

            switch(message[6]) {

                case config.sysExElements.channelFader:
                    outMessage = {
                        type: "fader",
                        target: "channel",
                        num: message[8]+1,
                        value: config.data2Fader(message.slice(9))
                    };
                    break;

                case config.sysExElements.sumFader:
                    outMessage = {
                        type: "fader",
                        target: "sum",
                        num: 0,
                        value: config.data2Fader(message.slice(9))
                    };
                    break;

                case config.sysExElements.auxSendFader:
                    outMessage = {
                        type: "fader",
                        target: "auxsend",
                        num: message[8]+1,
                        num2: (message[7]+1)/3,
                        value: config.data2Fader(message.slice(9))
                    };
                    break;

                case config.sysExElements.auxFader:
                    outMessage = {
                        type: "fader",
                        target: "aux",
                        num: message[8]+1,
                        value: config.data2Fader(message.slice(9))
                    };
                    break;

                case config.sysExElements.busFader:
                    outMessage = {
                        type: "fader",
                        target: "bus",
                        num: message[8]+1,
                        value: config.data2Fader(message.slice(9))
                    };
                    break;

                case config.sysExElements.channelOn:
                    outMessage = {
                        type: "on",
                        target: "channel",
                        num: message[8]+1,
                        value: config.data2On(message.slice(9))
                    };
                    break;

                case config.sysExElements.sumOn:
                    outMessage = {
                        type: "on",
                        target: "sum",
                        num: 0,
                        value: config.data2On(message.slice(9))
                    };
                    break;

                case config.sysExElements.auxOn:
                    outMessage = {
                        type: "on",
                        target: "aux",
                        num: message[8]+1,
                        value: config.data2On(message.slice(9))
                    };
                    break;

                case config.sysExElements.busOn:
                    outMessage = {
                        type: "on",
                        target: "bus",
                        num: message[8]+1,
                        value: config.data2On(message.slice(9))
                    };
                    break;

            }
        }
    }


    if(outMessage) {
        app.controllers.socket.broadcast(outMessage);
    }
    // log unknown messages
    else {
        console.log('[mixer] Unknown MIDI message: [' + message + ']');
    }
};

/**
 * dispatch client messages and send the corresponding midi commands
 * @param {object} message
 * 		{
 *			type: fader / on,
 *			target: channel / aux / bus / sum
 *			num: {int}
 *			num2: {int} aux number for target auxsend
 *	 		value: {int} / {bool}
 *		}
 */
var clientMessageHandler = function(message) {

    switch(message.type) {

        // control faders
        case "fader":

            switch(message.target) {
                case "channel":
                    setChannelFader(message.num, message.value);
                    break;

                case "auxsend":
                    setAuxSendFader(message.num2, message.num, message.value);
                    break;

                case "aux":
                    setAuxFader(message.num, message.value);
                    break;

                case "bus":
                    setBusFader(message.num, message.value);
                    break;

                case "sum":
                    setSumFader(message.value);
                    break;
            }

            break;

        // control On-buttons
        case "on":

            switch(message.target) {
                case "channel":
                case "auxsend":
                    setChannelOn(message.num, message.value);
                    break;

                case "aux":
                    setAuxOn(message.num, message.value);
                    break;

                case "bus":
                    setBusOn(message.num, message.value);
                    break;

                case "sum":
                    setSumOn(message.value);
                    break;
            }

            break;

        case "sync":
            sendSyncRequest();
            break;
    }
};


/*
 * message send functions
 */

var setChannelFader = function(channel, value) {
    if(channel < 1 || channel > config.channelCount) {
        console.log('[mixer] Invalid channel number ' + channel + ' (fader)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.channelFader,0,channel-1].concat(config.fader2Data(value))
        )
    );
};

var setChannelOn = function(channel, on) {
    if(channel < 1 || channel > config.channelCount) {
        console.log('[mixer] Invalid channel number ' + channel + ' (on)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.channelOn,0,channel-1].concat(config.on2Data(on))
        )
    );
};

var setSumFader = function(value) {
    device.send(
        config.parameterChange(
            [config.sysExElements.sumFader,0,0].concat(config.fader2Data(value))
        )
    );
};

var setSumOn = function(on) {
    device.send(
        config.parameterChange(
            [config.sysExElements.sumOn,0,0].concat(config.on2Data(on))
        )
    );
};

var setAuxSendFader = function(aux, channel, value) {
    if(aux < 1 || aux > config.auxSendCount) {
        console.log('[mixer] Invalid aux send number ' + aux);
        return;
    }

    if(channel < 1 || channel > config.channelCount) {
        console.log('[mixer] Invalid aux send channel number ' + channel);
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.auxSendFader,config.auxSendParam(aux),channel-1].concat(config.fader2Data(value))
        )
    );
};

var setAuxFader = function(aux, value) {
    if(aux < 1 || aux > config.auxCount) {
        console.log('[mixer] Invalid aux number ' + aux + ' (fader)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.auxFader,0,aux-1].concat(config.fader2Data(value))
        )
    );
};

var setAuxOn = function(aux, on) {
    if(aux < 1 || aux > config.auxCount) {
        console.log('[mixer] Invalid aux number ' + aux + ' (on)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.auxOn,0,aux-1].concat(config.on2Data(on))
        )
    );
};

var setBusFader = function(bus, value) {
    if(bus < 1 || bus > config.busCount) {
        console.log('[mixer] Invalid bus number ' + bus + ' (fader)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.busFader,0,bus-1].concat(config.fader2Data(value))
        )
    );
};

var setBusOn = function(bus, on) {
    if(bus < 1 || bus > config.busCount) {
        console.log('[mixer] Invalid bus number ' + bus + ' (on)');
        return;
    }

    device.send(
        config.parameterChange(
            [config.sysExElements.busOn,0,bus-1].concat(config.on2Data(on))
        )
    );
};

/*
 * Parameter requests
 */

var sendRemoteMeterRequest = function() {
    device.send(config.remoteMeterRequest);
};

var sendSyncRequest = function() {
    var i, j, limit, auxSendParam;

    for(i in config.sysExElements) {
        if(config.sysExElements.hasOwnProperty(i)) {

            // aux sends are handled later
            if(i.indexOf('auxSend') === 0) {
                continue;
            }

            if(i.indexOf('channel') === 0) {
                limit = config.channelCount;
            }
            else if(i.indexOf('aux') === 0) {
                limit = config.auxCount;
            }
            else if(i.indexOf('bus') === 0) {
                limit = config.busCount;
            }
            else {
                limit = 1;
            }

            for(j = 0; j < limit; j++) {
                device.send(
                    config.parameterRequest(
                        [config.sysExElements[i],0,j]
                    )
                );
            }

        }
    }

    // aux send: requests for all channels for all aux
    for(i = 1; i <= config.auxSendCount; i++) {
        auxSendParam = config.auxSendParam(i);

        for(j = 0; j < config.channelCount; j++) {
            device.send(
                config.parameterRequest(
                    [config.sysExElements.auxSendFader,auxSendParam,j]
                )
            );
        }
    }

};



module.exports = function(globalApp) {

    app = globalApp;
    app.events.on('ready', init);

};