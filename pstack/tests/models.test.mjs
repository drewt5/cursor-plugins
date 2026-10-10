import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadModelConfig, readConfig } from '../skills/pstack-runtime/scripts/models.mjs';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.pstack')); mkdirSync(join(dir, 'pstack'));
  return dir;
}
test('models merge defaults, user, user-host, project, and project-host in order', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'pstack/models.json'), JSON.stringify({ version: 1, roles: { 'bug-fix': 'user', 'hillclimb': 'user' }, hosts: { opencode: { roles: { 'bug-fix': 'user-host' } } } }));
  writeFileSync(join(dir, '.pstack/models.json'), JSON.stringify({ version: 1, roles: { 'bug-fix': 'project' }, hosts: { opencode: { roles: { 'bug-fix': 'project-host' }, reasoning: 'high' } } }));
  const config = loadModelConfig({ project: dir, configHome: dir, host: 'opencode' });
  assert.equal(config.roles['bug-fix'], 'project-host');
  assert.equal(config.roles.hillclimb, 'user');
  assert.equal(config.reasoning, 'high');
  assert.deepEqual(config.roles['architect runners'], ['inherit-parent', 'inherit-parent']);
  assert.equal(loadModelConfig({ project: dir, configHome: dir, host: 'codex' }).roles['bug-fix'], 'project');
});
test('invalid configs fail with actionable errors instead of silently inheriting', t => {
  const dir = fixture(t), file = join(dir, 'bad.json');
  for (const value of [null, { version: 2 }, { version: 1, roles: { typo: 'auto' } }, { version: 1, roles: { 'architect runners': [] } }, { version: 1, roles: { 'bug-fix': ['x'] } }, { version: 1, hosts: { other: {} } }]) {
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => readConfig(file));
  }
});
test('model resolver is executable through the installed skill symlink', t => {
  const dir = fixture(t);
  const link = join(dir, 'runtime');
  symlinkSync(new URL('../skills/pstack-runtime', import.meta.url), link, 'dir');
  const result = spawnSync(process.execPath, [join(link, 'scripts/models.mjs'), '--host', 'codex', '--project', dir], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: dir } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).roles['bug-fix'], 'inherit-parent');
});
