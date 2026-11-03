import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execute } from './process.js';

export class InputError extends Error {}
export function validateSubmission(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object');
  const { code, className = 'Main', stdin = '', args = [] } = body;
  if (typeof code !== 'string' || !code.trim()) throw new InputError('code must be a non-empty string');
  if (Buffer.byteLength(code) > config.codeLimitBytes) throw new InputError('code exceeds 64 KiB');
  if (typeof className !== 'string' || className.length > 160 ||
      !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(className)) {
    throw new InputError('className must be a Java class name, for example Main or practice.Main');
  }
  if (typeof stdin !== 'string' || Buffer.byteLength(stdin) > config.stdinLimitBytes) throw new InputError('stdin must be a string of at most 16 KiB');
  if (!Array.isArray(args) || args.length > 16 || args.some(a => typeof a !== 'string' || a.includes('\0') || Buffer.byteLength(a) > 1024)) {
    throw new InputError('args must contain at most 16 strings, each at most 1024 bytes, without NUL characters');
  }
  const springBoot = /\borg\.springframework\./.test(code);
  // Component scanning from the default package would scan every jar on the classpath.
  if (springBoot && /@(SpringBootApplication|ComponentScan)\b/.test(code) && !/^\s*package\s+[\w.$]+\s*;/m.test(code)) {
    throw new InputError('Spring Boot applications must declare a package, for example "package demo;", with className demo.Main');
  }
  return { code, className, stdin, args, springBoot };
}

function stageStatus(stage, failure) {
  if (stage.cancelled) return 'cancelled';
  if (stage.timedOut) return 'timeout';
  if (stage.outputLimitExceeded) return 'output_limit';
  return stage.exitCode === 0 ? 'success' : failure;
}

export class JavaRunner {
  constructor(config, runProcess = execute) {
    this.config = config;
    this.runProcess = runProcess;
    this.healthy = true;
  }

  async check() {
    const c = this.config;
    for (const command of [c.java, c.javac]) {
      const result = await this.runProcess(command, ['-version'], { timeoutMs: 5000 });
      if (result.exitCode !== 0 || !/\b17(?:\.|\b)/.test(result.stdout + result.stderr)) {
        throw new Error('JAVA_HOME must contain Java and javac version 17');
      }
    }
    if (c.mode === 'cloud-run') {
      await access(c.sandbox); // Fail closed: never fall back to ordinary child execution.
      await access(c.springBootLib); // The image must ship the Spring Boot jars.
      await access(c.springBootProjectLib);
      // Exercise actual sandbox creation before the service is marked ready.
      const result = await this.runProcess(c.sandbox, ['do', '--', '/bin/true'], { timeoutMs: 10000 });
      if (result.exitCode !== 0) throw new Error(`Cloud Run sandbox startup failed: ${result.stderr}`);
    }
  }

  async run(submission, signal) {
    if (!this.healthy) throw new Error('Runner unavailable after sandbox cleanup failure');
    const c = this.config;
    const spring = submission.springBoot === true;
    if (spring) {
      try { await access(c.springBootLib); }
      catch { throw new InputError('Spring Boot libraries are not installed on this server'); }
    }
    const sandboxName = `java-${randomUUID()}`;
    const workspace = await mkdtemp(path.join(tmpdir(), 'webnest-java-'));
    const fileName = `${submission.className.split('.').at(-1)}.java`;
    // A sandbox has its own private /tmp, so in cloud mode the source and classes live only inside it.
    const classes = c.mode === 'cloud-run' ? '/tmp/classes' : path.join(workspace, 'classes');
    const source = c.mode === 'cloud-run' ? `/tmp/src/${fileName}` : path.join(workspace, fileName);
    // A trailing * is a JVM classpath wildcard, expanded by java/javac (no shell is involved).
    const classpath = spring ? [classes, path.join(c.springBootLib, '*')].join(path.delimiter) : classes;
    let sandboxAttempted = false;
    const cleanEnvironment = Object.fromEntries(Object.entries({
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: workspace, TMP: workspace, HOME: workspace, LANG: 'C.UTF-8',
    }).filter(([, value]) => value !== undefined));
    const runStage = (command, args, timeoutMs, input = '') => this.runProcess(
      c.mode === 'cloud-run' ? c.sandbox : command,
      c.mode === 'cloud-run' ? ['exec', sandboxName, '--', command, ...args] : args,
      // The sandbox CLI reuses its cwd inside the sandbox, where the host temp directory does not exist.
      { input, timeoutMs, outputLimitBytes: c.outputLimitBytes, signal,
        ...(c.mode === 'local' ? { cwd: workspace, env: cleanEnvironment } : {}) });
    try {
      if (c.mode === 'cloud-run') {
        sandboxAttempted = true;
        const setup = await this.runProcess(c.sandbox,
          ['run', '--write', sandboxName, '--detach', '--', '/bin/sleep', '60'],
          { timeoutMs: 10000, outputLimitBytes: c.outputLimitBytes, signal });
        if (setup.exitCode !== 0 || setup.timedOut || setup.cancelled) throw new Error(`Sandbox creation failed: ${setup.stderr}`);
        // Stream the source in through stdin; the file name is passed as an argument, never interpolated.
        const upload = await runStage('/bin/sh',
          ['-c', 'mkdir -p /tmp/src /tmp/classes && cat > "/tmp/src/$1"', 'sh', fileName], 10000, submission.code);
        if (upload.exitCode !== 0 || upload.timedOut || upload.cancelled) throw new Error(`Sandbox source upload failed: ${upload.stderr}`);
      } else {
        await mkdir(classes);
        await writeFile(source, submission.code, { encoding: 'utf8', mode: 0o644 });
      }
      const compile = await runStage(c.javac, [
        '-J-Xmx192m', '-J-XX:MaxMetaspaceSize=96m', '-J-XX:ActiveProcessorCount=1',
        '--release', '17', '-encoding', 'UTF-8', '-proc:none', '-Xlint:all',
        // Spring binds constructor and request parameters by name.
        ...(spring ? ['-parameters'] : []),
        '-classpath', classpath, '-d', classes, source,
      ], spring ? c.springCompileTimeoutMs : c.compileTimeoutMs);
      // Return stable source filenames rather than host temporary paths.
      for (const key of ['stdout', 'stderr']) compile[key] = compile[key].split(source).join(fileName);
      const compileStatus = stageStatus(compile, 'compile_error');
      if (compileStatus !== 'success') return { status: compileStatus, phase: 'compile', springBoot: spring, compile, run: null };
      const run = await runStage(c.java, [
        '-Xms16m', spring ? '-Xmx256m' : '-Xmx128m', '-Xss512k',
        spring ? '-XX:MaxMetaspaceSize=128m' : '-XX:MaxMetaspaceSize=64m',
        '-XX:MaxDirectMemorySize=32m', spring ? '-XX:ReservedCodeCacheSize=48m' : '-XX:ReservedCodeCacheSize=32m',
        '-XX:ActiveProcessorCount=1', '-XX:+UseSerialGC', '-XX:-UsePerfData', '-XX:+DisableAttachMechanism',
        '-XX:+ExitOnOutOfMemoryError', '-Dfile.encoding=UTF-8',
        // Faster startup for short Spring runs. No embedded web server by default: it would never exit,
        // so a run would always end in a timeout. Pass --spring.main.web-application-type=servlet to opt in.
        ...(spring ? ['-XX:TieredStopAtLevel=1', '-Dspring.main.web-application-type=none'] : []),
        '-cp', classpath, submission.className, ...submission.args,
      ], spring ? c.springRunTimeoutMs : c.runTimeoutMs, submission.stdin);
      return { status: stageStatus(run, 'runtime_error'), phase: 'run', springBoot: spring, compile, run };
    } finally {
      try {
        if (sandboxAttempted) {
          // Force-deleting the named sandbox kills every process, including the detached keep-alive.
          const cleanup = await this.runProcess(c.sandbox, ['delete', '--force', sandboxName], { timeoutMs: 5000 });
          if (cleanup.exitCode !== 0 || cleanup.timedOut) {
            this.healthy = false;
            throw new Error(`Sandbox cleanup failed: ${cleanup.stderr}`);
          }
        }
      } finally {
        await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
      }
    }
  }
}
