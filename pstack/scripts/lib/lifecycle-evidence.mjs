import assert from 'node:assert/strict';
import { requiredJobChecks, requiredPhases } from './release-evidence.mjs';
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
  assert.ok(typeof proof.cost?.assessment === 'string' && proof.cost.assessment.trim(), 'Missing cost assessment');
  validateCostSample(proof.cost.current, required);
  validateCostSample(proof.cost.baseline);
  assert.notEqual(String(proof.cost.baseline.runId), String(proof.cost.current.runId), 'Baseline must identify its own run');
  const currentIds = new Set(proof.cost.current.jobs.map(job => job.id));
  assert.ok(proof.cost.baseline.jobs.every(job => !currentIds.has(job.id)), 'Baseline job IDs must belong to its own run');
  return { status: 'verified-for-maintainer-review', evidenceDigest: digest(JSON.stringify(proof)), evidence: proof, limits: 'Checks structure, arithmetic and correspondence with supplied required evidence. Unsigned baseline measurements and scenario log digests are maintainer attestations; no authentication, scenario execution proof, P1-P10 prose judgment, publication, semantic parity, model reasoning or GUI certification.' };
}

function duration(value, label) {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `Missing/invalid cost duration: ${label}`);
  return value;
}
function elapsed(value, expected, label) {
  assert.ok(Math.abs(duration(value, label) - expected) <= 0.001, `Inconsistent cost duration: ${label}`);
}
function timestamp(value, label) {
  assert.ok(typeof value === 'string' && Number.isFinite(Date.parse(value)), `Missing/invalid cost timestamp: ${label}`);
  return Date.parse(value);
}
function positiveId(value, label) {
  assert.ok(Number.isSafeInteger(value) && value > 0, `Invalid positive cost ID: ${label}`);
}
function sha(value, length, label) {
  assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value), `Missing/invalid cost digest: ${label}`);
}
function validateCostSample(sample, required) {
  assert.ok(sample && typeof sample === 'object', 'Missing cost sample; collect complete measurements');
  assert.ok(/^[1-9][0-9]*$/.test(String(sample.runId)) && ['string', 'number'].includes(typeof sample.runId), 'Invalid cost run ID');
  positiveId(Number(sample.runId), 'runId'); positiveId(sample.runAttempt, 'runAttempt');
  sha(sample.sourceHeadSha, 40, 'sourceHeadSha');
  assert.ok(['push', 'pull_request', 'workflow_dispatch', 'merge_group'].includes(sample.event), 'Invalid cost event');
  assert.equal(sample.url, `https://github.com/drewt5/cursor-plugins/actions/runs/${sample.runId}`, 'Cost run URL mismatch');
  assert.equal(sample.conclusion, 'success', 'Missing successful cost run conclusion; recollect evidence with explicit outcomes');
  sha(sample.checkoutLogDigest, 64, 'checkoutLogDigest');
  assert.deepEqual(Object.keys(sample.reportDigests ?? {}).sort(), Object.keys(requiredPhases).sort(), 'Missing cost report digests');
  for (const value of Object.values(sample.reportDigests)) sha(value, 64, 'reportDigest');
  assert.ok(Array.isArray(sample.jobs), 'Missing cost jobs');
  assert.deepEqual(sample.jobs.map(job => job.name).sort(), Object.keys(requiredJobChecks).sort(), 'Missing, duplicate or unknown cost jobs');
  const created = timestamp(sample.createdAt, 'createdAt'), ids = new Set(), starts = [], ends = [];
  if (required) {
    for (const key of ['runAttempt', 'sourceHeadSha', 'event', 'checkoutLogDigest']) assert.equal(sample[key], required[key], `Current cost ${key} differs from required evidence`);
    assert.equal(String(sample.runId), required.runId, 'Current cost run differs');
    assert.deepEqual(sample.reportDigests, Object.fromEntries(required.reports.map(report => [report.check, report.reportDigest])), 'Current cost report digests differ');
    assert.equal(sample.reportProvenance, undefined, 'Historical report provenance is baseline-only');
  } else {
    const provenance = sample.reportProvenance;
    assert.ok(provenance, 'Missing baseline reportProvenance; retain tested commit and run/checkout provenance');
    sha(provenance.testedSha, 40, 'baseline testedSha');
    assert.equal(String(provenance.runId), String(sample.runId)); assert.equal(provenance.runAttempt, sample.runAttempt);
    assert.equal(provenance.checkoutLogDigest, sample.checkoutLogDigest);
    if (provenance.sourceHeadSha === null) {
      assert.equal(provenance.limitation, 'cost-only historical reports lack sourceHeadSha', 'Missing explicit historical baseline limitation');
    } else assert.equal(provenance.sourceHeadSha, sample.sourceHeadSha, 'Baseline report source differs');
    if (sample.event !== 'pull_request') assert.equal(provenance.testedSha, sample.sourceHeadSha, 'Baseline checkout differs from source');
  }
  for (const job of sample.jobs) {
    positiveId(job.id, job.name); assert.ok(!ids.has(job.id), 'Duplicate cost job ID'); ids.add(job.id);
    assert.equal(job.conclusion, 'success', 'Missing successful cost job conclusion; recollect evidence with explicit outcomes');
    const start = timestamp(job.start, `${job.name}.start`), end = timestamp(job.end, `${job.name}.end`);
    assert.ok(created <= start && start <= end, 'Reversed cost timestamps'); starts.push(start); ends.push(end);
    elapsed(job.durationSeconds, (end - start) / 1000, `${job.name}.durationSeconds`);
    elapsed(job.preJobWaitSeconds, (start - created) / 1000, `${job.name}.preJobWaitSeconds`);
    assert.ok(Array.isArray(job.steps) && job.steps.length, 'Missing cost steps');
    const stepNames = new Set();
    for (const step of job.steps) {
      assert.ok(typeof step.name === 'string' && step.name.trim() && !stepNames.has(step.name), 'Missing/duplicate cost step name'); stepNames.add(step.name);
      assert.ok(['success', 'skipped'].includes(step.status), 'Unsuccessful cost step conclusion');
      duration(step.durationSeconds, `${job.name}.${step.name}`);
    }
    const check = requiredJobChecks[job.name];
    assert.ok(Array.isArray(job.executionPhases), 'Missing execution phase measurements');
    assert.deepEqual(job.executionPhases.map(phase => phase.phase).sort(), [...(requiredPhases[check] ?? [])].sort(), 'Incomplete cost execution phases');
    let phaseMs = 0;
    for (const phase of job.executionPhases) phaseMs += duration(phase.durationMs, `${job.name}.${phase.phase}`);
    elapsed(job.phaseExecutionSeconds, phaseMs / 1000, `${job.name}.phaseExecutionSeconds`);
    if (required) {
      const expectedJob = required.jobs.find(item => item.name === job.name);
      assert.equal(job.id, expectedJob.id, 'Current cost job ID differs');
      const ordered = steps => steps.map(step => [step.name, step.status]).sort(([a], [b]) => a.localeCompare(b));
      assert.deepEqual(ordered(job.steps), ordered(expectedJob.steps.map(step => ({ name: step.name, status: step.conclusion }))), 'Current cost step outcomes differ');
      const phases = required.reports.find(report => report.check === check)?.phases ?? [];
      for (const phase of job.executionPhases) assert.equal(phase.durationMs, phases.find(item => item.phase === phase.phase)?.durationMs, 'Current cost phase duration differs');
    }
  }
  elapsed(sample.criticalPathSeconds, (Math.max(...ends) - Math.min(...starts)) / 1000, 'criticalPathSeconds');
  elapsed(sample.eventToLastJobSeconds, (Math.max(...ends) - created) / 1000, 'eventToLastJobSeconds');
}
