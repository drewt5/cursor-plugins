import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
export const hosts = ['codex', 'opencode', 'claude-code', 'cursor'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export function present(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['node_modules', '.git', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.log')) return [];
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${name}`);
    return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
  });
}
export function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}
export function safePath(root, name) {
  const path = resolve(root, name);
  if (isAbsolute(name) || path === root || !path.startsWith(root + sep)) throw new Error(`Invalid install path: ${name}`);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    const stat = present(parent);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${parent}`);
    if (stat && !stat.isDirectory()) throw new Error(`Install parent is not a directory: ${parent}`);
  }
  return path;
}
export function stateFrom(path) {
  if (!present(path)) return { version: 2, targets: [], entries: {} };
  if (!lstatSync(path).isFile()) throw new Error(`Install manifest is not a regular file: ${path}`);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (![1, 2].includes(state.version) || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object') throw new Error('Invalid pstack install manifest.');
  if (state.version === 1) state.targets = state.target === 'all' ? hosts.slice(0, 3) : [state.target];
  if (!Array.isArray(state.targets) || state.targets.some(target => !hosts.includes(target))) throw new Error('Invalid installed targets.');
  if (Object.keys(state.entries).some(name => name.startsWith('@opencode/')) && typeof state.opencodeRoot !== 'string') throw new Error('Invalid OpenCode install root.');
  for (const [name, entry] of Object.entries(state.entries)) {
    if (!entry || !['file', 'link'].includes(entry.kind) || (entry.kind === 'file' ? typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) : typeof entry.to !== 'string')) throw new Error(`Invalid manifest entry: ${name}`);
    if (entry.kind === 'file' && entry.mode !== undefined && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw new Error(`Invalid manifest mode: ${name}`);
  }
  return state;
}

export function pathFor(root, name, state) {
  return name.startsWith('@opencode/') ? safePath(resolve(root, state.opencodeRoot), name.slice('@opencode/'.length)) : safePath(root, name);
}
export function observe(path) {
  const stat = present(path);
  if (!stat) return { kind: 'absent' };
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return { kind: 'link', to: readlinkSync(path), mode };
  if (stat.isFile()) return { kind: 'file', hash: digest(readFileSync(path)), mode };
  return { kind: stat.isDirectory() ? 'directory' : 'other', mode };
}
export function installationSnapshot({ root, desired, statePath = safePath(root, '.pstack/install.json') }) {
  root = canonicalPath(root);
  const previous = stateFrom(statePath);
  const owned = Object.entries(previous.entries).map(([name, entry]) => ({ name, entry, path: pathFor(root, name, previous) }));
  const wanted = Object.entries(desired.entries).map(([name, entry]) => ({ name, entry, path: pathFor(root, name, desired) }));
  const paths = [...new Set([...owned, ...wanted].map(item => item.path))].sort();
  return { root, statePath, previous, targets: previous.targets, opencodeRoot: desired.opencodeRoot,
    owned, wanted, observed: Object.fromEntries(paths.map(path => [path, observe(path)])), receipt: observe(statePath) };
}
