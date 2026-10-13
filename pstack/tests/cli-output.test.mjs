import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderOperation, renderDoctor } from '../scripts/lib/cli-output.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
const scripts = fileURLToPath(new URL('../scripts', import.meta.url));
const secret = 'SENTINEL-PRIVATE-TOKEN';
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-cli-output-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
  const env = withHostVersionFixtures(base, { HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config'), USER_SECRET: secret });
  symlinkSync(process.execPath, join(base, 'fixture-bin/node'));
  const run = (script, args = []) => spawnSync(process.execPath, [join(scripts, `${script}.mjs`), '--project', root, ...args], { env, cwd: home, encoding: 'utf8', timeout: 20000 });
  return { base, root, home, env, run };
}
const ok = result => assert.equal(result.status, 0, result.stderr);
const report = findings => ({ state: 'installed', scope: { kind: 'project', root: '/project' }, selectedTargets: ['codex'], integrity: { status: 'verified' }, discovery: { status: 'unavailable', probes: [] }, findings, hosts: [] });
const context = { root: '/project', global: false };
const outcome = findings => ({ status: 'applied', changed: true, prepared: { targets: ['codex'], selected: ['codex'] }, report: report(findings) });
test('fresh CLI install, repair, partial uninstall and no-op report actual outcomes on their streams', t => {
  const f = fixture(t);
  let result = f.run('install', ['--target', 'codex']); ok(result);
  assert.match(result.stdout, /Scope: project/); assert.match(result.stdout, /files installed for codex/); assert.match(result.stdout, /Restart/);
  assert.equal(result.stdout.match(/Host loading was not checked/g).length, 1);
  assert.match(result.stderr, /^Recovery if interrupted: /); assert.doesNotMatch(result.stdout, /DISCOVERY_UNAVAILABLE|classification|source .*digest/);
  const managed = join(f.root, '.agents/skills/how'); unlinkSync(managed);
  result = f.run('install', ['--target', 'codex']); ok(result); assert.doesNotMatch(result.stdout + result.stderr, /missing|OWNED_MISSING|repair the/);
  ok(f.run('install', ['--target', 'cursor']));
  result = f.run('uninstall', ['--target', 'codex']); ok(result); assert.match(result.stdout, /Removed pstack for codex\. Remaining hosts: cursor/); assert.doesNotMatch(result.stdout, /installed for|Restart|Host loading/);
  result = f.run('uninstall', ['--target', 'codex', '--verbose']); ok(result); assert.match(result.stdout, /Nothing needed removal\. Remaining hosts: cursor/);
  result = f.run('uninstall'); ok(result); result = f.run('uninstall'); ok(result); assert.match(result.stdout, /Nothing needed removal\. Remaining hosts: none/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
});
test('CLI conflicts appear once per affected path, preserve content and never print success', t => {
  const f = fixture(t), paths = ['how', 'why'].map(name => join(f.root, `.agents/skills/${name}`));
  for (const path of paths) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), 'user content'); }
  const result = f.run('install', ['--target', 'codex']); assert.equal(result.status, 1);
  for (const path of paths) { assert.equal(result.stderr.split(path).length - 1, 1); assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'user content'); }
  assert.match(result.stderr, /User content was preserved/); assert.doesNotMatch(result.stdout, /files installed|Restart/);
});
test('verbose and normal machine modes have identical JSON and exit status', t => {
  const f = fixture(t);
  for (const [script, args] of [['install', ['--target', 'codex', '--dry-run']], ['doctor', ['--target', 'codex', '--json']]]) {
    const normal = f.run(script, args), verbose = f.run(script, [...args, '--verbose']);
    assert.equal(verbose.status, normal.status); assert.deepEqual(JSON.parse(verbose.stdout), JSON.parse(normal.stdout)); assert.equal(verbose.stderr, normal.stderr);
  }
  ok(f.run('install', ['--target', 'codex']));
  const receipt = readFileSync(join(f.root, '.pstack/install.json'));
  const installNormal = f.run('install'), installVerbose = f.run('install', ['--verbose']);
  assert.equal(installNormal.status, installVerbose.status);
  assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), receipt);
  assert.match(installVerbose.stdout, /Release identity/);
  const normal = f.run('doctor'), verbose = f.run('doctor', ['--verbose']);
  assert.equal(normal.status, verbose.status); assert.equal(verbose.stderr, ''); assert.match(verbose.stdout, /DISCOVERY_UNAVAILABLE; verification unavailable/); assert.match(verbose.stdout, /Release identity/); assert.doesNotMatch(normal.stdout, /DISCOVERY_UNAVAILABLE/);
});
test('CLI warnings stay visible and successful on stderr; doctor keeps findings on stdout', t => {
  const f = fixture(t); writeFileSync(join(f.base, 'fixture-bin/codex'), '#!/bin/sh\nprintf "999.0.0\\n"\n', { mode: 0o755 });
  let result = f.run('install', ['--target', 'codex']); ok(result); assert.match(result.stderr, /999\.0\.0 differs from the recorded tested version/); assert.match(result.stderr, /Compatibility is unverified/);
  const global = spawnSync(process.execPath, [join(scripts, 'install.mjs'), '--global', '--target', 'codex'], { env: f.env, encoding: 'utf8' }); ok(global);
  result = f.run('install'); ok(result); assert.match(result.stderr, /multiple scopes/); assert.match(result.stderr, /active source is unknown/); assert.match(result.stderr, /uninstall.mjs.*--target codex/);
  const doctor = f.run('doctor'); ok(doctor); assert.equal(doctor.stderr, ''); assert.match(doctor.stdout, /multiple scopes/);
  assert.ok(doctor.stdout.includes(join(scripts, 'doctor.mjs')));
  assert.ok(doctor.stdout.includes(join(scripts, 'uninstall.mjs')));
  const advice = doctor.stdout.match(/Inspect each scope with (.+?) and /)[1];
  const inspected = spawnSync('/bin/sh', ['-c', advice], { env: f.env, cwd: f.home, encoding: 'utf8' });
  ok(inspected); assert.match(inspected.stdout, /Scope: project/);
});
test('renderers retain unknown failures, cleanup and restoration without exposing arbitrary evidence', () => {
  const findings = [
    { code: 'NEW_WARNING', severity: 'warning', subject: '/path\x1b[31m', action: 'Inspect the path.', evidence: { output: secret, error: secret, nested: secret }, verification: 'unavailable' },
    { code: 'NEW_ERROR', severity: 'error', subject: 'codex', action: 'Repair the installation.', evidence: { secret }, verification: 'failed' }
  ];
  for (const verbose of [false, true]) {
    const input = outcome(findings); input.cleanupPending = true; input.cleanupError = secret;
    input.cleanup = { preserved: [{ path: '/retained', reason: secret, action: 'Move your content before retrying uninstall.' }] };
    const output = renderOperation(input, { ...context, verbose });
    assert.match(output.stderr, /NEW_WARNING/); assert.match(output.stderr, /NEW_ERROR/); assert.match(output.stderr, /cleanup is unfinished/); assert.match(output.stderr, /\/retained/);
    assert.doesNotMatch(output.stdout + output.stderr, new RegExp(secret)); assert.doesNotMatch(output.stderr, /\x1b/); assert.match(output.stderr, /\\u001b/);
    assert.doesNotMatch(renderDoctor(report(findings), { ...context, verbose }), new RegExp(secret));
    input.status = 'verification-failed-restored'; input.restored = true;
    let failed = renderOperation(input, context); assert.match(failed.stderr, /attempted installation of codex/); assert.match(failed.stderr, /prior installation was restored; it has not passed a new verification/);
    input.restored = false; failed = renderOperation(input, context); assert.match(failed.stderr, /Restoration is incomplete/); assert.match(failed.stderr, /retained recovery command/);
  }
});
test('preflight rejection after recovery and successful repair do not misstate earlier findings', () => {
  const input = outcome([]); input.prepared.report = report([{ code: 'OWNED_MISSING', severity: 'error', subject: '/missing', action: 'Repair it.' }]);
  assert.doesNotMatch(renderOperation(input, context).stderr, /missing|Repair/);
  input.status = 'preflight-failed'; input.recovered = { status: 'restored-prior' }; input.prepared.failures = input.prepared.report.findings;
  const output = renderOperation(input, context); assert.match(output.stderr, /after automatic recovery/); assert.doesNotMatch(output.stderr, /No installation files changed/); assert.equal(output.stderr.split('/missing').length - 1, 1);
});
test('rollback and recovery keep parseable JSON stdout with recovery notices on stderr', t => {
  const f = fixture(t);
  ok(f.run('install', ['--target', 'cursor'])); ok(f.run('install', ['--target', 'codex']));
  let result = f.run('rollback'); ok(result); assert.equal(JSON.parse(result.stdout).status, 'applied'); assert.match(result.stderr, /^Recovery if interrupted:/);
  result = f.run('recover'); ok(result); assert.equal(JSON.parse(result.stdout).status, 'no-operation');
});
