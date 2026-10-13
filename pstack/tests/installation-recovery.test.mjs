import { installLegacy } from './fixtures/legacy-installation.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyActivationSource, compactActivation, serializablePrepared } from './fixtures/activation-fixtures.mjs';
import { prepareStagedActivation, applyStagedActivation, runStagedInstallation } from '../scripts/lib/installation-activation.mjs';
import { recoverInstallation, recoverDemonstrablyDeadLocks } from '../scripts/lib/installation-recovery.mjs';
import { readActivationJournal, recoveryCommand, journalName, instructionName, persistJournal, cleanPendingJournal } from '../scripts/lib/activation-journal.mjs';
import { inspectInstallationLock, withInstallationMutation } from '../scripts/lib/installation-lock.mjs';
import { canonicalPath, observe, stateFrom } from '../scripts/lib/installation-state.mjs';
import { verifyGeneration } from '../scripts/lib/installation-storage.mjs';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
const compactDirectory = mkdtempSync(join(tmpdir(), 'pstack-activation-source-'));
after(() => rmSync(compactDirectory, { recursive: true, force: true }));
const compactSource = copyActivationSource(source, join(compactDirectory, 'source'));
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
async function killAt(t, prepared, target, executableSource = source, env = process.env, childName = 'activation-child.mjs') {
  const child = fork(join(executableSource, 'tests/fixtures', childName), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '', killed = false; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  child.on('message', message => { if (message.boundary === target) { killed = true; child.kill('SIGKILL'); } else if (message.boundary) child.send('continue'); });
  child.send({ prepared: serializablePrepared(prepared) }); const [code, signal] = await once(child, 'exit');
  assert.ok(killed, `Missing boundary ${target}: ${stderr}`); assert.equal(signal, 'SIGKILL', stderr); assert.equal(code, null);
  assert.equal(stdout, '');
  return stderr;
}
function executeRecovery(f, command) {
  const result = spawnSync('sh', ['-c', command + ' --recover-dead-locks'], { env: f.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('bounded exhaustive IPC crashes cover every compact journal/mutation boundary and exact prior/committed active snapshots', { timeout: 90000 }, async t => {
  const control = fixture(t), prepared = compactActivation({ source: compactSource, ...control }), before = activeSnapshot(control.root), boundaries = [];
  await applyStagedActivation(prepared, { boundary: (name, journal) => {
    boundaries.push(name);
    if (name === 'prepared') assert.deepEqual(journal.operations.map(op => [op.name, op.before.kind, op.after.kind]), [
      ['.cursor/agents/nested/create.md', 'absent', 'file'],
      ['.cursor/agents/remove.md', 'file', 'absent'],
      ['.cursor/agents/replace.md', 'file', 'file'],
      ['.cursor/skills/how', 'absent', 'link'],
      ['.cursor/skills/why', 'link', 'absent'],
      ['.pstack/install.json', 'file', 'file']
    ]);
  } }); const after = activeSnapshot(control.root);
  const expected = [
    'prepared', 'applying', 'directory:0',
    'temporary:0', 'mutation:0', 'progress:0', // create file
    'mutation:1', 'progress:1', // remove file
    'temporary:2', 'mutation:2', 'progress:2', // replace file
    'temporary:3', 'mutation:3', 'progress:3', // create link
    'mutation:4', 'progress:4', // remove link
    'temporary:5', 'mutation:5', 'progress:5', // receipt last
    'verifying', 'committed', 'cleanup'
  ];
  assert.deepEqual(boundaries, expected, 'Compact crash coverage must not shrink with production callbacks');
  const started = Date.now();
  for (const target of expected) {
    const f = fixture(t), p = compactActivation({ source: compactSource, ...f }), original = activeSnapshot(f.root);
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
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
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
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
  writeFileSync(join(f.root, '.pstack/models.json'), JSON.stringify({ version: 1, roles: { 'bug-fix': 'inherit-parent' } }));
  mkdirSync(join(f.root, '.cursor/skills/unrelated'), { recursive: true }); writeFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'user skill');
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'mutation:0') throw new Error('interrupted'); } }), /interrupted/);
  const result = await runStagedInstallation(f.options); assert.equal(result.status, 'applied'); assert.equal(result.recovered.status, 'restored-prior');
  assert.equal(readFileSync(join(f.root, '.cursor/skills/unrelated/SKILL.md'), 'utf8'), 'user skill'); assert.match(readFileSync(join(f.root, '.pstack/models.json'), 'utf8'), /inherit-parent/);
  assert.equal(readActivationJournal(f.root), null); assert.equal(existsSync(join(f.root, '.opencode')), false);
});
test('live or unverifiable lock owners and tampered journal paths are preserved', async t => {
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
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
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'prepared') throw new Error('interrupted'); } }), /interrupted/);
  const journal = readActivationJournal(f.root), op = journal.operations.find(item => item.after.kind === 'file' && item.name !== '.pstack/install.json');
  const path = `${op.path}.pstack-${journal.id}.tmp`; mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'unknown temporary bytes');
  await assert.rejects(recoverInstallation(f.root), /Unknown operation temporary content.*move it aside/s); assert.equal(readFileSync(path, 'utf8'), 'unknown temporary bytes');
  rmSync(path); assert.equal((await recoverInstallation(f.root)).status, 'restored-prior');
});
test('restoration itself survives an IPC kill after a before-image temporary write', { timeout: 20000 }, async t => {
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f }), before = activeSnapshot(f.root);
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

// Each test owns its process; patches are restored before recovery and no test
// uses concurrency. Faults occur at actual fs calls, without a production seam.
async function withFilesystemFault(method, intercept, operation) {
  const original = fs[method];
  fs[method] = (...args) => intercept(original, args);
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { fs[method] = original; syncBuiltinESMExports(); }
}
for (const fault of ['journal-write', 'journal-rename', 'activation-rename', 'restoration-rename']) {
  test(`${fault} failure preserves user state and recovery converges`, async t => {
    const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
    writeFileSync(join(f.root, '.cursor/agents/user.md'), 'unowned user bytes');
    const before = activeSnapshot(f.root);
    if (fault === 'restoration-rename') {
      await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'verifying') throw new Error('stop before commit'); } }), /stop before commit/);
    }
    let fired = false, armed = !fault.startsWith('journal-');
    const method = fault === 'journal-write' ? 'writeFileSync' : 'renameSync';
    const intercept = (original, args) => {
      const journalWrite = fault === 'journal-write' && (typeof args[0] === 'number' || String(args[0]).includes('activation.json.'));
      const journalRename = fault === 'journal-rename' && canonicalPath(args[1]) === join(canonicalPath(f.root), journalName);
      const imageRename = ['activation-rename', 'restoration-rename'].includes(fault) && args[1] === join(canonicalPath(f.root), '.cursor/agents/replace.md');
      if (armed && !fired && (journalWrite || journalRename || imageRename)) {
        fired = true;
        if (journalWrite) original(args[0], String(args[1]).slice(0, 20), args[2]);
        throw Object.assign(new Error(`injected EIO: ${fault}`), { code: 'EIO' });
      }
      return original(...args);
    };
    await assert.rejects(withFilesystemFault(method, intercept, () => fault === 'restoration-rename'
      ? recoverInstallation(f.root)
      : applyStagedActivation(p, { boundary: name => { if (name === 'prepared') armed = true; } })), new RegExp(`injected EIO: ${fault}`));
    assert.ok(fired, 'The actual I/O boundary must execute');
    assert.equal(readFileSync(join(f.root, '.cursor/agents/user.md'), 'utf8'), 'unowned user bytes');
    const journal = readActivationJournal(f.root);
    assert.ok(journal, 'A recoverable journal must survive the injected failure');
    const command = recoveryCommand(f.root, journal);
    assert.equal(readFileSync(join(f.root, instructionName), 'utf8'), command + '\n');
    assert.equal(executeRecovery(f, command).status, 'restored-prior');
    assert.deepEqual(activeSnapshot(f.root), before);
    assert.equal((await recoverInstallation(f.root)).status, 'no-operation');
    // A fresh attempt must not inherit a poisoned journal temporary.
    assert.equal((await applyStagedActivation(p)).status, 'applied');
  });
}

for (const change of ['preexisting', 'replacement', 'edited']) {
  test(`journal persistence preserves ${change} unowned temporary bytes`, async t => {
    const f = fixture(t), journal = { id: 'ownership-test', state: 'prepared' };
    mkdirSync(join(f.root, '.pstack'));
    const temporary = join(f.root, `${journalName}.${journal.id}.tmp`);
    if (change === 'preexisting') {
      writeFileSync(temporary, 'unowned journal bytes');
      assert.throws(() => persistJournal(f.root, journal), { code: 'EEXIST' });
    } else {
      await assert.rejects(withFilesystemFault('renameSync', () => {
        if (change === 'replacement') rmSync(temporary);
        writeFileSync(temporary, 'unowned journal bytes');
        throw Object.assign(new Error('rename denied after external edit'), { code: 'EACCES' });
      }, async () => persistJournal(f.root, journal)), /rename denied/);
    }
    assert.equal(readFileSync(temporary, 'utf8'), 'unowned journal bytes');
    assert.equal(existsSync(join(f.root, journalName)), false);
  });
}

test('retained recovery handles SIGKILL between journal write and rename after source deletion', { timeout: 20000 }, async t => {
  const f = fixture(t, true), p = compactActivation({ source: f.selectedSource, ...f }), before = activeSnapshot(f.root);
  const retained = verifyGeneration(f.root, p.generation);
  rmSync(f.selectedSource, { recursive: true });
  await killAt(t, p, 'journal-written-before-rename', retained, f.env, 'journal-interruption-child.mjs');
  const journal = readActivationJournal(f.root), command = recoveryCommand(f.root, journal);
  const temporary = join(f.root, `${journalName}.${journal.id}.tmp`);
  assert.equal(journal.state, 'prepared');
  assert.equal(JSON.parse(readFileSync(temporary)).state, 'applying');
  assert.equal(readFileSync(join(f.root, instructionName), 'utf8'), command + '\n');
  assert.equal(executeRecovery(f, command).status, 'restored-prior');
  assert.deepEqual(activeSnapshot(f.root), before);
  assert.equal(existsSync(temporary), false);
  assert.equal(executeRecovery(f, command).status, 'no-operation');
});
for (const variant of ['partial', 'changed-identity', 'illegal-transition']) {
  test(`recovery preserves ${variant} journal temporary until manually moved aside`, async t => {
    const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
    await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'prepared') throw new Error('interrupted'); } }), /interrupted/);
    const journal = readActivationJournal(f.root), command = recoveryCommand(f.root, journal);
    const temporary = join(f.root, `${journalName}.${journal.id}.tmp`);
    const bytes = variant === 'partial' ? '{"id":' : JSON.stringify({ ...journal, state: variant === 'illegal-transition' ? 'committed' : 'applying', ...(variant === 'changed-identity' ? { extra: 'unowned' } : {}) });
    writeFileSync(temporary, bytes);
    await assert.rejects(recoverInstallation(f.root), error => error.message.includes('move it aside') && error.message.includes(command));
    assert.equal(readFileSync(temporary, 'utf8'), bytes);
    fs.renameSync(temporary, join(f.base, 'preserved-temporary'));
    assert.equal(executeRecovery(f, command).status, 'restored-prior');
    assert.equal(readFileSync(join(f.base, 'preserved-temporary'), 'utf8'), bytes);
  });
}

test('pending journal classifier accepts only the actual next writes and preserves unsafe paths', async t => {
  const f = fixture(t), p = compactActivation({ source: compactSource, ...f });
  await assert.rejects(applyStagedActivation(p, { boundary: name => { if (name === 'prepared') throw new Error('interrupted'); } }), /interrupted/);
  const validated = readActivationJournal(f.root), count = validated.operations.length;
  const temporary = join(f.root, `${journalName}.${validated.id}.tmp`);
  const legal = [
    ['prepared', 0, 'applying', 0],
    ['applying', 0, 'applying', 1],
    ['applying', count, 'verifying', count],
    ['verifying', count, 'verifying', count, { code: 'DIAGNOSTIC_EXECUTION_FAILED', error: 'probe failed' }],
    ['verifying', count, 'verifying', count, { code: 'POST_ACTIVATION_FAILED', findings: [], discovery: { status: 'unavailable' } }],
    ['verifying', count, 'committed', count],
    ['prepared', 0, 'restoring', 0],
    ['applying', 1, 'restoring', 1],
    ['verifying', count, 'restoring', count],
    ['restoring', 1, 'restoring', 1],
    ['restoring', 1, 'restored', 1]
  ];
  for (const [state, progress, nextState, nextProgress, failure] of legal) {
    const live = { ...validated, state, progress };
    writeFileSync(temporary, JSON.stringify({ ...live, state: nextState, progress: nextProgress, ...(failure ? { failure } : {}) }));
    cleanPendingJournal(f.root, live);
    assert.equal(existsSync(temporary), false, `${state}:${progress} -> ${nextState}:${nextProgress}`);
  }
  const live = { ...validated, state: 'applying', progress: 1 };
  for (const change of [
    { progress: 3 }, { progress: -1 }, { progress: count + 1 },
    { state: 'committed', progress: count }, { extra: 'unknown identity field' },
    { failure: { code: 'UNRECOGNIZED' } },
    { state: 'restoring', progress: 1, failure: { code: 'DIAGNOSTIC_EXECUTION_FAILED', error: 'not a diagnostic transition' } }
  ]) {
    const bytes = JSON.stringify({ ...live, ...change });
    writeFileSync(temporary, bytes);
    assert.throws(() => cleanPendingJournal(f.root, live), /preserve.*move it aside/s);
    assert.equal(readFileSync(temporary, 'utf8'), bytes);
    rmSync(temporary);
  }
  const userFile = join(f.base, 'user-journal');
  writeFileSync(userFile, 'user bytes');
  fs.symlinkSync(userFile, temporary);
  assert.throws(() => cleanPendingJournal(f.root, validated), /preserve.*move it aside/s);
  assert.equal(lstatSync(temporary).isSymbolicLink(), true);
  assert.equal(readFileSync(userFile, 'utf8'), 'user bytes');
});
