import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration } from '../src/config.js';
import { JavaRunner, validateSubmission } from '../src/runner.js';
import { runProject, validateProject } from '../src/project.js';
import { createServer } from '../src/server.js';

const config = configuration({ ...process.env, EXECUTION_MODE: 'local', PORT: '0' });
const runner = new JavaRunner(config);
const fixture = fileURLToPath(new URL('./fixtures/spring-tasks/', import.meta.url));
const MAIN = 'com.example.demo.DemoApplication';

async function fixtureFiles(dir = fixture) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await fixtureFiles(full));
    else found.push({ path: path.relative(fixture, full).split(path.sep).join('/'), content: await readFile(full, 'utf8') });
  }
  return found;
}
const starter = await fixtureFiles();
const edit = (files, filePath, change) => files.map((file) => (file.path === filePath ? { ...file, content: change(file.content) } : file));
const SERVICE = 'src/main/java/com/example/demo/task/TaskService.java';
const CONTROLLER = 'src/main/java/com/example/demo/task/TaskController.java';
const json = (body) => ({ 'Content-Type': 'application/json', body: JSON.stringify(body) });
const request = (method, target, body) => ({ method, path: target, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const run = (files, requests = [], options = {}) => runProject(options.runner ?? runner, validateProject({ files, mainClass: MAIN, requests }, config), options.signal);

// The project tests need the JPA and H2 jars as well (see spring-boot/pom.xml).
const jpaMissing = await readdir(config.springBootProjectLib).then(
  (names) => (names.some((name) => name.startsWith('hibernate-core')) && names.some((name) => name.startsWith('h2-')) ? false : 'Spring Boot JPA and H2 jars not installed; set SPRING_BOOT_PROJECT_LIB (see README)'),
  () => 'Spring Boot project jars not installed; set SPRING_BOOT_PROJECT_LIB (see README)',
);

test('project input is checked before anything runs', () => {
  const ok = { files: starter, mainClass: MAIN };
  assert.equal(validateProject(ok, config).files.length, starter.length);
  const bad = (change, pattern) => assert.throws(() => validateProject({ ...ok, ...change }, config), pattern);
  for (const filePath of ['../evil.java', '/etc/passwd', 'src/main/java/../../x.java', 'src/main/java/a b/X.java', 'src/main/resources/application.yml',
    'src/main/resources/static/index.html', 'src/test/java/com/X.java', 'pom.xml', 'src\\main\\java\\X.java']) {
    bad({ files: [...starter, { path: filePath, content: 'x' }] }, /files\[/);
  }
  bad({ files: [...starter, starter[0]] }, /listed twice/);
  bad({ files: [] }, /between 1 and/);
  bad({ files: [{ path: 'src/main/resources/data.sql', content: '' }] }, /at least one .java/);
  bad({ files: Array.from({ length: 61 }, (_, i) => ({ path: `src/main/java/p/C${i}.java`, content: '' })) }, /between 1 and 60/);
  bad({ files: [{ path: 'src/main/java/p/Big.java', content: 'a'.repeat(262145) }], mainClass: 'p.Big' }, /exceed 256 KiB/);
  bad({ mainClass: 'DemoApplication' }, /in a package/);
  bad({ mainClass: 'com.example.demo.Missing' }, /must match a file/);
  bad({ mainClass: '-version' }, /mainClass/);
  bad({ requests: [request('TRACE', '/')] }, /method/);
  bad({ requests: [request('GET', 'http://evil.example/')] }, /path/);
  bad({ requests: [request('GET', '//evil.example/')] }, /path/);
  bad({ requests: [request('GET', '/a b')] }, /path/);
  bad({ requests: [{ method: 'GET', path: '/', headers: { 'X-A': 'one\r\nX-B: two' } }] }, /invalid header/);
  bad({ requests: [{ method: 'POST', path: '/', body: 'a'.repeat(65537) }] }, /body/);
  bad({ requests: Array.from({ length: 31 }, () => request('GET', '/')) }, /at most 30/);
  // Headers the client sets itself are dropped rather than refused.
  const kept = validateProject({ ...ok, requests: [{ method: 'get', path: '/x', headers: { Host: 'evil', 'X-Token': 'abc' } }] }, config);
  assert.deepEqual(kept.requests[0], { method: 'GET', path: '/x', headers: { 'X-Token': 'abc' }, body: null });
});

test('a Spring Boot project answers CRUD requests in order', { skip: jpaMissing }, async () => {
  const result = await run(starter, [
    request('GET', '/api/tasks'),
    request('POST', '/api/tasks', { title: 'Write tests', done: false }),
    request('POST', '/api/tasks', { title: '', done: false }),
    request('POST', '/api/tasks', { title: 'Write tests', done: false }),
    request('PUT', '/api/tasks/3', { title: 'Write more tests', done: true }),
    request('GET', '/api/tasks?done=true'),
    request('DELETE', '/api/tasks/1'),
    request('GET', '/api/tasks/1'),
    { method: 'POST', path: '/api/tasks', headers: { 'Content-Type': 'application/json' }, body: '{not json' },
    request('GET', '/no/such/route'),
  ]);
  assert.equal(result.status, 'success', `${result.compile.stderr}\n${result.app?.stdout}\n${result.app?.stderr}`);
  assert.equal(result.phase, 'requests');
  assert.equal(result.startup.ready, true);
  assert.ok(result.startup.ms > 0);
  assert.deepEqual(result.responses.map((r) => r.status), [200, 201, 400, 409, 200, 200, 204, 404, 400, 404]);
  assert.deepEqual(JSON.parse(result.responses[0].body).map((t) => t.title), ['Learn Spring Boot', 'Build a REST API']);
  assert.deepEqual(JSON.parse(result.responses[1].body), { id: 3, title: 'Write tests', done: false });
  assert.deepEqual(JSON.parse(result.responses[2].body).errors, { title: 'title is required' });
  assert.deepEqual(JSON.parse(result.responses[5].body).map((t) => t.id), [2, 3]);
  assert.match(result.responses[0].headers['content-type'], /application\/json/);
  assert.match(result.app.stdout, /Started DemoApplication/);
});

test('each run starts from a fresh database', { skip: jpaMissing }, async () => {
  const result = await run(starter, [request('GET', '/api/tasks')]);
  assert.equal(result.status, 'success');
  assert.equal(JSON.parse(result.responses[0].body).length, 2);
});

test('compile errors show project paths and nothing starts', { skip: jpaMissing }, async () => {
  const result = await run(edit(starter, SERVICE, (code) => code.replace('repository.findAll()', 'repository.findEverything()')), [request('GET', '/api/tasks')]);
  assert.equal(result.status, 'compile_error');
  assert.equal(result.phase, 'compile');
  assert.match(result.compile.stderr, /^src\/main\/java\/com\/example\/demo\/task\/TaskService\.java:\d+: error: cannot find symbol/m);
  assert.doesNotMatch(result.compile.stderr, /webnest-spring-/);
  assert.equal(result.app, null);
  assert.deepEqual(result.responses, []);
});

test('startup failures are reported with the Spring log', { skip: jpaMissing }, async () => {
  const result = await run(edit(starter, SERVICE, (code) => code.replace('@Service\n', '')), [request('GET', '/api/tasks')]);
  assert.equal(result.status, 'startup_error');
  assert.equal(result.phase, 'startup');
  assert.equal(result.startup.ready, false);
  assert.match(result.app.stdout + result.app.stderr, /TaskService/);
  assert.deepEqual(result.responses, []);
});

test('an exception in a controller is a 500 response, not a failed run', { skip: jpaMissing }, async () => {
  const files = edit(starter, CONTROLLER, (code) => code.replace('return service.list(done);', 'throw new IllegalStateException("broken on purpose");'));
  const result = await run(files, [request('GET', '/api/tasks'), request('GET', '/api/tasks/2')]);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.responses.map((r) => r.status), [500, 200]);
  assert.match(result.app.stdout + result.app.stderr, /broken on purpose/);
});

test('the port and database cannot be changed by application.properties', { skip: jpaMissing }, async () => {
  const files = edit(starter, 'src/main/resources/application.properties', (text) => `${text}\nserver.port=9\nspring.datasource.url=jdbc:h2:file:/etc/evil\nspring.main.web-application-type=none\n`);
  const result = await run(files, [request('GET', '/api/tasks')]);
  assert.equal(result.status, 'success', result.app?.stdout);
  assert.equal(result.responses[0].status, 200);
});

test('an app that exits while handling requests keeps the earlier responses', { skip: jpaMissing }, async () => {
  const files = edit(starter, CONTROLLER, (code) => code.replace('return service.get(id);', 'if (id == 99) System.exit(3); return service.get(id);'));
  const result = await run(files, [request('GET', '/api/tasks/1'), request('GET', '/api/tasks/99'), request('GET', '/api/tasks/2')]);
  // Whether the JVM is gone before the probe finishes is a race: either way the run says what happened.
  assert.ok(['runtime_error', 'success'].includes(result.status), result.status);
  assert.equal(result.phase, 'requests');
  assert.equal(result.responses[0].status, 200);
  const failed = result.responses[1];
  if (failed) {
    assert.equal(failed.status, 0);
    assert.match(failed.error, /without a response|No response/);
  } else assert.equal(result.status, 'runtime_error');
});

test('an app that never starts listening times out', { skip: jpaMissing }, async () => {
  const quick = new JavaRunner({ ...config, projectReadyTimeoutMs: 4000 });
  const files = edit(starter, 'src/main/java/com/example/demo/DemoApplication.java',
    (code) => code.replace('SpringApplication.run(DemoApplication.class, args);', 'while (true) { Thread.onSpinWait(); }'));
  const started = Date.now();
  const result = await run(files, [request('GET', '/api/tasks')], { runner: quick });
  assert.equal(result.status, 'timeout');
  assert.equal(result.phase, 'startup');
  assert.ok(Date.now() - started < 25000, `took ${Date.now() - started} ms`);
});

test('the readiness check never calls the routes of the app', { skip: jpaMissing }, async () => {
  const files = [...starter, {
    path: 'src/main/java/com/example/demo/RootController.java',
    content: `package com.example.demo;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
@RestController
public class RootController {
    private static final AtomicInteger CALLS = new AtomicInteger();
    @GetMapping("/")
    public String root() { return "root " + CALLS.incrementAndGet(); }
    @GetMapping("/calls")
    public int calls() { return CALLS.get(); }
}
`,
  }];
  const result = await run(files, [request('GET', '/calls')]);
  assert.equal(result.status, 'success', result.app?.stdout);
  assert.equal(result.responses[0].body, '0');
});

test('one deadline bounds the whole run', { skip: jpaMissing }, async () => {
  // Too little time left after compiling to start the app: a timeout, quickly, not a hang.
  const short = new JavaRunner({ ...config, projectTotalTimeoutMs: 6000 });
  const started = Date.now();
  const result = await run(starter, [request('GET', '/api/tasks')], { runner: short });
  assert.equal(result.status, 'timeout');
  assert.ok(Date.now() - started < 15000, `took ${Date.now() - started} ms`);
});

test('cancelling a project run stops the app', { skip: jpaMissing }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const result = await run(starter, [request('GET', '/api/tasks')], { signal: controller.signal });
    assert.equal(result.status, 'cancelled');
  } finally { clearTimeout(timer); }
});

test('cloud project runs happen inside one sandbox that is deleted afterwards', async () => {
  const calls = [];
  const fake = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input, cwd: options.cwd });
    if (args.includes(path.join(process.cwd(), 'src', 'probe.js')) || args.some((a) => String(a).endsWith('probe.js'))) {
      return { exitCode: 0, stdout: '{"type":"ready","readyMs":5}\n{"type":"response","status":200,"headers":{},"body":"[]","truncated":false,"ms":3}\n{"type":"done","timedOut":false}\n', stderr: '', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run', springBootProjectLib: process.cwd() }, fake);
  const result = await runProject(cloudRunner, validateProject({ files: starter, mainClass: MAIN, requests: [request('GET', '/api/tasks')] }, config));
  assert.equal(result.status, 'success');
  assert.deepEqual(result.responses.map((r) => r.status), [200]);
  assert.ok(calls.every((c) => c.command === config.sandbox));
  assert.deepEqual(calls.map((c) => c.args[0]), ['run', 'exec', 'exec', 'exec', 'exec', 'delete']);
  const name = calls[0].args[2];
  assert.ok(calls.slice(1, 5).every((c) => c.args[1] === name));
  assert.deepEqual(calls.at(-1).args, ['delete', '--force', name]);
  // The files arrive on stdin, never in a command line.
  assert.deepEqual(JSON.parse(calls[1].input).map((f) => f.path).sort(), starter.map((f) => f.path).sort());
  assert.ok(calls.every((c) => c.cwd === undefined));
  const javac = calls[2].args;
  assert.ok(javac.includes('-parameters'));
  assert.ok(javac.includes('/tmp/project/src/main/java/com/example/demo/DemoApplication.java'));
  const java = calls.find((c) => c.args.includes(MAIN)).args;
  assert.ok(java.some((a) => /^--server\.port=\d+$/.test(a)));
  assert.ok(java.includes('--server.address=127.0.0.1'));
  assert.ok(!calls.flatMap((c) => c.args).includes('--allow-egress'));
});

test('a probe that breaks is a runner fault, and the sandbox is still deleted', async () => {
  const calls = [];
  const fake = async (command, args) => {
    calls.push(args);
    if (args.some((a) => String(a).endsWith('probe.js'))) return { exitCode: 0, stdout: '{"type":"error","message":"boom"}\n', stderr: '', timedOut: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run', springBootProjectLib: process.cwd() }, fake);
  await assert.rejects(runProject(cloudRunner, validateProject({ files: starter, mainClass: MAIN }, config)), /Request probe failed: boom/);
  assert.equal(calls.at(-1)[0], 'delete');
  assert.equal(cloudRunner.healthy, true);
});

test('single-file Spring runs keep their own, smaller classpath', async () => {
  const calls = [];
  const fake = async (command, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
  // Two real folders, because the runner checks that the library folder exists.
  const single = path.join(process.cwd(), 'src');
  const projectLib = path.join(process.cwd(), 'test');
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run', springBootLib: single, springBootProjectLib: projectLib }, fake);
  await cloudRunner.run(validateSubmission({ code: 'package demo; import org.springframework.boot.SpringApplication; public class Main {}', className: 'demo.Main' }, config));
  const classpaths = calls.flatMap((args) => args.filter((_, i) => args[i - 1] === '-cp' || args[i - 1] === '-classpath'));
  assert.ok(classpaths.length > 0);
  assert.ok(classpaths.every((cp) => cp.includes(single) && !cp.includes(projectLib)));
});

test('cloud project cleanup failure disables further execution', async () => {
  const fake = async (command, args) => ({ exitCode: args[0] === 'delete' ? 1 : 0, stdout: '', stderr: 'test failure' });
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run', springBootProjectLib: process.cwd() }, fake);
  const input = validateProject({ files: starter, mainClass: MAIN }, config);
  await assert.rejects(runProject(cloudRunner, input), /cleanup failed/);
  assert.equal(cloudRunner.healthy, false);
  await assert.rejects(runProject(cloudRunner, input), /unavailable/);
});

test('HTTP project route: limits, validation, and the shared busy lock', async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const fakeProject = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
  const server = createServer(config, runner, fakeProject);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (target, body) => fetch(`${base}${target}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  try {
    assert.equal((await fetch(`${base}/api/project/run`)).status, 405);
    assert.equal((await post('/api/project/run', '{}')).status, 400);
    assert.equal((await post('/api/project/run', JSON.stringify({ files: [{ path: '../x.java', content: '' }], mainClass: 'a.B' }))).status, 400);
    assert.equal((await post('/api/project/run', 'a'.repeat(530000))).status, 413);
    // The single-file route keeps its own, smaller limit.
    assert.equal((await post('/api/run', 'a'.repeat(140000))).status, 413);
    const first = post('/api/project/run', JSON.stringify({ files: starter, mainClass: MAIN }));
    await ready;
    assert.equal((await post('/api/run', JSON.stringify({ code: 'class X {}' }))).status, 429);
    assert.equal((await post('/api/project/run', JSON.stringify({ files: starter, mainClass: MAIN }))).status, 429);
    release({ status: 'success', phase: 'requests', springBoot: true, compile: { exitCode: 0 }, startup: { ready: true, ms: 1 }, app: { exitCode: null }, responses: [] });
    const response = await first;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.requestId, response.headers.get('X-Request-Id'));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
