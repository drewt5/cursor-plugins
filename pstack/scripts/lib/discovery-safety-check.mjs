// CI-only characterization. Never call this against a user's environment.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeHostVersion } from './installation-diagnostics.mjs';
import { inspectNativeDiscovery } from './installation-discovery.mjs';
function snapshot(root, prefix = '') {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = join(prefix, entry.name), path = join(root, entry.name), stat = lstatSync(path);
    if (stat.isDirectory()) return [[name, 'directory'], ...Object.entries(snapshot(path, name))];
    return [[name, stat.isSymbolicLink() ? 'link:' + readlinkSync(path) : `${stat.mode & 0o777}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`]];
  }));
}
export async function characterizeDiscoverySafety({ temporary, project, env, row, expected, bundles, signal }) {
  assert.ok(project.startsWith(temporary + '/') && env.HOME.startsWith(temporary + '/'), 'Safety characterization requires a caller-owned temporary environment');
  const marker = join(temporary, 'sentinel-executed');
  const sentinel = join(temporary, 'sentinel.mjs'); writeFileSync(sentinel, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  if (row.host === 'opencode') {
    const plugins = join(project, '.opencode/plugins'); mkdirSync(plugins, { recursive: true });
    writeFileSync(join(plugins, 'sentinel.mjs'), readFileSync(sentinel));
  } else if (row.host === 'codex') {
    writeFileSync(join(env.CODEX_HOME, 'config.toml'), `[mcp_servers.pstack_sentinel]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(sentinel)}]\n`);
  }
  const before = snapshot(temporary);
  const version = probeHostVersion(row, env);
  assert.equal(version.evidence.actualVersion, process.env.PSTACK_HOST_VERSION || row.version, JSON.stringify(version));
  assert.deepEqual(snapshot(temporary), before, 'Version probe changed the supplied user scope');
  const versionProbe = { actualVersion: version.evidence.actualVersion, environment: version.evidence.environment, requestedStateUnchanged: true };
  const options = { signal, host: row.host, executable: row.executable, project, scope: 'project', env, expected, bundles, actualVersion: process.env.PSTACK_HOST_VERSION || row.version };
  const automatic = await inspectNativeDiscovery(options);
  assert.equal(automatic.status, 'unavailable'); assert.deepEqual(snapshot(temporary), before, 'Automatic existing-scope discovery wrote or executed a sentinel');
  const observed = await inspectNativeDiscovery({ ...options, environmentOwnership: 'isolated-test' });
  if (row.host !== 'claude-code') assert.equal(observed.status, 'observed', JSON.stringify(observed));
  const after = snapshot(temporary), changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]);
  return { testedVersion: options.actualVersion, versionProbe, automaticReadOnly: false, automaticLaunch: 'disabled', automaticStateUnchanged: true, isolatedCatalogStatus: observed.status, changedPathCount: changed.length, changedPaths: changed.slice(0, 40), sentinelExecuted: existsSync(marker), decision: 'Existing-scope startup remains unavailable; isolated-test observations do not establish complete user resolution.' };
}
