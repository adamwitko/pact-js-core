'use strict';
var checkTypes = require('check-types'), _ = require('underscore'), logger = require('./logger'), path = require('path'), fs = require('fs'), cp = require('child_process'), eventEmitter = require('events').EventEmitter, http = require('request'), q = require('q'), util = require('util'), pactPath = require('@pact-foundation/pact-mock-service'), mkdirp = require('mkdirp'), pactUtil = require('./pact-util'), isWindows = process.platform === 'win32';
var CHECKTIME = 500;
var RETRY_AMOUNT = 60;
var PROCESS_TIMEOUT = 30000;
function Server(port, host, dir, ssl, sslcert, sslkey, cors, log, spec, consumer, provider) {
    this._options = {};
    this._options.port = port;
    this._options.host = host;
    this._options.dir = dir;
    this._options.ssl = ssl;
    this._options.sslcert = sslcert;
    this._options.sslkey = sslkey;
    this._options.cors = cors;
    this._options.log = log;
    this._options.spec = spec;
    this._options.consumer = consumer;
    this._options.provider = provider;
    this._running = false;
    this.START_EVENT = 'start';
    this.STOP_EVENT = 'stop';
    this.DELETE_EVENT = 'delete';
}
util.inherits(Server, eventEmitter);
Server.prototype.start = function () {
    if (this._instance && this._instance.connected) {
        logger.warn('You already have a process running with PID: ' + this._instance.pid);
        return;
    }
    var envVars = JSON.parse(JSON.stringify(process.env));
    delete envVars['RUBYGEMS_GEMDEPS'];
    var file, opts = {
        cwd: pactPath.cwd,
        detached: !isWindows,
        env: envVars
    }, args = pactUtil.createArguments(this._options, {
        'port': '--port',
        'host': '--host',
        'log': '--log',
        'ssl': '--ssl',
        'sslcert': '--sslcert',
        'sslkey': '--sslkey',
        'cors': '--cors',
        'dir': '--pact_dir',
        'spec': '--pact_specification_version',
        'consumer': '--consumer',
        'provider': '--provider'
    });
    var cmd = [pactPath.file].concat(args).join(' ');
    if (isWindows) {
        file = 'cmd.exe';
        args = ['/s', '/c', cmd];
        opts.windowsVerbatimArguments = true;
    }
    else {
        cmd = './' + cmd;
        file = '/bin/sh';
        args = ['-c', cmd];
    }
    logger.debug('Starting binary with `' + _.flatten([file, args, JSON.stringify(opts)]) + '`');
    this._instance = cp.spawn(file, args, opts);
    this._instance.stdout.setEncoding('utf8');
    this._instance.stdout.on('data', logger.debug.bind(logger));
    this._instance.stderr.setEncoding('utf8');
    this._instance.stderr.on('data', logger.debug.bind(logger));
    this._instance.on('error', logger.error.bind(logger));
    function catchPort(data) {
        var match = data.match(/port=([0-9]+)/);
        if (match && match[1]) {
            this._options.port = parseInt(match[1]);
            this._instance.stdout.removeListener('data', catchPort.bind(this));
            this._instance.stderr.removeListener('data', catchPort.bind(this));
        }
    }
    if (!this._options.port) {
        this._instance.stdout.on('data', catchPort.bind(this));
        this._instance.stderr.on('data', catchPort.bind(this));
    }
    logger.info('Creating Pact with PID: ' + this._instance.pid);
    this._instance.once('close', (function (code) {
        if (code !== 0) {
            logger.warn('Pact exited with code ' + code + '.');
        }
        this.stop();
    }).bind(this));
    return waitForServerUp(this._options)
        .timeout(PROCESS_TIMEOUT, "Couldn't start Pact with PID: " + this._instance.pid)
        .tap((function () {
        this._running = true;
        this.emit(this.START_EVENT, this);
    }).bind(this));
};
Server.prototype.stop = function () {
    var pid = -1;
    if (this._instance) {
        pid = this._instance.pid;
        logger.info('Removing Pact with PID: ' + pid);
        this._instance.removeAllListeners();
        if (isWindows) {
            cp.execSync('taskkill /f /t /pid ' + pid);
        }
        else {
            process.kill(-pid, 'SIGINT');
        }
        this._instance = undefined;
    }
    return waitForServerDown(this._options)
        .timeout(PROCESS_TIMEOUT, "Couldn't stop Pact with PID: " + pid)
        .tap((function () {
        this._running = false;
        this.emit(this.STOP_EVENT, this);
    }).bind(this));
};
Server.prototype.delete = function () {
    return this.stop().tap((function () {
        this.emit(this.DELETE_EVENT, this);
    }).bind(this));
};
function waitForServerUp(options) {
    var amount = 0, deferred = q.defer();
    function retry() {
        if (amount >= RETRY_AMOUNT) {
            deferred.reject(new Error("Pact startup failed; tried calling service 10 times with no result."));
        }
        setTimeout(check.bind(this), CHECKTIME);
    }
    function check() {
        amount++;
        if (options.port) {
            call(options).then(function () {
                deferred.resolve();
            }, retry);
        }
        else {
            retry();
        }
    }
    check();
    return deferred.promise;
}
function waitForServerDown(options) {
    var amount = 0, deferred = q.defer();
    function check() {
        amount++;
        if (options.port) {
            call(options).then(function () {
                if (amount >= RETRY_AMOUNT) {
                    deferred.reject(new Error("Pact stop failed; tried calling service 10 times with no result."));
                    return;
                }
                setTimeout(check, CHECKTIME);
            }, function () {
                deferred.resolve();
            });
        }
        else {
            deferred.resolve();
        }
    }
    check();
    return deferred.promise;
}
function call(options) {
    var deferred = q.defer();
    var config = {
        uri: (options.ssl ? 'https' : 'http') + '://' + options.host + ':' + options.port,
        method: 'GET',
        headers: {
            'X-Pact-Mock-Service': true,
            'Content-Type': 'application/json'
        }
    };
    if (options.ssl) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        config.agentOptions = {};
        config.agentOptions.rejectUnauthorized = false;
        config.agentOptions.requestCert = false;
        config.agentOptions.agent = false;
    }
    http(config, function (err, res) {
        if (!err && res.statusCode == 200) {
            deferred.resolve();
        }
        else {
            deferred.reject();
        }
    });
    return deferred.promise;
}
module.exports = function (options) {
    options = options || {};
    options.ssl = options.ssl || false;
    options.cors = options.cors || false;
    options.dir = options.dir ? path.resolve(options.dir) : process.cwd();
    options.host = options.host || 'localhost';
    if (options.port) {
        checkTypes.assert.number(options.port);
        checkTypes.assert.integer(options.port);
        checkTypes.assert.positive(options.port);
        checkTypes.assert.inRange(options.port, 0, 65535);
        if (checkTypes.not.inRange(options.port, 1024, 49151)) {
            logger.warn("Like a Boss, you used a port outside of the recommended range (1024 to 49151); I too like to live dangerously.");
        }
    }
    checkTypes.assert.boolean(options.ssl);
    if ((options.sslcert && !options.sslkey) || (!options.sslcert && options.sslkey)) {
        throw new Error('Custom ssl certificate and key must be specified together.');
    }
    if (options.sslcert) {
        try {
            fs.statSync(path.normalize(options.sslcert)).isFile();
        }
        catch (e) {
            throw new Error('Custom ssl certificate not found at path: ' + options.sslcert);
        }
    }
    if (options.sslkey) {
        try {
            fs.statSync(path.normalize(options.sslkey)).isFile();
        }
        catch (e) {
            throw new Error('Custom ssl key not found at path: ' + options.sslkey);
        }
    }
    if (options.sslcert && options.sslkey) {
        options.ssl = true;
    }
    checkTypes.assert.boolean(options.cors);
    if (options.spec) {
        checkTypes.assert.number(options.spec);
        checkTypes.assert.integer(options.spec);
        checkTypes.assert.positive(options.spec);
    }
    if (options.dir) {
        try {
            fs.statSync(path.normalize(options.dir)).isDirectory();
        }
        catch (e) {
            mkdirp.sync(path.normalize(options.dir));
        }
    }
    if (options.log) {
        var fileObj = path.parse(path.normalize(options.log));
        try {
            fs.statSync(fileObj.dir).isDirectory();
        }
        catch (e) {
            mkdirp.sync(fileObj.dir);
        }
    }
    if (options.host) {
        checkTypes.assert.string(options.host);
    }
    if (options.consumer) {
        checkTypes.assert.string(options.consumer);
    }
    if (options.provider) {
        checkTypes.assert.string(options.provider);
    }
    return new Server(options.port, options.host, options.dir, options.ssl, options.sslcert, options.sslkey, options.cors, options.log, options.spec, options.consumer, options.provider);
};
//# sourceMappingURL=server.js.map