// Runs inside the sandbox: writes the project files given as JSON on stdin under the directory in
// argv[2]. Each path is checked again here, so nothing can be written outside that directory.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isProjectPath } from './project.js';

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) {
  console.error('Usage: unpack.js <absolute directory>');
  process.exit(2);
}
let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const files = JSON.parse(text);
if (!Array.isArray(files)) throw new Error('Expected a list of files');
for (const file of files) {
  if (!isProjectPath(file?.path) || typeof file.content !== 'string') throw new Error('Invalid project file');
  const target = path.resolve(root, file.path);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid project path');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { encoding: 'utf8', mode: 0o644 });
}
await mkdir(path.join(root, 'classes'), { recursive: true });
