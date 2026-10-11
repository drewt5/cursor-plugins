import assert from 'node:assert/strict';
import { digest } from './installation-state.mjs';
const repository = 'drewt5/cursor-plugins';
export const requiredPhases = {
  'portable-ubuntu-latest': ['unit'], 'portable-macos-latest': ['unit'], helpers: ['helpers'],
  'native-codex': ['setup', 'discovery', 'invocation'], 'native-opencode': ['setup', 'discovery', 'invocation'], 'native-claude-code': ['setup', 'discovery', 'invocation'],
};
export const requiredJobChecks = {
  'Pstack host matrix': null,
  'Pstack portable (ubuntu-latest)': 'portable-ubuntu-latest',
  'Pstack portable (macos-latest)': 'portable-macos-latest',
  'Pstack helpers': 'helpers',
  'Pstack native (codex)': 'native-codex',
  'Pstack native (opencode)': 'native-opencode',
  'Pstack native (claude-code)': 'native-claude-code',
  'Pstack required': null,
};
const phaseCommand = (check, phase) => phase === 'setup' ? ['node', 'pstack/scripts/install-host.mjs'] : phase === 'unit' || phase === 'helpers' ? ['node', 'pstack/scripts/test.mjs', '--' + phase] : ['node', `pstack/scripts/check-${phase === 'discovery' ? 'hosts' : 'invocation'}.mjs`, check.slice('native-'.length)];
export function validateReleaseEvidence({ sourceCommit, run, jobs, reports, hosts, checkoutLog, runId, attempt }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/, 'Select an exact candidate source commit');
  assert.equal(String(run.id), String(runId), 'Run ID mismatch'); assert.equal(run.run_attempt, attempt, 'Stale run attempt; download the current attempt');
  assert.equal(run.repository?.full_name, repository, 'Wrong evidence repository');
  assert.equal(run.path, '.github/workflows/pstack-portability.yml', 'Only required baseline workflow evidence is accepted');
  assert.equal(run.status, 'completed', 'Run is pending'); assert.equal(run.conclusion, 'success', 'Run did not pass');
  assert.ok(['push', 'pull_request', 'workflow_dispatch', 'merge_group'].includes(run.event), 'Advisory/scheduled evidence is not required baseline evidence');
  assert.equal(run.head_sha, sourceCommit, 'Run tested a different source commit');
  assert.deepEqual(jobs.map(job => job.name).sort(), Object.keys(requiredJobChecks).sort(), 'Missing/duplicated required jobs');
  for (const job of jobs) {
    assert.equal(String(job.run_id), String(runId), 'Job run ID mismatch'); assert.equal(job.run_attempt, attempt, 'Job attempt mismatch');
    assert.ok(Array.isArray(job.steps) && job.steps.length, 'Missing complete job step outcomes');
    assert.ok(job.steps.every(step => step.status === 'completed' && ['success', 'skipped'].includes(step.conclusion)), 'Failed/cancelled/incomplete job step');
    assert.equal(job.status, 'completed', `${job.name} pending`); assert.equal(job.conclusion, 'success', `${job.name} failed or skipped`);
  }
  assert.deepEqual(reports.map(item => item.report.check).sort(), Object.keys(requiredPhases).sort(), 'Missing/duplicated required reports');
  const tested = new Set(), result = [];
  for (const { report, bytes, logs } of reports.sort((a, b) => a.report.check.localeCompare(b.report.check))) {
    assert.deepEqual(JSON.parse(bytes.toString()), report, 'Report digest input does not match parsed evidence');
    assert.equal(report.schemaVersion, 1); assert.equal(report.repository, repository); assert.equal(report.event, run.event);
    if (run.event === 'pull_request') assert.ok(Number.isSafeInteger(report.pullRequest) && report.pullRequest > 0, 'Missing PR identity'); else assert.equal(report.pullRequest, null, 'Unexpected PR identity');
    assert.equal(report.sourceHeadSha, sourceCommit, 'Stale source evidence'); assert.equal(String(report.runId), String(runId)); assert.equal(report.runAttempt, attempt);
    assert.equal(report.artifact, `pstack-${report.check}-${attempt}`, 'Artifact identity mismatch'); assert.equal(report.status, 'passed'); assert.deepEqual(report.failures, []);
    assert.match(report.testedSha, /^[a-f0-9]{40}$/); tested.add(report.testedSha);
    assert.ok(new RegExp('git log -1 --format=%H\\r?\\n[^\\n]*' + report.testedSha).test(checkoutLog), 'Missing checkout command evidence for tested SHA');
    assert.deepEqual(report.phases.map(phase => phase.phase), requiredPhases[report.check], 'Incomplete phase coverage');
    const phases = report.phases.map(phase => {
      assert.equal(phase.status, 'passed'); assert.equal(phase.exitCode, 0); assert.equal(phase.signal, null); assert.equal(phase.error, null);
      for (const key of ['repository', 'event', 'runId', 'runAttempt', 'sourceHeadSha', 'testedSha', 'check', 'pullRequest']) assert.deepEqual(phase.identity[key], report[key], `Phase identity mismatch: ${key}`);
      assert.deepEqual(phase.command, phaseCommand(report.check, phase.phase), 'Unexpected test entry point');
      assert.equal(phase.log, `${phase.phase}.log`); assert.ok(typeof logs[phase.log] === 'string', 'Missing/expired phase log input');
      assert.ok(Number.isSafeInteger(phase.durationMs) && phase.durationMs >= 0, 'Missing phase timing');
      return { phase: phase.phase, status: phase.status, exitCode: phase.exitCode, signal: phase.signal, error: phase.error, command: phase.command, durationMs: phase.durationMs, logDigest: digest(logs[phase.log]) };
    });
    if (report.check.startsWith('native-')) {
      const baseline = hosts.find(row => row.host === report.check.slice('native-'.length)); assert.ok(baseline, 'Unknown host baseline');
      assert.ok(report.host && !report.host.resolution, 'Advisory latest-version reports cannot substitute for required baseline');
      for (const [key, value] of Object.entries({ name: baseline.host, package: baseline.package, executable: baseline.executable, testedVersion: baseline.version, expectedVersion: baseline.version, actualVersion: baseline.version, requiredNode: baseline.node, capabilities: baseline.capabilities })) assert.deepEqual(report.host[key], value, `Unknown/mismatched actual host baseline: ${key}`);
      assert.equal(Number(report.node.match(/^v(\d+)\./)?.[1]), baseline.node, 'Wrong native Node runtime');
    } else { assert.equal(report.host, null, 'Unexpected native host evidence'); assert.match(report.node, /^v20\./, 'Wrong portable/helper Node baseline'); }
    result.push({ check: report.check, artifact: report.artifact, reportDigest: digest(bytes), sourceHeadSha: report.sourceHeadSha, testedSha: report.testedSha, runId: String(report.runId), runAttempt: report.runAttempt, status: report.status, host: report.host, node: report.node, os: report.os, phases });
  }
  assert.equal(tested.size, 1, 'Reports refer to mixed tested checkouts');
  if (run.event !== 'pull_request') assert.equal([...tested][0], sourceCommit, 'Non-PR checkout must exactly equal the candidate source');
  return { repository, workflow: run.path, runId: String(runId), runAttempt: attempt, event: run.event, sourceHeadSha: sourceCommit, testedSha: [...tested][0], conclusion: run.conclusion, createdAt: run.created_at, url: run.html_url, checkoutLogDigest: digest(checkoutLog), jobs: jobs.map(job => ({ name: job.name, id: job.id, startedAt: job.started_at, completedAt: job.completed_at, status: job.status, conclusion: job.conclusion, runId: String(job.run_id), runAttempt: job.run_attempt, url: job.html_url, steps: job.steps.map(step => ({ name: step.name, number: step.number, startedAt: step.started_at, completedAt: step.completed_at, status: step.status, conclusion: step.conclusion })) })).sort((a, b) => a.name.localeCompare(b.name)), reports: result };
}
