import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { entryOwner, observe, pathFor, safePath } from './installation-state.mjs';

function matches(path, observed, entry) {
  if (!entry || observed.kind !== entry.kind) return false;
  return entry.kind === 'file' ? observed.hash === entry.hash
    : resolve(dirname(path), observed.to) === resolve(dirname(path), entry.to);
}
export function planInstallation(snapshot, artifacts) {
  const previous = new Map(snapshot.owned.map(item => [item.path, item]));
  const wanted = new Map(snapshot.wanted.map(item => [item.path, item]));
  const operations = [];
  for (const [path, before] of Object.entries(snapshot.observed)) {
    const old = previous.get(path), next = wanted.get(path);
    const modified = old && before.kind !== 'absent' && !matches(path, before, old.entry);
    const collision = next && !old && before.kind !== 'absent';
    const unsafe = before.kind === 'unsafe-parent';
    const conflict = unsafe || modified || collision;
    const unchanged = next && matches(path, before, next.entry) && (next.entry.kind !== 'file' || next.entry.mode === undefined || next.entry.mode === before.mode);
    const action = conflict ? 'conflict' : next ? unchanged ? 'unchanged' : before.kind === 'absent' ? 'create' : 'replace' : before.kind === 'absent' ? 'unchanged' : 'remove';
    const name = next?.name ?? old.name;
    const attempted = next ? before.kind === 'absent' ? 'create' : 'replace' : 'remove';
    const wrongKind = before.kind !== 'absent' && before.kind !== (old?.entry ?? next?.entry).kind;
    const code = unsafe ? 'unsafe-parent' : conflict ? wrongKind ? 'wrong-path-kind' : old ? 'modified-owned' : 'unowned' : null;
    operations.push({ path, name, ownership: old ? 'managed' : 'unowned', attempted, code, owner: entryOwner(name), before, intended: next?.entry ?? { kind: 'absent' }, action,
      reason: unsafe ? `${before.error}. No files changed; choose a project path without symlinked host directories or restore the intended directory yourself` : modified ? 'Locally modified pstack file; preserve or move it before retrying' : collision ? 'Install conflict: unowned content, including identical content, cannot be adopted; no files changed. Choose a separate project installation to preserve existing skills, or resolve this path yourself' : next ? 'Desired installation artifact' : 'No longer selected' });
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
