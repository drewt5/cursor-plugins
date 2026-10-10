import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadHosts, validateHosts, observeHost } from '../scripts/lib/tested-hosts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pstack-host-metadata-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(root, 'scripts'), join(directory, 'scripts'), { recursive: true });
  cpSync(join(root, 'tested-hosts.json'), join(directory, 'tested-hosts.json'));
  return directory;
}
function matrix(directory, env = {}) {
  return spawnSync(process.execPath, [join(directory, 'scripts/host-matrix.mjs')], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', ...env } });
}

test('one edited host pin reaches matrix and report without changing other files', t => {
  const directory = fixture(t);
  const metadata = JSON.parse(readFileSync(join(directory, 'tested-hosts.json')));
  metadata.hosts.find(row => row.host === 'codex').version = '1.2.3';
  writeFileSync(join(directory, 'tested-hosts.json'), JSON.stringify(metadata));
  const output = join(directory, 'output');
  const result = matrix(directory, { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).include.find(row => row.host === 'codex').version, '1.2.3');
  assert.equal(readFileSync(output, 'utf8'), `matrix=${result.stdout.trim()}\n`);
  assert.equal(matrix(directory).stdout, result.stdout);
  const reporter = join(directory, 'scripts/ci-report.mjs');
  const env = { ...process.env, PSTACK_REPORT_DIR: directory, PSTACK_HOST: 'codex', PSTACK_HOST_VERSION: '', PSTACK_STEPS: '{}', GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '' };
  const run = args => spawnSync(process.execPath, [reporter, ...args], { encoding: 'utf8', env });
  assert.equal(run(['run', 'discovery', '--', process.execPath, '-e', '']).status, 0);
  writeFileSync(join(directory, 'host-version.txt'), '1.2.3');
  assert.equal(run(['finalize', 'discovery']).status, 0);
  const host = JSON.parse(readFileSync(join(directory, 'report.json'))).host;
  assert.equal(host.expectedVersion, '1.2.3');
  assert.equal(host.actualVersion, '1.2.3');
  assert.equal(host.testedVersion, '1.2.3');
  assert.equal(host.package, '@openai/codex');
});

test('matrix rejects absent, duplicated, unexpected, malformed, and empty host rows', t => {
  const directory = fixture(t);
  const rows = loadHosts();
  const invalid = [
    [], rows.slice(1), [...rows, rows[0]],
    rows.map(row => row.host === 'codex' ? { ...row, package: 'other-package' } : row),
    rows.map(row => row.host === 'codex' ? { ...row, executable: 'other-command' } : row),
    rows.map(row => row.host === 'codex' ? { ...row, version: 'latest' } : row),
    rows.map(row => row.host === 'codex' ? { ...row, node: '22' } : row),
    rows.map(row => row.host === 'codex' ? { ...row, capabilities: [] } : row),
  ];
  for (const hosts of invalid) {
    assert.throws(() => validateHosts({ schemaVersion: 1, hosts }));
    writeFileSync(join(directory, 'tested-hosts.json'), JSON.stringify({ schemaVersion: 1, hosts }));
    const result = matrix(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  writeFileSync(join(directory, 'tested-hosts.json'), '{malformed');
  assert.equal(matrix(directory).status, 1);
});

test('native version probe checks default baseline and explicit candidate before discovery', t => {
  const directory = fixture(t);
  const command = join(directory, 'codex');
  writeFileSync(command, '#!/bin/sh\nprintf "codex-cli 1.2.3\\n"\n', { mode: 0o755 });
  const env = { PATH: directory, PSTACK_HOST_VERSION: '1.2.3' };
  assert.deepEqual(observeHost('codex', env), { ...loadHosts().find(row => row.host === 'codex'), expectedVersion: '1.2.3', actualVersion: '1.2.3' });
  assert.throws(() => observeHost('codex', { PATH: directory }), /version mismatch/);
  writeFileSync(command, '#!/bin/sh\nprintf "codex-cli 1.2.3-preview.1\\n"\n');
  assert.throws(() => observeHost('codex', env), /version mismatch/);
});
