import { installLegacy } from './fixtures/legacy-installation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { compactActivation, serializablePrepared } from './fixtures/activation-fixtures.mjs';
import { prepareStagedActivation, applyStagedActivation, runStagedInstallation } from '../scripts/lib/installation-activation.mjs';
import { recoverInstallation, recoverDemonstrablyDeadLocks } from '../scripts/lib/installation-recovery.mjs';
import { readActivationJournal, recoveryCommand, journalName, instructionName } from '../scripts/lib/activation-journal.mjs';
import { inspectInstallationLock, withInstallationMutation } from '../scripts/lib/installation-lock.mjs';
import { canonicalPath, observe, stateFrom } from '../scripts/lib/installation-state.mjs';
import { verifyGeneration } from '../scripts/lib/installation-storage.mjs';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t, copy = false) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-recovery-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "space ' scope"), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
  let selectedSource = source;
  if (copy) { selectedSource = join(base, 'source'); cpSync(source, selectedSource, { recursive: true, filter: path => !path.split('/').includes('node_modules') && !path.endsWith('/.git') }); }
  const env = isolatedEnvironment(base);
  const options = { source: selectedSource, root, globalRoot: home, options: { target: 'cursor' }, env };
  return { base, root, home, env, selectedSource, options };
}
function activeSnapshot(root) {
  const walk = path => !existsSync(path) && observe(path).kind === 'absent' ? [] : (() => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) return [[path, 'directory', stat.mode & 0o777], ...readdirSync(path).sort().flatMap(name => walk(join(path, name)))];
    return [[path, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString('base64')]];
  })();
  return ['.cursor', '.agents', '.claude', '.opencode', '.pstack/package', '.pstack/install.json', '.pstack/models.json'].flatMap(name => walk(join(root, name)));
}
async function killAt(t, prepared, target, executableSource = source, env = process.env) {
  const child = fork(join(executableSource, 'tests/fixtures/activation-child.mjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '', killed = false; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  child.on('message', message => { if (message.boundary === target) { killed = true; child.kill('SIGKILL'); } else if (message.boundary) child.send('continue'); });
  child.send({ prepared: serializablePrepared(prepared) }); const [code, signal] = await once(child, 'exit');
  assert.ok(killed, `Missing boundary ${target}: ${stderr}`); assert.equal(signal, 'SIGKILL', stderr); assert.equal(code, null);
  return stdout;
}
function executeRecovery(f, command) {
  const result = spawnSync('sh', ['-c', command + ' --recover-dead-locks'], { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('bounded exhaustive IPC crashes cover every compact journal/mutation boundary and exact prior/committed active snapshots', { timeout: 90000 }, async t => {
  const control = fixture(t), prepared = compactActivation({ source, ...control }), before = activeSnapshot(control.root), boundaries = [];
  await applyStagedActivation(prepared, { boundary: name => boundaries.push(name) }); const after = activeSnapshot(control.root);
  const started = Date.now();
  for (const target of boundaries) {
    const f = fixture(t), p = compactActivation({ source, ...f }), original = activeSnapshot(f.root);
    await killAt(t, p, target, source, f.env);
    const journal = readActivationJournal(f.root), command = recoveryCommand(f.root, journal || { generation: p.generation });
    if (journal) assert.equal(readFileSync(join(f.root, instructionName), 'utf8'), command + '\n');
    const result = executeRecovery(f, command);
    if (['committed', 'cleanup'].includes(target)) {
      const normalized = activeSnapshot(f.root).map(row => row.map(value => typeof value === 'string' ? value.replaceAll(f.root, control.root) : value));
      // Receipt identity/provenance differs only when source content changes; both use the same source here.
      assert.deepEqual(normalized, after);
    } else assert.deepEqual(activeSnapshot(f.root), original);
    assert.equal(existsSync(join(f.root, journalName)), false); assert.equal(inspectInstallationLock(join(f.root, '.pstack/mutation.lock')).status, 'absent');
    assert.equal((await recoverInstallation(f.root)).status, 'no-operation');
  }
  t.diagnostic(`${boundaries.length} deterministic crash points in ${Date.now() - started}ms; existing portable phase budget is 180000ms`);
});
test('third-party edit survives conflicted recovery; doctor reports the exact command without writing', async t => {
  const f = fixture(t), p = compactActivation({ source, ...f });
  await killAt(t, p, 'verifying', source, f.env); writeFileSync(join(f.root, '.cursor/agents/replace.md'), 'user edit');
  const journal = readActivationJournal(f.root), command = recoveryCommand(f.root, journal), before = activeSnapshot(f.root);
  const doctorBefore = readFileSync(join(f.root, journalName), 'utf8');
  const doctor = spawnSync(process.execPath, [join(source, 'scripts/doctor.mjs'), '--project', f.root, '--json'], { env: f.env, encoding: 'utf8' });
  assert.equal(doctor.status, 1, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).operation.command, command);
  assert.equal(readFileSync(join(f.root, journalName), 'utf8'), doctorBefore); assert.deepEqual(activeSnapshot(f.root), before);
  await assert.rejects(recoverInstallation(f.root, { recoverDeadLocks: true }), /Recovery conflict.*replace.md/s);
  assert.deepEqual(activeSnapshot(f.root), before); assert.equal(readFileSync(join(f.root, '.cursor/agents/replace.md'), 'utf8'), 'user edit');
  writeFileSync(join(f.root, 'preserved-user-edit.md'), 'user edit'); writeFileSync(join(f.root, '.cursor/agents/replace.md'), 'new');
  assert.equal(executeRecovery(f, command).status, 'restored-prior'); assert.equal(readFileSync(join(f.root, 'preserved-user-edit.md'), 'utf8'), 'user edit');
  assert.equal(readFileSync(join(f.root, '.cursor/agents/replace.md'), 'utf8'), 'old');
});
test('printed retained command recovers a killed fresh install with the original checkout removed', { timeout: 20000 }, async t => {
  const f = fixture(t, true), p = await prepareStagedActivation(f.options), retained = verifyGeneration(f.root, p.generation), before = activeSnapshot(f.root);
  rmSync(f.selectedSource, { recursive: true });
  const stdout = await killAt(t, p, 'mutation:0', retained, f.env), command = readFileSync(join(f.root, instructionName), 'utf8').trim();
  assert.ok(stdout.includes(command)); assert.equal(executeRecovery(f, command).status, 'restored-prior'); assert.deepEqual(activeSnapshot(f.root), before);
  assert.equal(executeRecovery(f, command).status, 'no-operation');
});
test('legacy schemas recover the exact real directory/receipt through a candidate executable after source deletion', { timeout: 30000 }, async t => {
  for (const [schema, target] of [[1, 'mutation:1'], [2, 'mutation:0'], [2, 'mutation:1']]) {
    const f = fixture(t, true), legacySource = join(f.base, 'legacy-source'); cpSync(f.selectedSource, legacySource, { recursive: true }); rmSync(join(legacySource, 'scripts/recover.mjs'));
    installLegacy({ source: legacySource, root: f.root });
    const state = JSON.parse(readFileSync(join(f.root, '.pstack/install.json')));
    for (const name of ['release.json', 'pstack-provenance.json']) { rmSync(join(f.root, '.pstack/package', name), { force: true }); delete state.entries['.pstack/package/' + name]; }
    state.version = schema; delete state.provenance; delete state.hostObservations; if (schema === 1) { state.target = 'cursor'; delete state.targets; }
    writeFileSync(join(f.root, '.pstack/install.json'), JSON.stringify(state, null, 2) + '\n');
    const before = activeSnapshot(f.root), p = await prepareStagedActivation(f.options), retained = verifyGeneration(f.root, p.generation);
    assert.ok(p.legacy); assert.equal(p.legacy.generation.provenance.classification, 'legacy-unknown'); assert.equal(p.legacy.generation.provenance.sourceCommit, null); assert.equal(p.legacy.generation.provenance.upstreamCommit, null); assert.equal(p.legacy.generation.renderer, null); rmSync(f.selectedSource, { recursive: true }); rmSync(legacySource, { recursive: true });
    const stdout = await killAt(t, p, target, retained, f.env), command = readFileSync(join(f.root, instructionName), 'utf8').trim(); assert.ok(stdout.includes(command));
    assert.equal(executeRecovery(f, command).status, 'restored-prior'); assert.deepEqual(activeSnapshot(f.root), before);
    assert.equal(observe(join(f.root, '.pstack/package')).kind, 'directory'); assert.equal(stateFrom(join(f.root, '.pstack/install.json')).version, schema);
  }
});
test('next internal mutation recovers before planning and preserves user models/unrelated skills', async t => {
  const f = fixture(t), p = compactActivation({ source, ...f });
  writeFileSync(join(f.root, '.pstack/models.json'), JSON.stringify({ version: 1, roles: { 'bug-fix': 'inherit-parent' } }));
  mkdirSync(join(f.root, '.cursor/skills/unrelated'), { recursive: true }); writeFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'user skill');
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'mutation:0') throw new Error('interrupted'); } }), /interrupted/);
  const result = await runStagedInstallation(f.options); assert.equal(result.status, 'applied'); assert.equal(result.recovered.status, 'restored-prior');
  assert.equal(readFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'utf8'), 'user skill'); assert.match(readFileSync(join(f.root, '.pstack/models.json'), 'utf8'), /inherit-parent/);
  assert.equal(readActivationJournal(f.root), null); assert.equal(existsSync(join(f.root, '.opencode')), false);
});
test('live or unverifiable lock owners and tampered journal paths are preserved', async t => {
  const f = fixture(t), p = compactActivation({ source, ...f });
  await withInstallationMutation({ root: f.root }, async () => {
    assert.throws(() => recoverDemonstrablyDeadLocks(f.root), /Preserving live or unverifiable/);
    assert.equal(inspectInstallationLock(join(f.root, '.pstack/mutation.lock')).status, 'active');
  });
  writeFileSync(join(f.root, '.pstack/mutation.lock'), '{}'); assert.throws(() => recoverDemonstrablyDeadLocks(f.root), /unverifiable/); assert.equal(readFileSync(join(f.root, '.pstack/mutation.lock'), 'utf8'), '{}'); rmSync(join(f.root, '.pstack/mutation.lock'));
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'prepared') throw new Error('interrupted'); } }), /interrupted/);
  const path = join(f.root, journalName), journal = JSON.parse(readFileSync(path)); journal.operations[0].path = join(f.home, 'unowned'); writeFileSync(path, JSON.stringify(journal));
  assert.throws(() => readActivationJournal(f.root), /path differs/); assert.equal(existsSync(join(f.home, 'unowned')), false);
});
test('global partial-target update across changed XDG roots restores both recorded scopes and clears every dead lock', { timeout: 30000 }, async t => {
  const f = fixture(t, true); f.env = withHostVersionFixtures(f.base, f.env);
  const options = { ...f.options, root: f.home, env: f.env, options: { target: 'opencode', global: true } };
  assert.equal((await applyStagedActivation(await prepareStagedActivation(options))).status, 'applied');
  assert.equal((await applyStagedActivation(await prepareStagedActivation({ ...options, options: { target: 'cursor', global: true } }))).status, 'applied');
  const oldRoot = stateFrom(join(f.home, '.pstack/install.json')).opencodeRoot;
  mkdirSync(join(oldRoot, 'skills/unrelated'), { recursive: true }); writeFileSync(join(oldRoot, 'skills/unrelated/SKILL.md'), 'external plugin');
  const before = activeSnapshot(f.home), oldFiles = readdirSync(join(oldRoot, 'commands')).sort();
  const changedEnv = { ...f.env, XDG_CONFIG_HOME: join(f.base, 'config-next') };
  const prepared = await prepareStagedActivation({ ...options, env: changedEnv, options: { target: 'cursor', global: true, uninstall: true } });
  const newRoot = prepared.plan.artifacts.state.opencodeRoot, retained = verifyGeneration(f.home, prepared.generation); rmSync(f.selectedSource, { recursive: true });
  await killAt(t, prepared, 'verifying', retained, changedEnv);
  const journal = readActivationJournal(f.home), command = recoveryCommand(f.home, journal), globalFixture = { ...f, root: f.home, env: changedEnv };
  assert.equal(executeRecovery(globalFixture, command).status, 'restored-prior'); assert.deepEqual(activeSnapshot(f.home), before);
  assert.deepEqual(readdirSync(join(oldRoot, 'commands')).sort(), oldFiles); assert.equal(readFileSync(join(oldRoot, 'skills/unrelated/SKILL.md'), 'utf8'), 'external plugin');
  assert.equal(readdirSync(newRoot).length, 0);
  for (const path of [join(f.home, '.pstack/mutation.lock'), join(oldRoot, '.pstack-mutation.lock'), join(newRoot, '.pstack-mutation.lock')]) assert.equal(inspectInstallationLock(path).status, 'absent');
});
test('unknown operation temporary bytes are preserved with a named retry action', async t => {
  const f = fixture(t), p = compactActivation({ source, ...f });
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'prepared') throw new Error('interrupted'); } }), /interrupted/);
  const journal = readActivationJournal(f.root), op = journal.operations.find(item => item.after.kind === 'file' && item.name !== '.pstack/install.json');
  const path = `${op.path}.pstack-${journal.id}.tmp`; mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'unknown temporary bytes');
  await assert.rejects(recoverInstallation(f.root), /Unknown operation temporary content.*move it aside/s); assert.equal(readFileSync(path, 'utf8'), 'unknown temporary bytes');
  rmSync(path); assert.equal((await recoverInstallation(f.root)).status, 'restored-prior');
});
test('restoration itself survives an IPC kill after a before-image temporary write', { timeout: 20000 }, async t => {
  const f = fixture(t), p = compactActivation({ source, ...f }), before = activeSnapshot(f.root);
  await killAt(t, p, 'verifying', source, f.env);
  const journal = readActivationJournal(f.root), command = recoveryCommand(f.root, journal), retained = verifyGeneration(f.root, p.generation);
  const child = fork(join(retained, 'tests/fixtures/recovery-child.mjs'), [], { env: f.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes); let killed = false;
  child.on('message', message => { if (message.boundary?.startsWith('restore-temporary:')) { killed = true; child.kill('SIGKILL'); } else if (message.boundary) child.send('continue'); });
  child.send({ root: f.root }); const [, signal] = await once(child, 'exit'); assert.ok(killed, stderr); assert.equal(signal, 'SIGKILL', stderr);
  assert.equal(readActivationJournal(f.root).state, 'restoring'); assert.equal(executeRecovery(f, command).status, 'restored-prior'); assert.deepEqual(activeSnapshot(f.root), before);
});
test('successful internal legacy activation cleans its certified directory backup only after committing', async t => {
  const f = fixture(t);
  installLegacy({ source, root: f.root });
  const prepared = await prepareStagedActivation(f.options); assert.ok(prepared.legacy);
  let backup;
  assert.equal((await applyStagedActivation(prepared, { boundary: (name, journal) => {
    const op = journal.operations.find(item => item.kind === 'legacy-directory'); backup = join(f.root, op.backupName);
    if (name === 'committed') assert.equal(existsSync(backup), true);
  } })).status, 'applied');
  assert.equal(existsSync(backup), false); assert.equal(observe(join(f.root, '.pstack/package')).kind, 'link'); assert.equal(stateFrom(join(f.root, '.pstack/install.json')).version, 4); assert.equal(readActivationJournal(f.root), null);
});
