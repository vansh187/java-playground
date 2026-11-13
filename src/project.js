import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InputError } from './runner.js';

// A Spring Boot project: several source files and a few resources, started as a web server so the
// requests in the submission can be sent to it. The app lives only for one submission.
const JAVA_PATH = /^src\/main\/java\/(?:[A-Za-z_$][\w$]*\/)*[A-Za-z_$][\w$]*\.java$/;
const RESOURCE_PATH = /^src\/main\/resources\/(?:application\.properties|data\.sql|schema\.sql)$/;
const CLASS_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
export const PROJECT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
// Set by the client for each request, or meaningless inside the sandbox.
const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect', 'te', 'trailer']);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const unpackScript = fileURLToPath(new URL('./unpack.js', import.meta.url));
const probeScript = fileURLToPath(new URL('./probe.js', import.meta.url));

export const isProjectPath = (name) => typeof name === 'string' && (JAVA_PATH.test(name) || RESOURCE_PATH.test(name));

function validateRequest(request, index, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new InputError(`requests[${index}] must be an object`);
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!PROJECT_METHODS.has(method)) throw new InputError(`requests[${index}].method must be GET, POST, PUT, PATCH or DELETE`);
  const target = request.path;
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//') || target.length > 2048 || /[\s\0]/.test(target)) {
    throw new InputError(`requests[${index}].path must start with / and contain no spaces`);
  }
  const headers = {};
  const given = request.headers ?? {};
  if (typeof given !== 'object' || Array.isArray(given) || Object.keys(given).length > 20) throw new InputError(`requests[${index}].headers must be an object with at most 20 entries`);
  for (const [name, value] of Object.entries(given)) {
    if (!HEADER_NAME.test(name) || typeof value !== 'string' || value.length > 1024 || /[\r\n\0]/.test(value)) {
      throw new InputError(`requests[${index}].headers has an invalid header`);
    }
    if (!DROPPED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  const body = request.body ?? null;
  if (body !== null && (typeof body !== 'string' || Buffer.byteLength(body) > config.projectRequestBodyLimitBytes)) {
    throw new InputError(`requests[${index}].body must be a string of at most ${config.projectRequestBodyLimitBytes / 1024} KiB`);
  }
  return { method, path: target, headers, body };
}

export function validateProject(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object');
  const { files, mainClass, requests = [] } = body;
  if (!Array.isArray(files) || !files.length || files.length > config.projectFileLimit) {
    throw new InputError(`files must list between 1 and ${config.projectFileLimit} files`);
  }
  const seen = new Set();
  let total = 0;
  const clean = files.map((file, index) => {
    if (!file || typeof file !== 'object' || !isProjectPath(file.path) || typeof file.content !== 'string') {
      throw new InputError(`files[${index}] must have a path under src/main/java (.java) or src/main/resources (application.properties, data.sql, schema.sql), and string content`);
    }
    if (seen.has(file.path)) throw new InputError(`files[${index}].path is listed twice`);
    seen.add(file.path);
    total += Buffer.byteLength(file.content);
    return { path: file.path, content: file.content };
  });
  if (total > config.projectCodeLimitBytes) throw new InputError(`files exceed ${config.projectCodeLimitBytes / 1024} KiB in total`);
  if (!clean.some((file) => file.path.endsWith('.java'))) throw new InputError('files must include at least one .java file');
  if (typeof mainClass !== 'string' || mainClass.length > 160 || !CLASS_NAME.test(mainClass)) {
    throw new InputError('mainClass must be a class name, for example com.example.demo.DemoApplication');
  }
  if (!mainClass.includes('.')) throw new InputError('mainClass must be in a package, for example com.example.demo.DemoApplication');
  if (!seen.has(`src/main/java/${mainClass.replaceAll('.', '/')}.java`)) {
    throw new InputError(`mainClass ${mainClass} must match a file, src/main/java/${mainClass.replaceAll('.', '/')}.java`);
  }
  return { files: clean, mainClass, requests: validateProjectRequests(requests, config) };
}

// The requests to send to a started app; shared with Node.js projects (src/node.js).
export function validateProjectRequests(requests, config) {
  if (!Array.isArray(requests) || requests.length > config.projectRequestLimit) {
    throw new InputError(`requests must be a list of at most ${config.projectRequestLimit} requests`);
  }
  return requests.map((request, index) => validateRequest(request, index, config));
}

const stageStatus = (stage, failure) => {
  if (stage.cancelled) return 'cancelled';
  if (stage.timedOut) return 'timeout';
  if (stage.outputLimitExceeded) return 'output_limit';
  return stage.exitCode === 0 ? 'success' : failure;
};

// The probe's report: one JSON line per event. A line cut off when it was stopped is skipped.
export function parseProbe(stage) {
  const report = { ready: false, readyMs: null, responses: [], done: false, timedOut: false, error: null };
  for (const line of stage.stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'ready') {
      report.ready = true;
      report.readyMs = event.readyMs;
    } else if (event?.type === 'response') {
      const { type, ...response } = event;
      report.responses.push(response);
    } else if (event?.type === 'done') {
      report.done = true;
      report.timedOut = Boolean(event.timedOut);
    } else if (event?.type === 'error') {
      report.error = String(event.message ?? 'unknown error').slice(0, 300);
    }
  }
  return report;
}

// Compiles the project, starts it, sends the requests in order, then stops it. `runner` is the
// JavaRunner: they share the sandbox, the process runner and the health flag.
export async function runProject(runner, submission, signal) {
  if (!runner.healthy) throw new Error('Runner unavailable after sandbox cleanup failure');
  const c = runner.config;
  try { await access(c.springBootProjectLib); }
  catch { throw new InputError('Spring Boot libraries are not installed on this server'); }
  // Every stage gets at most the time left before this deadline.
  const deadline = Date.now() + c.projectTotalTimeoutMs;
  const left = (limitMs) => Math.max(1, Math.min(limitMs, deadline - Date.now()));
  const cloud = c.mode === 'cloud-run';
  const sandboxName = `spring-${randomUUID()}`;
  const workspace = await mkdtemp(path.join(tmpdir(), 'webnest-spring-'));
  // A sandbox has its own private /tmp, so in cloud mode the project lives only inside it.
  const root = cloud ? '/tmp/project' : path.join(workspace, 'project');
  const at = (relative) => (cloud ? `${root}/${relative}` : path.join(root, ...relative.split('/')));
  const classes = at('classes');
  const classpath = [classes, at('src/main/resources'), path.join(c.springBootProjectLib, '*')].join(path.delimiter);
  const port = randomInt(20000, 30000);
  const cleanEnvironment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: workspace, TMP: workspace, HOME: workspace, LANG: 'C.UTF-8',
  }).filter(([, value]) => value !== undefined));
  let sandboxAttempted = false;
  const runStage = (command, args, { timeoutMs, input = '', outputLimitBytes = c.outputLimitBytes, stageSignal = signal }) => runner.runProcess(
    cloud ? c.sandbox : command,
    cloud ? ['exec', sandboxName, '--', command, ...args] : args,
    { input, timeoutMs, outputLimitBytes, signal: stageSignal, ...(cloud ? {} : { cwd: workspace, env: cleanEnvironment }) });

  try {
    if (cloud) {
      sandboxAttempted = true;
      const setup = await runner.runProcess(c.sandbox,
        ['run', '--write', sandboxName, '--detach', '--', '/bin/sleep', String(Math.ceil(c.projectSandboxLifetimeMs / 1000))],
        { timeoutMs: 10000, outputLimitBytes: c.outputLimitBytes, signal });
      if (setup.exitCode !== 0 || setup.timedOut || setup.cancelled) throw new Error(`Sandbox creation failed: ${setup.stderr}`);
      // The files arrive as JSON on stdin and are written by a script that checks every path again.
      const upload = await runStage(process.execPath, [unpackScript, root], { timeoutMs: left(15000), input: JSON.stringify(submission.files) });
      if (upload.exitCode !== 0 || upload.timedOut || upload.cancelled) throw new Error(`Sandbox upload failed: ${upload.stderr}`);
    } else {
      for (const file of submission.files) {
        if (!isProjectPath(file.path)) throw new InputError('Invalid project path');
        await mkdir(path.dirname(at(file.path)), { recursive: true });
        await writeFile(at(file.path), file.content, { encoding: 'utf8', mode: 0o644 });
      }
      await mkdir(classes, { recursive: true });
    }

    const sources = submission.files.filter((file) => file.path.endsWith('.java')).map((file) => at(file.path));
    const compile = await runStage(c.javac, [
      '-J-Xmx256m', '-J-XX:MaxMetaspaceSize=128m', `-J-XX:ActiveProcessorCount=${c.projectCpus}`,
      // No -Xlint:all here: like a Maven build, so learners only see the warnings that matter.
      '--release', '17', '-encoding', 'UTF-8', '-proc:none', '-parameters',
      '-classpath', classpath, '-d', classes, ...sources,
    ], { timeoutMs: left(c.projectCompileTimeoutMs) });
    // Show the project's own paths, not where it was written.
    const prefix = cloud ? `${root}/` : `${root}${path.sep}`;
    for (const key of ['stdout', 'stderr']) {
      compile[key] = compile[key].split(prefix).join('');
      if (!cloud) compile[key] = compile[key].replaceAll('\\', '/');
    }
    const compileStatus = stageStatus(compile, 'compile_error');
    if (compileStatus !== 'success') {
      return { status: compileStatus, phase: 'compile', springBoot: true, compile, startup: null, app: null, responses: [] };
    }

    // The app and the probe run side by side: the probe waits for the port, sends the requests,
    // then the app is stopped. If the app exits first, the probe is stopped instead. Both get
    // what is left of the deadline.
    const appBudgetMs = left(c.projectAppTimeoutMs);
    if (appBudgetMs < 5000) {
      return { status: 'timeout', phase: 'startup', springBoot: true, compile, startup: { ready: false, ms: null }, app: null, responses: [] };
    }
    const stopApp = new AbortController();
    const stopProbe = new AbortController();
    const appSignal = signal ? AbortSignal.any([signal, stopApp.signal]) : stopApp.signal;
    const probeSignal = signal ? AbortSignal.any([signal, stopProbe.signal]) : stopProbe.signal;
    // Which of the two finished first decides whether the app stopped by itself.
    let probeFinished = false;
    let appStoppedEarly = false;
    const app = runStage(c.java, [
      '-Xms32m', `-Xmx${c.projectHeapMb}m`, '-XX:MaxMetaspaceSize=192m', '-Xss512k',
      '-XX:MaxDirectMemorySize=64m', '-XX:ReservedCodeCacheSize=64m', `-XX:ActiveProcessorCount=${c.projectCpus}`,
      '-XX:TieredStopAtLevel=1', '-XX:+UseSerialGC', '-XX:-UsePerfData', '-XX:+DisableAttachMechanism',
      '-XX:+ExitOnOutOfMemoryError', '-Dfile.encoding=UTF-8',
      '-cp', classpath, submission.mainClass,
      // Command-line properties win over application.properties, so these cannot be changed by the project.
      `--server.port=${port}`, '--server.address=127.0.0.1', '--spring.main.web-application-type=servlet',
      '--spring.datasource.url=jdbc:h2:mem:app;DB_CLOSE_DELAY=-1', '--spring.datasource.username=sa',
      '--spring.datasource.password=', '--spring.h2.console.enabled=false',
      '--spring.jpa.open-in-view=false', '--spring.main.banner-mode=off',
      // Short log lines (time, level, class, message), so the message fits in a narrow panel.
      '--logging.pattern.console=%d{HH:mm:ss.SSS} %-5level %logger{0} : %msg%n',
    ], { timeoutMs: appBudgetMs, stageSignal: appSignal }).then((result) => {
      if (!probeFinished) appStoppedEarly = true;
      stopProbe.abort();
      return result;
    });
    const probe = runStage(process.execPath, [probeScript], {
      timeoutMs: appBudgetMs,
      outputLimitBytes: c.projectProbeOutputLimitBytes,
      stageSignal: probeSignal,
      input: JSON.stringify({
        // The probe stops itself a little before the app's own limit, so its report arrives.
        port, requests: submission.requests, totalTimeoutMs: appBudgetMs - 2000, readyTimeoutMs: c.projectReadyTimeoutMs,
        requestTimeoutMs: c.projectRequestTimeoutMs, requestsTimeoutMs: c.projectRequestsTimeoutMs,
        responseBodyLimitBytes: c.projectResponseBodyLimitBytes,
      }),
    }).then((result) => {
      probeFinished = true;
      stopApp.abort();
      return result;
    });
    const [probeStage, appStage] = await Promise.all([probe, app]);
    const report = parseProbe(probeStage);
    // A probe that broke is a fault in this service, not in the learner's app.
    if (report.error && !report.done && !signal?.aborted) throw new Error(`Request probe failed: ${report.error}`);
    const startup = { ready: report.ready, ms: report.readyMs };
    const appResult = {
      stdout: appStage.stdout, stderr: appStage.stderr, exitCode: appStage.exitCode,
      timedOut: appStage.timedOut, outputLimitExceeded: appStage.outputLimitExceeded,
    };
    const done = (status, phase) => ({ status, phase, springBoot: true, compile, startup, app: appResult, responses: report.responses });

    if (signal?.aborted) return done('cancelled', startup.ready ? 'requests' : 'startup');
    if (appStage.outputLimitExceeded) return done('output_limit', startup.ready ? 'requests' : 'startup');
    if (!startup.ready) return done(appStoppedEarly && !appStage.timedOut ? 'startup_error' : 'timeout', 'startup');
    if (probeStage.outputLimitExceeded) return done('output_limit', 'requests');
    if (appStoppedEarly && !report.done) return done(appStage.timedOut ? 'timeout' : 'runtime_error', 'requests');
    if (probeStage.timedOut || report.timedOut || !report.done) return done('timeout', 'requests');
    return done('success', 'requests');
  } finally {
    try {
      if (sandboxAttempted) {
        // Force-deleting the named sandbox kills every process, including the app and the keep-alive.
        const cleanup = await runner.runProcess(c.sandbox, ['delete', '--force', sandboxName], { timeoutMs: 5000 });
        if (cleanup.exitCode !== 0 || cleanup.timedOut) {
          runner.healthy = false;
          throw new Error(`Sandbox cleanup failed: ${cleanup.stderr}`);
        }
      }
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
