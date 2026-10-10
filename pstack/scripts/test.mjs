#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from './lib/test-environment.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let mode = 'full', repeat = 1;
for (let i = 0; i < args.length; i++) {
  if (['--unit', '--portable', '--helpers'].includes(args[i])) mode = args[i].slice(2);
  else if (args[i] === '--repeat' && /^[1-9][0-9]*$/.test(args[i + 1] || '')) repeat = Number(args[++i]);
  else if (args[i] === '--help') { console.log('Usage: node pstack/scripts/test.mjs [--unit|--portable|--helpers] [--repeat N]\nDefault: unit, helpers, native discovery, and mock API invocation. No checks are silently skipped.'); process.exit(0); }
  else { console.error(`Unknown or invalid argument: ${args[i]}`); process.exit(1); }
}
function snapshot(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['.git', 'node_modules'].includes(entry.name)) return [];
    const name = join(prefix, entry.name), file = join(path, entry.name);
    if (entry.isDirectory()) return snapshot(file, name);
    return [[name, lstatSync(file).mode, createHash('sha256').update(readFileSync(file)).digest('hex')]];
  });
}
const temporary = mkdtempSync(join(tmpdir(), 'pstack-suite-'));
const env = isolatedEnvironment(temporary);
const before = snapshot(root);
function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, env: { ...env, PWD: cwd }, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed`);
}
try {
  const required = ['git', 'bash', ...(mode !== 'unit' ? ['bun'] : []), ...(mode === 'full' ? ['codex', 'opencode', 'claude'] : [])];
  for (const executable of required) {
    const result = spawnSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
    if (result.error || result.status !== 0) throw new Error(`Missing or unusable prerequisite: ${executable}. Install it, or explicitly choose --unit / --portable / --helpers for a narrower check.`);
    console.log(`${executable}: ${result.stdout.trim().split('\n')[0]}`);
  }
  for (let pass = 1; pass <= repeat; pass++) {
    console.log(`\nPstack ${mode} suite ${pass}/${repeat}`);
    if (mode !== 'helpers') {
      run(process.execPath, ['--test', ...readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(root, 'tests', name))]);
      run('bash', ['-n', join(root, 'skills/poteto-mode/scripts/worktree-audit.sh')]);
    }
    if (mode !== 'unit') {
      const helpers = join(temporary, `helpers-${pass}`);
      cpSync(join(root, 'skills/poteto-mode/scripts'), helpers, { recursive: true, filter: path => !path.split(/[\\/]/).includes('node_modules') });
      run('bun', ['install', '--frozen-lockfile'], helpers);
      run('bun', ['test', 'orch', 'watch-pr'], helpers);
      run('bun', ['run', 'typecheck'], helpers);
    }
    if (mode === 'full') {
      run(process.execPath, [join(root, 'scripts/check-hosts.mjs')]);
      run(process.execPath, [join(root, 'scripts/check-invocation.mjs')]);
    }
    assert.deepEqual(snapshot(root), before, 'The test suite modified its source checkout');
  }
  console.log(`\nPASS: ${mode} suite completed ${repeat} time(s); source checkout unchanged.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
