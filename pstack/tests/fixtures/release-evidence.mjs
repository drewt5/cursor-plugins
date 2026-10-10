import { loadHosts } from '../../scripts/lib/tested-hosts.mjs';
const sourceCommit = 'a'.repeat(40), runId = '123', attempt = 1;
export function evidenceFixture(commit = sourceCommit) {
  const hosts = loadHosts(), phases = { 'portable-ubuntu-latest': ['unit'], 'portable-macos-latest': ['unit'], helpers: ['helpers'], ...Object.fromEntries(hosts.map(row => ['native-' + row.host, ['setup', 'discovery', 'invocation']])) };
  const command = (check, phase) => phase === 'setup' ? ['node', 'pstack/scripts/install-host.mjs'] : ['unit', 'helpers'].includes(phase) ? ['node', 'pstack/scripts/test.mjs', '--' + phase] : ['node', `pstack/scripts/check-${phase === 'discovery' ? 'hosts' : 'invocation'}.mjs`, check.slice(7)];
  const reports = Object.entries(phases).map(([check, names]) => {
    const row = hosts.find(row => check === 'native-' + row.host), identity = { repository: 'drewt5/cursor-plugins', event: 'push', runId, runAttempt: attempt, sourceHeadSha: commit, testedSha: commit, check, pullRequest: null };
    const report = { schemaVersion: 1, ...identity, artifact: `pstack-${check}-1`, status: 'passed', failures: [], node: row ? 'v22.0.0' : 'v20.0.0', os: 'linux', host: row ? { name: row.host, package: row.package, executable: row.executable, testedVersion: row.version, expectedVersion: row.version, actualVersion: row.version, requiredNode: row.node, capabilities: row.capabilities } : null, phases: names.map(phase => ({ phase, identity, command: command(check, phase), status: 'passed', exitCode: 0, signal: null, error: null, durationMs: 1, log: phase + '.log' })) };
    return { report, bytes: JSON.stringify(report), logs: Object.fromEntries(names.map(name => [name + '.log', 'retained phase proof'])) };
  });
  const jobs = ['Pstack host matrix', 'Pstack portable (ubuntu-latest)', 'Pstack portable (macos-latest)', 'Pstack helpers', ...hosts.map(row => `Pstack native (${row.host})`), 'Pstack required'].map((name, id) => ({ name, id, run_id: 123, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: 'https://github.com/drewt5/cursor-plugins/actions/runs/123/job/' + id, steps: [{ name: 'Verified fixture', number: 1, status: 'completed', conclusion: 'success' }] }));
  const run = { id: 123, run_attempt: 1, repository: { full_name: 'drewt5/cursor-plugins' }, path: '.github/workflows/pstack-portability.yml', head_sha: commit, event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/drewt5/cursor-plugins/actions/runs/123' };
  return { sourceCommit: commit, runId, attempt, run, jobs, reports, hosts, checkoutLog: 'git log -1 --format=%H\n' + commit };
}
