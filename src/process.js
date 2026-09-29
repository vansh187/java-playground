import { spawn } from 'node:child_process';

// No shell is involved. Source, stdin, and program arguments never become shell commands.
export function execute(command, args, { cwd, input = '', timeoutMs = 5000,
  outputLimitBytes = 65536, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd, env, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let reason = null;
    let bytes = 0;
    const stdout = [], stderr = [];
    const stop = (why) => {
      reason ||= why;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        const remaining = Math.max(0, outputLimitBytes - bytes);
        if (remaining) chunks.push(chunk.subarray(0, remaining));
        bytes += chunk.length;
        if (bytes > outputLimitBytes) stop('output_limit');
      });
    }
    child.stdin.on('error', () => {}); // A program may exit without consuming stdin.
    child.stdin.end(input);
    child.on('error', reject);
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal: exitSignal,
        timedOut: reason === 'timeout', outputLimitExceeded: reason === 'output_limit',
        cancelled: reason === 'cancelled', durationMs: Math.round(performance.now() - started) });
    });
  });
}
