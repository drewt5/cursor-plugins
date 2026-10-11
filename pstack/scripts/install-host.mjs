#!/usr/bin/env node
import { startTiming } from './lib/ci-timing.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHosts } from './lib/tested-hosts.mjs';
try {
  const row = loadHosts().find(row => row.host === process.env.PSTACK_HOST);
  assert.ok(row, 'Unknown native host');
  const version = process.env.PSTACK_HOST_VERSION || row.version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected exact stable version');
  assert.ok(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required');
  const prefix = join(process.env.RUNNER_TEMP, 'pstack-host');
  const finishInstall = startTiming('native-command', 'npm install pinned host');
  const install = spawnSync('npm', ['install', '--prefix', prefix, '--engine-strict', '--no-audit', '--no-fund', `${row.package}@${version}`], { stdio: 'inherit', timeout: 180000 });
  finishInstall({ status: !install.error && install.status === 0 ? 'passed' : 'failed', exitCode: install.status, signal: install.signal, timedOut: install.error?.code === 'ETIMEDOUT' });
  assert.ok(!install.error && install.status === 0, `Host setup failed: ${install.error?.message || install.status}. EBADENGINE identifies an unsupported runner runtime; other npm errors identify download/install failures.`);
  const executable = join(prefix, 'node_modules/.bin', row.executable);
  const finishVersion = startTiming('native-command', `${row.host} --version`);
  const observed = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 15000 });
  finishVersion({ status: !observed.error && observed.status === 0 ? 'passed' : 'failed', exitCode: observed.status, signal: observed.signal, timedOut: observed.error?.code === 'ETIMEDOUT' });
  assert.ok(!observed.error && observed.status === 0, `Installed host version probe failed: ${observed.error?.message || observed.stderr}`);
  const actual = observed.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  console.log(observed.stdout.trim());
  const directory = process.env.PSTACK_REPORT_DIR || join(process.env.RUNNER_TEMP, 'pstack-evidence');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'host-version.txt'), actual || 'unavailable');
  assert.equal(actual, version, `Host version mismatch: expected ${version}, observed ${actual}`);
  if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, join(prefix, 'node_modules/.bin') + '\n');
} catch (error) { console.error(error.message); process.exitCode = 1; }
