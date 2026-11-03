import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { configuration } from '../src/config.js';
import { JavaRunner, validateSubmission } from '../src/runner.js';
import { createServer } from '../src/server.js';

const config = configuration({ ...process.env, EXECUTION_MODE: 'local', PORT: '0' });
const runner = new JavaRunner(config);
const program = body => `public class Main { public static void main(String[] args) throws Exception { ${body} } }`;
const run = (code, extra = {}) => runner.run(validateSubmission({ code, ...extra }, config));

test('installed compiler and runtime are Java 17', () => runner.check());
test('Java 17 features, Unicode, stdin, arguments, stdout, and stderr', async () => {
  const result = await run(program('record Item(String value) {} var s = new java.util.Scanner(System.in); System.out.println(new Item(s.nextLine()).value() + args[0]); System.err.println("diagnostic");'),
    { stdin: 'नमस्ते 🌱\n', args: ['!'] });
  assert.equal(result.status, 'success');
  assert.equal(result.run.stdout.trim(), 'नमस्ते 🌱!');
  assert.equal(result.run.stderr.trim(), 'diagnostic');
});
test('package declarations and helper classes compile correctly', async () => {
  const result = await run('package practice; public class Main { public static void main(String[] args) { System.out.println(Helper.answer()); } } class Helper { static int answer() { return 42; } }', { className: 'practice.Main' });
  assert.equal(result.status, 'success');
  assert.equal(result.run.stdout.trim(), '42');
});
test('compile failures return source lines and never execute', async () => {
  const result = await run('public class Main {\n public static void main(String[] args) {\n System.out.println(unknown);\n }\n}');
  assert.equal(result.status, 'compile_error');
  assert.match(result.compile.stderr, /Main.java:3/);
  assert.match(result.compile.stderr, /cannot find symbol/);
  assert.equal(result.run, null);
});
test('runtime exceptions retain printed output and stack trace', async () => {
  const result = await run(program('System.out.println("before"); throw new IllegalStateException("learning error");'));
  assert.equal(result.status, 'runtime_error');
  assert.equal(result.run.stdout.trim(), 'before');
  assert.match(result.run.stderr, /IllegalStateException: learning error/);
  assert.match(result.run.stderr, /Main.main\(Main.java:1\)/);
});
test('infinite loops stop at the runtime deadline', async () => {
  const result = await run(program('while(true) {}'));
  assert.equal(result.status, 'timeout');
  assert.equal(result.phase, 'run');
  assert.equal(result.run.timedOut, true);
});
test('flooded output is bounded and the program is stopped', async () => {
  const result = await run(program('while(true) System.out.print("abcdefghij");'));
  assert.equal(result.status, 'output_limit');
  assert.ok(Buffer.byteLength(result.run.stdout + result.run.stderr) <= config.outputLimitBytes);
});
test('heap exhaustion is isolated and later requests still succeed', async () => {
  const result = await run(program('byte[] tooLarge = new byte[300 * 1024 * 1024]; System.out.println(tooLarge.length);'));
  assert.equal(result.status, 'runtime_error');
  assert.match(result.run.stdout + result.run.stderr, /OutOfMemoryError/);
  assert.equal((await run(program('System.out.print("recovered");'))).run.stdout, 'recovered');
});
test('missing main and nonzero exits are reported', async () => {
  assert.equal((await run('public class Main {}')).status, 'runtime_error');
  const result = await run(program('System.exit(7);'));
  assert.equal(result.status, 'runtime_error');
  assert.equal(result.run.exitCode, 7);
});
test('EOF is delivered even for empty input', async () => {
  const result = await run(program('System.out.print(System.in.read());'));
  assert.equal(result.run.stdout, '-1');
});
test('source files from earlier runs cannot affect later compilation', async () => {
  await run('class Leftover {} public class Main { public static void main(String[] args) {} }');
  const result = await run(program('System.out.println(new Leftover());'));
  assert.equal(result.status, 'compile_error');
});
test('invalid class paths, argument options, and large inputs', () => {
  for (const className of ['../Main', '-version', '/Main', 'foo/bar', 'Main.java;echo']) {
    assert.throws(() => validateSubmission({ code: 'x', className }, config));
  }
  assert.throws(() => validateSubmission({ code: 'a'.repeat(65537) }, config));
  assert.throws(() => validateSubmission({ code: 'x', stdin: 'a'.repeat(16385) }, config));
  assert.throws(() => validateSubmission({ code: 'x', args: ['\0'] }, config));
  assert.throws(() => configuration({ JAVA_HOME: 'x', EXECUTION_MODE: 'local', K_SERVICE: 'production' }));
});
const springMissing = await import('node:fs/promises').then(fs => fs.access(config.springBootLib)).then(() => false, () =>
  'Spring Boot jars not installed; set SPRING_BOOT_LIB (see README)');
const springApp = `package demo;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.*;
@SpringBootApplication
public class Main {
  public static void main(String[] args) { SpringApplication.run(Main.class, args); }
  @Bean CommandLineRunner greet(Greeter greeter) { return args -> System.out.println(greeter.hello(args[0])); }
}
@Service class Greeter { String hello(String name) { return "Hello, " + name + " from Spring"; } }
@RestController class Api { @GetMapping("/hi") String hi(@RequestParam String name) { return name; } }`;
test('Spring Boot applications compile, inject beans, and exit without a web server', { skip: springMissing }, async () => {
  const result = await run(springApp, { className: 'demo.Main', args: ['learner'] });
  assert.equal(result.status, 'success', result.compile.stderr + (result.run?.stderr ?? ''));
  assert.equal(result.springBoot, true);
  assert.match(result.run.stdout, /Hello, learner from Spring/);
  assert.doesNotMatch(result.run.stdout, /Tomcat started/);
});
test('Spring Boot errors are reported as compile and runtime errors', { skip: springMissing }, async () => {
  const compile = await run(springApp.replace('greeter.hello', 'greeter.missing'), { className: 'demo.Main' });
  assert.equal(compile.status, 'compile_error');
  const runtime = await run(springApp.replace('@Service class Greeter', 'class Greeter'), { className: 'demo.Main', args: ['x'] });
  assert.equal(runtime.status, 'runtime_error');
  assert.match(runtime.run.stdout + runtime.run.stderr, /Greeter/);
});
test('plain Java does not get the Spring classpath', async () => {
  // Split the name so the source does not mention the Spring package and stays a plain Java submission.
  const result = await run(program('Class.forName("org." + "springframework.boot.SpringApplication");'));
  assert.equal(result.status, 'runtime_error');
  assert.match(result.run.stderr, /ClassNotFoundException/);
  assert.equal(result.springBoot, false);
});
test('Spring Boot applications in the default package are rejected', () => {
  assert.throws(() => validateSubmission({ code: springApp.replace('package demo;', '') }, config), /must declare a package/);
  assert.equal(validateSubmission({ code: springApp, className: 'demo.Main' }, config).springBoot, true);
});

test('cancellation stops an active program', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const result = await runner.run(validateSubmission({ code: program('while(true) {}') }, config), controller.signal);
    assert.equal(result.status, 'cancelled');
  } finally { clearTimeout(timer); }
});

test('HTTP editor, input errors, request IDs, and execution contract', async () => {
  const server = createServer(config, runner);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body,
  });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.match(await (await fetch(base)).text(), /Webnest Studio/i);
    assert.equal((await fetch(`${base}/api/run`)).status, 405);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('{}')).status, 400);
    assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('{}', { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await post('a'.repeat(140000))).status, 413);
    const response = await post(JSON.stringify({ code: program('System.out.print("api works");') }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.requestId, response.headers.get('X-Request-Id'));
    assert.equal(body.run.stdout, 'api works');
    assert.equal(body.status, 'success');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('overlapping requests get backpressure, not a second execution', async () => {
  let release;
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const fake = { healthy: true, run: () => { entered(); return new Promise(resolve => { release = resolve; }); } };
  const server = createServer(config, fake);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'test' }),
  });
  try {
    const first = post(); await ready;
    assert.equal((await post()).status, 429);
    release({ status: 'success', phase: 'run', compile: { exitCode: 0 }, run: { exitCode: 0 } });
    assert.equal((await first).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('cloud runner compiles and runs inside one sandbox then deletes it', async () => {
  const calls = [];
  const fake = async (command, args, options = {}) => {
    calls.push({ command, args, input: options.input, cwd: options.cwd });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run' }, fake);
  const code = program('');
  await cloudRunner.run(validateSubmission({ code }, config));
  assert.deepEqual(calls.map(c => c.args[0]), ['run', 'exec', 'exec', 'exec', 'delete']);
  assert.ok(calls.every(c => c.command === config.sandbox));
  assert.equal(calls[0].args[2], calls[1].args[1]);
  // The sandbox cannot see the host's /tmp, so the source must arrive through stdin.
  assert.equal(calls[1].input, code);
  assert.ok(calls.every(c => c.cwd === undefined)); // host temp directories do not exist inside the sandbox
  assert.ok(calls[2].args.includes('/tmp/src/Main.java'));
  assert.deepEqual(calls[4].args, ['delete', '--force', calls[1].args[1]]);
  assert.ok(!calls.flatMap(c => c.args).includes('--allow-egress'));
});
test('cloud runner adds the Spring Boot classpath only for Spring submissions', async () => {
  const calls = [];
  const fake = async (command, args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
  // The cloud runner checks the jar directory on the host, which shares the sandbox's filesystem.
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run', springBootLib: process.cwd() }, fake);
  await cloudRunner.run(validateSubmission({ code: 'package demo; import org.springframework.boot.SpringApplication; public class Main {}', className: 'demo.Main' }, config));
  const [compile, execute] = [calls[2], calls[3]];
  const expected = ['/tmp/classes', `${process.cwd()}${process.platform === 'win32' ? '\\' : '/'}*`].join(process.platform === 'win32' ? ';' : ':');
  assert.equal(compile[compile.indexOf('-classpath') + 1], expected);
  assert.equal(execute[execute.indexOf('-cp') + 1], expected);
  assert.ok(execute.includes('-Dspring.main.web-application-type=none'));
});
test('cloud cleanup failure disables further execution', async () => {
  const fake = async (command, args) => ({ exitCode: args[0] === 'delete' ? 1 : 0, stdout: '', stderr: 'test failure' });
  const cloudRunner = new JavaRunner({ ...config, mode: 'cloud-run' }, fake);
  const input = validateSubmission({ code: program('') }, config);
  await assert.rejects(cloudRunner.run(input), /cleanup failed/);
  assert.equal(cloudRunner.healthy, false);
  await assert.rejects(cloudRunner.run(input), /unavailable/);
});
