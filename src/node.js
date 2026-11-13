import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { InputError } from './runner.js';
import { validateProjectRequests, parseProbe } from './project.js';
import { isNodePath, isNodeEntry } from './nodePaths.js';

// Node.js submissions: a script that runs once (POST /api/node/run), or an Express app that is
// started, sent the requests in the submission, then stopped (POST /api/node/project/run). Both
// run in the same sandbox as Java with the preinstalled packages (config.nodeLibs) linked in as
// node_modules; nothing is installed per run and there is no network.
const unpackScript = fileURLToPath(new URL('./unpack.js', import.meta.url));
const probeScript = fileURLToPath(new URL('./probe.js', import.meta.url));
const listenScript = fileURLToPath(new URL('./nodeListen.cjs', import.meta.url));
const stdinScript = fileURLToPath(new URL('./nodeStdin.cjs', import.meta.url));
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

let packagesCache = null;
// The preinstalled packages as { name: version }, read once from the packages folder. A missing
// folder means none are installed: scripts that use only Node's own modules still run.
export async function nodePackages(config) {
  if (packagesCache?.dir === config.nodeLibs) return packagesCache.packages;
  let packages = {};
  try {
    const manifest = JSON.parse(await readFile(path.join(config.nodeLibs, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(path.join(config.nodeLibs, 'package-lock.json'), 'utf8').catch(() => '{}'));
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      // A local stand-in (file:local/...) is a link in the lock; its version is on the target.
      const entry = lock.packages?.[`node_modules/${name}`];
      packages[name] = (entry?.link ? lock.packages?.[entry.resolved]?.version : entry?.version) ?? manifest.dependencies[name];
    }
    await access(path.join(config.nodeLibs, 'node_modules'));
  } catch {
    packages = {};
  }
  packagesCache = { dir: config.nodeLibs, packages };
  return packages;
}

function validateFiles(files, config) {
  if (!Array.isArray(files) || !files.length || files.length > config.nodeFileLimit) {
    throw new InputError(`files must list between 1 and ${config.nodeFileLimit} files`);
  }
  const seen = new Set();
  let total = 0;
  const clean = files.map((file, index) => {
    if (!file || typeof file !== 'object' || !isNodePath(file.path) || typeof file.content !== 'string') {
      throw new InputError(`files[${index}] must have a relative path ending in .js, .mjs, .cjs, .json, .html, .css, .txt, .md, .csv or .sql (not inside node_modules), and string content`);
    }
    if (seen.has(file.path)) throw new InputError(`files[${index}].path is listed twice`);
    seen.add(file.path);
    total += Buffer.byteLength(file.content);
    return { path: file.path, content: file.content };
  });
  if (total > config.nodeCodeLimitBytes) throw new InputError(`files exceed ${config.nodeCodeLimitBytes / 1024} KiB in total`);
  return { files: clean, seen };
}

function validateEntry(entry, seen) {
  if (!isNodeEntry(entry)) throw new InputError('entry must be a .js, .mjs or .cjs file, for example main.js');
  if (!seen.has(entry)) throw new InputError(`entry ${entry} must be one of the files`);
  return entry;
}

// The packages a project's package.json asks for, so ones that are not installed can be named
// before anything runs. A package.json that is not valid JSON is left for Node to report.
function requestedPackages(files) {
  const manifest = files.find((file) => file.path === 'package.json');
  if (!manifest) return [];
  try {
    const parsed = JSON.parse(manifest.content);
    return [...new Set(['dependencies', 'devDependencies'].flatMap((key) => (
      parsed?.[key] && typeof parsed[key] === 'object' && !Array.isArray(parsed[key]) ? Object.keys(parsed[key]) : [])))];
  } catch {
    return [];
  }
}

export function validateNodeScript(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object');
  const { entry = 'main.js', stdin = '' } = body;
  const { files, seen } = validateFiles(body.files, config);
  if (typeof stdin !== 'string' || Buffer.byteLength(stdin) > config.stdinLimitBytes) throw new InputError('stdin must be a string of at most 16 KiB');
  return { files, entry: validateEntry(entry, seen), stdin };
}

export function validateNodeProject(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Expected a JSON object');
  const { entry = 'server.js', requests = [] } = body;
  const { files, seen } = validateFiles(body.files, config);
  return { files, entry: validateEntry(entry, seen), requests: validateProjectRequests(requests, config) };
}

const stageStatus = (stage, failure) => {
  if (stage.cancelled) return 'cancelled';
  if (stage.timedOut) return 'timeout';
  if (stage.outputLimitExceeded) return 'output_limit';
  return stage.exitCode === 0 ? 'success' : failure;
};

// Module names in "Cannot find module/package 'x'" errors that are packages, not the project's own files.
function missingFromError(text, packages) {
  const names = new Set();
  for (const match of text.matchAll(/Cannot find (?:module|package) '([^']+)'/g)) {
    const specifier = match[1];
    if (/^[./]/.test(specifier) || /^[A-Za-z]:[\\/]/.test(specifier) || BUILTINS.has(specifier)) continue;
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (!Object.hasOwn(packages, name)) names.add(name);
  }
  return [...names];
}

// One sandbox (or, locally, one temporary folder) holding the project, for the life of `work`.
async function withProject(runner, submission, signal, lifetimeMs, work) {
  if (!runner.healthy) throw new Error('Runner unavailable after sandbox cleanup failure');
  const c = runner.config;
  const cloud = c.mode === 'cloud-run';
  const packages = await nodePackages(c);
  const linked = Object.keys(packages).length > 0;
  const sandboxName = `node-${randomUUID()}`;
  const workspace = await mkdtemp(path.join(tmpdir(), 'webnest-node-'));
  // A sandbox has its own private /tmp, so in cloud mode the project lives only inside it. The
  // learner's files are in <base>/app and the packages are linked in beside it as
  // <base>/node_modules: Node still finds them by walking up, but only app/ is writable, so a
  // program cannot change the shared packages through the link.
  const base = cloud ? '/tmp/project' : path.join(workspace, 'project');
  const root = cloud ? `${base}/app` : path.join(base, 'app');
  const cleanEnvironment = Object.fromEntries(Object.entries({
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    TEMP: workspace, TMP: workspace, HOME: workspace, LANG: 'C.UTF-8',
  }).filter(([, value]) => value !== undefined));
  let sandboxAttempted = false;
  // The sandbox CLI keeps the server's working folder, so the shell moves into the project first.
  const runStage = (command, args, { timeoutMs, input = '', env = {}, outputLimitBytes = c.outputLimitBytes, stageSignal = signal, inProject = false }) => {
    const variables = Object.entries(env).map(([name, value]) => `${name}=${value}`);
    if (cloud) {
      const inner = inProject ? ['/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', root] : [];
      return runner.runProcess(c.sandbox, ['exec', sandboxName, '--', ...(variables.length ? ['/usr/bin/env', ...variables] : []), ...inner, command, ...args],
        { input, timeoutMs, outputLimitBytes, signal: stageSignal });
    }
    return runner.runProcess(command, args, { input, timeoutMs, outputLimitBytes, signal: stageSignal,
      cwd: inProject ? root : workspace, env: { ...cleanEnvironment, ...env } });
  };
  try {
    if (cloud) {
      sandboxAttempted = true;
      const setup = await runner.runProcess(c.sandbox,
        ['run', '--write', sandboxName, '--detach', '--', '/bin/sleep', String(Math.ceil(lifetimeMs / 1000))],
        { timeoutMs: 10000, outputLimitBytes: c.outputLimitBytes, signal });
      if (setup.exitCode !== 0 || setup.timedOut || setup.cancelled) throw new Error(`Sandbox creation failed: ${setup.stderr}`);
      const upload = await runStage(process.execPath, [unpackScript, root, '--node', ...(linked ? [c.nodeLibs] : [])],
        { timeoutMs: 15000, input: JSON.stringify(submission.files) });
      if (upload.exitCode !== 0 || upload.timedOut || upload.cancelled) throw new Error(`Sandbox upload failed: ${upload.stderr}`);
    } else {
      for (const file of submission.files) {
        if (!isNodePath(file.path)) throw new InputError('Invalid project path');
        const target = path.join(root, ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { encoding: 'utf8', mode: 0o644 });
      }
      await mkdir(root, { recursive: true });
      if (linked) await symlink(path.join(c.nodeLibs, 'node_modules'), path.join(base, 'node_modules'), 'junction');
    }
    // Node's permission model as a second wall inside the sandbox: files only in the project
    // (and reading the packages), no child processes, workers or native addons.
    const nodeArgs = (extra = []) => [
      '--permission', `--allow-fs-read=${base}`, `--allow-fs-write=${root}`,
      ...(linked ? [`--allow-fs-read=${c.nodeLibs}`] : []), ...extra.flatMap((file) => [`--allow-fs-read=${file}`]),
      `--max-old-space-size=${c.nodeHeapMb}`, '--disable-warning=ExperimentalWarning',
    ];
    // Show the project's own paths, not where it was written.
    const tidy = (stage) => {
      const prefixes = [`${root}/`, `${root}${path.sep}`, ...(cloud ? [] : [`file:///${root.replaceAll('\\', '/')}/`])];
      for (const key of ['stdout', 'stderr']) {
        for (const prefix of prefixes) stage[key] = stage[key].split(prefix).join('');
        if (cloud) stage[key] = stage[key].split(`file://${root}/`).join('');
      }
      return stage;
    };
    return await work({ c, root, packages, runStage, nodeArgs, tidy });
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

const missingPackages = async (config, files) => {
  const packages = await nodePackages(config);
  // Node's own modules (fs, node:fs) need no package; names like "constructor" are just names.
  return requestedPackages(files).filter((name) => !BUILTINS.has(name) && !Object.hasOwn(packages, name));
};

// Runs a script once with its stdin, like the Java /api/run.
export async function runNodeScript(runner, submission, signal) {
  const missing = await missingPackages(runner.config, submission.files);
  if (missing.length) return { status: 'package_error', phase: 'install', runtime: 'node', nodeVersion: process.version, missing, compile: null, run: null };
  return withProject(runner, submission, signal, runner.config.nodeRunTimeoutMs + 20000, async ({ c, root, packages, runStage, nodeArgs, tidy }) => {
    const run = tidy(await runStage(process.execPath, [...nodeArgs([stdinScript]), '--require', stdinScript, path.posix.join(...(c.mode === 'cloud-run' ? [root] : []), submission.entry)],
      { timeoutMs: c.nodeRunTimeoutMs, input: submission.stdin, inProject: true }));
    const missingNow = missingFromError(run.stderr, packages);
    return { status: stageStatus(run, 'runtime_error'), phase: 'run', runtime: 'node', nodeVersion: process.version,
      ...(missingNow.length ? { missing: missingNow } : {}), compile: null, run };
  });
}

// Starts an Express (or any Node HTTP) app, sends the requests in order, then stops it, like the
// Spring Boot /api/project/run. The app gets PORT, and nodeListen.cjs makes its first server
// listen there on 127.0.0.1 whatever port the code asks for.
export async function runNodeProject(runner, submission, signal) {
  const missing = await missingPackages(runner.config, submission.files);
  const base = { runtime: 'node', nodeVersion: process.version, compile: null };
  if (missing.length) return { status: 'package_error', phase: 'install', ...base, missing, startup: null, app: null, responses: [] };
  const c = runner.config;
  const deadline = Date.now() + c.nodeTotalTimeoutMs;
  const left = (limitMs) => Math.max(1, Math.min(limitMs, deadline - Date.now()));
  return withProject(runner, submission, signal, c.nodeSandboxLifetimeMs, async ({ root, packages, runStage, nodeArgs, tidy }) => {
    const appBudgetMs = left(c.nodeAppTimeoutMs);
    if (appBudgetMs < 5000) return { status: 'timeout', phase: 'startup', ...base, startup: { ready: false, ms: null }, app: null, responses: [] };
    const port = randomInt(20000, 30000);
    const stopApp = new AbortController();
    const stopProbe = new AbortController();
    const appSignal = signal ? AbortSignal.any([signal, stopApp.signal]) : stopApp.signal;
    const probeSignal = signal ? AbortSignal.any([signal, stopProbe.signal]) : stopProbe.signal;
    let probeFinished = false;
    let appStoppedEarly = false;
    const entry = c.mode === 'cloud-run' ? path.posix.join(root, submission.entry) : submission.entry;
    const app = runStage(process.execPath, [...nodeArgs([listenScript]), '--require', listenScript, entry],
      { timeoutMs: appBudgetMs, stageSignal: appSignal, inProject: true, env: { PORT: String(port), NODE_ENV: 'development' } }).then((result) => {
      if (!probeFinished) appStoppedEarly = true;
      stopProbe.abort();
      return result;
    });
    const probe = runStage(process.execPath, [probeScript], {
      timeoutMs: appBudgetMs, outputLimitBytes: c.projectProbeOutputLimitBytes, stageSignal: probeSignal,
      input: JSON.stringify({
        port, requests: submission.requests, totalTimeoutMs: appBudgetMs - 2000, readyTimeoutMs: c.nodeReadyTimeoutMs,
        requestTimeoutMs: c.projectRequestTimeoutMs, requestsTimeoutMs: c.projectRequestsTimeoutMs,
        responseBodyLimitBytes: c.projectResponseBodyLimitBytes,
      }),
    }).then((result) => {
      probeFinished = true;
      stopApp.abort();
      return result;
    });
    const [probeStage, appStage] = await Promise.all([probe, app]);
    tidy(appStage);
    const report = parseProbe(probeStage);
    if (report.error && !report.done && !signal?.aborted) throw new Error(`Request probe failed: ${report.error}`);
    const startup = { ready: report.ready, ms: report.readyMs };
    const missingNow = missingFromError(appStage.stderr, packages);
    const appResult = {
      stdout: appStage.stdout, stderr: appStage.stderr, exitCode: appStage.exitCode,
      timedOut: appStage.timedOut, outputLimitExceeded: appStage.outputLimitExceeded,
    };
    const done = (status, phase) => ({ status, phase, ...base, ...(missingNow.length ? { missing: missingNow } : {}),
      startup, app: appResult, responses: report.responses });
    if (signal?.aborted) return done('cancelled', startup.ready ? 'requests' : 'startup');
    if (appStage.outputLimitExceeded) return done('output_limit', startup.ready ? 'requests' : 'startup');
    if (!startup.ready) return done(appStoppedEarly && !appStage.timedOut ? 'startup_error' : 'timeout', 'startup');
    if (probeStage.outputLimitExceeded) return done('output_limit', 'requests');
    if (appStoppedEarly && !report.done) return done(appStage.timedOut ? 'timeout' : 'runtime_error', 'requests');
    if (probeStage.timedOut || report.timedOut || !report.done) return done('timeout', 'requests');
    return done('success', 'requests');
  });
}
