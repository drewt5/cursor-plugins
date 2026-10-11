import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareStagedActivation, applyStagedActivation } from '../scripts/lib/installation-activation.mjs';
import { prepareRollback, rollbackInstallation } from '../scripts/lib/installation-rollback.mjs';
import { removeInstallation } from '../scripts/lib/installation-removal.mjs';
import { recoverInstallation } from '../scripts/lib/installation-recovery.mjs';
import { stateFrom } from '../scripts/lib/installation-state.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-rollback-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'), candidate = join(base, 'source'); mkdirSync(root); mkdirSync(home); cpSync(source, candidate, { recursive: true });
  const env = { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: join(home, '.config') };
  const options = { source: candidate, root, globalRoot: home, options: { target: 'cursor' }, env };
  return { base, root, home, candidate, options, rollback: { root, globalRoot: home, env } };
}
const receipt = f => stateFrom(join(f.root, '.pstack/install.json'));
async function apply(f, text) { if (text) writeFileSync(join(f.candidate, 'fixture-release.txt'), text); const prepared = await prepareStagedActivation(f.options); assert.equal(prepared.plan.conflicts.length, 0); assert.equal(prepared.failures.length, 0); const result = await applyStagedActivation(prepared); assert.equal(result.status, 'applied'); return receipt(f); }
test('three updates retain only active and previous; rollback reuses exact adapters and preserves user content; full uninstall removes executable storage', async t => {
  const f = fixture(t); const a = await apply(f, 'A'), b = await apply(f, 'B'), c = await apply(f, 'C');
  assert.equal(c.previous.state.generation.digest, b.generation.digest); assert.equal(existsSync(join(f.root, a.generation.name)), false);
  assert.equal(readdirSync(join(f.root, '.pstack/releases')).filter(name => /^[a-f0-9]{64}$/.test(name)).length, 2);
  mkdirSync(join(f.root, '.cursor/skills/unrelated')); writeFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'user');
  mkdirSync(join(f.root, '.pstack'), { recursive: true }); writeFileSync(join(f.root, '.pstack/user.txt'), 'keep');
  const result = await rollbackInstallation(f.rollback); assert.equal(result.status, 'applied'); assert.equal(result.regenerated, false);
  const rolled = receipt(f); assert.equal(rolled.generation.digest, b.generation.digest); assert.equal(rolled.previous.state.generation.digest, c.generation.digest);
  assert.deepEqual(rolled.entries, b.entries); assert.equal(readFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'utf8'), 'user');
  assert.equal((await removeInstallation({ root: f.root })).status, 'applied'); assert.equal(existsSync(join(f.root, '.pstack/install.json')), false); assert.equal(existsSync(join(f.root, '.pstack/releases')), false); assert.equal(readFileSync(join(f.root, '.pstack/user.txt'), 'utf8'), 'keep');
});
test('no prior generation and modified/colliding paths refuse together before writes', async t => {
  const f = fixture(t); writeFileSync(join(f.candidate, 'agents/rollback-only.md'), 'prior agent'); await apply(f, 'A'); await assert.rejects(prepareRollback(f.rollback), /No previous/);
  rmSync(join(f.candidate, 'agents/rollback-only.md')); await apply(f, 'B'); writeFileSync(join(f.root, '.cursor/agents/rollback-only.md'), 'unowned collision'); const before = readFileSync(join(f.root, '.pstack/install.json'));
  const names = Object.keys(receipt(f).entries).filter(name => name.startsWith('.cursor/agents/'));
  for (const name of names.slice(0, 2)) writeFileSync(join(f.root, name), 'user edit');
  writeFileSync(join(f.root, receipt(f).generation.name, 'fixture-release.txt'), 'modified active package');
  const result = await rollbackInstallation(f.rollback); assert.equal(result.status, 'preflight-failed'); assert.ok(result.prepared.plan.conflicts.length >= 3); assert.ok(result.prepared.failures.some(item => item.code === 'GENERATION_INVALID')); assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), before);
  for (const name of names.slice(0, 2)) assert.equal(readFileSync(join(f.root, name), 'utf8'), 'user edit');
});
test('rollback interruption restores the newer installation through the same recovery journal', async t => {
  const f = fixture(t); await apply(f, 'A'); const b = await apply(f, 'B'); const before = readFileSync(join(f.root, '.pstack/install.json'));
  await assert.rejects(rollbackInstallation(f.rollback, { boundary: name => { if (name === 'mutation:0') throw new Error('interrupted rollback'); } }), /interrupted rollback/);
  assert.equal((await recoverInstallation(f.root)).restored, true); assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), before); assert.equal(receipt(f).generation.digest, b.generation.digest);
});
function models(f, model, reasoning = 'high') {
  mkdirSync(join(f.root, '.pstack'), { recursive: true });
  const bytes = JSON.stringify({ version: 1, reasoning, hosts: { opencode: { roles: { 'bug-fix': model } } } }); writeFileSync(join(f.root, '.pstack/models.json'), bytes); return bytes;
}
function opencodeFixture(f) {
  const env = withHostVersionFixtures(f.base, f.options.env, ['opencode']); f.options.env = env; f.rollback.env = env; f.options.options.target = 'opencode';
}
test('model A -> update -> config B -> rollback regenerates with verified previous renderer; reasoning-only edits reuse artifacts', async t => {
  const f = fixture(t); opencodeFixture(f); models(f, 'vendor/model-A'); const a = await apply(f, 'A'); await apply(f, 'B');
  const bytes = models(f, 'vendor/model-B'); const prepared = await prepareRollback(f.rollback); assert.equal(prepared.regenerated, true);
  assert.ok(prepared.plan.artifacts.state.generation.digest === a.generation.digest);
  const result = await rollbackInstallation(f.rollback); assert.equal(result.status, 'applied'); assert.equal(result.regenerated, true);
  assert.equal(readFileSync(join(f.root, '.pstack/models.json'), 'utf8'), bytes);
  const map = JSON.parse(readFileSync(join(f.root, '.pstack/opencode-models.json'))); assert.deepEqual(Object.keys(map.agents), ['vendor/model-B']);
  assert.match(readFileSync(join(f.root, '.opencode/agents', map.agents['vendor/model-B'] + '.md'), 'utf8'), /vendor\/model-B/);
  await apply(f, 'C'); models(f, 'vendor/model-B', 'low'); assert.equal((await rollbackInstallation(f.rollback)).regenerated, false);
});
test('unsupported retained rendering contract refuses changed inputs without writes but accepts configuration-independent edits', async t => {
  const f = fixture(t); opencodeFixture(f); models(f, 'vendor/model-A'); await apply(f, 'A'); await apply(f, 'B');
  const state = receipt(f); state.previous.state.generation.renderer = null;
  writeFileSync(join(f.root, '.pstack/install.json'), JSON.stringify(state)); const before = readFileSync(join(f.root, '.pstack/install.json'));
  models(f, 'vendor/model-B'); await assert.rejects(rollbackInstallation(f.rollback), /Rollback refused before writes.*Apply the current selected release/s);
  assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), before); assert.equal(existsSync(join(f.root, '.pstack/activation.json')), false); assert.equal(existsSync(join(f.root, '.pstack/mutation.lock')), false);
  models(f, 'vendor/model-A', 'low'); assert.equal((await rollbackInstallation(f.rollback)).status, 'applied');
});
test('obsolete modified generations and unowned directories survive cleanup and uninstall with precise explanations', async t => {
  const f = fixture(t); const a = await apply(f, 'A'); await apply(f, 'B');
  writeFileSync(join(f.root, a.generation.name, 'user-added.txt'), 'keep'); mkdirSync(join(f.root, '.pstack/releases/user-directory')); writeFileSync(join(f.root, '.pstack/releases/user-directory/script.mjs'), 'user');
  writeFileSync(join(f.candidate, 'fixture-release.txt'), 'C');
  const result = await applyStagedActivation(await prepareStagedActivation(f.options)); assert.equal(result.status, 'applied'); assert.ok(result.cleanup.preserved.some(item => item.path.endsWith(a.generation.digest)));
  const removal = await removeInstallation({ root: f.root }); assert.equal(removal.status, 'applied'); assert.equal(removal.cleanup.preserved.length, 2);
  assert.equal(readFileSync(join(f.root, a.generation.name, 'user-added.txt'), 'utf8'), 'keep'); assert.equal(readFileSync(join(f.root, '.pstack/releases/user-directory/script.mjs'), 'utf8'), 'user');
});
test('previous model loader rejects unsupported current role before writes; source-deleted partial removal preserves remaining targets and config', async t => {
  const f = fixture(t); opencodeFixture(f);
  const loader = join(f.candidate, 'skills/pstack-runtime/scripts/models.mjs'); writeFileSync(loader, readFileSync(loader, 'utf8').replace("'how explainer', ", ''));
  await apply(f, 'A'); writeFileSync(loader, readFileSync(join(source, 'skills/pstack-runtime/scripts/models.mjs'))); await apply(f, 'B');
  const bytes = JSON.stringify({ version: 1, roles: { 'how explainer': 'vendor/current-only-role' } }); writeFileSync(join(f.root, '.pstack/models.json'), bytes);
  const before = readFileSync(join(f.root, '.pstack/install.json'));
  await assert.rejects(rollbackInstallation(f.rollback), /Rollback refused before writes.*unknown role how explainer/s);
  assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), before); assert.equal(existsSync(join(f.root, '.pstack/mutation.lock')), false);
  f.options.options.target = 'cursor'; await apply(f, 'C'); rmSync(f.candidate, { recursive: true });
  assert.equal((await removeInstallation({ root: f.root, targets: ['opencode'] })).status, 'applied'); assert.deepEqual(receipt(f).targets, ['cursor']);
  assert.equal(readFileSync(join(f.root, '.pstack/models.json'), 'utf8'), bytes); assert.equal(existsSync(join(f.root, '.pstack/opencode-models.json')), false); assert.equal(existsSync(join(f.root, '.cursor/skills/pstack-runtime/SKILL.md')), true);
});

test('after rollback to an older helper, interrupted full removal uses the supported retained previous executable', async t => {
  const f = fixture(t), module = join(f.candidate, 'scripts/lib/installation-recovery.mjs');
  writeFileSync(module, readFileSync(module, 'utf8').replace('export const recoveryContract = 2;', ''));
  const a = await apply(f, 'A'); writeFileSync(module, readFileSync(join(source, 'scripts/lib/installation-recovery.mjs'))); const b = await apply(f, 'B');
  assert.equal((await rollbackInstallation(f.rollback)).status, 'applied'); assert.equal(receipt(f).generation.digest, a.generation.digest);
  await assert.rejects(removeInstallation({ root: f.root }, { boundary: name => { if (name === 'verifying') throw new Error('interrupted full removal'); } }), /interrupted full removal/);
  const journal = JSON.parse(readFileSync(join(f.root, '.pstack/activation.json'))); assert.equal(journal.recoveryGeneration.digest, b.generation.digest); assert.equal(journal.operations.at(-1).after.kind, 'absent');
  const command = readFileSync(join(f.root, '.pstack/recovery.txt'), 'utf8').trim();
  const { spawnSync } = await import('node:child_process'); const recovery = spawnSync('/bin/sh', ['-c', command], { env: f.options.env, encoding: 'utf8' }); assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(receipt(f).generation.digest, a.generation.digest); assert.equal((await removeInstallation({ root: f.root })).status, 'applied'); assert.equal(existsSync(join(f.root, '.pstack/releases')), false);
});
