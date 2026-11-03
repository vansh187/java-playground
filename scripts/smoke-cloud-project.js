// Checks the deployed Spring Boot project service: a CRUD round trip, a validation error, a
// compile error, a startup error, and that the sandbox has no outside network.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.PLAYGROUND_URL?.replace(/\/$/, '');
const token = process.env.PLAYGROUND_ID_TOKEN;
if (!base || !token) throw new Error('Set PLAYGROUND_URL (the Spring service) and PLAYGROUND_ID_TOKEN (a Google identity token)');

const fixture = fileURLToPath(new URL('../test/fixtures/spring-tasks/', import.meta.url));
async function files(dir = fixture) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(full));
    else found.push({ path: path.relative(fixture, full).split(path.sep).join('/'), content: await readFile(full, 'utf8') });
  }
  return found;
}
const starter = await files();
const MAIN = 'com.example.demo.DemoApplication';
const json = (method, target, body) => ({ method, path: target, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function run(projectFiles, requests) {
  const started = Date.now();
  const response = await fetch(`${base}/api/project/run`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: projectFiles, mainClass: MAIN, requests }), signal: AbortSignal.timeout(118000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${await response.clone().text()}`);
  const body = await response.json();
  console.log(`  ${body.status} in ${Date.now() - started} ms (startup ${body.startup?.ms ?? '-'} ms)`);
  return body;
}

console.log('CRUD round trip');
const crud = await run(starter, [
  { method: 'GET', path: '/api/tasks' },
  json('POST', '/api/tasks', { title: 'From the cloud', done: false }),
  json('POST', '/api/tasks', { title: '', done: false }),
  { method: 'GET', path: '/api/tasks/3' },
]);
assert.equal(crud.status, 'success', `${crud.compile?.stderr}\n${crud.app?.stdout}`);
assert.deepEqual(crud.responses.map((r) => r.status), [200, 201, 400, 200]);
assert.equal(JSON.parse(crud.responses[3].body).title, 'From the cloud');

console.log('Compile error');
const broken = starter.map((f) => (f.path.endsWith('TaskService.java') ? { ...f, content: f.content.replace('findAll()', 'findEverything()') } : f));
const compile = await run(broken, [{ method: 'GET', path: '/api/tasks' }]);
assert.equal(compile.status, 'compile_error');
assert.match(compile.compile.stderr, /TaskService\.java:\d+: error/);

console.log('Startup error');
const missingBean = starter.map((f) => (f.path.endsWith('TaskService.java') ? { ...f, content: f.content.replace('@Service\n', '') } : f));
const startup = await run(missingBean, [{ method: 'GET', path: '/api/tasks' }]);
assert.equal(startup.status, 'startup_error');

console.log('No outside network from a controller');
const probe = starter.map((f) => (f.path.endsWith('TaskController.java') ? { ...f, content: f.content.replace(
  'return service.list(done);',
  'try { var c = new java.net.URL("https://example.com").openConnection(); c.setConnectTimeout(1500); c.getInputStream(); throw new IllegalStateException("NETWORK OPEN"); } catch (java.io.IOException e) { return service.list(done); }',
) } : f));
const network = await run(probe, [{ method: 'GET', path: '/api/tasks' }]);
assert.equal(network.responses[0]?.status, 200, 'Outbound network should be blocked inside the sandbox');

console.log('Spring Boot project smoke tests passed: CRUD, validation, compile and startup errors, network isolation.');
