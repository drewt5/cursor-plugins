import { renderingFingerprint, selectRecoveryGeneration } from './installation-history.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmdirSync } from 'node:fs';
import { entryOwner, canonicalPath, pathFor, safePath, stateFrom, installationSnapshot } from './installation-state.mjs';
import { planInstallation } from './installation-plan.mjs';
import { verifyGeneration } from './installation-storage.mjs';
import { applyStagedActivation } from './installation-activation.mjs';
import { readActivationJournal } from './activation-journal.mjs';
import { recoverInstallation } from './installation-recovery.mjs';
export async function prepareRemoval({ root, targets }) {
  root = canonicalPath(root); const previous = stateFrom(safePath(root, '.pstack/install.json'));
  assert.equal(previous.version, 4, 'Retained removal requires a current-format installation; use the legacy installer until public migration ships');
  const failures = []; try { verifyGeneration(root, previous.generation); } catch (error) { failures.push({ code: 'GENERATION_INVALID', severity: 'error', subject: previous.generation.name, evidence: { error: error.message }, action: 'Preserve and restore the modified managed package before uninstall.' }); }
  const selected = targets ?? previous.targets;
  assert.ok(selected.every(target => previous.targets.includes(target)), 'Removal target is not installed');
  const remaining = previous.targets.filter(target => !selected.includes(target));
  const state = remaining.length ? structuredClone(previous) : { version: 2, targets: [], entries: {} };
  delete state.previous; state.targets = remaining; if (remaining.length && !remaining.includes('opencode')) state.renderingFingerprint = renderingFingerprint({ roles: {} }, remaining);
  if (remaining.length) { for (const name of Object.keys(state.entries)) if (entryOwner(name) !== 'shared-package' && !remaining.includes(entryOwner(name))) delete state.entries[name]; state.hostObservations = state.hostObservations.filter(item => remaining.includes(item.host)); }
  const contents = new Map();
  for (const [name, entry] of Object.entries(state.entries)) if (entry.kind === 'file') contents.set(name, readFileSync(pathFor(root, name, previous)));
  const plan = planInstallation(installationSnapshot({ root, desired: state }), { state, contents });
  return { root, generation: previous.generation, recoveryGeneration: !failures.length && !plan.conflicts.length ? await selectRecoveryGeneration(root, previous) : previous.generation, targets: remaining, options: { uninstall: true }, noHistory: !remaining.length, plan, failures, discoveryFailures: [], diagnosticOptions: { root, targets: [] } };
}
export async function removeInstallation(options, controls = {}) {
  const root = canonicalPath(options.root);
  const recovered = readActivationJournal(root) ? await recoverInstallation(root, { recoverDeadLocks: !!options.recoverDeadLocks }) : null;
  const prepared = await prepareRemoval({ ...options, root });
  if (prepared.plan.conflicts.length || prepared.failures.length) return { status: 'preflight-failed', changed: false, prepared, recovered };
  const result = await applyStagedActivation(prepared, { ...controls, diagnose: controls.diagnose ?? (async () => ({ findings: [], discovery: { status: 'unavailable' } })) });
  if (!prepared.targets.length && result.status === 'applied' && !result.cleanupPending) for (const name of ['.pstack/releases', '.pstack']) {
    const path = safePath(root, name); try { if (!readdirSync(path).length) rmdirSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...result, recovered };
}
