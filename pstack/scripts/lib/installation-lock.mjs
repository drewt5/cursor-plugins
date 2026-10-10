import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { canonicalPath, present, safePath } from './installation-state.mjs';

function processStart(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' } });
  if (result.error || ![0, 1].includes(result.status)) return { known: false };
  const start = result.stdout.trim();
  return { known: true, start: start || null };
}
function readLock(path) {
  if (!present(path)?.isFile()) throw new Error('Lock is missing or is not a regular file');
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  if (owner.schemaVersion !== 1 || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.token)
    || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.machine !== 'string'
    || typeof owner.platform !== 'string' || typeof owner.scope !== 'string'
    || typeof owner.start !== 'string' || Number.isNaN(Date.parse(owner.start))) throw new Error('Malformed lock owner identity');
  return owner;
}
export function inspectInstallationLock(path) {
  if (!present(path)) return { status: 'absent', path };
  let owner;
  try { owner = readLock(path); } catch (error) { return { status: 'unknown', path, reason: error.message }; }
  if (owner.machine !== hostname() || owner.platform !== process.platform) return { status: 'unknown', path, owner, reason: 'Owner is on a different machine or platform' };
  const current = processStart(owner.pid);
  if (!current.known) return { status: 'unknown', path, owner, reason: 'Process start identity is unavailable' };
  if (current.start === owner.start) return { status: 'active', path, owner, reason: 'Recorded process identity is still present' };
  if (current.start) return { status: 'dead', path, owner, reason: 'PID now belongs to a different process start identity' };
  try { process.kill(owner.pid, 0); } catch (error) {
    if (error.code === 'ESRCH') return { status: 'dead', path, owner, reason: 'Recorded process identity is absent; both process probes agree' };
  }
  return { status: 'unknown', path, owner, reason: 'Process probes disagree or access is restricted' };
}
function removeOwned(path, token) {
  const owner = readLock(path);
  if (owner.token !== token) throw new Error(`Lock ownership changed; preserving ${path}`);
  unlinkSync(path);
}
export function recoverInstallationLock(path, token) {
  const result = inspectInstallationLock(path);
  if (result.status !== 'dead' || result.owner.token !== token) throw new Error(`Cannot recover ${path}: ${result.status}. Inspect the owner; never remove a live or unverifiable lock.`);
  removeOwned(path, token);
}
function acquire(path, scope) {
  const identity = processStart(process.pid);
  if (!identity.known || !identity.start) throw new Error('Cannot establish this process start identity; no installation mutation started.');
  mkdirSync(dirname(path), { recursive: true });
  let descriptor;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const result = inspectInstallationLock(path);
    throw new Error(`Installation busy (${result.status}): ${path}; owner ${JSON.stringify(result.owner ?? null)}. No mutation started. Inspect this lock; ${result.status === 'dead' ? 'use internal recoverInstallationLock with the recorded token after inspection' : 'finish the owning operation or establish its identity before recovery'}.`);
  }
  const token = randomUUID(), stat = lstatSync(path);
  try {
    writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, token, scope, pid: process.pid, start: identity.start, machine: hostname(), platform: process.platform, createdAt: new Date().toISOString() }) + '\n');
  } catch (error) {
    const current = lstatSync(path);
    if (current.dev === stat.dev && current.ino === stat.ino) unlinkSync(path);
    throw error;
  } finally { closeSync(descriptor); }
  return { path, token };
}
// Internal until the public migration has a directly runnable recovery path.
export async function withInstallationMutation({ root, opencodeRoot }, mutate) {
  const scope = canonicalPath(root);
  const paths = [safePath(scope, '.pstack/mutation.lock')];
  if (opencodeRoot) paths.push(safePath(canonicalPath(opencodeRoot), '.pstack-mutation.lock'));
  const acquired = [];
  const release = () => {
    const errors = [];
    for (const lock of acquired.splice(0).reverse()) {
      try { removeOwned(lock.path, lock.token); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Some installation locks changed ownership and were preserved');
  };
  const onExit = () => { try { release(); } catch (error) { console.error(error.message); process.exitCode = 1; } };
  process.once('exit', onExit);
  try {
    for (const path of [...new Set(paths)].sort()) acquired.push(acquire(path, scope));
    return await mutate();
  } finally {
    process.removeListener('exit', onExit);
    release();
  }
}
