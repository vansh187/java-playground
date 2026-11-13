// Runs inside the sandbox: writes the project files given as JSON on stdin under the directory in
// argv[2]. Each path is checked again here, so nothing can be written outside that directory.
// `unpack.js <dir>` writes a Spring Boot project; `unpack.js <dir> --node [<packages>]` writes a
// Node.js project and links the preinstalled packages in as its node_modules.
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { isProjectPath } from './project.js';
import { isNodePath } from './nodePaths.js';

const root = process.argv[2];
const node = process.argv[3] === '--node';
const libs = process.argv[4];
if (!root || !path.isAbsolute(root) || (libs !== undefined && !path.isAbsolute(libs))) {
  console.error('Usage: unpack.js <absolute directory> [--node [<absolute packages folder>]]');
  process.exit(2);
}
let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const files = JSON.parse(text);
if (!Array.isArray(files)) throw new Error('Expected a list of files');
const allowed = node ? isNodePath : isProjectPath;
await mkdir(root, { recursive: true });
for (const file of files) {
  if (!allowed(file?.path) || typeof file.content !== 'string') throw new Error('Invalid project file');
  const target = path.resolve(root, file.path);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid project path');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, file.content, { encoding: 'utf8', mode: 0o644 });
}
if (!node) await mkdir(path.join(root, 'classes'), { recursive: true });
// Beside the project, not in it: only the project folder is writable (see src/node.js).
else if (libs) await symlink(path.join(libs, 'node_modules'), path.join(path.dirname(root), 'node_modules'), 'junction');
