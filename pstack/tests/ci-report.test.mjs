import { loadHosts } from '../scripts/lib/tested-hosts.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/ci-report.mjs');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pstack-report-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const event = join(directory, 'event.json');
  writeFileSync(event, JSON.stringify({ number: 123, pull_request: { head: { sha: 'source-head' } } }));
  const env = { ...process.env, PSTACK_REPORT_DIR: directory, PSTACK_CHECK: 'native-test', GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'pull_request', GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '2', GITHUB_REPOSITORY: 'owner/repo', PSTACK_STEPS: '{}', PSTACK_HOST: '', GITHUB_STEP_SUMMARY: join(directory, 'github-summary.md') };
  return {
    directory,
    run: (args, extra = {}) => spawnSync(process.execPath, [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }),
    read: name => JSON.parse(readFileSync(join(directory, name), 'utf8')),
  };
}
test('report and summary preserve identity, command, version, and successful evidence', t => {
  const f = fixture(t);
  assert.equal(f.run(['run', 'discovery', '--', process.execPath, '-e', 'console.log("discovered")']).status, 0);
  writeFileSync(join(f.directory, 'host-version.txt'), '1.2.3\n');
  assert.equal(f.run(['finalize', 'discovery'], { PSTACK_HOST: 'codex', PSTACK_HOST_VERSION: '1.2.3' }).status, 0);
  const report = f.read('report.json');
  assert.equal(report.status, 'passed');
  assert.equal(report.repository, 'owner/repo');
  assert.equal(report.pullRequest, 123);
  assert.equal(report.runId, '456');
  assert.equal(report.runAttempt, 2);
  assert.equal(report.sourceHeadSha, 'source-head');
  assert.match(report.testedSha, /^[a-f0-9]{40}$/);
  assert.equal(report.host.actualVersion, '1.2.3');
  assert.deepEqual(report.phases[0].command, [process.execPath, '-e', 'console.log("discovered")']);
  assert.match(readFileSync(join(f.directory, 'summary.md'), 'utf8'), /discovery \| passed/);
});
test('nonzero commands retain their assertion and fail finalization', t => {
  const f = fixture(t);
  assert.equal(f.run(['run', 'invocation', '--', process.execPath, '-e', 'console.error("expected skill missing"); process.exit(7)']).status, 1);
  assert.equal(f.run(['finalize', 'invocation'], { PSTACK_STEPS: '{"invocation":{"outcome":"failure"}}' }).status, 1);
  const phase = f.read('report.json').phases[0];
  assert.equal(phase.exitCode, 7);
  assert.equal(phase.status, 'failed');
  assert.equal(phase.log, 'invocation.log');
  assert.match(phase.reproduce, /expected skill missing/);
  assert.match(readFileSync(join(f.directory, 'summary.md'), 'utf8'), /expected skill missing/);
});
test('large output retains the failure tail and continues streaming to the console', t => {
  const f = fixture(t);
  const result = f.run(['run', 'invocation', '--', process.execPath, '-e', 'process.stdout.write("x".repeat(5 * 1024 * 1024)); process.stdout.write("\\nterminal assertion failed\\n"); process.exitCode = 7']);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.length > 5 * 1024 * 1024);
  assert.match(result.stdout, /terminal assertion failed/);
  const log = readFileSync(join(f.directory, 'invocation.log'), 'utf8');
  const truncation = '[Earlier output truncated; retaining last 4 MiB]\n';
  assert.ok(log.startsWith(truncation));
  assert.equal(Buffer.byteLength(log), 4 * 1024 * 1024 + Buffer.byteLength(truncation));
  assert.match(log, /terminal assertion failed\n$/);
  assert.equal(f.run(['finalize', 'invocation']).status, 1);
  assert.match(readFileSync(join(f.directory, 'summary.md'), 'utf8'), /terminal assertion failed/);
});
test('timeout forces a resistant process to close and retains evidence', t => {
  const f = fixture(t);
  const result = f.run(['run', 'invocation', '--', process.execPath, '-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100)'], { PSTACK_PHASE_TIMEOUT_MS: '200' });
  assert.equal(result.status, 1);
  assert.match(f.read('invocation.json').error, /Timed out after 200 ms/);
  assert.equal(f.run(['finalize', 'invocation']).status, 1);
});
test('missing, malformed, and wrong-identity evidence fail closed', t => {
  const f = fixture(t);
  assert.equal(f.run(['finalize', 'setup', 'discovery']).status, 1);
  assert.deepEqual(f.read('report.json').phases.map(phase => phase.status), ['not-run', 'not-run']);
  writeFileSync(join(f.directory, 'setup.json'), '{broken');
  assert.equal(f.run(['finalize', 'setup']).status, 1);
  assert.equal(f.run(['run', 'setup', '--', process.execPath, '-e', '']).status, 0);
  assert.equal(f.run(['finalize', 'setup'], { GITHUB_RUN_ATTEMPT: '3' }).status, 1);
});
test('step outcome cannot be hidden by a successful conclusion or command', t => {
  const f = fixture(t);
  assert.equal(f.run(['run', 'discovery', '--', process.execPath, '-e', '']).status, 0);
  assert.equal(f.run(['finalize', 'discovery'], { PSTACK_STEPS: JSON.stringify({ discovery: { outcome: 'failure', conclusion: 'success' } }) }).status, 1);
  assert.equal(f.read('report.json').status, 'failed');
});
test('version mismatch and failed setup cannot pass', t => {
  const f = fixture(t);
  assert.equal(f.run(['run', 'unit', '--', process.execPath, '-e', '']).status, 0);
  assert.equal(f.run(['finalize', 'unit'], { PSTACK_HOST: 'codex', PSTACK_HOST_VERSION: '1.2.3' }).status, 1);
  assert.equal(f.run(['finalize', 'unit'], { PSTACK_STEPS: '{"runtime":{"outcome":"failure"}}' }).status, 1);
});
test('untrusted output is command-disabled and escaped in the summary', t => {
  const f = fixture(t);
  const result = f.run(['run', 'unit', '--', process.execPath, '-e', 'console.log("::error:: <script> | `code`"); process.exit(1)']);
  assert.match(result.stdout, /^::stop-commands::[^\n]+\n::error::/);
  assert.equal(f.run(['finalize', 'unit']).status, 1);
  const summary = readFileSync(join(f.directory, 'summary.md'), 'utf8');
  assert.ok(!summary.includes('<script>'));
  assert.match(summary, /&lt;script&gt;/);
});
test('gate rejects empty, failed, skipped, cancelled, and missing job results', t => {
  const f = fixture(t);
  for (const needs of [{}, { native: {} }, ...['failure', 'skipped', 'cancelled'].map(result => ({ native: { result } }))]) {
    assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify(needs) }).status, 1);
  }
  const needs = { prepare: { result: 'success', outputs: { matrix: JSON.stringify({ include: loadHosts() }) } }, portable: { result: 'success' }, helpers: { result: 'success' }, native: { result: 'success' } };
  assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify(needs) }).status, 0);
  for (const name of Object.keys(needs)) {
    const missing = { ...needs }; delete missing[name];
    assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify(missing) }).status, 1);
  }
  for (const result of ['failure', 'skipped', 'cancelled']) {
    assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify({ ...needs, native: { result } }) }).status, 1);
  }
  assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify({ ...needs, prepare: { result: 'success' } }) }).status, 1);
  for (const include of [[], loadHosts().slice(1), [...loadHosts(), loadHosts()[0]]]) {
    assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify({ ...needs, prepare: { result: 'success', outputs: { matrix: JSON.stringify({ include }) } } }) }).status, 1);
  }
  assert.equal(f.run(['gate'], { PSTACK_NEEDS: JSON.stringify({ ...needs, unexpected: { result: 'success' } }) }).status, 1);
});
test('advisory reports retain exact resolution and default-branch source identity', t => {
  const f = fixture(t);
  const event = join(f.directory, 'advisory-event.json'); writeFileSync(event, '{}');
  const extra = { GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: 'default-branch-source' };
  assert.equal(f.run(['run', 'setup', '--', process.execPath, '-e', ''], extra).status, 0);
  const tested = f.read('setup.json').identity.testedSha;
  const row = loadHosts().find(row => row.host === 'codex');
  const resolution = { resolvedAt: '2026-10-10T12:00:00.000Z', sourceCommit: tested, nodeEngine: '>=16', registry: 'https://registry.npmjs.org', tag: 'latest' };
  writeFileSync(join(f.directory, 'host-version.txt'), row.version);
  const env = { ...extra, PSTACK_HOST: 'codex', PSTACK_HOST_VERSION: row.version, PSTACK_HOST_RESOLUTION: JSON.stringify({ ...row, resolution }) };
  assert.equal(f.run(['finalize', 'setup'], env).status, 0);
  const report = f.read('report.json');
  assert.equal(report.sourceHeadSha, 'default-branch-source');
  assert.equal(report.pullRequest, null);
  assert.deepEqual(report.host.resolution, resolution);
  assert.equal(f.run(['finalize', 'setup'], { ...env, PSTACK_HOST_RESOLUTION: JSON.stringify({ ...row, version: '99.0.0', resolution }) }).status, 1);
});
