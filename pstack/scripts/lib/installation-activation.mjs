import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath, digest, observe, pathFor, present, safePath, parseInstallationState } from './installation-state.mjs';
import { generationDescriptor } from './generation-contract.mjs';
import { stagePackage, renderStagedArtifacts, verifyGeneration } from './installation-storage.mjs';
import { prepareInstallation, mandatoryDiscoveryFailures } from './installation-preflight.mjs';
import { inspectExistingInstallation } from './installation-discovery.mjs';
import { withInstallationMutation } from './installation-lock.mjs';

export const journalName = '.pstack/activation.json';
export async function prepareStagedActivation(options) {
  const root = canonicalPath(options.root), generation = generationDescriptor(stagePackage({ source: options.source, root }));
  const packageRoot = verifyGeneration(root, generation);
  const { loadModelConfig } = await import(pathToFileURL(join(packageRoot, 'skills/pstack-runtime/scripts/models.mjs')).href);
  const config = options.config ?? loadModelConfig({ project: root, home: options.globalRoot, configHome: options.env?.XDG_CONFIG_HOME, host: 'opencode' });
  const renderingFingerprint = digest(JSON.stringify(Object.entries(config.roles).sort()));
  const prepared = await prepareInstallation({ ...options, root, render: async args => {
    const artifacts = await renderStagedArtifacts({ ...args, root, generation, config });
    artifacts.state.version = 4; artifacts.state.generation = generation; artifacts.state.renderingFingerprint = renderingFingerprint;
    parseInstallationState(JSON.stringify(artifacts.state));
    return artifacts;
  } });
  return { ...prepared, generation, config };
}
export function mutationRoots(prepared) {
  return [...new Set([prepared.plan.snapshot.previous, prepared.plan.artifacts.state].filter(state => Object.keys(state.entries).some(name => name.startsWith('@opencode/'))).map(state => resolve(prepared.root, state.opencodeRoot)))];
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
function image(path, expected, data) {
  if (expected.kind === 'file') {
    const bytes = data === undefined ? readFileSync(path) : Buffer.from(data);
    assert.equal(digest(bytes), expected.hash, `File changed while capturing journal: ${path}`);
    return { ...expected, data: bytes.toString('base64') };
  }
  assert.ok(['absent', 'link'].includes(expected.kind), `Unsupported journal path kind: ${path}`);
  return expected;
}
function parentDirectories(root, operations) {
  const directories = new Set();
  for (const op of operations) for (let parent = dirname(op.path); parent !== root && !present(parent); parent = dirname(parent)) directories.add(parent);
  return [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b));
}
export function buildActivationJournal(prepared) {
  const plan = prepared.plan, root = prepared.root;
  assert.ok(plan && !plan.conflicts.length && !prepared.failures.length && !prepared.discoveryFailures.length, 'Preflight failed; no activation started');
  verifyGeneration(root, prepared.generation);
  assert.ok(!present(safePath(root, journalName)), 'An unresolved activation journal exists; recover it before starting another operation');
  for (const op of plan.operations) {
    pathFor(root, op.name, op.intended.kind === 'absent' ? plan.snapshot.previous : plan.artifacts.state);
    assert.ok(isDeepStrictEqual(observe(op.path), op.before), `Installation changed after planning: ${op.path}`);
  }
  assert.ok(isDeepStrictEqual(observe(plan.snapshot.statePath), plan.snapshot.receipt), 'Receipt changed after planning');
  const operations = plan.operations.filter(op => op.action !== 'unchanged').map(op => ({ name: op.name, path: pathFor(root, op.name, op.intended.kind === 'absent' ? plan.snapshot.previous : plan.artifacts.state),
    before: image(op.path, op.before), after: image(op.path, op.intended, op.intended.kind === 'file' ? plan.artifacts.contents.get(op.name) : undefined) }));
  operations.sort((a, b) => (a.name === '.pstack/package' ? -1 : b.name === '.pstack/package' ? 1 : a.name.localeCompare(b.name)));
  const receipt = JSON.stringify(plan.artifacts.state, null, 2) + '\n';
  const before = image(plan.snapshot.statePath, plan.snapshot.receipt);
  const after = image(plan.snapshot.statePath, { kind: 'file', hash: digest(receipt), mode: 0o600 }, receipt);
  const receiptUnchanged = matchesObserved(plan.snapshot.statePath, plan.snapshot.receipt, after);
  if (!operations.length && receiptUnchanged) return null;
  operations.push({ name: '.pstack/install.json', path: safePath(root, '.pstack/install.json'), before, after });
  for (const op of plan.operations) assert.ok(isDeepStrictEqual(observe(op.path), op.before), `Installation changed after planning: ${op.path}`);
  assert.ok(isDeepStrictEqual(observe(plan.snapshot.statePath), plan.snapshot.receipt), 'Receipt changed after planning');
  return { schemaVersion: 1, kind: 'pstack-activation', id: randomUUID(), root, state: 'prepared', progress: 0, priorReceipt: plan.snapshot.previous,
    intendedReceipt: plan.artifacts.state, generation: prepared.generation, operations, createdDirectories: parentDirectories(root, operations) };
}
export function assertJournalOperation(op, which) {
  const expected = op[which];
  if (expected.kind === 'file') assert.equal(digest(Buffer.from(expected.data, 'base64')), expected.hash, `Invalid journal file data: ${op.name}`);
}
export function applyJournalImage(op, which, id) {
  const desired = op[which], current = observe(op.path), other = op[which === 'after' ? 'before' : 'after'];
  assertJournalOperation(op, which);
  if (matchesObserved(op.path, current, desired)) return;
  assert.ok(matchesObserved(op.path, current, other), `Recovery conflict; preserve changed path: ${op.path}`);
  if (desired.kind === 'absent') { rmSync(op.path); return; }
  mkdirSync(dirname(op.path), { recursive: true });
  const temporary = `${op.path}.pstack-${id}.tmp`;
  if (desired.kind === 'link') symlinkSync(process.platform === 'win32' ? resolve(dirname(op.path), desired.to) : desired.to, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  else { writeFileSync(temporary, Buffer.from(desired.data, 'base64'), { flag: 'wx', mode: desired.mode }); chmodSync(temporary, desired.mode); }
  renameSync(temporary, op.path);
}
export async function applyActivationUnderLock(prepared, { boundary = async () => {}, diagnose = inspectExistingInstallation } = {}) {
  const journal = buildActivationJournal(prepared);
  if (!journal) return { status: 'unchanged', changed: false };
  const { root } = prepared;
  persistJournal(root, journal); await boundary('prepared', journal);
  journal.state = 'applying'; persistJournal(root, journal); await boundary('applying', journal);
  for (const [index, directory] of journal.createdDirectories.entries()) { mkdirSync(directory); await boundary(`directory:${index}`, journal); }
  for (const [index, op] of journal.operations.entries()) {
    pathFor(root, op.name, op.name === '.pstack/install.json' || op.after.kind !== 'absent' ? journal.intendedReceipt : journal.priorReceipt);
    applyJournalImage(op, 'after', journal.id); await boundary(`mutation:${index}`, journal);
    journal.progress = index + 1; persistJournal(root, journal); await boundary(`progress:${index}`, journal);
  }
  journal.state = 'verifying'; persistJournal(root, journal); await boundary('verifying', journal);
  let report;
  try { report = await diagnose({ ...prepared.diagnosticOptions, targets: prepared.targets }); }
  catch (error) { journal.failure = { code: 'DIAGNOSTIC_EXECUTION_FAILED', error: error.message }; persistJournal(root, journal); return { status: 'verification-failed', changed: true, journal }; }
  if (report.findings.some(item => item.severity === 'error') || mandatoryDiscoveryFailures(report).length) {
    journal.failure = { code: 'POST_ACTIVATION_FAILED', findings: report.findings, discovery: report.discovery }; persistJournal(root, journal);
    return { status: 'verification-failed', changed: true, report, journal };
  }
  journal.state = 'committed'; persistJournal(root, journal); await boundary('committed', journal);
  rmSync(safePath(root, journalName)); await boundary('cleanup', journal);
  return { status: 'applied', changed: true, report };
}
export async function applyStagedActivation(prepared, options) {
  return withInstallationMutation({ root: prepared.root, opencodeRoots: mutationRoots(prepared) }, () => applyActivationUnderLock(prepared, options));
}
