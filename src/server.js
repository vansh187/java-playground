import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { configuration } from './config.js';
import { JavaRunner, InputError, validateSubmission } from './runner.js';
import { runProject, validateProject } from './project.js';

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
function log(entry) { console.log(JSON.stringify({ time: new Date().toISOString(), ...entry })); }

// `projectRunner` runs a Spring Boot project; tests pass a fake.
export function createServer(config, runner, projectRunner = runProject) {
  let active = false;
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ requestId, ...body }));
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { return send(400, { error: 'Invalid request URL' }); }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(runner.healthy ? 200 : 503, { status: runner.healthy ? 'ok' : 'unavailable', javaVersion: 17, executionMode: config.mode });
    }
    if (req.method === 'GET' && publicFiles.has(url.pathname)) {
      try {
        const [file, type] = publicFiles.get(url.pathname);
        const data = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
      } catch { send(500, { error: 'Unable to load editor' }); }
      return;
    }
    const project = url.pathname === '/api/project/run';
    if (url.pathname !== '/api/run' && !project) return send(404, { error: 'Not found' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(405, { error: `Use POST ${url.pathname}` });
    }
    // Disallow cross-origin browser execution, including requests targeting the local JDK.
    const origin = req.headers.origin;
    if (origin && ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(origin)) {
      return send(403, { error: 'Use the same-origin Webnest backend to call this service' });
    }
    if (config.mode === 'local' && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) {
      return send(403, { error: 'Local mode only accepts localhost requests' });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(415, { error: 'Content-Type must be application/json' });
    }
    if (!runner.healthy) return send(503, { error: 'Execution is temporarily unavailable' });
    if (active) {
      res.setHeader('Retry-After', '1');
      return send(429, { error: 'Runner is busy. Try again shortly.' });
    }
    active = true;
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    const started = performance.now();
    const bodyTimer = setTimeout(() => req.destroy(), 10000);
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        const limit = project ? config.projectBodyLimitBytes : config.bodyLimitBytes;
        if (size > limit) {
          send(413, { error: `Request exceeds ${limit / 1024} KiB` });
          return;
        }
        chunks.push(chunk);
      }
      clearTimeout(bodyTimer);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new InputError('Request body is not valid JSON'); }
      const result = project
        ? await projectRunner(runner, validateProject(body, config), controller.signal)
        : await runner.run(validateSubmission(body, config), controller.signal);
      send(200, { ...result, javaVersion: 17, durationMs: Math.round(performance.now() - started) });
      // Never put source, stdin, stdout, or student exception text in shared server logs.
      log({ severity: result.status === 'success' ? 'INFO' : 'WARNING', event: 'execution',
        requestId, status: result.status, phase: result.phase, durationMs: Math.round(performance.now() - started),
        compileExitCode: result.compile.exitCode, runExitCode: result.run?.exitCode ?? result.app?.exitCode ?? null,
        ...(project ? { kind: 'project', requests: result.responses?.length ?? 0 } : {}) });
    } catch (error) {
      if (error instanceof InputError) send(400, { error: error.message });
      else {
        log({ severity: 'ERROR', event: 'runner_error', requestId, message: error.message, stack: error.stack });
        send(500, { error: 'Execution service failed. Use the request ID to locate server logs.' });
      }
    } finally {
      clearTimeout(bodyTimer);
      res.off('close', abort);
      active = false;
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = configuration();
    const runner = new JavaRunner(config);
    await runner.check();
    const server = createServer(config, runner);
    server.listen(config.port, config.host, () => log({ severity: 'INFO', event: 'listening',
      mode: config.mode, address: `http://${config.host}:${server.address().port}` }));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  } catch (error) {
    log({ severity: 'ERROR', event: 'startup_failed', message: error.message });
    process.exitCode = 1;
  }
}
