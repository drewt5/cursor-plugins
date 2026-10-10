import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { observe, pathFor, safePath } from './installation-state.mjs';

function matches(path, observed, entry) {
  if (!entry || observed.kind !== entry.kind) return false;
  return entry.kind === 'file' ? observed.hash === entry.hash
    : resolve(dirname(path), observed.to) === resolve(dirname(path), entry.to);
}
function owner(name) {
  if (name.startsWith('.agents/')) return 'codex';
  if (name.startsWith('@opencode/') || name === '.pstack/opencode-models.json') return 'opencode';
  if (name.startsWith('.claude/')) return 'claude-code';
  if (name.startsWith('.cursor/')) return 'cursor';
  return 'shared-package';
}
export function planInstallation(snapshot, artifacts) {
  const previous = new Map(snapshot.owned.map(item => [item.path, item]));
  const wanted = new Map(snapshot.wanted.map(item => [item.path, item]));
  const operations = [];
  for (const [path, before] of Object.entries(snapshot.observed)) {
    const old = previous.get(path), next = wanted.get(path);
    const modified = old && before.kind !== 'absent' && !matches(path, before, old.entry) && !matches(path, before, next?.entry);
    const collision = next && !old && before.kind !== 'absent' && !matches(path, before, next.entry);
    const conflict = modified || collision;
    const unchanged = next && matches(path, before, next.entry) && (next.entry.kind !== 'file' || next.entry.mode === undefined || next.entry.mode === before.mode);
    const action = conflict ? 'conflict' : next ? unchanged ? 'unchanged' : before.kind === 'absent' ? 'create' : 'replace' : before.kind === 'absent' ? 'unchanged' : 'remove';
    const name = next?.name ?? old.name;
    operations.push({ path, name, owner: owner(name), before, intended: next?.entry ?? { kind: 'absent' }, action,
      reason: modified ? 'Locally modified pstack file; preserve or move it before retrying' : collision ? 'Install conflict; no files changed. Use a project installation or move the conflicting skill yourself' : next ? 'Desired installation artifact' : 'No longer selected' });
  }
  return { snapshot, artifacts, operations, conflicts: operations.filter(op => op.action === 'conflict') };
}
export function applyInstallation(plan) {
  if (plan.conflicts.length) throw new Error(plan.conflicts.map(op => `${op.reason}: ${op.path}`).join('\n'));
  safePath(plan.snapshot.root, '.pstack/install.json');
  for (const item of plan.snapshot.owned) pathFor(plan.snapshot.root, item.name, plan.snapshot.previous);
  for (const item of plan.snapshot.wanted) pathFor(plan.snapshot.root, item.name, plan.artifacts.state);
  // Refuse a stale plan before any write, including receipt replacement.
  if (!isDeepStrictEqual(observe(plan.snapshot.statePath), plan.snapshot.receipt)
    || plan.operations.some(op => !isDeepStrictEqual(observe(op.path), op.before))) throw new Error('Installation changed after planning; no files changed. Re-run the command.');
  for (const op of plan.operations) {
    if (op.action === 'unchanged' || op.action === 'remove') continue;
    const entry = op.intended, path = op.path;
    mkdirSync(dirname(path), { recursive: true });
    if (entry.kind === 'link') {
      if (op.before.kind !== 'absent') rmSync(path);
      symlinkSync(process.platform === 'win32' ? resolve(dirname(path), entry.to) : entry.to, path, process.platform === 'win32' ? 'junction' : 'dir');
    } else if (matches(path, op.before, entry)) chmodSync(path, entry.mode);
    else {
      const temp = `${path}.pstack-${process.pid}.tmp`;
      writeFileSync(temp, plan.artifacts.contents.get(op.name), { flag: 'wx', mode: entry.mode });
      renameSync(temp, path);
    }
  }
  for (const op of plan.operations) if (op.action === 'remove') rmSync(op.path);
  const { statePath } = plan.snapshot;
  if (!plan.artifacts.state.targets.length) {
    if (plan.snapshot.receipt.kind !== 'absent') rmSync(statePath);
  } else {
    mkdirSync(dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(plan.artifacts.state, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, statePath);
  }
}
