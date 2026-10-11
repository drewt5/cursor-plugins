import { cleanupReleases } from './release-cleanup.mjs';
import assert from 'node:assert/strict';
import { rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalPath, observe, present, safePath, stateFrom } from './installation-state.mjs';
import { readActivationJournal, matchesObserved, legacyMoveStatus, applyLegacyMove, applyJournalImage, persistJournal, recoveryCommand, cleanupJournalMetadata, cleanOperationTemporaries, finishJournalCleanup } from './activation-journal.mjs';
import { inspectInstallationLock, recoverInstallationLock, withInstallationMutation } from './installation-lock.mjs';
export function journalMutationRoots(root, journal) {
  return [...new Set([journal.priorReceipt, journal.intendedReceipt].filter(state => Object.keys(state.entries).some(name => name.startsWith('@opencode/'))).map(state => resolve(root, state.opencodeRoot)))];
}
export function recoverDemonstrablyDeadLocks(root, roots = []) {
  const paths = [...new Set([safePath(root, '.pstack/mutation.lock'), ...roots.map(path => safePath(canonicalPath(path), '.pstack-mutation.lock'))])].sort();
  const inspected = paths.map(inspectInstallationLock);
  assert.ok(inspected.every(item => ['absent', 'dead'].includes(item.status)), `Preserving live or unverifiable locks: ${inspected.filter(item => !['absent', 'dead'].includes(item.status)).map(item => `${item.path}: ${item.status} (${item.reason})`).join('; ')}`);
  for (const item of inspected.filter(item => item.status === 'dead')) recoverInstallationLock(item.path, item.owner.token);
  return inspected.filter(item => item.status === 'dead').map(item => item.path);
}
export async function recoverUnderLock(root, { boundary = async () => {} } = {}) {
  const journal = readActivationJournal(root);
  if (!journal) {
    return { status: 'no-operation', restored: false };
  }
  const command = recoveryCommand(root, journal);
  if (['committed', 'restored'].includes(journal.state)) {
    const conflicts = journal.operations.filter(op => {
      if (op.kind === 'legacy-directory') {
        const allowedStates = journal.state === 'committed' ? ['after', 'cleaned'] : ['before'];
        return !allowedStates.includes(legacyMoveStatus(root, journal, op));
      }
      const restoredLegacyPackage =
        journal.state === 'restored' && op.name === '.pstack/package' && journal.operations[0].kind === 'legacy-directory';
      if (restoredLegacyPackage) {
        return false;
      }
      return !matchesObserved(op.path, observe(op.path), op[journal.state === 'committed' ? 'after' : 'before']);
    });
    assert.ok(!conflicts.length, `Committed cleanup conflict; preserve: ${conflicts.map(op => op.path).join(', ')}. Retry: ${command}`);
    cleanupJournalMetadata(root, journal);
    await boundary('recovery:cleanup', journal);
    return {
      status: journal.state === 'committed' ? 'committed-cleanup' : 'restored-cleanup',
      restored: journal.state === 'restored',
      operation: journal.id
    };
  }
  const legacy = journal.operations.find(op => op.kind === 'legacy-directory');
  const conflicts = journal.operations.filter(op => {
    if (op.kind === 'legacy-directory') {
      return legacyMoveStatus(root, journal, op) === 'conflict';
    }
    if (legacy && op.name === '.pstack/package' && legacyMoveStatus(root, journal, legacy) === 'before') {
      return false;
    }
    return !matchesObserved(op.path, observe(op.path), op.before) && !matchesObserved(op.path, observe(op.path), op.after);
  });
  assert.ok(
    !conflicts.length,
    `Recovery conflict; preserve changed paths: ${conflicts.map(op => op.path).join(', ')}. Restore a recorded before/after version after preserving your edit, then retry: ${command}`
  );
  cleanOperationTemporaries(journal);
  journal.state = 'restoring';
  persistJournal(root, journal);
  await boundary('restoring', journal);
  for (const [index, op] of journal.operations.slice().reverse().entries()) {
    if (op.kind === 'legacy-directory') {
      applyLegacyMove(root, journal, op, 'before');
    } else if (!(legacy && op.name === '.pstack/package' && legacyMoveStatus(root, journal, legacy) === 'before')) {
      await applyJournalImage(op, 'before', journal.id, () => boundary(`restore-temporary:${index}`, journal));
    }
    await boundary(`restore:${index}`, journal);
  }
  for (const path of journal.createdDirectories.slice().reverse()) {
    if (present(path)) {
      try {
        rmdirSync(path);
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) {
          throw error;
        }
      }
    }
  }
  journal.state = 'restored';
  persistJournal(root, journal);
  await boundary('restored', journal);
  cleanupJournalMetadata(root, journal);
  await boundary('recovery:cleanup', journal);
  return { status: 'restored-prior', restored: true, operation: journal.id };
}
export const recoveryContract = 2;
export async function recoverInstallation(root, { recoverDeadLocks = false, boundary, executablePackage, env = process.env } = {}) {
  root = canonicalPath(root);
  const journal = readActivationJournal(root);
  if (executablePackage && journal) {
    assert.equal(
      canonicalPath(executablePackage),
      canonicalPath(resolve(root, (journal.recoveryGeneration ?? journal.generation).name)),
      'Use the exact retained recovery command from doctor/journal'
    );
  }
  let roots;
  if (journal) {
    roots = journalMutationRoots(root, journal);
  } else {
    const previous = stateFrom(safePath(root, '.pstack/install.json'));
    const candidates = [join(root, '.opencode')];
    if (Object.keys(previous.entries).some(name => name.startsWith('@opencode/'))) {
      candidates.push(resolve(root, previous.opencodeRoot));
    }
    if (root === canonicalPath(env.HOME || homedir())) {
      candidates.push(resolve(env.XDG_CONFIG_HOME || join(root, '.config'), 'opencode'));
    }
    roots = [...new Set(candidates)].filter(path => present(safePath(canonicalPath(path), '.pstack-mutation.lock')));
  }

  const recoveredLocks = recoverDeadLocks ? recoverDemonstrablyDeadLocks(root, roots) : [];
  if (!journal) {
    return { status: 'no-operation', restored: false, recoveredLocks };
  }
  try {
    const result = await withInstallationMutation({ root, opencodeRoots: roots }, () => recoverUnderLock(root, { boundary }));
    if (result.operation) {
      try {
        await withInstallationMutation({ root }, () => {
          finishJournalCleanup(root, result.operation);
          if (result.status === 'committed-cleanup') {
            result.cleanup = cleanupReleases(root);
          }
        });
      } catch (error) {
        result.cleanupPending = true;
        result.cleanupError = error.message;
      }
    }
    return { ...result, recoveredLocks };
  } catch (error) {
    if (journal) {
      error.message += `\nRetry after resolving ownership: ${recoveryCommand(root, journal)}${/Installation busy/.test(error.message) ? ' --recover-dead-locks (only demonstrably dead owners are removed)' : ''}`;
    }
    throw error;
  }
}
