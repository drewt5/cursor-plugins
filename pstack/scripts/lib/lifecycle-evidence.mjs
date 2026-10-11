import assert from 'node:assert/strict';
import { digest } from './installation-state.mjs';
export const lifecycleCases = ['public-clone', 'coherent-coexistence', 'ownership-conflict', 'interrupted-recovery', 'rollback', 'relocation-uninstall', 'historical-upgrade'];
export function validateLifecycleEvidence(proof, identity, required, upstreamReview) {
  assert.ok(proof && proof.schemaVersion === 1 && proof.kind === 'portable-lifecycle-acceptance' && proof.status === 'passed', 'Missing successful lifecycle acceptance evidence');
  assert.deepEqual(proof.candidate, { sourceCommit: identity.sourceCommit, packageDigest: identity.packageDigest, upstreamCommit: identity.upstreamCommit }, 'Lifecycle used a stale/different candidate');
  assert.deepEqual(proof.required, { runId: required.runId, runAttempt: required.runAttempt, sourceHeadSha: required.sourceHeadSha }, 'Lifecycle uses a different required run/attempt/head');
  assert.equal(proof.upstreamSharedDiffDigest, upstreamReview.sharedWorkflowDiffDigest, 'Lifecycle upstream review differs');
  assert.equal(proof.environment.cloneUrl, 'https://github.com/drewt5/cursor-plugins.git');
  assert.equal(proof.environment.cloneSourceCommit, identity.sourceCommit); assert.equal(proof.environment.maintainerCredentials, false); assert.equal(proof.environment.existingInstallation, false);
  assert.ok(proof.environment.prerequisites?.node && proof.environment.prerequisites?.codex, 'Record actual explicit prerequisites');
  assert.deepEqual(proof.cases.map(item => item.name).sort(), [...lifecycleCases].sort(), 'Incomplete lifecycle cases');
  assert.ok(proof.cases.every(item => item.status === 'passed' && /^[a-f0-9]{64}$/.test(item.logDigest)), 'Failed or missing lifecycle logs');
  assert.deepEqual(proof.audit.map(item => item.principle).sort(), Array.from({ length: 10 }, (_, i) => `P${i + 1}`).sort(), 'Account for P1-P10');
  assert.ok(proof.audit.every(item => ['fulfilled', 'fulfilled-with-limits'].includes(item.status) && item.evidence && Array.isArray(item.limits)), 'Incomplete manifesto evidence/limits');
  assert.ok(proof.cost?.baseline?.runId && proof.cost?.current?.runId === required.runId && proof.cost.current.runAttempt === required.runAttempt && proof.cost.baseline.jobs?.length === 8 && proof.cost.current.jobs?.length === 8 && proof.cost.assessment, 'Missing bounded required-CI cost comparison');
  return { status: 'verified-for-maintainer-review', evidenceDigest: digest(JSON.stringify(proof)), evidence: proof, limits: 'Unsigned maintainer evidence; no automatic publication, semantic parity, real-model reasoning or GUI certification.' };
}
