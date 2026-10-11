import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isManagedEntryName, canonicalPath, digest, observe, pathFor, present, safePath, parseInstallationState } from './installation-state.mjs';
import { validateGeneration } from './generation-contract.mjs';
import { legacyTree } from './legacy-storage.mjs';
import { verifyGeneration } from './installation-storage.mjs';
export const journalName = '.pstack/activation.json';
export const completedJournalName = '.pstack/activation-completed.json';
export const instructionName = '.pstack/recovery.txt';
export const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function recoveryCommand(root, journal) {
  const generation = journal.recoveryGeneration ?? journal.generation;
  validateGeneration(generation); const packageRoot = verifyGeneration(root, generation);
  return commandAt(root, packageRoot);
}
function commandAt(root, packageRoot) {
  assert.ok(present(join(packageRoot, 'scripts/recover.mjs'))?.isFile(), 'Retained recovery executable is missing');
  return `node ${quote(join(packageRoot, 'scripts/recover.mjs'))} --project ${quote(canonicalPath(root))}`;
}
export function matchesObserved(path, actual, expected) {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'absent') return true;
  if (actual.kind === 'file') return actual.hash === expected.hash && (expected.mode === undefined || actual.mode === expected.mode);
  if (actual.kind === 'link') return resolve(dirname(path), actual.to) === resolve(dirname(path), expected.to);
  return isDeepStrictEqual(actual, expected);
}
export function persistJournal(root, journal) {
  const path = safePath(root, journalName), temporary = safePath(root, `${journalName}.${journal.id}.tmp`);
  writeFileSync(temporary, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function assertJournalOperation(op, which) {
  const expected = op[which];
  if (expected.kind === 'file') assert.equal(digest(Buffer.from(expected.data, 'base64')), expected.hash, `Invalid journal file data: ${op.name}`);
}
export async function applyJournalImage(op, which, id, temporaryReady = async () => {}) {
  const desired = op[which], current = observe(op.path), other = op[which === 'after' ? 'before' : 'after'];
  assertJournalOperation(op, which);
  if (matchesObserved(op.path, current, desired)) return;
  assert.ok(matchesObserved(op.path, current, other), `Recovery conflict; preserve changed path: ${op.path}`);
  if (desired.kind === 'absent') { rmSync(op.path); return; }
  mkdirSync(dirname(op.path), { recursive: true });
  const temporary = `${op.path}.pstack-${id}.tmp`;
  if (desired.kind === 'link') symlinkSync(process.platform === 'win32' ? resolve(dirname(op.path), desired.to) : desired.to, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  else { writeFileSync(temporary, Buffer.from(desired.data, 'base64'), { flag: 'wx', mode: desired.mode }); chmodSync(temporary, desired.mode); }
  await temporaryReady();
  renameSync(temporary, op.path);
}
function entryAt(root, state, name, path) {
  const entry = state.entries[name];
  return entry && pathFor(root, name, state) === path ? entry : { kind: 'absent' };
}
function validImage(op, which) {
  const value = op[which];
  assert.ok(value && ['absent', 'file', 'link'].includes(value.kind), 'Unsupported journal image');
  assert.ok(Object.keys(value).every(key => ['kind', 'hash', 'mode', 'data', 'to'].includes(key)), 'Unexpected journal image fields');
  if (value.kind === 'file') { assert.match(value.hash, /^[a-f0-9]{64}$/); assert.ok(Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777); assert.equal(typeof value.data, 'string'); assertJournalOperation(op, which); }
  if (value.kind === 'link') assert.equal(typeof value.to, 'string');
}
export function readActivationJournal(root) {
  root = canonicalPath(root);
  assert.ok(!(present(safePath(root, journalName)) && present(safePath(root, completedJournalName))), 'Two unresolved journal paths; preserve both');
  const path = safePath(root, present(safePath(root, journalName)) ? journalName : completedJournalName), stat = present(path);
  if (!stat) return null;
  assert.ok(stat.isFile() && stat.size <= 8 * 1024 * 1024, 'Activation journal must be a bounded regular file');
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(journal.schemaVersion, 1); assert.equal(journal.kind, 'pstack-activation'); assert.match(journal.id, /^[a-f0-9-]{36}$/); assert.equal(journal.root, root, 'Interrupted scope moved; restore its original scope location before recovery');
  assert.ok(['prepared', 'applying', 'verifying', 'restoring', 'restored', 'committed'].includes(journal.state));
  const prior = parseInstallationState(JSON.stringify(journal.priorReceipt)), intended = parseInstallationState(JSON.stringify(journal.intendedReceipt));
  // Deduplicate identical descriptors only within this synchronous parse. Every
  // new diagnostic/recovery/activation call revalidates current stored bytes.
  const verified = new Map();
  const verify = generation => { validateGeneration(generation); const key = JSON.stringify(generation); if (!verified.has(key)) verified.set(key, verifyGeneration(root, generation)); return verified.get(key); };
  verify(journal.generation);
  if (journal.recoveryGeneration) verify(journal.recoveryGeneration);
  if (journal.legacyGeneration) verify(journal.legacyGeneration);
  if (prior.version === 4) verify(prior.generation);
  assert.ok(Array.isArray(journal.operations) && journal.operations.length && journal.operations.length <= 10000);
  assert.ok(Number.isSafeInteger(journal.progress) && journal.progress >= 0 && journal.progress <= journal.operations.length);
  const paths = new Set();
  for (const op of journal.operations) {
    if (op.kind === 'legacy-directory') {
      assert.ok(Object.keys(op).every(key => ['kind','name','path','backupName','treeDigest','treeRows','before','after'].includes(key)));
      assert.equal(op.name, '.pstack/package'); assert.equal(op.path, safePath(root, op.name)); assert.equal(op.backupName, `.pstack/legacy-${journal.id}`);
      assert.equal(op.before.kind, 'directory'); assert.equal(op.after.kind, 'absent'); assert.ok(prior.version < 4 && journal.legacyGeneration);
      assert.match(op.treeDigest, /^[a-f0-9]{64}$/); assert.ok(Array.isArray(op.treeRows)); assert.equal(digest(JSON.stringify(op.treeRows)), op.treeDigest);
      assert.ok(!paths.has(op.path), 'Duplicated legacy move'); paths.add(op.path); continue;
    }
    assert.ok(op && Object.keys(op).every(key => ['name', 'path', 'before', 'after'].includes(key)), 'Unexpected journal operation fields');
    assert.ok(op.name === '.pstack/install.json' || isManagedEntryName(op.name), 'Journal path is outside managed locations');
    validImage(op, 'before'); validImage(op, 'after');
    const expectedPath = op.name === '.pstack/install.json' ? safePath(root, op.name) : pathFor(root, op.name, op.after.kind === 'absent' ? prior : intended);
    assert.equal(op.path, expectedPath, 'Journal path differs from validated receipt'); assert.ok(!paths.has(op.path) || op.name === '.pstack/package' && journal.operations[0].kind === 'legacy-directory', 'Duplicated journal path'); paths.add(op.path);
    if (op.name === '.pstack/install.json') {
      if (op.before.kind === 'file') assert.deepEqual(parseInstallationState(Buffer.from(op.before.data, 'base64')), prior, 'Prior receipt image mismatch'); else assert.ok(!prior.targets.length && op.before.kind === 'absent');
      if (intended.targets.length) { assert.equal(op.after.kind, 'file'); assert.deepEqual(parseInstallationState(Buffer.from(op.after.data, 'base64')), intended, 'Intended receipt image mismatch'); } else assert.equal(op.after.kind, 'absent');
    } else {
      const old = entryAt(root, prior, op.name, op.path), next = entryAt(root, intended, op.name, op.path);
      assert.ok(op.before.kind === 'absent' || matchesObserved(op.path, op.before, { ...old, mode: undefined }), 'Journal before image is not previously owned');
      assert.ok(matchesObserved(op.path, op.after, next), 'Journal after image differs from intended receipt');
    }
  }
  if (journal.operations[0].kind === 'legacy-directory') assert.equal(journal.operations.filter(op => op.name === '.pstack/package').length, 2, 'Invalid legacy transition count');
  assert.equal(journal.operations.at(-1).name, '.pstack/install.json', 'Receipt transition must be last');
  assert.ok(Array.isArray(journal.createdDirectories) && new Set(journal.createdDirectories).size === journal.createdDirectories.length);
  const allowed = new Set();
  for (const op of journal.operations) {
    const boundary = op.name.startsWith('@opencode/') ? resolve(root, (op.after.kind === 'absent' ? prior : intended).opencodeRoot) : root;
    for (let parent = dirname(op.path); parent !== boundary; parent = dirname(parent)) { assert.notEqual(parent, dirname(parent), 'Invalid parent boundary'); allowed.add(parent); }
  }
  assert.ok(journal.createdDirectories.every(path => allowed.has(path)), 'Journal directory is outside operation parents');
  assert.equal(journal.recoveryInstruction, commandAt(root, verify(journal.recoveryGeneration ?? journal.generation)), 'Recovery instruction differs from validated retained identity');
  return journal;
}
export function inspectInterruptedOperation(root) {
  try {
    const journal = readActivationJournal(root);
    return journal ? { status: ['committed', 'restored'].includes(journal.state) ? 'cleanup-pending' : 'recovery-required', id: journal.id, state: journal.state, progress: journal.progress, command: recoveryCommand(root, journal) } : { status: 'absent' };
  } catch (error) { return { status: 'invalid', error: error.message }; }
}
export function cleanupJournalMetadata(root, journal) {
  cleanOperationTemporaries(journal);
  for (const op of journal.operations.filter(item => item.kind === 'legacy-directory')) {
    if (journal.state === 'committed') {
      assert.ok(['after', 'cleaned'].includes(legacyMoveStatus(root, journal, op)), `Legacy cleanup conflict; preserve ${op.backupName}`);
      if (present(safePath(root, op.backupName))) rmSync(safePath(root, op.backupName), { recursive: true });
    } else assert.equal(legacyMoveStatus(root, journal, op), 'before', 'Legacy directory was not safely restored');
  }
  const instruction = safePath(root, instructionName), command = recoveryCommand(root, journal) + '\n';
  if (present(instruction)) {
    assert.ok(present(instruction).isFile() && readFileSync(instruction, 'utf8') === command, `Recovery instruction changed; preserve ${instruction}`);
  }
  const temporary = safePath(root, `${journalName}.${journal.id}.tmp`);
  if (present(temporary)) {
    const pending = JSON.parse(readFileSync(temporary, 'utf8'));
    assert.equal(pending.id, journal.id, 'Journal temporary ownership changed'); rmSync(temporary);
  }
  if (present(safePath(root, journalName))) {
    assert.ok(['committed', 'restored'].includes(journal.state), 'Journal must be resolved before cleanup');
    renameSync(safePath(root, journalName), safePath(root, completedJournalName));
  }
}
export function finishJournalCleanup(root, id) {
  const path = safePath(root, completedJournalName);
  if (present(path)) {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.id === id) {
      const instruction = safePath(root, instructionName);
      if (present(instruction)) { assert.ok(present(instruction).isFile() && readFileSync(instruction, 'utf8') === record.recoveryInstruction + '\n', `Recovery instruction changed; preserve ${instruction}`); rmSync(instruction); }
      rmSync(path);
    }
  }
}
export function legacyMoveStatus(root, journal, op) {
  const path = safePath(root, op.name), backup = safePath(root, op.backupName), current = observe(path), saved = observe(backup);
  if (current.kind === 'directory' && saved.kind === 'absent') return legacyTree(path, journal.priorReceipt).digest === op.treeDigest && current.mode === op.before.mode ? 'before' : 'conflict';
  const link = journal.operations.find(item => !item.kind && item.name === op.name);
  const activeAfter = current.kind === 'absent' || link && matchesObserved(path, current, link.after);
  if (saved.kind === 'directory' && activeAfter) {
    const tree = legacyTree(backup, journal.priorReceipt, { allowMissing: journal.state === 'committed' });
    const expected = new Map(op.treeRows.map(row => [row.name, row]));
    const matches = tree.rows.every(row => isDeepStrictEqual(row, expected.get(row.name))) && (journal.state === 'committed' || tree.digest === op.treeDigest);
    return matches && saved.mode === op.before.mode ? 'after' : 'conflict';
  }
  if (saved.kind === 'absent' && activeAfter && journal.state === 'committed') return 'cleaned';
  return 'conflict';
}
export function applyLegacyMove(root, journal, op, which) {
  const status = legacyMoveStatus(root, journal, op), backup = safePath(root, op.backupName);
  assert.notEqual(status, 'conflict', `Legacy recovery conflict; preserve ${op.path} and ${backup}`);
  if (which === 'after' && status === 'before') { assert.ok(!present(backup), 'Legacy backup appeared'); renameSync(op.path, backup); }
  if (which === 'before' && status === 'after') { assert.equal(observe(op.path).kind, 'absent', 'Preserve unexpected active package path'); renameSync(backup, op.path); }
}

export function cleanOperationTemporaries(journal) {
  for (const op of journal.operations.filter(item => !item.kind)) {
    const temporary = `${op.path}.pstack-${journal.id}.tmp`, actual = observe(temporary);
    if (actual.kind !== 'absent') {
      assert.ok(matchesObserved(op.path, actual, op.before) || matchesObserved(op.path, actual, op.after), `Unknown operation temporary content; preserve ${temporary} and move it aside before retrying recovery`);
      rmSync(temporary);
    }
  }
}
