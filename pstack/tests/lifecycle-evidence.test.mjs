import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLifecycleEvidence } from '../scripts/lib/lifecycle-evidence.mjs';
import { validateReleaseEvidence } from '../scripts/lib/release-evidence.mjs';
import { evidenceFixture } from './fixtures/release-evidence.mjs';
import { lifecycleFixture } from './fixtures/lifecycle-evidence.mjs';
const identity = { sourceCommit: 'a'.repeat(40), packageDigest: 'b'.repeat(64), upstreamCommit: 'c'.repeat(40) };
const input = evidenceFixture();
input.jobs[0].steps.push({ name: 'Skipped fixture', number: 2, status: 'completed', conclusion: 'skipped' });
const required = validateReleaseEvidence(input), upstream = { sharedWorkflowDiffDigest: 'd'.repeat(64) };
const fixture = () => lifecycleFixture(identity, required, upstream);
const validate = proof => validateLifecycleEvidence(proof, identity, required, upstream);
test('complete cost measurements include zero-duration and skipped steps, with jobs matched by name', () => {
  const proof = fixture();
  assert.equal(validate(proof).status, 'verified-for-maintainer-review');
  proof.cost.current.jobs.reverse(); proof.cost.baseline.jobs.reverse();
  assert.equal(validate(proof).status, 'verified-for-maintainer-review');
  proof.cost.current.jobs[0].durationSeconds += 0.0005;
  assert.equal(validate(proof).status, 'verified-for-maintainer-review');
});
test('rejects empty cost job records', () => {
  for (const sample of ['current', 'baseline']) {
    const proof = fixture(); proof.cost[sample].jobs = Array.from({ length: 8 }, () => ({}));
    assert.throws(() => validate(proof), /cost jobs/);
  }
});
test('lifecycle source, case and manifesto binding remains required', () => {
  for (const change of [p => p.candidate.sourceCommit = 'f'.repeat(40), p => p.required.runAttempt = 2, p => p.environment.maintainerCredentials = true, p => p.cases.pop(), p => p.cases[0].status = 'failed', p => p.audit.pop(), p => p.cost.assessment = ' ']) {
    const proof = fixture(); change(proof); assert.throws(() => validate(proof));
  }
});
const invalidSamples = {
  'missing job': s => s.jobs.pop(),
  'duplicate job': s => s.jobs[0] = structuredClone(s.jobs[1]),
  'unknown job': s => s.jobs[0].name = 'Other job',
  'zero ID': s => s.jobs[0].id = 0,
  'duplicate ID': s => s.jobs[0].id = s.jobs[1].id,
  'string ID': s => s.jobs[0].id = '1',
  'invalid run ID': s => s.runId = 'not-numeric',
  'invalid attempt': s => s.runAttempt = 1.5,
  'invalid source': s => s.sourceHeadSha = 'a'.repeat(39),
  'invalid event': s => s.event = 'schedule',
  'invalid URL': s => s.url = 'https://example.com',
  'invalid createdAt': s => s.createdAt = 'unknown',
  'missing report digest': s => delete s.reportDigests.helpers,
  'invalid checkout digest': s => s.checkoutLogDigest = '',
  'failed run': s => s.conclusion = 'failure',
  'missing run outcome': s => delete s.conclusion,
  'failed job': s => s.jobs[0].conclusion = 'failure',
  'missing job outcome': s => delete s.jobs[0].conclusion,
  'reversed timestamps': s => s.jobs[0].end = s.createdAt,
  'job before event': s => s.createdAt = s.jobs[0].end,
  'wrong elapsed': s => s.jobs[0].durationSeconds += 1,
  'wrong wait': s => s.jobs[0].preJobWaitSeconds += 1,
  'wrong critical path': s => s.criticalPathSeconds = 80,
  'wrong event total': s => s.eventToLastJobSeconds += 1,
  'missing steps': s => s.jobs[0].steps = [],
  'duplicate step': s => s.jobs[0].steps.push(structuredClone(s.jobs[0].steps[0])),
  'failed step': s => s.jobs[0].steps[0].status = 'failure',
  'lifecycle status instead of outcome': s => s.jobs[0].steps[0].status = 'completed',
  'omitted phase': s => s.jobs.find(j => j.executionPhases.length).executionPhases.pop(),
  'missing phase list': s => delete s.jobs[0].executionPhases,
  'wrong phase total': s => s.jobs[0].phaseExecutionSeconds += 1,
};
for (const [name, change] of Object.entries(invalidSamples)) test(`rejects ${name} in either cost sample`, () => {
  for (const sample of ['current', 'baseline']) {
    const proof = fixture(); change(proof.cost[sample]); assert.throws(() => validate(proof));
  }
});
for (const bad of [undefined, -1, '0', NaN, Infinity]) test(`rejects invalid duration ${String(bad)} at every measurement boundary`, () => {
  for (const sample of ['current', 'baseline']) for (const change of [
    s => s.criticalPathSeconds = bad, s => s.eventToLastJobSeconds = bad,
    s => s.jobs[0].durationSeconds = bad, s => s.jobs[0].preJobWaitSeconds = bad,
    s => s.jobs[0].phaseExecutionSeconds = bad, s => s.jobs[0].steps[0].durationSeconds = bad,
    s => s.jobs.find(j => j.executionPhases.length).executionPhases[0].durationMs = bad,
  ]) { const proof = fixture(); change(proof.cost[sample]); assert.throws(() => validate(proof)); }
});
test('current cost must correspond to supplied validated required evidence', () => {
  for (const change of [
    s => s.runId = '124', s => s.runAttempt = 2, s => s.sourceHeadSha = 'f'.repeat(40), s => s.event = 'pull_request',
    s => s.jobs[0].id += 100, s => s.jobs[0].steps[0].name = 'Different step', s => s.jobs[0].steps[0].status = 'skipped',
    s => s.reportDigests.helpers = 'f'.repeat(64), s => s.checkoutLogDigest = 'f'.repeat(64),
    s => { const job = s.jobs.find(j => j.executionPhases.length); job.executionPhases[0].durationMs += 1000; job.phaseExecutionSeconds += 1; },
  ]) { const proof = fixture(); change(proof.cost.current); assert.throws(() => validate(proof)); }
});
test('historical missing report source is allowed only with explicit baseline provenance', () => {
  const proof = fixture();
  proof.cost.baseline.reportProvenance.sourceHeadSha = null;
  proof.cost.baseline.reportProvenance.limitation = 'cost-only historical reports lack sourceHeadSha';
  assert.equal(validate(proof).status, 'verified-for-maintainer-review');
  for (const change of [
    p => delete p.cost.baseline.reportProvenance,
    p => delete p.cost.baseline.reportProvenance.limitation,
    p => p.cost.baseline.reportProvenance.testedSha = null,
    p => p.cost.baseline.reportProvenance.runId = '999',
    p => p.cost.baseline.reportProvenance.checkoutLogDigest = 'f'.repeat(64),
    p => p.cost.baseline.sourceHeadSha = null,
    p => p.cost.current = structuredClone(p.cost.baseline),
    p => p.cost.current.reportProvenance = structuredClone(p.cost.baseline.reportProvenance),
    p => p.cost.baseline.jobs[0].id = p.cost.current.jobs[0].id,
  ]) { const bad = structuredClone(proof); change(bad); assert.throws(() => validate(bad)); }
});
