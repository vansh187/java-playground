import net from 'node:net';

// Runs inside the sandbox next to the app: waits until the app listens on its port, sends the
// requests in order, and reports on stdout. Nothing here throws past main().
let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const { port, requests = [], readyTimeoutMs = 45000, requestTimeoutMs = 10000, requestsTimeoutMs = 25000,
  totalTimeoutMs = 75000, responseBodyLimitBytes = 32768 } = JSON.parse(text);
const started = performance.now();
const until = (ms) => Math.min(performance.now() + ms, started + totalTimeoutMs);
const base = `http://127.0.0.1:${port}`;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// True once something accepts a connection on the port. Only a connection: the learner's own
// routes, such as GET /, are never called before their requests.
const canConnect = () => new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = (ok) => { socket.destroy(); resolve(ok); };
  socket.setTimeout(1000, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

async function waitUntilReady() {
  const readyBy = until(readyTimeoutMs);
  while (performance.now() < readyBy) {
    if (await canConnect()) return Math.round(performance.now() - started);
    await pause(150);
  }
  return null;
}

function cutBody(buffer) {
  const truncated = buffer.length > responseBodyLimitBytes;
  // Cut on a whole UTF-8 character so the text stays valid.
  let end = Math.min(buffer.length, responseBodyLimitBytes);
  while (truncated && end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { body: buffer.subarray(0, end).toString('utf8'), truncated };
}

async function send(request, deadline) {
  const started = performance.now();
  const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, deadline - performance.now()));
  try {
    const hasBody = request.body !== null && request.body !== undefined && request.method !== 'GET';
    const response = await fetch(`${base}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const { body, truncated } = cutBody(Buffer.from(await response.arrayBuffer()));
    const headers = {};
    for (const [name, value] of response.headers) if (Object.keys(headers).length < 30) headers[name] = value;
    return { status: response.status, headers, body, truncated, ms: Math.round(performance.now() - started) };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return { status: 0, headers: {}, body: '', truncated: false, ms: Math.round(performance.now() - started),
      error: timedOut ? `No response within ${Math.round(timeoutMs / 1000)} seconds` : 'The app closed the connection without a response' };
  }
}

// One JSON line per event, so whatever arrived before the app stopped is kept.
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

async function main() {
  const readyMs = await waitUntilReady();
  if (readyMs === null) {
    emit({ type: 'not_ready' });
    return;
  }
  emit({ type: 'ready', readyMs });
  const deadline = until(requestsTimeoutMs);
  for (const request of requests) {
    if (performance.now() >= deadline) {
      emit({ type: 'done', timedOut: true });
      return;
    }
    emit({ type: 'response', ...(await send(request, deadline)) });
  }
  emit({ type: 'done', timedOut: false });
}

try {
  await main();
} catch (error) {
  emit({ type: 'error', message: String(error?.message ?? error) });
}
