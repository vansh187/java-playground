// Corner cases learners hit in practice, run against the real runner (local mode): crashes,
// hangs, async work, odd input, odd app shapes, and attempts to get out of the project. Each
// run must end with a clear status and never take the service down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configuration } from '../src/config.js';
import { JavaRunner } from '../src/runner.js';
import { runNodeProject, runNodeScript, validateNodeProject, validateNodeScript } from '../src/node.js';

const NODE_LIBS = process.env.NODE_LIBS || fileURLToPath(new URL('../node-libs/', import.meta.url));
const config = configuration({ ...process.env, EXECUTION_MODE: 'local', PORT: '0', NODE_LIBS });
const runner = new JavaRunner(config);
const skip = await access(`${NODE_LIBS}/node_modules/express/package.json`).then(() => false, () => 'Node packages not installed; run npm run node-libs');

const script = (code, { stdin = '', files = [], entry } = {}) => runNodeScript(runner,
  validateNodeScript({ files: [{ path: entry ?? 'main.js', content: code }, ...files], stdin, ...(entry ? { entry } : {}) }, config));
const app = (code, requests, { files = [], entry } = {}) => runNodeProject(runner,
  validateNodeProject({ files: [{ path: entry ?? 'server.js', content: code }, ...files], requests, ...(entry ? { entry } : {}) }, config));
const get = (path) => ({ method: 'GET', path });
const post = (path, body, type = 'application/json') => ({ method: 'POST', path, headers: { 'Content-Type': type }, body });
const EXPRESS = "const express = require('express');\nconst app = express();\napp.use(express.json());\n";

// ---- Scripts: how programs end ---------------------------------------------------------------

test('scripts: exit codes, async errors and leftover timers', { skip }, async () => {
  const exit = await script("console.log('bye'); process.exit(3);");
  assert.equal(exit.status, 'runtime_error');
  assert.equal(exit.run.exitCode, 3);
  assert.equal(exit.run.stdout, 'bye\n');
  assert.equal((await script('process.exit(0)')).status, 'success');
  const rejected = await script("Promise.reject(new Error('nobody caught me'));");
  assert.equal(rejected.status, 'runtime_error');
  assert.match(rejected.run.stderr, /nobody caught me/);
  const later = await script("setTimeout(() => { throw new Error('later') }, 50); console.log('first');");
  assert.equal(later.status, 'runtime_error');
  assert.match(later.run.stderr, /later/);
  // A timer that keeps the program alive runs into the time limit, with what it printed kept.
  const forever = await script("setInterval(() => {}, 1000); console.log('started');");
  assert.equal(forever.status, 'timeout');
  assert.equal(forever.run.stdout, 'started\n');
  const topLevelAwait = await script("const wait = (ms) => new Promise((r) => setTimeout(r, ms));\nawait wait(20);\nconsole.log('done');", { entry: 'main.mjs' });
  assert.equal(topLevelAwait.status, 'success', topLevelAwait.run.stderr);
  assert.equal(topLevelAwait.run.stdout, 'done\n');
});

test('scripts: recursion, big output, unicode and empty programs', { skip }, async () => {
  const deep = await script('function f(n) { return f(n + 1); } f(0);');
  assert.equal(deep.status, 'runtime_error');
  assert.match(deep.run.stderr, /Maximum call stack size exceeded/);
  const unicode = await script("console.log('नमस्ते 👋 café');");
  assert.equal(unicode.run.stdout, 'नमस्ते 👋 café\n');
  const longLine = await script("process.stdout.write('x'.repeat(60000));");
  assert.equal(longLine.status, 'success');
  assert.equal(longLine.run.stdout.length, 60000);
  const empty = await script('');
  assert.equal(empty.status, 'success');
  assert.equal(empty.run.stdout, '');
  const comment = await script('// nothing yet');
  assert.equal(comment.status, 'success');
  const errorOut = await script("console.error('warning only');");
  assert.equal(errorOut.status, 'success');
  assert.equal(errorOut.run.stderr, 'warning only\n');
});

test('scripts: input that runs out, Windows line ends, and readline', { skip }, async () => {
  const short = await script("const prompt = require('prompt-sync')();\nconsole.log(prompt('a? '), prompt('b? '), prompt('c? ', 'default'));", { stdin: 'one\r\n' });
  assert.equal(short.status, 'success', short.run.stderr);
  assert.equal(short.run.stdout, 'a? b? c? one null default\n');
  const noInput = await script("const prompt = require('prompt-sync')();\nconst n = Number(prompt('n? '));\nconsole.log(Number.isNaN(n) ? 'no number' : n * 2);");
  // Like the real prompt-sync: no input left gives null, and Number(null) is 0.
  assert.equal(noInput.run.stdout, 'n? 0\n');
  const lines = await script("const rl = require('node:readline').createInterface({ input: process.stdin });\nconst all = [];\nrl.on('line', (l) => all.push(l));\nrl.on('close', () => console.log(all.join('|')));", { stdin: 'a\nb\r\nc' });
  assert.equal(lines.run.stdout, 'a|b|c\n');
  const question = await script("const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });\nrl.question('Name? ', (n) => { console.log(`Hi ${n}`); rl.close(); });", { stdin: 'Ravi\n' });
  assert.match(question.run.stdout, /Hi Ravi/);
  const promises = await script("import { createInterface } from 'node:readline/promises';\nconst rl = createInterface({ input: process.stdin });\nconst a = await rl.question('');\nconst b = await rl.question('');\nrl.close();\nconsole.log(Number(a) + Number(b));", { entry: 'main.mjs', stdin: '2\n3\n' });
  assert.equal(promises.run.stdout.trim(), '5', promises.run.stderr);
  const raw = await script("let text = '';\nprocess.stdin.on('data', (c) => { text += c; });\nprocess.stdin.on('end', () => console.log(text.trim().split(/\\s+/).map(Number).reduce((a, b) => a + b, 0)));", { stdin: '1 2 3\n4' });
  assert.equal(raw.run.stdout, '10\n');
});

test('scripts: module systems and package.json', { skip }, async () => {
  const esmFlag = await script("import _ from 'lodash';\nconsole.log(_.sum([1, 2]));", { files: [{ path: 'package.json', content: '{"type":"module"}' }] });
  assert.equal(esmFlag.status, 'success', esmFlag.run.stderr);
  assert.equal(esmFlag.run.stdout, '3\n');
  const mixed = await script("const { twice } = require('./lib/math.cjs');\nconsole.log(twice(4));", { files: [{ path: 'lib/math.cjs', content: 'exports.twice = (n) => n * 2;' }] });
  assert.equal(mixed.run.stdout, '8\n');
  const json = await script("console.log(require('./data/users.json').length);", { files: [{ path: 'data/users.json', content: '[1,2,3]' }] });
  assert.equal(json.run.stdout, '3\n');
  const badJson = await script("console.log('runs')", { files: [{ path: 'package.json', content: '{ not json' }] });
  assert.equal(badJson.status, 'runtime_error');
  assert.match(badJson.run.stderr, /package\.json|JSON/);
  // Node's own modules in dependencies are not "missing"; odd names are just names.
  const builtins = await script("console.log('ok')", { files: [{ path: 'package.json', content: '{"dependencies":{"fs":"*","node:path":"*","lodash":"*"}}' }] });
  assert.equal(builtins.status, 'success', JSON.stringify(builtins.missing));
  const odd = await script("console.log('ok')", { files: [{ path: 'package.json', content: '{"dependencies":{"constructor":"1","__proto__":"1","toString":"1"}}' }] });
  assert.equal(odd.status, 'package_error');
  assert.deepEqual(odd.missing.sort(), ['constructor', 'toString'].sort().concat(odd.missing.includes('__proto__') ? ['__proto__'] : []).sort());
  const weirdShapes = await script("console.log('ok')", { files: [{ path: 'package.json', content: '{"dependencies":["express"],"devDependencies":null}' }] });
  assert.equal(weirdShapes.status, 'success');
  const scoped = await script("require('@faker-js/faker'); console.log('ok')");
  assert.equal(scoped.status, 'success', scoped.run.stderr);
  const subpath = await script("const { v4 } = require('uuid'); const debounce = require('lodash/debounce'); console.log(typeof v4, typeof debounce)");
  assert.equal(subpath.run.stdout, 'function function\n', subpath.run.stderr);
});

test('scripts: attempts to leave the project are refused, the runner keeps working', { skip }, async () => {
  const tries = await script(`const fs = require('node:fs');
const attempts = {
  readUp: () => fs.readFileSync('../package.json'),
  readAbsolute: () => fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('../package.json', import.meta.url)))}),
  writeOutside: () => fs.writeFileSync(${JSON.stringify(fileURLToPath(new URL('../evil.txt', import.meta.url)))}, 'x'),
  child: () => require('node:child_process').spawnSync('node', ['-v']),
  worker: () => new (require('node:worker_threads').Worker)('./main.js'),
  addon: () => process.dlopen({ exports: {} }, 'x.node'),
  replacePackages: () => fs.writeFileSync('node_modules/lodash/index.js', 'x'),
};
for (const [name, attempt] of Object.entries(attempts)) {
  try { attempt(); console.log(name, 'allowed'); } catch (error) { console.log(name, error.code || error.message.slice(0, 40)); }
}`);
  assert.equal(tries.status, 'success', tries.run.stderr);
  assert.doesNotMatch(tries.run.stdout, /allowed/);
  await assert.rejects(access(fileURLToPath(new URL('../evil.txt', import.meta.url))));
  // Eval and new Function work: learners use them, and the walls above still hold.
  const evaluated = await script("console.log(eval('1 + 1'), new Function('return 3')())");
  assert.equal(evaluated.run.stdout, '2 3\n');
  assert.equal((await script("console.log('still fine')")).status, 'success');
});

test('scripts: a file and folder of the project can be created and read back', { skip }, async () => {
  const files = await script("const fs = require('node:fs');\nfs.mkdirSync('out/deep', { recursive: true });\nfs.writeFileSync('out/deep/a.txt', 'saved');\nconsole.log(fs.readFileSync('out/deep/a.txt', 'utf8'), fs.readdirSync('.').includes('out'));");
  assert.equal(files.run.stdout, 'saved true\n', files.run.stderr);
  const csv = await script("const fs = require('node:fs');\nconst rows = fs.readFileSync('data.csv', 'utf8').trim().split('\\n').slice(1);\nconsole.log(rows.length);", { files: [{ path: 'data.csv', content: 'name\nA\nB\n' }] });
  assert.equal(csv.run.stdout, '2\n');
});

// ---- Express: app shapes ----------------------------------------------------------------------

test('apps: plain http, ESM, listen forms and other frameworks', { skip }, async () => {
  const http = await app("require('node:http').createServer((req, res) => res.end('plain ' + req.url)).listen(8080);", [get('/x')]);
  assert.equal(http.status, 'success', http.app.stderr);
  assert.equal(http.responses[0].body, 'plain /x');
  const esm = await app("import express from 'express';\nconst app = express();\napp.get('/', (req, res) => res.json({ esm: true }));\napp.listen(process.env.PORT);", [get('/')], { entry: 'server.mjs' });
  assert.equal(esm.responses[0]?.body, '{"esm":true}', esm.app.stderr);
  for (const listen of ['app.listen()', "app.listen(5000, '0.0.0.0', () => console.log('up'))", "app.listen({ port: 4000, host: 'localhost' })", "app.listen('3000')"]) {
    const result = await app(`${EXPRESS}app.get('/', (req, res) => res.send('ok'));\n${listen};`, [get('/')]);
    assert.equal(result.responses[0]?.body, 'ok', `${listen}: ${result.status} ${result.app.stderr}`);
  }
  const koa = await app("const Koa = require('koa');\nconst Router = require('@koa/router');\nconst app = new Koa();\nconst router = new Router();\nrouter.get('/k', (ctx) => { ctx.body = { koa: 1 }; });\napp.use(router.routes());\napp.listen(3000);", [get('/k')]);
  assert.equal(koa.responses[0]?.body, '{"koa":1}', koa.app.stderr);
  const fastify = await app("const app = require('fastify')();\napp.get('/f', async () => ({ fastify: 1 }));\napp.listen({ port: 3000 });", [get('/f')]);
  assert.equal(fastify.responses[0]?.body, '{"fastify":1}', fastify.app.stderr);
});

test('apps: startup failures say what happened', { skip }, async () => {
  const syntax = await app(`${EXPRESS}app.get('/', (req, res) => {\n`, [get('/')]);
  assert.equal(syntax.status, 'startup_error');
  assert.match(syntax.app.stderr, /SyntaxError/);
  const exits = await app("console.log('config missing'); process.exit(1);", [get('/')]);
  assert.equal(exits.status, 'startup_error');
  assert.equal(exits.app.stdout, 'config missing\n');
  // An app that keeps running but never listens: a clear timeout, not a hang.
  const never = await app("setInterval(() => {}, 1000);", [get('/')]);
  assert.equal(never.status, 'timeout');
  assert.equal(never.phase, 'startup');
  const missing = await app("const db = require('left-pad');", [get('/')]);
  assert.equal(missing.status, 'startup_error');
  assert.deepEqual(missing.missing, ['left-pad']);
  const noRequests = await app(`${EXPRESS}app.listen(3000);`, []);
  assert.equal(noRequests.status, 'success');
  assert.deepEqual(noRequests.responses, []);
});

test('apps: requests that crash, hang, redirect or answer big', { skip }, async () => {
  const code = `${EXPRESS}
app.get('/ok', (req, res) => res.json({ q: req.query, h: req.get('x-test') ?? null }));
app.get('/items/:id', (req, res) => res.json({ id: req.params.id }));
app.get('/throw', () => { throw new Error('sync boom'); });
app.get('/reject', async () => { throw new Error('async boom'); });
app.get('/hang', () => {});
app.get('/slow', (req, res) => setTimeout(() => res.send('late'), 200));
app.get('/redirect', (req, res) => res.redirect('/ok'));
app.get('/big', (req, res) => res.send('y'.repeat(40000)));
app.get('/bytes', (req, res) => res.type('application/octet-stream').send(Buffer.from([0, 255, 1])));
app.get('/cookie', (req, res) => res.cookie('sid', 'abc').send('set'));
app.post('/echo', (req, res) => res.status(201).json({ body: req.body ?? null }));
app.get('/crash', () => { setImmediate(() => { throw new Error('process dies'); }); });
app.listen(3000);`;
  const result = await app(code, [
    { method: 'GET', path: '/ok?name=%E0%A4%A8&x=1&x=2', headers: { 'X-Test': 'yes' } },
    get('/items/a%2Fb'),
    get('/throw'),
    get('/reject'),
    get('/slow'),
    get('/redirect'),
    get('/big'),
    get('/bytes'),
    get('/cookie'),
    post('/echo', '{"a":1}'),
    post('/echo', '{broken'),
    post('/echo', 'a=1&b=2', 'application/x-www-form-urlencoded'),
    { method: 'DELETE', path: '/echo' },
    get('/nope'),
  ]);
  assert.equal(result.status, 'success', result.app.stderr);
  const [ok, item, thrown, rejected, slow, redirect, big, bytes, cookie, echo, broken, form, wrongMethod, missing] = result.responses;
  assert.deepEqual(JSON.parse(ok.body), { q: { name: 'न', x: ['1', '2'] }, h: 'yes' });
  assert.deepEqual(JSON.parse(item.body), { id: 'a/b' });
  assert.equal(thrown.status, 500);
  assert.equal(rejected.status, 500, 'Express 5 catches rejected async handlers');
  assert.equal(slow.body, 'late');
  assert.equal(redirect.status, 302, 'redirects are shown, not followed');
  assert.equal(redirect.headers.location, '/ok');
  assert.equal(big.truncated, true);
  assert.ok(big.body.length <= config.projectResponseBodyLimitBytes);
  assert.equal(bytes.status, 200);
  assert.match(cookie.headers['set-cookie'], /sid=abc/);
  assert.deepEqual(JSON.parse(echo.body), { body: { a: 1 } });
  assert.equal(broken.status, 400);
  assert.equal(form.status, 201);
  assert.equal(wrongMethod.status, 404);
  assert.equal(missing.status, 404);

  // A request with no answer gets an error after the per-request limit; the next ones still run.
  const hang = await app(code, [get('/hang'), get('/ok')]);
  assert.equal(hang.responses[0].status, 0);
  assert.match(hang.responses[0].error, /No response within/);
  assert.equal(hang.responses[1]?.status, 200);

  // An error thrown outside a request kills the process: earlier answers are kept.
  const crash = await app(code, [get('/ok'), get('/crash'), get('/ok')]);
  assert.ok(['runtime_error', 'success'].includes(crash.status), crash.status);
  assert.equal(crash.responses[0].status, 200);
  assert.match(crash.app.stderr, /process dies/);
});

test('apps: state, files and the database within one run', { skip }, async () => {
  const code = `${EXPRESS}const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t (v TEXT)');
let hits = 0;
app.post('/v', (req, res) => { db.prepare('INSERT INTO t VALUES (?)').run(req.body.v); fs.appendFileSync('log.txt', req.body.v + '\\n'); res.status(201).end(); });
app.get('/v', (req, res) => res.json({ rows: db.prepare('SELECT v FROM t').all().map((r) => r.v), log: fs.readFileSync('log.txt', 'utf8'), hits: ++hits }));
app.use(express.static('public'));
app.listen(3000);`;
  const result = await app(code, [post('/v', '{"v":"a"}'), post('/v', '{"v":"b"}'), get('/v'), get('/index.html')], { files: [{ path: 'public/index.html', content: '<h1>hi</h1>' }] });
  assert.equal(result.status, 'success', result.app.stderr);
  assert.deepEqual(JSON.parse(result.responses[2].body), { rows: ['a', 'b'], log: 'a\nb\n', hits: 1 });
  assert.equal(result.responses[3].body, '<h1>hi</h1>');
  // The next run starts empty: nothing is kept between runs.
  const fresh = await app(code, [get('/v')], { files: [{ path: 'log.txt', content: '' }] });
  assert.deepEqual(JSON.parse(fresh.responses[0].body).rows, []);
});

test('apps: the most requests, and a run cancelled midway', { skip }, async () => {
  const many = await app(`${EXPRESS}let n = 0;\napp.get('/n', (req, res) => res.json(++n));\napp.listen(3000);`, Array.from({ length: config.projectRequestLimit }, () => get('/n')));
  assert.equal(many.status, 'success');
  assert.equal(many.responses.at(-1).body, String(config.projectRequestLimit));
  const controller = new AbortController();
  const pending = runNodeProject(runner, validateNodeProject({ files: [{ path: 'server.js', content: `${EXPRESS}app.get('/hang', () => {});\napp.listen(3000);` }], requests: [get('/hang')] }, config), controller.signal);
  setTimeout(() => controller.abort(), 1500);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  // The runner is still healthy afterwards.
  assert.equal(runner.healthy, true);
  assert.equal((await script("console.log('after')")).run.stdout, 'after\n');
});
