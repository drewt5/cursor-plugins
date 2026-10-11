import { join, resolve } from 'node:path';
import { loadModelConfig } from '../../skills/pstack-runtime/scripts/models.mjs';
import { readSourceProvenance } from './package-provenance.mjs';
import { renderingFingerprint } from './installation-history.mjs';
import { generationDescriptor } from './generation-contract.mjs';
import { legacyTree } from './legacy-storage.mjs';
import { canonicalPath, installationSnapshot, present, safePath, stateFrom, observe } from './installation-state.mjs';
import { renderArtifacts } from './installation-artifacts.mjs';
import { prepareInstallation } from './installation-preflight.mjs';
import { planInstallation } from './installation-plan.mjs';
import { runStagedInstallation, applyStagedActivation } from './installation-activation.mjs';
import { prepareRemoval, removeInstallation } from './installation-removal.mjs';
import { recoverInstallation } from './installation-recovery.mjs';
import { readActivationJournal, quote } from './activation-journal.mjs';
import { withInstallationMutation } from './installation-lock.mjs';
import { cleanupReleases, removeEmptyStorage } from './release-cleanup.mjs';
export function publicOptions(options) {
  const root = canonicalPath(options.root), previous = stateFrom(safePath(root, '.pstack/install.json'));
  return { ...options, root, ...(previous.version < 4 && Object.keys(previous.entries).some(name => name.startsWith('@opencode/')) ? { opencodeRootOverride: previous.opencodeRoot } : {}) };
}
export async function previewInstallation(raw) {
  const options = publicOptions(raw), { root, source } = options, previous = stateFrom(safePath(root, '.pstack/install.json'));
  if (options.options.uninstall && previous.version === 4) {
    const selected = options.options.target === 'all' ? previous.targets.filter(target => target !== 'cursor') : options.options.target ? previous.targets.filter(target => target === options.options.target) : previous.targets;
    const prepared = await prepareRemoval({ root, targets: selected });
    return { ...prepared, selected, options: options.options, report: { findings: prepared.failures, discovery: { status: 'unavailable', reason: 'Uninstall does not launch providers.' } } };
  }
  const provenance = readSourceProvenance(source), generation = generationDescriptor({ digest: provenance.packageDigest, name: `.pstack/releases/${provenance.packageDigest}`, provenance, renderer: { module: 'scripts/lib/installation-artifacts.mjs', export: 'renderArtifacts', contract: 1 } });
  const modelConfig = () => loadModelConfig({ project: root, home: options.globalRoot, configHome: options.env?.XDG_CONFIG_HOME, host: 'opencode' });
  const prepared = await prepareInstallation({ ...options, render: args => {
    const config = args.targets.includes('opencode') ? modelConfig() : { roles: {} };
    const artifacts = renderArtifacts({ ...args, config, provenance, includePackage: false });
    for (const name of Object.keys(artifacts.state.entries)) if (name.startsWith('.pstack/package/')) { delete artifacts.state.entries[name]; artifacts.contents.delete(name); }
    if (artifacts.state.targets.length) { artifacts.state.entries['.pstack/package'] = { kind: 'link', to: `releases/${generation.digest}` }; Object.assign(artifacts.state, { version: 4, generation, provenance, renderingFingerprint: renderingFingerprint(config, artifacts.state.targets) }); }
    else artifacts.state = { version: 2, targets: [], entries: {} };
    return artifacts;
  } });
  if (previous.targets.length && previous.version < 4 && present(safePath(root, '.pstack/package'))?.isDirectory()) {
    const legacy = legacyTree(safePath(root, '.pstack/package'), previous, { collect: true });
    const snapshot = installationSnapshot({ root, desired: prepared.plan.artifacts.state, includeEntry: name => !name.startsWith('.pstack/package/') });
    prepared.plan = planInstallation(snapshot, prepared.plan.artifacts);
    let stable = prepared.plan.operations.find(op => op.name === '.pstack/package');
    if (!stable) { stable = { name: '.pstack/package', path: safePath(root, '.pstack/package'), before: observe(safePath(root, '.pstack/package')), intended: { kind: 'absent' }, action: 'conflict', ownership: 'unowned', owner: 'shared-package', reason: 'Legacy directory must be verified before removal' }; prepared.plan.operations.push(stable); }
    if (stable && !legacy.conflicts.length) Object.assign(stable, { action: stable.intended.kind === 'absent' ? 'remove' : 'replace', ownership: 'managed', code: null, reason: 'Verified legacy directory transition' });
    prepared.plan.conflicts = [...prepared.plan.operations.filter(op => op.action === 'conflict'), ...legacy.conflicts];
    prepared.legacy = { verified: !legacy.conflicts.length };
  }
  return { ...prepared, generation };
}
export async function applyPublicInstallation(raw, controls = {}) {
  const root = canonicalPath(raw.root);
  let recovered = null;
  if (readActivationJournal(root) || raw.options['recover-dead-locks']) {
    recovered = await recoverInstallation(root, { recoverDeadLocks: !!raw.options['recover-dead-locks'], env: raw.env });
  }
  const options = publicOptions({ ...raw, root });
  const prepared = await previewInstallation(options);
  if (!prepared.plan || prepared.plan.conflicts.length || prepared.failures.length || prepared.discoveryFailures.length) {
    return { status: 'preflight-failed', changed: false, prepared, recovered };
  }
  const previous = stateFrom(safePath(root, '.pstack/install.json'));
  if (options.options.uninstall && previous.version === 4) {
    return { ...(await removeInstallation({ root, targets: prepared.selected }, controls)), prepared, recovered };
  }
  if (options.options.uninstall && !previous.targets.length) {
    if (!present(safePath(root, '.pstack/releases'))) {
      return { status: 'unchanged', changed: false, prepared, recovered, report: prepared.report };
    }
    const cleanup = await withInstallationMutation({ root }, () => cleanupReleases(root));
    removeEmptyStorage(root);
    return { status: 'unchanged', changed: false, prepared, recovered, cleanup, report: prepared.report };
  }
  const selectedOptions = {
    ...options,
    options: {
      ...options.options,
      ...(options.options.target === undefined && !previous.targets.length && prepared.selected.length === 1
        ? { target: prepared.selected[0] }
        : {})
    }
  };
  let result;
  try {
    result = await runStagedInstallation(selectedOptions, controls);
  } catch (error) {
    if (/Installation busy/.test(error.message)) {
      error.message += `\nRecovery: node ${quote(join(options.source, 'scripts/recover.mjs'))} --project ${quote(root)} --recover-dead-locks (only demonstrably dead owners are removed)`;
    }
    throw error;
  }
  if (result.status === 'applied' && !result.prepared.targets.length && !result.cleanupPending) {
    removeEmptyStorage(root);
  }
  return { ...result, report: result.report ?? result.prepared?.report ?? prepared.report, recovered };
}
