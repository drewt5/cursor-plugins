import { renderArtifacts } from '../../scripts/lib/installation-artifacts.mjs';
import { installationSnapshot } from '../../scripts/lib/installation-state.mjs';
import { planInstallation, applyInstallation } from '../../scripts/lib/installation-plan.mjs';
// Offline ownership/layout fixture; the real historical Git baseline is checked separately.
export function installLegacy({ source, root, targets = ['cursor'], schema = 2, opencodeRoot = '.opencode', global = false, config }) {
  const artifacts = renderArtifacts({ source, root, targets, opencodeRoot, global, config });
  for (const name of ['.pstack/package/release.json', '.pstack/package/pstack-provenance.json']) { delete artifacts.state.entries[name]; artifacts.contents.delete(name); }
  artifacts.state.version = schema; delete artifacts.state.provenance; delete artifacts.state.hostObservations;
  if (schema === 1) { artifacts.state.target = targets.length > 1 ? 'all' : targets[0]; delete artifacts.state.targets; }
  const desired = { ...artifacts.state, targets }; applyInstallation(planInstallation(installationSnapshot({ root, desired }), { ...artifacts, state: desired }));
  return artifacts;
}
