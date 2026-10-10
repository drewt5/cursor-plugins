import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath, safePath, stateFrom, installationSnapshot, parseInstallationState } from './installation-state.mjs';
import { validatePrevious, renderingFingerprint, selectRecoveryGeneration } from './installation-history.mjs';
import { loadModelConfig } from '../../skills/pstack-runtime/scripts/models.mjs';
import { renderStagedArtifacts, verifyGeneration } from './installation-storage.mjs';
import { planInstallation } from './installation-plan.mjs';
import { inspectExistingInstallation } from './installation-discovery.mjs';
import { mandatoryDiscoveryFailures } from './installation-preflight.mjs';
import { applyStagedActivation } from './installation-activation.mjs';
import { readActivationJournal } from './activation-journal.mjs';
import { recoverInstallation } from './installation-recovery.mjs';
const derived = name => name === '.pstack/opencode-models.json' || /^@opencode\/agents\/pstack-model-[a-f0-9]{12}\.md$/.test(name);
export async function prepareRollback({ root, globalRoot, global = false, env = process.env, diagnose = inspectExistingInstallation }) {
  root = canonicalPath(root); const current = stateFrom(safePath(root, '.pstack/install.json'));
  assert.ok(current.version === 4 && current.previous, 'No previous successful installation is available; apply an explicitly selected release checkout with install.mjs.');
  validatePrevious(current.previous); const previous = current.previous;
  const integrityFailures = []; let packageRoot;
  for (const generation of [previous.state.generation, current.generation]) try { const path = verifyGeneration(root, generation); if (generation === previous.state.generation) packageRoot = path; } catch (error) { integrityFailures.push({ code: 'GENERATION_INVALID', severity: 'error', subject: generation.name, evidence: { error: error.message }, action: 'Preserve the modified package and restore its verified bytes before rollback.' }); }
  const config = loadModelConfig({ project: root, home: globalRoot, configHome: env.XDG_CONFIG_HOME, host: 'opencode' });
  const fingerprint = renderingFingerprint(config, previous.state.targets);
  let artifacts = { state: structuredClone(previous.state), contents: new Map(Object.entries(previous.contents).map(([name, data]) => [name, Buffer.from(data, 'base64')])) };
  if (fingerprint !== previous.state.renderingFingerprint && !integrityFailures.length) {
    try {
      assert.ok(previous.state.generation.renderer, 'The previous release has no supported retained renderer');
      const retained = await import(pathToFileURL(join(packageRoot, 'skills/pstack-runtime/scripts/models.mjs')).href);
      const retainedConfig = retained.loadModelConfig({ project: root, home: globalRoot, configHome: env.XDG_CONFIG_HOME, host: 'opencode' });
      assert.equal(renderingFingerprint(retainedConfig, previous.state.targets), fingerprint, 'Previous release cannot represent current effective model inputs');
      artifacts = await renderStagedArtifacts({ root, generation: previous.state.generation, targets: previous.state.targets, opencodeRoot: previous.state.opencodeRoot, global, config: retainedConfig, hostObservations: previous.state.hostObservations });
      for (const name of new Set([...Object.keys(previous.state.entries), ...Object.keys(artifacts.state.entries)])) if (!derived(name)) assert.ok(isDeepStrictEqual(artifacts.state.entries[name], previous.state.entries[name]), `Previous renderer changed configuration-independent artifact ${name}`);
      Object.assign(artifacts.state, { version: 4, generation: previous.state.generation, renderingFingerprint: fingerprint });
    } catch (error) { throw new Error(`Rollback refused before writes: ${error.message}. Apply the current selected release with install.mjs to render current settings, or restore the previous effective model settings and retry rollback.`); }
  }
  parseInstallationState(JSON.stringify(artifacts.state));
  const plan = planInstallation(installationSnapshot({ root, desired: artifacts.state }), artifacts);
  const diagnosticOptions = { root, global, globalRoot, env };
  const report = await diagnose({ ...diagnosticOptions, targets: current.targets });
  const failures = [...integrityFailures, ...report.findings.filter(item => item.severity === 'error' && !(item.code === 'OWNED_MISSING' && plan.operations.some(op => op.path === item.subject && op.action !== 'conflict')))];
  return { root, globalRoot, generation: previous.state.generation, recoveryGeneration: !failures.length && !plan.conflicts.length ? await selectRecoveryGeneration(root, current) : current.generation, targets: artifacts.state.targets, options: { global }, plan, report, failures, discoveryFailures: mandatoryDiscoveryFailures(report), diagnosticOptions, regenerated: fingerprint !== previous.state.renderingFingerprint };
}
export async function rollbackInstallation(options, controls = {}) {
  const root = canonicalPath(options.root);
  const recovered = readActivationJournal(root) ? await recoverInstallation(root, { recoverDeadLocks: !!options.recoverDeadLocks }) : null;
  const prepared = await prepareRollback({ ...options, root });
  if (prepared.plan.conflicts.length || prepared.failures.length || prepared.discoveryFailures.length) return { status: 'preflight-failed', changed: false, prepared, recovered };
  return { ...await applyStagedActivation(prepared, controls), regenerated: prepared.regenerated, recovered };
}
