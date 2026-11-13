// File rules for Node.js submissions, shared by the server (src/node.js) and the sandbox-side
// writer (src/unpack.js). Kept free of other imports so unpack.js stays small.
const SEGMENT = /^[A-Za-z0-9_][\w.-]*$/;
export const NODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'json', 'html', 'css', 'txt', 'md', 'csv', 'sql']);
export const NODE_ENTRY_EXTENSIONS = new Set(['js', 'mjs', 'cjs']);

const extension = (name) => (name.includes('.') ? name.split('.').at(-1).toLowerCase() : '');

// A relative path of at most six folders, without "..", hidden folders or node_modules: the
// preinstalled packages are linked in as node_modules, so a project cannot replace them.
export function isNodePath(name) {
  if (typeof name !== 'string' || !name || name.length > 200) return false;
  const parts = name.split('/');
  if (parts.length > 7) return false;
  const file = parts.at(-1);
  if (parts.slice(0, -1).some((part) => !SEGMENT.test(part) || part.toLowerCase() === 'node_modules')) return false;
  if (file === '.env') return true;
  return SEGMENT.test(file) && file.toLowerCase() !== 'node_modules' && NODE_EXTENSIONS.has(extension(file));
}

export const isNodeEntry = (name) => isNodePath(name) && NODE_ENTRY_EXTENSIONS.has(extension(name));
