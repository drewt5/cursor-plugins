import { lifecycleCases } from '../../scripts/lib/lifecycle-evidence.mjs';
import { requiredJobChecks } from '../../scripts/lib/release-evidence.mjs';
export function lifecycleFixture(identity, required, upstream) {
  const current = {
    runId: required.runId, runAttempt: required.runAttempt, sourceHeadSha: required.sourceHeadSha,
    event: required.event, url: required.url, conclusion: 'success', createdAt: '2026-10-10T00:00:00Z',
    criticalPathSeconds: 17, eventToLastJobSeconds: 19,
    reportDigests: Object.fromEntries(required.reports.map(report => [report.check, report.reportDigest])),
    checkoutLogDigest: required.checkoutLogDigest,
    jobs: required.jobs.map((job, index) => {
      const executionPhases = (required.reports.find(report => report.check === requiredJobChecks[job.name])?.phases ?? []).map(({ phase, durationMs }) => ({ phase, durationMs }));
      return {
        name: job.name, id: job.id, conclusion: 'success', start: new Date(Date.UTC(2026, 9, 10, 0, 0, index + 2)).toISOString(),
        end: new Date(Date.UTC(2026, 9, 10, 0, 0, index + 12)).toISOString(), durationSeconds: 10, preJobWaitSeconds: index + 2,
        steps: job.steps.map(step => ({ name: step.name, status: step.conclusion, durationSeconds: 0 })),
        executionPhases, phaseExecutionSeconds: executionPhases.reduce((total, phase) => total + phase.durationMs, 0) / 1000,
      };
    }),
  };
  const baseline = structuredClone(current);
  baseline.runId = '122'; baseline.url = 'https://github.com/drewt5/cursor-plugins/actions/runs/122';
  baseline.jobs.forEach(job => { job.id += 1000; });
  baseline.reportProvenance = { sourceHeadSha: baseline.sourceHeadSha, testedSha: baseline.sourceHeadSha, runId: baseline.runId, runAttempt: baseline.runAttempt, checkoutLogDigest: baseline.checkoutLogDigest };
  return {
    schemaVersion: 1, kind: 'portable-lifecycle-acceptance', status: 'passed',
    candidate: { sourceCommit: identity.sourceCommit, packageDigest: identity.packageDigest, upstreamCommit: identity.upstreamCommit },
    required: { runId: required.runId, runAttempt: required.runAttempt, sourceHeadSha: required.sourceHeadSha },
    upstreamSharedDiffDigest: upstream.sharedWorkflowDiffDigest,
    environment: { cloneUrl: 'https://github.com/drewt5/cursor-plugins.git', cloneSourceCommit: identity.sourceCommit, maintainerCredentials: false, existingInstallation: false, prerequisites: { node: '20', codex: 'baseline' } },
    cases: lifecycleCases.map(name => ({ name, status: 'passed', logDigest: 'e'.repeat(64) })),
    audit: Array.from({ length: 10 }, (_, i) => ({ principle: `P${i + 1}`, status: 'fulfilled-with-limits', evidence: 'explicit audit and source-bound outcomes', limits: ['No semantic/GUI/model reasoning certification'] })),
    cost: { baseline, current, assessment: 'Separate execution from queue/setup; bounded matrix remains' },
  };
}
