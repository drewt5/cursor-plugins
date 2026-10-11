import { startTiming } from './ci-timing.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const identities = {
  codex: ['@openai/codex', 'codex'],
  opencode: ['opencode-ai', 'opencode'],
  'claude-code': ['@anthropic-ai/claude-code', 'claude'],
};

export function validateHosts(metadata) {
  assert.equal(metadata.schemaVersion, 1, 'Unsupported tested-host metadata schema');
  assert.ok(Array.isArray(metadata.hosts), 'Expected tested-host rows');
  assert.deepEqual(metadata.hosts.map(row => row.host).sort(), Object.keys(identities).sort(), 'Expected exactly codex, opencode, and claude-code once each');
  for (const row of metadata.hosts) {
    assert.deepEqual([row.package, row.executable], identities[row.host], `Unexpected package/executable mapping for ${row.host}`);
    assert.match(row.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, `Expected exact stable version for ${row.host}`);
    assert.ok(Number.isSafeInteger(row.node) && row.node >= 20, `Invalid Node runtime for ${row.host}`);
    assert.ok(Array.isArray(row.capabilities) && row.capabilities.length > 0 && row.capabilities.every(value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value)) && new Set(row.capabilities).size === row.capabilities.length, `Invalid verified capabilities for ${row.host}`);
  }
  return metadata.hosts;
}

export function loadHosts() {
  return validateHosts(JSON.parse(readFileSync(new URL('../../tested-hosts.json', import.meta.url), 'utf8')));
}

export function observeHost(host, env = process.env) {
  const baseline = loadHosts().find(row => row.host === host);
  assert.ok(baseline, `Unknown native host: ${host}`);
  const expectedVersion = env.PSTACK_HOST_VERSION || baseline.version;
  assert.match(expectedVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected an exact stable host version');
  const finishTiming = startTiming('native-command', `${host} --version`);
  const result = spawnSync(baseline.executable, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
  finishTiming({ status: !result.error && result.status === 0 ? 'passed' : 'failed', exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT' });
  assert.ok(!result.error && result.status === 0, `${host} version probe failed: ${result.error?.message || result.stderr}`);
  const actualVersion = result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  assert.equal(actualVersion, expectedVersion, `${host} version mismatch: expected ${expectedVersion}, observed ${actualVersion || result.stdout.trim()}`);
  console.log(`${host}: ${actualVersion} (expected ${expectedVersion}; tested baseline ${baseline.version})`);
  return { ...baseline, expectedVersion, actualVersion };
}
