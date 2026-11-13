'use strict';
// Preloaded (--require) into Node.js scripts. A playground run gets all its input at once on
// stdin, not typed line by line. readline then reads every line before the program asks its
// second question, and with nobody listening those lines are dropped: the common
//   const a = await rl.question('a? '); const b = await rl.question('b? ');
// would wait for ever. Lines that arrive while nothing listens for them are kept, and the next
// question() gets the oldest one, as it would have in a terminal. Programs that listen with
// rl.on('line') or for await (const line of rl) are not affected.
const readline = require('node:readline');
const readlinePromises = require('node:readline/promises');

const waiting = new WeakMap();
const keptLines = (rl) => waiting.get(rl);
const takeLine = (rl) => {
  const lines = keptLines(rl);
  return lines && lines.length ? lines.shift() : undefined;
};
const showQuestion = (rl, query) => {
  if (query && rl.output && typeof rl.output.write === 'function') rl.output.write(String(query));
};

try {
  // The class both readline interfaces share: lines are emitted there.
  const shared = Object.getPrototypeOf(readlinePromises.Interface.prototype);
  const emit = shared.emit;
  shared.emit = function keepUnheardLines(event, ...args) {
    if (event === 'line' && this.listenerCount('line') === 0) {
      if (!waiting.has(this)) waiting.set(this, []);
      waiting.get(this).push(args[0]);
      return true;
    }
    return emit.call(this, event, ...args);
  };

  const ask = readline.Interface.prototype.question;
  readline.Interface.prototype.question = function question(query, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const line = typeof done === 'function' ? takeLine(this) : undefined;
    if (line === undefined) return ask.apply(this, arguments);
    showQuestion(this, query);
    process.nextTick(done, line);
    return undefined;
  };

  const askAsync = readlinePromises.Interface.prototype.question;
  readlinePromises.Interface.prototype.question = function question(query, options) {
    const line = takeLine(this);
    if (line === undefined) return askAsync.apply(this, arguments);
    showQuestion(this, query);
    return Promise.resolve(line);
  };
} catch {
  // A Node version with a different readline: programs run without this help.
}
