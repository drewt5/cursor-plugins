import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, lstatSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
import { prepareInstallation, applyPreparedInstallation } from '../scripts/lib/installation-preflight.mjs';
import { inspectExistingInstallation } from '../scripts/lib/installation-discovery.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
function snapshot(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(root, entry.name), stat = lstatSync(path);
    return stat.isDirectory() ? [[entry.name, 'directory'], ...snapshot(path).map(item => [join(entry.name, item[0]), ...item.slice(1)])] : [[entry.name, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('base64')]];
  });
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-preflight-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  const env = withHostVersionFixtures(root, { HOME: home, PATH: '', XDG_CONFIG_HOME: join(root, 'config') });
  const run = (command, args = [], environment = env) => spawnSync(process.execPath, [join(source, 'scripts', command + '.mjs'), '--project', project, ...args], { env: environment, encoding: 'utf8' });
  const prepare = overrides => prepareInstallation({ source, root: project, globalRoot: home, env, options: { target: 'cursor' }, ...overrides });
  return { root, project, home, env, run, prepare };
}
test('one CLI lifecycle preserves unrelated skills, diagnoses later collisions, refuses update/uninstall and safely finishes', t => {
  const f = fixture(t), unrelated = join(f.project, '.agents/skills/user-skill'); mkdirSync(unrelated, { recursive: true }); writeFileSync(join(unrelated, 'SKILL.md'), 'user-owned');
  let result = f.run('install', ['--target', 'codex']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Scope: project/); assert.match(result.stdout, /discovery: unavailable/);
  assert.equal(f.run('doctor', ['--json']).status, 0);
  const path = join(f.project, '.agents/skills/how'), link = readlinkSync(path); rmSync(path); mkdirSync(path); writeFileSync(join(path, 'SKILL.md'), 'later user collision'); const before = snapshot(f.root);
  const preview = f.run('install', ['--dry-run']); assert.equal(preview.status, 1); const installer = JSON.parse(preview.stdout);
  const doctor = f.run('doctor', ['--json']); assert.equal(doctor.status, 1); const diagnosis = JSON.parse(doctor.stdout);
  assert.ok(installer.findings.some(item => item.code === 'OWNED_REPLACED')); assert.ok(diagnosis.findings.some(item => item.code === 'OWNED_REPLACED'));
  for (const command of ['install', 'uninstall']) { result = f.run(command); assert.equal(result.status, 1); assert.match(result.stderr, /no files changed/); assert.deepEqual(snapshot(f.root), before); }
  const backup = join(f.project, 'preserved-user-skill'); renameSync(path, backup); symlinkSync(link, path, 'dir');
  result = f.run('uninstall', [], { ...f.env, PATH: '' }); assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(join(backup, 'SKILL.md'), 'utf8'), 'later user collision'); assert.equal(readFileSync(join(unrelated, 'SKILL.md'), 'utf8'), 'user-owned');
});
test('static preflight aggregates missing selected host and independent ownership conflicts without writing', t => {
  const f = fixture(t);
  for (const path of ['.agents/skills/how', '.claude/skills/why']) { mkdirSync(join(f.project, path), { recursive: true }); writeFileSync(join(f.project, path, 'SKILL.md'), 'independent'); }
  const before = snapshot(f.root), result = f.run('install', ['--target', 'all', '--dry-run'], { ...f.env, PATH: '' });
  assert.equal(result.status, 1); const report = JSON.parse(result.stdout); assert.equal(report.findings.filter(item => item.code === 'HOST_MISSING').length, 3); assert.equal(report.conflicts.length, 2); assert.deepEqual(snapshot(f.root), before);
});
test('mandatory native failure and actual ambiguity block preflight; coherent origins and unavailable evidence permit apply', async t => {
  for (const classification of ['ambiguous-sources', 'conflicting-registration', 'missing-registration', 'identified-source', 'unavailable-evidence']) {
    const f = fixture(t), before = snapshot(f.root), diagnose = async options => {
      const report = await inspectExistingInstallation(options);
      report.discovery = { status: classification === 'unavailable-evidence' ? 'unavailable' : 'observed', probes: [{ host: 'cursor', status: classification === 'unavailable-evidence' ? 'unavailable' : 'observed', classification }] }; return report;
    };
    const prepared = await f.prepare({ diagnose }); const result = await applyPreparedInstallation(prepared, { diagnose });
    if (['identified-source', 'unavailable-evidence'].includes(classification)) assert.equal(result.status, 'applied');
    else { assert.equal(result.status, 'preflight-failed'); assert.equal(result.changed, false); assert.deepEqual(snapshot(f.root), before); }
  }
});
test('post-apply failure reports changed files without pretending restoration; missing owned files remain repairable', async t => {
  const f = fixture(t), prepared = await f.prepare();
  const result = await applyPreparedInstallation(prepared, { diagnose: async options => { const report = await inspectExistingInstallation(options); report.discovery = { status: 'failed', probes: [{ host: 'cursor', status: 'failed', classification: 'invalid-evidence' }] }; return report; } });
  assert.equal(result.status, 'post-apply-failed'); assert.equal(result.changed, true); assert.equal(JSON.parse(readFileSync(join(f.project, '.pstack/install.json'))).targets[0], 'cursor');
  rmSync(join(f.project, '.pstack/package/README.md'));
  const repair = await f.prepare(); assert.ok(repair.report.findings.some(item => item.code === 'OWNED_MISSING')); assert.equal(repair.failures.length, 0); assert.equal((await applyPreparedInstallation(repair)).status, 'applied');
});

test('post-apply diagnostic exceptions retain honest changed-state evidence', async t => {
  const f = fixture(t), prepared = await f.prepare();
  const result = await applyPreparedInstallation(prepared, { diagnose: () => { throw new Error('diagnostic execution failure'); } });
  assert.equal(result.status, 'post-apply-failed'); assert.equal(result.changed, true);
  assert.ok(result.report.findings.some(item => item.code === 'DIAGNOSTIC_EXECUTION_FAILED' && item.action.includes('Files were applied')));
});
