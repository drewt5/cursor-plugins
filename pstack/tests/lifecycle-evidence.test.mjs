import test from 'node:test';
import assert from 'node:assert/strict';
import { lifecycleCases, validateLifecycleEvidence } from '../scripts/lib/lifecycle-evidence.mjs';
const identity = { sourceCommit: 'a'.repeat(40), packageDigest: 'b'.repeat(64), upstreamCommit: 'c'.repeat(40) };
const required = { runId: '123', runAttempt: 1, sourceHeadSha: identity.sourceCommit }, upstream = { sharedWorkflowDiffDigest: 'd'.repeat(64) };
function fixture() { return { schemaVersion: 1, kind: 'portable-lifecycle-acceptance', status: 'passed', candidate: identity, required, upstreamSharedDiffDigest: upstream.sharedWorkflowDiffDigest, environment: { cloneUrl: 'https://github.com/drewt5/cursor-plugins.git', cloneSourceCommit: identity.sourceCommit, maintainerCredentials: false, existingInstallation: false, prerequisites: { node: '20', codex: 'baseline' } }, cases: lifecycleCases.map(name => ({ name, status: 'passed', logDigest: 'e'.repeat(64) })), audit: Array.from({ length: 10 }, (_, i) => ({ principle: `P${i + 1}`, status: 'fulfilled-with-limits', evidence: 'explicit audit and source-bound outcomes', limits: ['No semantic/GUI/model reasoning certification'] })), cost: { baseline: { runId: '122', jobs: Array(8).fill({}) }, current: { runId: '123', runAttempt: 1, jobs: Array(8).fill({}) }, assessment: 'Separate execution from queue/setup; bounded matrix remains' } }; }
test('only complete source/run-bound public lifecycle and manifesto evidence marks a candidate for maintainer review', () => {
  assert.equal(validateLifecycleEvidence(fixture(), identity, required, upstream).status, 'verified-for-maintainer-review');
  for (const change of [p => p.candidate = { ...identity, sourceCommit: 'f'.repeat(40) }, p => p.required = { ...required, runAttempt: 2 }, p => p.environment.maintainerCredentials = true, p => p.cases.pop(), p => p.cases[0].status = 'failed', p => p.audit.pop(), p => p.cost.current.runId = '124']) {
    const proof = structuredClone(fixture()); change(proof); assert.throws(() => validateLifecycleEvidence(proof, identity, required, upstream));
  }
});
