import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const javaHome = process.env.JAVA_HOME || (process.platform === 'win32' &&
  existsSync('C:\\Program Files\\Java\\jdk-17') ? 'C:\\Program Files\\Java\\jdk-17' : '');
console.log('Local development: run only trusted code. Open http://127.0.0.1:8080');
const child = spawn(process.execPath, ['src/server.js'], {
  stdio: 'inherit', env: { ...process.env, JAVA_HOME: javaHome, EXECUTION_MODE: 'local' },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
