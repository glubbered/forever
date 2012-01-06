var events = require('events');
    fs = require('fs'),
    path = require('path'),
    nssocket = require('nssocket'),
    utile = require('utile'),
    forever = require('../forever');

function findSocket(sockPath, startAt, callback) {
  if (typeof startAt == "function") {
    callback = startAt;
    startAt = null;
  }

  startAt || (startAt = 0);
  var sock = path.join(sockPath, 'worker.' + startAt + '.sock');
  fs.stat(sock, function (err, stat) {
    if (err) {
      return err.code == 'ENOENT' 
        ? callback(null, sock)
        : callback(err);
    }
    
    return findSocket(sockPath, ++startAt, callback);
  });
}

var Worker = exports.Worker = function (options) {
  events.EventEmitter.call(this);
  options || (options = {});

  this.monitor  = options.monitor;
  this.sockPath = options.sockPath || forever.config.get('sockPath');
  this.exitOnStop = options.exitOnStop === true;

  this._socket = null;
};

utile.inherits(Worker, events.EventEmitter);

Worker.prototype.start = function (callback) {
  var self = this,
      err;

  if (this._socket) {
    err = new Error("Can't start already started worker");
    if (callback) {
      return callback(err);
    }
    
    throw err;
  }  

  //
  // Defines a simple `nssocket` protocol for communication
  // with a parent process.
  //
  function workerProtocol(socket) {
    socket.data(['ping'], function () {
      socket.send(['pong']);
    });

    socket.data(['data'], function () {
      socket.send(['data'], self.monitor.data);
    });

    socket.data(['spawn'], function (data) {
      if (!data.script) {
        return socket.send(['spawn', 'error'], { error: new Error('No script given') });
      }

      if (self.monitor) {
        return socket.send(['spawn', 'error'], { error: new Error("Already running") });
      }

      var monitor = new (forever.Monitor)(data.script, data.options);
      monitor.start();

      monitor.on('start', function () {
        socket.send(['spawn', 'start'], monitor.data);
      });
    });

    socket.data(['stop'], function () {
      self.monitor.once('stop', function () {
        socket.send(['stop', 'ok']);
        self.exitOnStop && process.exit();
      });
      
      self.monitor.stop();
    });
    
    socket.data(['restart'], function () {
      self.monitor.once('restart', function () {
        socket.send(['restart', 'ok']);
      });
      
      self.monitor.restart();
    });
  }

  function findAndStart() {
    self._socket = nssocket.createServer(workerProtocol);
    self._socket.on('listening', function () {
      //
      // `listening` listener doesn't take error as the first parameter
      //
      self.emit('start');
      callback && callback(null, self._sockFile);
    });

    self._socket.on('error', function (err) {
      if (err.code === 'EADDRINUSE') {
        return findAndStart();
      }

      callback && callback(err);
    });
    
    findSocket(self.sockPath, function (err, sock) {
      if (err) {
        return callback && callback(err);
      }

      self._sockFile = sock;
      self._socket.listen(sock);
    });
  }
  
  //
  // Attempt to start the server the first time
  //
  findAndStart();
  return this;
};
