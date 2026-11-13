import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configuration } from '../src/config.js';
import { JavaRunner } from '../src/runner.js';
import { nodePackages, runNodeProject, runNodeScript, validateNodeProject, validateNodeScript } from '../src/node.js';
import { isNodePath } from '../src/nodePaths.js';
import { createServer } from '../src/server.js';

// The preinstalled packages: `npm run node-libs` installs them into node-libs/ (or set NODE_LIBS).
const NODE_LIBS = process.env.NODE_LIBS || fileURLToPath(new URL('../node-libs/', import.meta.url));
const config = configuration({ ...process.env, EXECUTION_MODE: 'local', PORT: '0', NODE_LIBS });
const runner = new JavaRunner(config);
const noLibs = await access(`${NODE_LIBS}/node_modules/express/package.json`).then(() => false, () => 'Node packages not installed; run npm run node-libs');

const script = (code, extra = {}) => runNodeScript(runner, validateNodeScript({ files: [{ path: 'main.js', content: code }, ...(extra.files ?? [])], stdin: extra.stdin ?? '' }, config), extra.signal);
const json = (method, target, body) => ({ method, path: target, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const TASKS = `const express = require('express');
const app = express();
app.use(express.json());
const tasks = [{ id: 1, title: 'Learn Node.js' }];
app.get('/api/tasks', (req, res) => res.json(tasks));
app.post('/api/tasks', (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: 'title is required' });
  const task = { id: tasks.length + 1, title: req.body.title };
  tasks.push(task);
  res.status(201).json(task);
});
app.get('/boom', () => { throw new Error('broken on purpose'); });
app.get('/exit', () => process.exit(3));
app.listen(3000, () => console.log('Listening on port 3000'));
`;
const project = (content, requests, files = []) => runNodeProject(runner, validateNodeProject({ files: [{ path: 'server.js', content }, ...files], requests }, config));

test('node file paths stay inside the project', () => {
  for (const ok of ['main.js', 'src/app.mjs', 'lib/util.cjs', 'package.json', 'public/index.html', 'data/seed.csv', '.env', 'db/schema.sql']) assert.ok(isNodePath(ok), ok);
  for (const bad of ['../x.js', '/etc/passwd', 'a/../x.js', 'node_modules/express/index.js', 'src/node_modules/x.js', '.hidden/x.js', 'a\\b.js',
    'main.exe', 'a b.js', '', 'x/'.repeat(8) + 'a.js', `${'a'.repeat(201)}.js`, 'C:/x.js']) assert.ok(!isNodePath(bad), bad);
});

test('node input is checked before anything runs', () => {
  const ok = { files: [{ path: 'main.js', content: '' }] };
  assert.equal(validateNodeScript(ok, config).entry, 'main.js');
  const bad = (body, pattern, check = validateNodeScript) => assert.throws(() => check(body, config), pattern);
  bad({ files: [] }, /between 1 and 40/);
  bad({ files: [{ path: 'node_modules/x.js', content: '' }] }, /files\[0\]/);
  bad({ files: [{ path: 'main.js', content: '' }, { path: 'main.js', content: '' }] }, /listed twice/);
  bad({ files: [{ path: 'main.js', content: 'a'.repeat(262145) }] }, /exceed 256 KiB/);
  bad({ ...ok, entry: 'other.js' }, /must be one of the files/);
  bad({ ...ok, entry: 'data.json' }, /entry must be/);
  bad({ ...ok, stdin: 'a'.repeat(16385) }, /stdin/);
  bad({ files: [{ path: 'server.js', content: '' }], requests: [{ method: 'TRACE', path: '/' }] }, /method/, validateNodeProject);
  assert.equal(validateNodeProject({ files: [{ path: 'server.js', content: '' }] }, config).entry, 'server.js');
});

test('a script runs with stdin, its own modules and the preinstalled packages', { skip: noLibs }, async () => {
  const result = await script(`const _ = require('lodash');
const prompt = require('prompt-sync')();
const name = prompt('Name? ');
const age = Number(prompt('Age? '));
console.log(\`Hi \${name}, next year you are \${age + 1}\`, _.sum([1, 2, 3]), require('./util.cjs').twice(4));
console.log(prompt('More? '));
`, { stdin: 'Asha\n21\n', files: [{ path: 'util.cjs', content: 'exports.twice = (n) => n * 2;' }] });
  assert.equal(result.status, 'success', result.run.stderr);
  assert.equal(result.runtime, 'node');
  assert.equal(result.run.stdout, 'Name? Age? Hi Asha, next year you are 22 6 8\nMore? null\n');
});

test('ES modules import packages and built-in modules', { skip: noLibs }, async () => {
  const result = await runNodeScript(runner, validateNodeScript({ entry: 'main.mjs', files: [{ path: 'main.mjs', content: `import dayjs from 'dayjs';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec('create table notes (text)');
db.prepare('insert into notes values (?)').run('hi');
console.log(dayjs('2026-01-02').format('DD/MM/YYYY'), z.string().parse('ok'), JSON.parse(await readFile('data.json', 'utf8')).n, db.prepare('select text from notes').get().text);
` }, { path: 'data.json', content: '{"n":7}' }] }, config));
  assert.equal(result.status, 'success', result.run.stderr);
  assert.equal(result.run.stdout, '02/01/2026 ok 7 hi\n');
});

test('a script can only use files in its project', { skip: noLibs }, async () => {
  const result = await script(`const fs = require('node:fs');
fs.writeFileSync('out.txt', 'saved');
console.log(fs.readFileSync('out.txt', 'utf8'));
for (const attempt of [() => fs.readFileSync(${JSON.stringify(fileURLToPath(new URL('../package.json', import.meta.url)))}),
  () => require('node:child_process').execSync('echo hi'), () => new (require('node:worker_threads').Worker)('./main.js')]) {
  try { attempt(); console.log('allowed'); } catch (error) { console.log(error.code); }
}
`);
  assert.equal(result.status, 'success', result.run.stderr);
  assert.equal(result.run.stdout, 'saved\nERR_ACCESS_DENIED\nERR_ACCESS_DENIED\nERR_ACCESS_DENIED\n');
});

test('errors show project paths and name missing packages', { skip: noLibs }, async () => {
  const thrown = await script("function fail() { throw new Error('broken on purpose'); }\nfail();\n");
  assert.equal(thrown.status, 'runtime_error');
  assert.match(thrown.run.stderr, /broken on purpose/);
  assert.match(thrown.run.stderr, /at fail \(main\.js:1:/);
  assert.doesNotMatch(thrown.run.stderr, /webnest-node-/);
  const missing = await script("require('left-pad');");
  assert.equal(missing.status, 'runtime_error');
  assert.deepEqual(missing.missing, ['left-pad']);
  const syntax = await script('console.log(');
  assert.equal(syntax.status, 'runtime_error');
  assert.match(syntax.run.stderr, /SyntaxError/);
});

test('package.json asking for a package that is not installed stops before running', { skip: noLibs }, async () => {
  const result = await script("console.log('never');", { files: [{ path: 'package.json', content: '{"dependencies":{"express":"^5.0.0","left-pad":"1.3.0","@scope/thing":"1"}}' }] });
  assert.equal(result.status, 'package_error');
  assert.deepEqual(result.missing, ['left-pad', '@scope/thing']);
  assert.equal(result.run, null);
  const fine = await script("console.log(require('express').name);", { files: [{ path: 'package.json', content: '{"dependencies":{"express":"^5.0.0"}}' }] });
  assert.equal(fine.status, 'success', fine.run.stderr);
});

test('limits: time, output and memory', { skip: noLibs }, async () => {
  const loop = await script('while (true) {}');
  assert.equal(loop.status, 'timeout');
  const noisy = await script("for (;;) console.log('x'.repeat(1000));");
  assert.equal(noisy.status, 'output_limit');
  const hungry = await script('const keep = []; for (;;) keep.push(new Array(1e6).fill(1));');
  assert.equal(hungry.status, 'runtime_error');
  assert.match(hungry.run.stderr, /heap/i);
});

test('an Express app answers requests in order, whatever port it listens on', { skip: noLibs }, async () => {
  const result = await project(TASKS, [
    { method: 'GET', path: '/api/tasks' }, json('POST', '/api/tasks', { title: 'Write tests' }), json('POST', '/api/tasks', {}),
    { method: 'GET', path: '/api/tasks' }, { method: 'GET', path: '/boom' }, { method: 'GET', path: '/no/such/route' },
  ]);
  assert.equal(result.status, 'success', `${result.app?.stdout}\n${result.app?.stderr}`);
  assert.equal(result.phase, 'requests');
  assert.equal(result.startup.ready, true);
  assert.deepEqual(result.responses.map((r) => r.status), [200, 201, 400, 200, 500, 404]);
  assert.deepEqual(JSON.parse(result.responses[3].body).map((t) => t.title), ['Learn Node.js', 'Write tests']);
  assert.match(result.app.stdout, /Listening on port 3000/);
  assert.match(result.app.stderr, /broken on purpose/);
});

test('Express failures: a crash at startup, an app that never listens, one that exits', { skip: noLibs }, async () => {
  const crash = await project("require('express')().get('/', (q, s) => s.send('x'));\nthrow new Error('bad start');", [{ method: 'GET', path: '/' }]);
  assert.equal(crash.status, 'startup_error');
  assert.match(crash.app.stderr, /bad start/);
  const quiet = await project("console.log('no server here');", [{ method: 'GET', path: '/' }]);
  assert.equal(quiet.status, 'startup_error');
  const exits = await project(TASKS, [{ method: 'GET', path: '/api/tasks' }, { method: 'GET', path: '/exit' }, { method: 'GET', path: '/api/tasks' }]);
  assert.ok(['runtime_error', 'success'].includes(exits.status), exits.status);
  assert.equal(exits.responses[0].status, 200);
  const missing = await project("require('left-pad');", []);
  assert.equal(missing.status, 'startup_error');
  assert.deepEqual(missing.missing, ['left-pad']);
});

test('the server routes Node runs and lists the packages', async (t) => {
  const calls = [];
  const fake = (kind) => async (_runner, submission) => {
    calls.push([kind, submission.entry]);
    return { status: 'success', phase: 'run', runtime: 'node', compile: null, run: { exitCode: 0 } };
  };
  const server = createServer(config, runner, undefined, { nodeScript: fake('script'), nodeProject: fake('project') });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (target, body) => fetch(`${base}${target}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const script = await post('/api/node/run', { files: [{ path: 'main.js', content: '' }] });
  assert.equal(script.status, 200);
  const body = await script.json();
  assert.equal(body.status, 'success');
  assert.equal(body.javaVersion, undefined);
  assert.equal((await post('/api/node/project/run', { files: [{ path: 'server.js', content: '' }] })).status, 200);
  assert.deepEqual(calls, [['script', 'main.js'], ['project', 'server.js']]);
  assert.equal((await post('/api/node/run', { files: [{ path: '../x.js', content: '' }] })).status, 400);
  const listed = await (await fetch(`${base}/api/node/packages`)).json();
  if (!noLibs) assert.ok(listed.packages.some((p) => p.name === 'express' && /^\d/.test(p.version)));
  assert.deepEqual(Object.keys(await nodePackages(config)).length, listed.packages.length);
});
