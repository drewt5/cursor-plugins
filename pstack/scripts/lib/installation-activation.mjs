import { capturePrevious, renderingFingerprint } from './installation-history.mjs';
import { cleanupReleases } from './release-cleanup.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath, digest, observe, pathFor, present, safePath, stateFrom, parseInstallationState } from './installation-state.mjs';
import { generationDescriptor } from './generation-contract.mjs';
import { captureLegacyPackage, legacyTree } from './legacy-storage.mjs';
import { installationSnapshot } from './installation-state.mjs';
import { planInstallation } from './installation-plan.mjs';
import { stagePackage, renderStagedArtifacts, verifyGeneration } from './installation-storage.mjs';
import { prepareInstallation, mandatoryDiscoveryFailures } from './installation-preflight.mjs';
import { inspectExistingInstallation } from './installation-discovery.mjs';
import { recoverUnderLock, journalMutationRoots } from './installation-recovery.mjs';
import { withInstallationMutation } from './installation-lock.mjs';

import { journalName, instructionName, matchesObserved, persistJournal, applyJournalImage, applyLegacyMove, recoveryCommand, cleanupJournalMetadata, finishJournalCleanup, readActivationJournal } from './activation-journal.mjs';
export { journalName, matchesObserved, persistJournal, applyJournalImage, assertJournalOperation } from './activation-journal.mjs';
export async function prepareStagedActivation(options) {
  const root = canonicalPath(options.root), generation = generationDescriptor(stagePackage({ source: options.source, root }));
  // stagePackage verifies the retained bytes before returning synchronously.
  const packageRoot = safePath(root, generation.name);
  const { loadModelConfig } = await import(pathToFileURL(join(packageRoot, 'skills/pstack-runtime/scripts/models.mjs')).href);
  let config = options.config;
  const modelConfig = () => config ??= loadModelConfig({ project: root, home: options.globalRoot, configHome: options.env?.XDG_CONFIG_HOME, host: 'opencode' });
  const fingerprint = targets => renderingFingerprint(config, targets);
  const prepared = await prepareInstallation({ ...options, root, render: async args => {
    if (args.targets.includes('opencode')) modelConfig(); else config ??= { roles: {} };
    const artifacts = await renderStagedArtifacts({ ...args, root, generation, config });
    if (artifacts.state.targets.length) { artifacts.state.version = 4; artifacts.state.generation = generation; artifacts.state.renderingFingerprint = fingerprint(artifacts.state.targets); } else artifacts.state = { version: 2, targets: [], entries: {} };
    parseInstallationState(JSON.stringify(artifacts.state));
    return artifacts;
  } });
  let legacy;
  if (prepared.plan?.snapshot.previous.targets.length && prepared.plan.snapshot.previous.version < 4 && present(safePath(root, '.pstack/package'))?.isDirectory()) {
    legacy = captureLegacyPackage(root, prepared.plan.snapshot.previous);
    const snapshot = installationSnapshot({ root, desired: prepared.plan.artifacts.state, includeEntry: name => !name.startsWith('.pstack/package/') });
    const plan = planInstallation(snapshot, prepared.plan.artifacts);
    let stable = plan.operations.find(op => op.name === '.pstack/package');
    if (!stable) { stable = { name: '.pstack/package', path: safePath(root, '.pstack/package'), before: observe(safePath(root, '.pstack/package')), intended: { kind: 'absent' }, action: 'remove', ownership: 'managed', owner: 'shared-package' }; plan.operations.push(stable); }
    assert.equal(stable.before.kind, 'directory');
    Object.assign(stable, { action: stable.intended.kind === 'absent' ? 'remove' : 'replace', ownership: 'managed', code: null, reason: 'Verified legacy directory transition' });
    plan.conflicts = plan.operations.filter(op => op.action === 'conflict'); prepared.plan = plan;
  }
  return { ...prepared, generation, config, legacy };
}
export function mutationRoots(prepared) {
  return [...new Set([prepared.plan.snapshot.previous, prepared.plan.artifacts.state].filter(state => Object.keys(state.entries).some(name => name.startsWith('@opencode/'))).map(state => resolve(prepared.root, state.opencodeRoot)))];
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
  const plan = prepared.plan, root = canonicalPath(prepared.root);
  assert.ok(plan && !plan.conflicts.length && !prepared.failures.length && !prepared.discoveryFailures.length, 'Preflight failed; no activation started');
  verifyGeneration(root, prepared.generation);
  assert.ok(!readActivationJournal(root), 'An unresolved activation journal exists; recover it before starting another operation');
  for (const op of plan.operations) {
    pathFor(root, op.name, op.intended.kind === 'absent' ? plan.snapshot.previous : plan.artifacts.state);
    assert.ok(isDeepStrictEqual(observe(op.path), op.before), `Installation changed after planning: ${op.path}`);
  }
  assert.ok(isDeepStrictEqual(observe(plan.snapshot.statePath), plan.snapshot.receipt), 'Receipt changed after planning');
  assert.ok(!present(safePath(root, instructionName)), 'Unowned recovery instruction exists; preserve it before activation');
  const id = randomUUID();
  if (prepared.legacy) assert.equal(legacyTree(safePath(root, '.pstack/package'), plan.snapshot.previous).digest, prepared.legacy.treeDigest, 'Legacy package changed after planning');
  const operations = plan.operations.filter(op => op.action !== 'unchanged').map(op => ({ name: op.name, path: pathFor(root, op.name, op.intended.kind === 'absent' ? plan.snapshot.previous : plan.artifacts.state),
    before: prepared.legacy && op.name === '.pstack/package' ? { kind: 'absent' } : image(op.path, op.before), after: image(op.path, op.intended, op.intended.kind === 'file' ? plan.artifacts.contents.get(op.name) : undefined) }));
  operations.sort((a, b) => (a.name === '.pstack/package' ? -1 : b.name === '.pstack/package' ? 1 : a.name.localeCompare(b.name)));
  if (prepared.legacy) operations.unshift({ kind: 'legacy-directory', name: '.pstack/package', path: safePath(root, '.pstack/package'), backupName: `.pstack/legacy-${id}`, treeDigest: prepared.legacy.treeDigest, treeRows: prepared.legacy.treeRows, before: observe(safePath(root, '.pstack/package')), after: { kind: 'absent' } });
  const changed = operations.length || plan.snapshot.previous.generation?.digest !== prepared.generation.digest || plan.snapshot.previous.renderingFingerprint !== plan.artifacts.state.renderingFingerprint;
  const previous = plan.artifacts.state.targets.length ? changed ? capturePrevious(root, plan.snapshot.previous, prepared.legacy) : plan.snapshot.previous.previous : null;
  if (previous && !prepared.noHistory) plan.artifacts.state.previous = previous;
  const receipt = JSON.stringify(plan.artifacts.state, null, 2) + '\n';
  const before = image(plan.snapshot.statePath, plan.snapshot.receipt);
  const after = plan.artifacts.state.targets.length ? image(plan.snapshot.statePath, { kind: 'file', hash: digest(receipt), mode: 0o600 }, receipt) : { kind: 'absent' };
  const receiptUnchanged = matchesObserved(plan.snapshot.statePath, plan.snapshot.receipt, after);
  if (!operations.length && receiptUnchanged) return null;
  operations.push({ name: '.pstack/install.json', path: safePath(root, '.pstack/install.json'), before, after });
  for (const op of plan.operations) assert.ok(isDeepStrictEqual(observe(op.path), op.before), `Installation changed after planning: ${op.path}`);
  assert.ok(isDeepStrictEqual(observe(plan.snapshot.statePath), plan.snapshot.receipt), 'Receipt changed after planning');
  return { schemaVersion: 1, kind: 'pstack-activation', id, root, state: 'prepared', progress: 0, priorReceipt: plan.snapshot.previous,
    intendedReceipt: plan.artifacts.state, generation: prepared.generation, recoveryGeneration: prepared.recoveryGeneration ?? prepared.generation, ...(prepared.legacy ? { legacyGeneration: prepared.legacy.generation } : {}), operations, createdDirectories: parentDirectories(root, operations) };
}
export async function applyActivationUnderLock(prepared, { boundary = async () => {}, diagnose = inspectExistingInstallation, onRecoveryReady } = {}) {
  const journal = buildActivationJournal(prepared);
  if (!journal) {
    return { status: 'unchanged', changed: false };
  }
  const { root } = prepared;
  journal.recoveryInstruction = recoveryCommand(root, journal);
  persistJournal(root, journal);
  writeFileSync(safePath(root, instructionName), journal.recoveryInstruction + '\n', { flag: 'wx', mode: 0o600 });
  await onRecoveryReady?.(journal.recoveryInstruction);
  await boundary('prepared', journal);
  journal.state = 'applying';
  persistJournal(root, journal);
  await boundary('applying', journal);
  for (const [index, directory] of journal.createdDirectories.entries()) {
    mkdirSync(directory);
    await boundary(`directory:${index}`, journal);
  }
  for (const [index, op] of journal.operations.entries()) {
    pathFor(
      root,
      op.name,
      op.name === '.pstack/install.json' || op.after.kind !== 'absent' ? journal.intendedReceipt : journal.priorReceipt
    );
    if (op.kind === 'legacy-directory') {
      applyLegacyMove(root, journal, op, 'after');
    } else {
      await applyJournalImage(op, 'after', journal.id, () => boundary(`temporary:${index}`, journal));
    }
    await boundary(`mutation:${index}`, journal);
    journal.progress = index + 1;
    persistJournal(root, journal);
    await boundary(`progress:${index}`, journal);
  }
  journal.state = 'verifying';
  persistJournal(root, journal);
  await boundary('verifying', journal);
  let report;
  try {
    report = await diagnose({ ...prepared.diagnosticOptions, targets: prepared.targets, operationId: journal.id });
  } catch (error) {
    journal.failure = { code: 'DIAGNOSTIC_EXECUTION_FAILED', error: error.message };
    persistJournal(root, journal);
    const recovery = await recoverUnderLock(root, { boundary });
    return {
      status: 'verification-failed-restored',
      changed: true,
      restored: recovery.restored,
      failure: journal.failure,
      operation: journal.id
    };
  }
  if (report.findings.some(item => item.severity === 'error') || mandatoryDiscoveryFailures(report).length) {
    journal.failure = { code: 'POST_ACTIVATION_FAILED', findings: report.findings, discovery: report.discovery };
    persistJournal(root, journal);
    const recovery = await recoverUnderLock(root, { boundary });
    return { status: 'verification-failed-restored', changed: true, restored: recovery.restored, report, operation: journal.id };
  }
  journal.state = 'committed';
  persistJournal(root, journal);
  await boundary('committed', journal);
  cleanupJournalMetadata(root, journal);
  await boundary('cleanup', journal);
  return { status: 'applied', changed: true, report, operation: journal.id };
}
export async function applyStagedActivation(prepared, options) {
  const result = await withInstallationMutation({ root: prepared.root, opencodeRoots: mutationRoots(prepared) }, () =>
    applyActivationUnderLock(prepared, options)
  );
  if (result.operation) {
    try {
      await withInstallationMutation({ root: prepared.root }, () => {
        finishJournalCleanup(prepared.root, result.operation);
        result.cleanup = cleanupReleases(prepared.root);
      });
    } catch (error) {
      result.cleanupPending = true;
      result.cleanupError = error.message;
    }
  }
  return result;
}

export async function runStagedInstallation(options, controls = {}) {
  const root = canonicalPath(options.root);
  const unfinished = readActivationJournal(root);
  let configured;
  if (options.opencodeRootOverride) {
    configured = resolve(root, options.opencodeRootOverride);
  } else if (options.options?.global) {
    configured = resolve(options.env?.XDG_CONFIG_HOME || join(root, '.config'), 'opencode');
  } else {
    configured = join(root, '.opencode');
  }
  const previous = unfinished?.priorReceipt ?? stateFrom(safePath(root, '.pstack/install.json'));
  const recorded = Object.keys(previous.entries).some(name => name.startsWith('@opencode/')) ? [resolve(root, previous.opencodeRoot)] : [];
  const needsConfigured =
    ['opencode', 'all'].includes(options.options?.target) ||
    previous.targets.includes('opencode') ||
    (options.options?.target === undefined && !previous.targets.length);
  const roots = [...(unfinished ? journalMutationRoots(root, unfinished) : []), ...recorded, ...(needsConfigured ? [configured] : [])];
  const result = await withInstallationMutation({ root, opencodeRoots: roots }, async () => {
    const recovered = await recoverUnderLock(root, controls);
    if (recovered.operation) {
      finishJournalCleanup(root, recovered.operation);
    }
    const prepared = await prepareStagedActivation(options);
    if (!prepared.plan || prepared.plan.conflicts.length || prepared.failures.length || prepared.discoveryFailures.length) {
      return { status: 'preflight-failed', prepared, recovered, changed: false };
    }
    try {
      return { ...(await applyActivationUnderLock(prepared, controls)), recovered, prepared };
    } catch (error) {
      if (readActivationJournal(root)?.state !== 'committed') {
        try {
          const restored = await recoverUnderLock(root);
          if (restored.restored) {
            error.message += '; prior installation restored';
          }
        } catch (recoveryError) {
          error.message += '; recovery required: ' + recoveryError.message;
        }
      }
      throw error;
    }
  });
  if (result.operation) {
    try {
      await withInstallationMutation({ root }, () => {
        finishJournalCleanup(root, result.operation);
        result.cleanup = cleanupReleases(root);
      });
    } catch (error) {
      result.cleanupPending = true;
      result.cleanupError = error.message;
    }
  }
  return result;
}
