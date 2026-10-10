import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, readlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
import { runDoctor } from '../scripts/doctor.mjs';
function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(root, entry.name), stat = lstatSync(path);
    return stat.isDirectory() ? [[entry.name, 'directory'], ...snapshot(path).map(item => [join(entry.name, item[0]), ...item.slice(1)])] : [[entry.name, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('base64')]];
  });
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-doctor-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const env = withHostVersionFixtures(root, { HOME: home, PATH: '', XDG_CONFIG_HOME: join(root, 'config'), USER_SECRET: 'never-serialize-this-credential' });
  const run = (command, args = [], environment = env) => spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${command}.mjs`, import.meta.url)), ...args], { env: environment, encoding: 'utf8' });
  const doctor = (args = [], environment = env) => run('doctor', ['--project', project, '--json', ...args], environment);
  const install = target => { const r = run('install', ['--project', project, '--target', target]); assert.equal(r.status, 0, r.stderr); };
  return { root, project, home, env, run, doctor, install };
}
test('doctor reports healthy static/unavailable discovery, release unknown and restart guidance without writes', t => {
  const f = fixture(t); f.install('cursor'); const before = snapshot(f.root), result = f.doctor();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, ''); const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1); assert.equal(report.integrity.status, 'verified'); assert.equal(report.discovery.status, 'unavailable'); assert.deepEqual(report.selectedTargets, ['cursor']);
  assert.equal(report.session.restartRequiredAfterChanges, true); assert.ok(!result.stdout.includes(f.env.USER_SECRET)); assert.deepEqual(snapshot(f.root), before);
  const human = f.run('doctor', ['--project', f.project]); assert.equal(human.status, 0); assert.match(human.stdout, /Release identity: 0\.16\.0 development/); assert.match(human.stdout, /until restart/);
});
test('uninstalled doctor detects CLI information without treating absent installation/providers as failure', t => {
  const f = fixture(t), before = snapshot(f.root);
  for (const env of [f.env, { ...f.env, PATH: '' }]) {
    const result = f.doctor([], env); assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
    assert.equal(report.state, 'uninstalled'); assert.equal(report.detectedHosts.length, 3); assert.deepEqual(report.selectedTargets, []);
  }
  assert.deepEqual(snapshot(f.root), before);
});
test('broken artifacts, malformed receipts and missing selected executables are actionable exit one', t => {
  const f = fixture(t); f.install('codex');
  let result = f.doctor([], { ...f.env, PATH: '' }); assert.equal(result.status, 1); assert.ok(JSON.parse(result.stdout).findings.some(item => item.code === 'HOST_MISSING' && item.action));
  const file = join(f.project, '.pstack/package/README.md'); writeFileSync(file, 'user edit'); const before = snapshot(f.root);
  result = f.doctor(); assert.equal(result.status, 1); assert.ok(JSON.parse(result.stdout).findings.some(item => item.code === 'OWNED_MODIFIED' && item.action)); assert.deepEqual(snapshot(f.root), before);
  writeFileSync(join(f.project, '.pstack/install.json'), '{broken'); result = f.doctor(); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).receipt.status, 'invalid');
});
test('unknown versions and recorded ambiguity remain explicit advisory unknowns; unrelated plugin changes retain visibility limit', t => {
  const f = fixture(t); f.install('codex');
  writeFileSync(join(f.root, 'fixture-bin/codex'), `#!${process.execPath}\nconsole.log('999.0.0');\n`, { mode: 0o755 });
  let result = f.doctor(); assert.equal(result.status, 0); let report = JSON.parse(result.stdout); assert.ok(report.findings.some(item => item.code === 'HOST_VERSION_UNKNOWN' && item.verification === 'unavailable'));
  assert.equal(f.run('install', ['--global', '--target', 'codex']).status, 0);
  result = f.doctor(); assert.equal(result.status, 0); report = JSON.parse(result.stdout); assert.ok(report.findings.some(item => item.code === 'DUPLICATE_PSTACK' && item.verification === 'unavailable'));
  mkdirSync(join(f.project, '.claude-plugin')); writeFileSync(join(f.project, '.claude-plugin/plugin.json'), '{"name":"unrelated"}'); const before = snapshot(f.root);
  result = f.doctor(); assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).discovery.status, 'unavailable'); assert.deepEqual(snapshot(f.root), before);
});
test('global target selection and CLI usage/internal errors have consistent exit semantics', async t => {
  const f = fixture(t); assert.equal(f.run('install', ['--global', '--target', 'cursor']).status, 0);
  const global = f.run('doctor', ['--global', '--json']); assert.equal(global.status, 0); const report = JSON.parse(global.stdout); assert.equal(report.scope.kind, 'global'); assert.deepEqual(report.selectedTargets, ['cursor']);
  for (const args of [['--bogus'], ['--repair'], ['--target', 'invalid'], ['--global', '--project', f.project], ['--project']]) {
    const result = f.run('doctor', [...args, '--json']); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.match(result.stderr, /Doctor could not complete/);
  }
  assert.equal(f.run('doctor', ['--help']).status, 0);
  await assert.rejects(runDoctor({}, { inspector: () => { throw new Error('internal diagnostic failure'); } }), /internal diagnostic failure/);
});
