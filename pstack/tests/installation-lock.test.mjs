import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInstallationMutation, inspectInstallationLock, recoverInstallationLock } from '../scripts/lib/installation-lock.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-lock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function worker(t, root, output) {
  const child = fork(new URL('./fixtures/lock-worker.mjs', import.meta.url), [root, ...(output ? [output] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const message = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`Worker exited early: ${code}`); })]);
  assert.equal(message[0].ready, true);
  return child;
}
test('one scope has one writer while independent projects can mutate concurrently', { timeout: 10000 }, async t => {
  const root = fixture(t), other = fixture(t), child = await worker(t, root);
  const lock = join(root, '.pstack/mutation.lock');
  assert.equal(inspectInstallationLock(lock).status, 'active');
  let entered = false;
  await assert.rejects(withInstallationMutation({ root }, () => { entered = true; }), /Installation busy \(active\)/);
  assert.equal(entered, false);
  await withInstallationMutation({ root: other }, () => { entered = true; });
  assert.equal(entered, true);
  const exit = once(child, 'exit'); child.send({ apply: true }); await exit;
  assert.equal(inspectInstallationLock(lock).status, 'absent');
});
test('scope aliases and shared external OpenCode roots cannot bypass locks', { timeout: 10000 }, async t => {
  const root = fixture(t), other = fixture(t), output = fixture(t), aliasParent = fixture(t);
  const alias = join(aliasParent, 'scope'); symlinkSync(root, alias);
  const child = await worker(t, root, output);
  await assert.rejects(withInstallationMutation({ root: alias }, () => assert.fail('alias bypassed lock')), /Installation busy/);
  await assert.rejects(withInstallationMutation({ root: other, opencodeRoot: output }, () => assert.fail('shared output bypassed lock')), /Installation busy/);
  assert.equal(inspectInstallationLock(join(other, '.pstack/mutation.lock')).status, 'absent', 'partial acquisition must release its own lock');
  const exit = once(child, 'exit'); child.send({ apply: true }); await exit;
});
test('error releases owned locks; process crash preserves a token-identified recoverable lock', { timeout: 10000 }, async t => {
  const root = fixture(t), lock = join(root, '.pstack/mutation.lock');
  await assert.rejects(withInstallationMutation({ root }, () => { throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(inspectInstallationLock(lock).status, 'absent');
  const child = await worker(t, root);
  const owner = JSON.parse(readFileSync(lock, 'utf8'));
  assert.throws(() => recoverInstallationLock(lock, owner.token), /Cannot recover.*active/);
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
  assert.equal(inspectInstallationLock(lock).status, 'dead');
  assert.throws(() => recoverInstallationLock(lock, 'incorrect'), /Cannot recover/);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).token, owner.token);
  recoverInstallationLock(lock, owner.token);
  await withInstallationMutation({ root }, () => {});
  assert.equal(inspectInstallationLock(lock).status, 'absent');
});
test('malformed owner data remains unverifiable and is never deleted', async t => {
  const root = fixture(t), lock = join(root, '.pstack/mutation.lock');
  mkdirSync(join(root, '.pstack')); writeFileSync(lock, '{invalid');
  assert.equal(inspectInstallationLock(lock).status, 'unknown');
  assert.throws(() => recoverInstallationLock(lock, 'token'), /unknown/);
  await assert.rejects(withInstallationMutation({ root }, () => assert.fail('invalid lock was ignored')), /Installation busy \(unknown\)/);
  assert.equal(readFileSync(lock, 'utf8'), '{invalid');
});

test('explicit normal process exit releases its owned lock', { timeout: 10000 }, async t => {
  const root = fixture(t), child = await worker(t, root);
  const exit = once(child, 'exit'); child.send({ exit: true }); await exit;
  assert.equal(inspectInstallationLock(join(root, '.pstack/mutation.lock')).status, 'absent');
});
