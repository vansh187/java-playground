'use strict';
// Preloaded (--require) into a learner's Express app. The first server the app starts listens on
// the port the request probe uses, on 127.0.0.1, whatever port the code asks for, so
// app.listen(3000) works as well as app.listen(process.env.PORT).
const net = require('node:net');

const port = Number(process.env.PORT);
const listen = net.Server.prototype.listen;
let claimed = false;

net.Server.prototype.listen = function webnestListen(...args) {
  // A Unix socket path or an existing handle is left alone.
  const first = args[0];
  const pathOrHandle = typeof first === 'string' && !/^\d+$/.test(first)
    || (first && typeof first === 'object' && (first.path !== undefined || first.fd !== undefined || first._handle !== undefined));
  if (claimed || !Number.isInteger(port) || port <= 0 || pathOrHandle) return listen.apply(this, args);
  claimed = true;
  const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
  return callback ? listen.call(this, { port, host: '127.0.0.1' }, callback) : listen.call(this, { port, host: '127.0.0.1' });
};
