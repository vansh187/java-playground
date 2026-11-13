'use strict';
// The real prompt-sync opens /dev/tty, which a playground run does not have: its input arrives on
// stdin. This keeps the same API (prompt(question, defaultValue), prompt.hide, prompt.history)
// and reads one line at a time from stdin, synchronously.
const fs = require('node:fs');

let buffered = '';
let ended = false;
const pause = new Int32Array(new SharedArrayBuffer(4));

function readLine() {
  const chunk = Buffer.alloc(4096);
  while (!buffered.includes('\n') && !ended) {
    let read = 0;
    try {
      read = fs.readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      if (error.code === 'EAGAIN') { Atomics.wait(pause, 0, 0, 20); continue; }
      if (error.code === 'EOF') read = 0;
      else throw error;
    }
    if (read === 0) ended = true;
    else buffered += chunk.subarray(0, read).toString('utf8');
  }
  if (!buffered) return null;
  const end = buffered.indexOf('\n');
  const line = end === -1 ? buffered : buffered.slice(0, end);
  buffered = end === -1 ? '' : buffered.slice(end + 1);
  return line.replace(/\r$/, '');
}

module.exports = function createPrompt(config = {}) {
  function prompt(ask, value, options) {
    let fallback = value;
    if (value && typeof value === 'object') { options = value; fallback = options.value; }
    if (ask) process.stdout.write(String(ask));
    const line = readLine();
    // Like prompt-sync with nothing left to read: null, or the default when one is given.
    if (line === null) return fallback ?? (config.sigint ? process.exit(130) : null);
    const answer = line === '' && fallback !== undefined ? String(fallback) : line;
    if (config.history && typeof config.history.push === 'function') config.history.push(answer);
    return answer;
  }
  prompt.hide = (ask) => prompt(ask, { echo: '' });
  prompt.history = config.history;
  return prompt;
};
