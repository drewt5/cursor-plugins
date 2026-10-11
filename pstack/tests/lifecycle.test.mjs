import test, { after } from 'node:test';
import { copyRuntimeSource } from './fixtures/runtime-source.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, lstatSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function snapshot(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(path, entry.name), name = join(prefix, entry.name);
    if (entry.isDirectory()) return snapshot(file, name);
    if (entry.isSymbolicLink()) return [[name, 'link', readlinkSync(file)]];
    return [[name, lstatSync(file).mode & 0o777, createHash('sha256').update(readFileSync(file)).digest('hex')]];
  });
}
const runtimeDirectory = mkdtempSync(join(tmpdir(), 'pstack-lifecycle-source-'));
after(() => rmSync(runtimeDirectory, { recursive: true, force: true }));
const runtimeSource = copyRuntimeSource(root, join(runtimeDirectory, 'source'));
function fixture(t, selectedSource = root) {
  const temporary = mkdtempSync(join(tmpdir(), 'pstack-lifecycle-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = withHostVersionFixtures(temporary, isolatedEnvironment(temporary)), project = join(temporary, 'project');
  mkdirSync(project);
  const run = (command, args) => spawnSync(process.execPath, [join(selectedSource, 'scripts', command + '.mjs'), ...args], { env, encoding: 'utf8' });
  return { temporary, env, project, run };
}
function ok(result) { assert.equal(result.status, 0, result.stderr); }
for (const scope of ['project', 'global']) {
  for (const target of ['codex', 'opencode', 'claude-code', 'cursor', 'all']) {
    test(`${scope} ${target}: repeat install/uninstall preserves exact owned content and user files`, t => {
      const { temporary, env, project, run } = fixture(t, target === 'all' ? root : runtimeSource);
      const destination = scope === 'global' ? env.HOME : project;
      mkdirSync(join(destination, '.pstack'), { recursive: true });
      writeFileSync(join(destination, '.pstack/models.json'), '{"version":1,"roles":{}}\n');
      writeFileSync(join(destination, 'user.txt'), 'keep me');
      const args = ['--target', target, ...(scope === 'global' ? ['--global'] : ['--project', project])];
      const initial = snapshot(temporary);
      ok(run('uninstall', args));
      assert.deepEqual(snapshot(temporary), initial, 'absent install uninstall changed files');
      ok(run('install', args));
      const installed = snapshot(temporary);
      ok(run('install', args));
      assert.deepEqual(snapshot(temporary), installed, 'repeat installation changed content or modes');
      ok(run('uninstall', [...args, '--dry-run']));
      assert.deepEqual(snapshot(temporary), installed, 'uninstall dry-run changed files');
      ok(run('uninstall', args));
      assert.deepEqual(snapshot(temporary), initial, 'uninstall left owned files or changed user files');
      ok(run('uninstall', args));
      assert.deepEqual(snapshot(temporary), initial, 'repeat uninstall changed files');
      ok(run('install', args));
      assert.deepEqual(snapshot(temporary), installed, 'install after uninstall did not converge');
    });
  }
}
test('immutable package mode changes refuse update until restored without overwriting bytes', t => {
  const { project, run } = fixture(t), args = ['--target', 'codex', '--project', project];
  ok(run('install', args));
  const name = 'skills/poteto-mode/scripts/worktree-audit.sh', file = join(project, '.pstack/package', name);
  chmodSync(file, 0o600);
  const refused = run('install', args); assert.equal(refused.status, 1); assert.match(refused.stderr, /GENERATION_INVALID|PACKAGE_DIGEST_CHANGED/); assert.equal(lstatSync(file).mode & 0o777, 0o600);
  chmodSync(file, lstatSync(join(root, name)).mode & 0o777); ok(run('install', args));
  assert.equal(lstatSync(file).mode & 0o777, lstatSync(join(root, name)).mode & 0o777);
  assert.deepEqual(readFileSync(file), readFileSync(join(root, name)));
});
test('global OpenCode migration to a new XDG directory removes old owned links', t => {
  const { temporary, env } = fixture(t);
  const run = config => spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--global', '--target', 'opencode'], { env: { ...env, XDG_CONFIG_HOME: config }, encoding: 'utf8' });
  ok(run(env.XDG_CONFIG_HOME));
  const next = join(temporary, 'new-config');
  ok(run(next));
  assert.deepEqual(snapshot(join(env.XDG_CONFIG_HOME, 'opencode')), []);
  assert.match(readFileSync(join(next, 'opencode/skills/poteto-mode/SKILL.md'), 'utf8'), /Non-negotiables/);
  const current = snapshot(temporary);
  ok(run(next));
  assert.deepEqual(snapshot(temporary), current);
});
