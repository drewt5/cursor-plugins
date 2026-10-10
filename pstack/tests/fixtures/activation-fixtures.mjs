import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { stagePackage } from '../../scripts/lib/installation-storage.mjs';
import { generationDescriptor } from '../../scripts/lib/generation-contract.mjs';
import { digest, installationSnapshot } from '../../scripts/lib/installation-state.mjs';
import { planInstallation, applyInstallation } from '../../scripts/lib/installation-plan.mjs';
export function compactActivation({ source, root, home, env }) {
  const generation = generationDescriptor(stagePackage({ source, root }));
  const file = bytes => ({ kind: 'file', hash: digest(bytes), mode: 0o644 });
  const common = { version: 4, targets: ['cursor'], opencodeRoot: '.opencode', provenance: generation.provenance, hostObservations: [], generation, renderingFingerprint: digest('config') };
  const prior = { state: { ...common, entries: { '.pstack/package': { kind: 'link', to: `releases/${generation.digest}` }, '.cursor/agents/replace.md': file('old'), '.cursor/agents/remove.md': file('remove'), '.cursor/skills/why': { kind: 'link', to: '../../.pstack/package/skills/why' } } }, contents: new Map([['.cursor/agents/replace.md', 'old'], ['.cursor/agents/remove.md', 'remove']]) };
  applyInstallation(planInstallation(installationSnapshot({ root, desired: prior.state }), prior)); chmodSync(join(root, '.pstack/install.json'), 0o600);
  const desired = { state: { ...common, entries: { '.pstack/package': prior.state.entries['.pstack/package'], '.cursor/agents/replace.md': file('new'), '.cursor/agents/nested/create.md': file('create'), '.cursor/skills/how': { kind: 'link', to: '../../.pstack/package/skills/how' } } }, contents: new Map([['.cursor/agents/replace.md', 'new'], ['.cursor/agents/nested/create.md', 'create']]) };
  return { source, root, globalRoot: home, plan: planInstallation(installationSnapshot({ root, desired: desired.state }), desired), generation, failures: [], discoveryFailures: [], targets: ['cursor'], diagnosticOptions: { root, globalRoot: home, env } };
}
export function serializablePrepared(prepared) {
  return { ...prepared, plan: { ...prepared.plan, artifacts: { ...prepared.plan.artifacts, contents: [...prepared.plan.artifacts.contents] } } };
}
