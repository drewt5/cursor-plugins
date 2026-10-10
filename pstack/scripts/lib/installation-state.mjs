import { validateGeneration } from './generation-contract.mjs';
import { validateProvenance } from './package-provenance.mjs';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
export const hosts = ['codex', 'opencode', 'claude-code', 'cursor'];
export const digest = value => createHash('sha256').update(value).digest('hex');
export function present(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function isPackagePath(name) {
  return !name.split(/[\\/]/).some(part => ['node_modules', '.git', '.DS_Store', '.pstack', '.cache'].includes(part)) && !name.endsWith('.log') && name !== 'pstack-provenance.json';
}
export function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = join(prefix, entry.name);
    if (!isPackagePath(name)) return [];
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${name}`);
    return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
  });
}
export function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}
export function installationPath(root, name) {
  const path = resolve(root, name);
  if (isAbsolute(name) || path === root || !path.startsWith(root + sep)) throw new Error(`Invalid install path: ${name}`);
  return path;
}
export function safePath(root, name) {
  const path = installationPath(root, name);
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
  return parseInstallationState(readFileSync(path, 'utf8'));
}
export function parseInstallationState(bytes) {
  const state = JSON.parse(bytes);
  if (![1, 2, 3, 4].includes(state.version) || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object') throw new Error('Invalid pstack install manifest.');
  if (state.version >= 3) {
    validateProvenance(state.provenance);
    if (!Array.isArray(state.hostObservations) || state.hostObservations.length > 3 || new Set(state.hostObservations.map(item => item?.host)).size !== state.hostObservations.length || state.hostObservations.some(item => !item || Object.keys(item).some(key => !['host', 'version', 'status'].includes(key)) || !hosts.slice(0, 3).includes(item.host) || !state.targets.includes(item.host) || !['observed', 'unavailable'].includes(item.status) || item.version !== null && (typeof item.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version)))) throw new Error('Invalid installed host observations');
  }
  if (state.version === 4) {
    validateGeneration(state.generation);
    if (!/^[a-f0-9]{64}$/.test(state.renderingFingerprint) || Object.keys(state.entries).some(name => name.startsWith('.pstack/package/')) || state.entries['.pstack/package']?.kind !== 'link' || state.entries['.pstack/package'].to !== `releases/${state.generation.digest}` || JSON.stringify(state.provenance) !== JSON.stringify(state.generation.provenance)) throw new Error('Invalid retained installation receipt');
  }
  if (state.version === 1) state.targets = state.target === 'all' ? hosts.slice(0, 3) : [state.target];
  if (!Array.isArray(state.targets) || state.targets.some(target => !hosts.includes(target))) throw new Error('Invalid installed targets.');
  if (Object.keys(state.entries).some(name => name.startsWith('@opencode/')) && typeof state.opencodeRoot !== 'string') throw new Error('Invalid OpenCode install root.');
  for (const [name, entry] of Object.entries(state.entries)) {
    if (!entry || !['file', 'link'].includes(entry.kind) || (entry.kind === 'file' ? typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) : typeof entry.to !== 'string')) throw new Error(`Invalid manifest entry: ${name}`);
    if (entry.kind === 'file' && entry.mode !== undefined && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) throw new Error(`Invalid manifest mode: ${name}`);
  }
  return state;
}

export function pathFor(root, name, state, inspectParents = true) {
  const locate = inspectParents ? safePath : installationPath;
  if (!name.startsWith('@opencode/')) return locate(root, name);
  const base = resolve(root, state.opencodeRoot);
  if (inspectParents && canonicalPath(base) !== base) throw new Error(`Refusing changed or symlinked OpenCode root: ${base}`);
  return locate(base, name.slice('@opencode/'.length));
}
export function observe(path) {
  const stat = present(path);
  if (!stat) return { kind: 'absent' };
  const mode = stat.mode & 0o777;
  if (stat.isSymbolicLink()) return { kind: 'link', to: readlinkSync(path), mode };
  if (stat.isFile()) return { kind: 'file', hash: digest(readFileSync(path)), mode };
  return { kind: stat.isDirectory() ? 'directory' : 'other', mode };
}
export function installationSnapshot({ root, desired, includeEntry = () => true, statePath = safePath(root, '.pstack/install.json') }) {
  root = canonicalPath(root);
  const previous = stateFrom(statePath);
  const owned = Object.entries(previous.entries).filter(([name]) => includeEntry(name)).map(([name, entry]) => ({ name, entry, path: pathFor(root, name, previous, false) }));
  const wanted = Object.entries(desired.entries).filter(([name]) => includeEntry(name)).map(([name, entry]) => ({ name, entry, path: pathFor(root, name, desired, false) }));
  const paths = [...new Set([...owned, ...wanted].map(item => item.path))].sort();
  const observed = {};
  for (const path of paths) {
    const item = wanted.find(item => item.path === path) ?? owned.find(item => item.path === path);
    const state = wanted.includes(item) ? desired : previous;
    try { pathFor(root, item.name, state); observed[path] = observe(path); }
    catch (error) { observed[path] = { kind: 'unsafe-parent', error: error.message }; }
  }
  return { root, statePath, previous, targets: previous.targets, opencodeRoot: desired.opencodeRoot,
    owned, wanted, observed, receipt: observe(statePath) };
}

export function entryOwner(name) {
  if (name.startsWith('.agents/')) return 'codex';
  if (name.startsWith('@opencode/') || name.startsWith('.opencode/') || name === '.pstack/opencode-models.json') return 'opencode';
  if (name.startsWith('.claude/')) return 'claude-code';
  if (name.startsWith('.cursor/')) return 'cursor';
  return 'shared-package';
}
