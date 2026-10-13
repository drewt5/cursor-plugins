import { copyActivationSource, compactActivation } from './fixtures/activation-fixtures.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { stagePackage, verifyGeneration } from '../scripts/lib/installation-storage.mjs';
import { prepareStagedActivation, applyStagedActivation, matchesObserved, journalName } from '../scripts/lib/installation-activation.mjs';
import { observe, safePath, stateFrom } from '../scripts/lib/installation-state.mjs';
import { withInstallationMutation, inspectInstallationLock, recoverInstallationLock } from '../scripts/lib/installation-lock.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
const compactDirectory = mkdtempSync(join(tmpdir(), 'pstack-activation-source-'));
after(() => rmSync(compactDirectory, { recursive: true, force: true }));
const compactSource = copyActivationSource(source, join(compactDirectory, 'source'));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-activation-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
  const options = { source, root, globalRoot: home, options: { target: 'cursor' }, env: { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: join(home, '.config') } };
  return { base, root, home, options };
}
function compact(t) {
  const f = fixture(t), prepared = compactActivation({ source: compactSource, root: f.root, home: f.home, env: f.options.env });
  return { ...f, generation: prepared.generation, prepared };
}

test('internal fresh activation records accurate boundaries, publishes a verified receipt, and converges; public installer uses the same transaction', async t => {
  const f = fixture(t), prepared = await prepareStagedActivation(f.options), boundaries = [];
  assert.equal(prepared.failures.length, 0);
  const result = await applyStagedActivation(prepared, { boundary: async (name, journal) => {
    boundaries.push(name);
    if (name.startsWith('mutation:')) {
      const index = Number(name.split(':')[1]);
      assert.equal(journal.progress, index); assert.ok(matchesObserved(journal.operations[index].path, observe(journal.operations[index].path), journal.operations[index].after));
      assert.equal(JSON.parse(readFileSync(join(f.root, journalName))).state, journal.state);
    }
    assert.ok(existsSync(verifyGeneration(f.root, journal.generation)));
  } });
  assert.equal(result.status, 'applied'); assert.equal(stateFrom(join(f.root, '.pstack/install.json')).version, 4); assert.equal(existsSync(join(f.root, journalName)), false);
  assert.equal(observe(join(f.root, '.pstack/package')).kind, 'link'); assert.equal((await applyStagedActivation(await prepareStagedActivation(f.options))).status, 'unchanged');
  assert.ok(boundaries.includes('verifying') && boundaries.includes('committed') && boundaries.includes('cleanup'));
  const other = fixture(t), publicResult = spawnSync(process.execPath, [join(source, 'scripts/install.mjs'), '--project', other.root, '--target', 'cursor'], { env: other.options.env, encoding: 'utf8' });
  assert.equal(publicResult.status, 0, publicResult.stderr); assert.equal(stateFrom(join(other.root, '.pstack/install.json')).version, 4); assert.equal(observe(join(other.root, '.pstack/package')).kind, 'link');
});
test('every compact mutation interruption retains exact before/after values and generation without advertising recovery execution', async t => {
  const initial = compact(t), count = initial.prepared.plan.operations.filter(op => op.action !== 'unchanged').length + 1;
  for (let stop = 0; stop < count; stop++) {
    const f = compact(t);
    await assert.rejects(applyStagedActivation(f.prepared, { boundary: name => { if (name === `mutation:${stop}`) throw new Error('fixture interruption'); } }), /fixture interruption/);
    const journal = JSON.parse(readFileSync(join(f.root, journalName)));
    assert.equal(journal.state, 'applying'); assert.equal(journal.progress, stop);
    for (const [index, op] of journal.operations.entries()) assert.ok(matchesObserved(op.path, observe(op.path), index <= stop ? op.after : op.before), op.name);
    assert.ok(existsSync(verifyGeneration(f.root, journal.generation)));
    await assert.rejects(applyStagedActivation(f.prepared), /unresolved activation journal/);
  }
});
test('stale target and receipt plans refuse before journal/path writes, preserving external edits', async t => {
  for (const target of ['.cursor/agents/replace.md', '.pstack/install.json']) {
    const f = compact(t); writeFileSync(join(f.root, target), 'external edit');
    await assert.rejects(applyStagedActivation(f.prepared), /changed after planning/);
    assert.equal(readFileSync(join(f.root, target), 'utf8'), 'external edit'); assert.equal(existsSync(join(f.root, journalName)), false);
  }
});
test('mandatory discovery failure or diagnostic exception restores the prior installation and never reports success', async t => {
  for (const diagnose of [async () => ({ findings: [], discovery: { status: 'failed', probes: [{ status: 'failed' }] } }), () => { throw new Error('diagnostic broke'); }]) {
    const f = compact(t), result = await applyStagedActivation(f.prepared, { diagnose });
    assert.equal(result.status, 'verification-failed-restored'); assert.equal(result.restored, true);
    assert.equal(existsSync(join(f.root, journalName)), false);
    assert.equal(readFileSync(join(f.root, '.cursor/agents/replace.md'), 'utf8'), 'old');
    assert.ok(existsSync(verifyGeneration(f.root, f.generation)));
  }
});
test('IPC acknowledgment supports a real process kill after stable-link mutation with truthful durable progress', { timeout: 20000 }, async t => {
  const f = fixture(t), child = fork(join(source, 'tests/fixtures/activation-child.mjs'), [], { env: f.options.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes);
  child.on('message', message => { if (message.boundary === 'mutation:0') child.kill('SIGKILL'); else if (message.boundary) child.send('continue'); });
  child.send({ source, root: f.root, globalRoot: f.home });
  const [code, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', stderr); assert.equal(code, null);
  const journal = JSON.parse(readFileSync(join(f.root, journalName))); assert.equal(journal.state, 'applying'); assert.equal(journal.progress, 0); assert.equal(journal.operations[0].name, '.pstack/package');
  assert.ok(matchesObserved(journal.operations[0].path, observe(journal.operations[0].path), journal.operations[0].after));
  assert.equal(existsSync(join(f.root, '.pstack/install.json')), false);
  const lockPath = safePath(f.root, '.pstack/mutation.lock'), lock = inspectInstallationLock(lockPath); assert.equal(lock.status, 'dead'); recoverInstallationLock(lockPath, lock.owner.token);
  assert.equal(inspectInstallationLock(lockPath).status, 'absent');
});

test('activation can lock both old and new external roots, preventing another scope from editing either', async t => {
  const f = fixture(t), other = fixture(t), oldRoot = join(f.base, 'old-config/opencode'), newRoot = join(f.base, 'new-config/opencode');
  await withInstallationMutation({ root: f.root, opencodeRoots: [oldRoot, newRoot, oldRoot] }, async () => {
    for (const opencodeRoot of [oldRoot, newRoot]) await assert.rejects(withInstallationMutation({ root: other.root, opencodeRoot }, () => assert.fail('contender mutated')), /Installation busy/);
  });
  for (const root of [oldRoot, newRoot]) assert.equal(inspectInstallationLock(join(root, '.pstack-mutation.lock')).status, 'absent');
});

test('cleanup failure after commit preserves the successful installation and original error until recovery retries', async t => {
  const f = compact(t);
  const instruction = join(f.root, '.pstack/recovery.txt');
  let committedReceipt, recoveryInstruction;
  const result = await applyStagedActivation(f.prepared, {
    boundary: (name, journal) => {
      if (name === 'cleanup') {
        committedReceipt = readFileSync(join(f.root, '.pstack/install.json'));
        recoveryInstruction = journal.recoveryInstruction;
        writeFileSync(instruction, 'user changed recovery instructions');
      }
    }
  });
  assert.equal(result.status, 'applied');
  assert.equal(result.changed, true);
  assert.equal(result.cleanupPending, true);
  assert.equal(result.cleanupError, `Recovery instruction changed; preserve ${instruction}`);
  assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), committedReceipt);
  assert.equal(readFileSync(join(f.root, '.cursor/agents/replace.md'), 'utf8'), 'new');
  assert.equal(readFileSync(instruction, 'utf8'), 'user changed recovery instructions');
  assert.equal(JSON.parse(readFileSync(join(f.root, '.pstack/activation-completed.json'))).state, 'committed');
  const { recoverInstallation } = await import('../scripts/lib/installation-recovery.mjs');
  writeFileSync(instruction, recoveryInstruction + '\n');
  const recovered = await recoverInstallation(f.root);
  assert.equal(recovered.status, 'committed-cleanup');
  assert.equal(recovered.restored, false);
  assert.equal(existsSync(instruction), false);
  assert.equal(existsSync(join(f.root, '.pstack/activation-completed.json')), false);
  assert.deepEqual(readFileSync(join(f.root, '.pstack/install.json')), committedReceipt);
});

test('preparation rejects modified retained model code before importing it', async t => {
  const f = fixture(t);
  const generation = stagePackage({ source, root: f.root });
  const model = join(f.root, generation.name, 'skills/pstack-runtime/scripts/models.mjs');
  const marker = join(f.root, 'unverified-code-executed');
  writeFileSync(model, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nexport function loadModelConfig() {}\n`);
  await assert.rejects(prepareStagedActivation(f.options), /Stored package digest mismatch/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(f.root, '.pstack/install.json')), false);
});
test('recovery notification is awaited after durable instruction and before activation; direct library calls are silent', async t => {
  const f = compact(t), before = f.prepared.plan.operations.map(op => observe(op.path));
  let delivered = false, notified = false;
  const originalLog = console.log, originalError = console.error, output = [];
  console.log = (...args) => output.push(args); console.error = (...args) => output.push(args);
  try {
    await applyStagedActivation(f.prepared, {
      onRecoveryReady: async command => {
        notified = true;
        const journal = JSON.parse(readFileSync(join(f.root, journalName)));
        assert.equal(journal.state, 'prepared'); assert.equal(journal.recoveryInstruction, command);
        assert.equal(readFileSync(join(f.root, '.pstack/recovery.txt'), 'utf8'), command + '\n');
        assert.deepEqual(f.prepared.plan.operations.map(op => observe(op.path)), before);
        await new Promise(resolve => setImmediate(resolve)); delivered = true;
      },
      boundary: name => { if (name === 'prepared') assert.equal(delivered, true); }
    });
    assert.equal(notified, true);
    const silent = compact(t); await applyStagedActivation(silent.prepared);
    assert.deepEqual(output, []);
  } finally { console.log = originalLog; console.error = originalError; }
});
