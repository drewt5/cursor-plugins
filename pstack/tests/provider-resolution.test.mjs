import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviders } from '../scripts/lib/provider-resolution.mjs';
import { loadHosts } from '../scripts/lib/tested-hosts.mjs';
const sourceCommit = 'a'.repeat(40), resolvedAt = '2026-10-10T12:00:00.000Z';
const metadata = row => ({ name: row.package, version: row.version, engines: { node: '>=20' } });
test('resolution samples each configured provider exactly once and emits the complete validated matrix', async () => {
  const requests = [];
  const report = await resolveProviders({ sourceCommit, now: () => resolvedAt, fetchMetadata: async row => { requests.push(row.host); return metadata(row); } });
  assert.equal(report.status, 'resolved');
  assert.deepEqual(requests.sort(), ['claude-code', 'codex', 'opencode']);
  assert.equal(report.matrix.include.length, 3);
  for (const row of report.matrix.include) assert.deepEqual(row.resolution, { sourceCommit, resolvedAt, nodeEngine: '>=20', registry: 'https://registry.npmjs.org', tag: 'latest' });
});
test('registry outage or malformed latest stable data retains all host outcomes and never emits a partial matrix', async () => {
  for (const change of [
    () => { throw new Error('Registry HTTP 503'); },
    row => ({ ...metadata(row), version: '3.0.0-preview.1' }),
    row => ({ ...metadata(row), version: 'latest' }),
    row => ({ ...metadata(row), name: 'unexpected-package' }),
    row => ({ ...metadata(row), engines: { node: 22 } }),
  ]) {
    const report = await resolveProviders({ sourceCommit, now: () => resolvedAt, fetchMetadata: async row => row.host === 'codex' ? change(row) : metadata(row) });
    assert.equal(report.status, 'failed'); assert.equal(report.matrix, null);
    assert.equal(report.results.length, 3);
    assert.equal(report.results.find(row => row.host === 'codex').status, 'failed');
    assert.ok(report.results.find(row => row.host === 'codex').error.length);
    assert.equal(report.results.filter(row => row.status === 'resolved').length, 2);
  }
});
test('a new Node engine requirement is retained for strict npm setup rather than silently omitting the provider', async () => {
  const report = await resolveProviders({ sourceCommit, fetchMetadata: async row => ({ ...metadata(row), engines: { node: '>=999' } }) });
  assert.deepEqual(report.matrix.include.map(row => row.host).sort(), loadHosts().map(row => row.host).sort());
  assert.ok(report.matrix.include.every(row => row.resolution.nodeEngine === '>=999'));
});
test('the setup engine-strict flag rejects an incompatible local package without contacting a registry', async t => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { isolatedEnvironment } = await import('../scripts/lib/test-environment.mjs');
  const root = mkdtempSync(join(tmpdir(), 'pstack-engine-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = join(root, 'fixture'); mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'pstack-engine-fixture', version: '1.0.0', engines: { node: '>=999' } }));
  const result = spawnSync('npm', ['install', '--engine-strict', '--ignore-scripts', '--no-audit', '--no-fund', '--offline', '--prefix', join(root, 'installation'), pkg], { env: isolatedEnvironment(root), encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /EBADENGINE/);
});
