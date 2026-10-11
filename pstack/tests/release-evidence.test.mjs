import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReleaseEvidence } from '../scripts/lib/release-evidence.mjs';
import { validateUpstreamReview } from '../scripts/lib/upstream-review.mjs';
import { evidenceFixture } from './fixtures/release-evidence.mjs';
const sourceCommit = 'a'.repeat(40), runId = '123', attempt = 1;
const refresh = fixture => { for (const item of fixture.reports) item.bytes = JSON.stringify(item.report); return fixture; };
test('complete required baseline compiles deterministic self-contained phase/job/version identities and digests', () => {
  const f = evidenceFixture(), result = validateReleaseEvidence(f); assert.deepEqual(validateReleaseEvidence(f), result);
  assert.equal(result.createdAt, f.run.created_at);
  const job = result.jobs.find(item => item.id === f.jobs[0].id);
  assert.equal(job.startedAt, f.jobs[0].started_at); assert.equal(job.completedAt, f.jobs[0].completed_at);
  assert.equal(job.steps[0].startedAt, f.jobs[0].steps[0].started_at); assert.equal(job.steps[0].completedAt, f.jobs[0].steps[0].completed_at);
  assert.equal(result.reports.length, 6); assert.equal(result.jobs.length, 8); assert.equal(result.sourceHeadSha, sourceCommit);
  for (const r of result.reports) { assert.match(r.reportDigest, /^[a-f0-9]{64}$/); assert.equal(r.status, 'passed'); assert.ok(r.phases.every(p => p.status === 'passed' && /^[a-f0-9]{64}$/.test(p.logDigest))); }
  const published = JSON.parse(JSON.stringify(result)); f.reports = []; assert.equal(published.reports[0].phases[0].command[0], 'node'); assert.equal(published.jobs[0].steps[0].conclusion, 'success');
});
test('wrong commits, stale attempts, missing/failed phases/jobs/logs and unknown versions fail closed', () => {
  const mutations = [
    f => { f.sourceCommit = 'b'.repeat(40); }, f => { f.attempt = 2; }, f => { f.run.run_attempt = 2; },
    f => { f.reports.pop(); }, f => { f.reports[0].report.phases = []; }, f => { f.jobs.pop(); },
    f => { f.jobs[0].steps[0].conclusion = 'failure'; }, f => { f.reports[0].report.phases[0].status = 'failed'; },
    f => { f.reports[0].report.phases[0].identity = { ...f.reports[0].report.phases[0].identity, runAttempt: 2 }; },
    f => { f.reports[0].logs = {}; }, f => { f.reports.find(i => i.report.host).report.host.actualVersion = '999.0.0'; },
    f => { f.reports[0].report.testedSha = 'b'.repeat(40); }, f => { f.checkoutLog = sourceCommit; },
    f => { f.jobs[0].run_attempt = 2; }, f => { f.reports[0].report.phases[0].command = ['echo', 'mock pass']; },
  ];
  for (const mutate of mutations) { const f = evidenceFixture(); mutate(f); assert.throws(() => validateReleaseEvidence(refresh(f))); }
});
test('advisory latest-version evidence cannot replace required-baseline coverage', () => {
  for (const mutate of [f => { f.run.path = '.github/workflows/pstack-canary.yml'; }, f => { f.run.event = 'schedule'; }, f => { f.reports.find(i => i.report.host).report.host.resolution = { version: 'latest' }; }]) { const f = evidenceFixture(); mutate(f); assert.throws(() => validateReleaseEvidence(refresh(f))); }
});
test('upstream review binds exact shared delta and inventory while allowing metadata-only candidate reuse', () => {
  const comparison = { upstreamCommit: sourceCommit, sharedWorkflowDiffDigest: 'b'.repeat(64), changedPaths: ['pstack/skills/one/SKILL.md'], inventory: { upstreamSkillCount: 1, currentSkillCount: 2, added: ['runtime'], removed: [] } };
  const review = { schemaVersion: 1, ...comparison, deviations: [{ paths: comparison.changedPaths, rationale: 'Resolve host capabilities without changing the workflow purpose.' }], upstreamCandidates: ['Portable transcript handling'], limitations: ['Mock invocation is not model reasoning.'] };
  assert.equal(validateUpstreamReview(comparison, review).inventory.added[0], 'runtime');
  for (const change of [r => { r.sharedWorkflowDiffDigest = 'c'.repeat(64); }, r => { r.inventory.added = []; }, r => { r.deviations = []; }, r => { r.deviations[0].rationale = ''; }]) { const r = structuredClone(review); change(r); assert.throws(() => validateUpstreamReview(comparison, r)); }
});
