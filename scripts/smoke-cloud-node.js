// Checks Node.js runs on the deployed service: a script with stdin and packages, a missing
// package, the permission model, an Express round trip, and that the sandbox has no network.
import assert from 'node:assert/strict';

const base = process.env.PLAYGROUND_URL?.replace(/\/$/, '');
const token = process.env.PLAYGROUND_ID_TOKEN;
if (!base || !token) throw new Error('Set PLAYGROUND_URL (the service) and PLAYGROUND_ID_TOKEN (a Google identity token)');

async function post(target, body) {
  const started = Date.now();
  const response = await fetch(`${base}${target}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  assert.equal(response.status, 200, `HTTP ${response.status}: ${await response.clone().text()}`);
  const result = await response.json();
  console.log(`  ${target} ${result.status} in ${Date.now() - started} ms (server ${result.durationMs} ms)`);
  return result;
}
const script = (content, stdin = '', files = []) => post('/api/node/run', { files: [{ path: 'main.js', content }, ...files], stdin });

console.log('Packages list');
const listed = await (await fetch(`${base}/api/node/packages`, { headers: { Authorization: `Bearer ${token}` } })).json();
assert.ok(listed.packages.length >= 100, `only ${listed.packages.length} packages`);
console.log(`  ${listed.packages.length} packages on ${listed.nodeVersion}`);

console.log('Script with stdin and packages');
const hello = await script("const prompt = require('prompt-sync')(); const _ = require('lodash');\nconsole.log('Hi', prompt('Name? '), _.sum([1, 2]));", 'Asha\n');
assert.equal(hello.status, 'success', hello.run?.stderr);
assert.equal(hello.run.stdout, 'Name? Hi Asha 3\n');

console.log('Missing package');
const missing = await script("require('left-pad')");
assert.deepEqual(missing.missing, ['left-pad']);

console.log('Permission model and network');
const walls = await script(`const fs = require('node:fs');
for (const attempt of [() => fs.readFileSync('/etc/passwd'), () => require('node:child_process').execSync('id')]) {
  try { attempt(); console.log('allowed'); } catch (error) { console.log(error.code); }
}
fetch('https://example.com', { signal: AbortSignal.timeout(4000) }).then(() => console.log('online'), () => console.log('offline'));
`);
assert.equal(walls.status, 'success', walls.run?.stderr);
assert.equal(walls.run.stdout, 'ERR_ACCESS_DENIED\nERR_ACCESS_DENIED\noffline\n');

console.log('Express round trip');
const app = await post('/api/node/project/run', {
  files: [{ path: 'server.js', content: `const express = require('express');
const app = express();
app.use(express.json());
const notes = [];
app.get('/api/notes', (req, res) => res.json(notes));
app.post('/api/notes', (req, res) => { notes.push(req.body); res.status(201).json(req.body); });
app.listen(3000);
` }],
  requests: [
    { method: 'POST', path: '/api/notes', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hi"}' },
    { method: 'GET', path: '/api/notes' },
  ],
});
assert.equal(app.status, 'success', app.app?.stderr);
assert.deepEqual(app.responses.map((r) => r.status), [201, 200]);
assert.deepEqual(JSON.parse(app.responses[1].body), [{ text: 'hi' }]);
console.log(`  startup ${app.startup.ms} ms`);
console.log('All Node.js checks passed');
