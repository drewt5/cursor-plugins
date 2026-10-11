import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyRuntimeSource } from './fixtures/runtime-source.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
import { digest } from '../scripts/lib/installation-state.mjs';
import { inspectInstallationLock } from '../scripts/lib/installation-lock.mjs';
import { readActivationJournal } from '../scripts/lib/activation-journal.mjs';

function tree(root) {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [[path, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? digest(readFileSync(path)) : 'directory'], ...(stat.isDirectory() ? tree(path) : [])];
  });
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-public-contention-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = copyRuntimeSource(fileURLToPath(new URL('..', import.meta.url)), join(base, 'source'));
  const root = join(base, 'project'), home = join(base, 'home');
  mkdirSync(root); mkdirSync(home);
  writeFileSync(join(root, 'user.txt'), 'unrelated project content');
  writeFileSync(join(home, 'user.txt'), 'unrelated home content');
  const env = withHostVersionFixtures(base, { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: join(base, 'config') }, ['opencode']);
  const run = (script, args, selectedEnv = env) => spawnSync(process.execPath, [join(source, 'scripts', `${script}.mjs`), ...args], { env: selectedEnv, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  return { base, source, root, home, env, run };
}
function ok(result) { assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stdout + result.stderr); }
async function owner(t, f, root, options) {
  const child = fork(new URL('./fixtures/public-contention-owner.mjs', import.meta.url), [], { env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => output += bytes);
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const ready = once(child, 'message');
  child.send({ source: f.source, root, globalRoot: f.home, options });
  const [message] = await Promise.race([ready, exited.then(([code]) => { throw new Error(`Owner exited before checkpoint (${code}): ${output}`); })]);
  assert.equal(message.ready, true, JSON.stringify(message));
  assert.equal(readActivationJournal(root), null, 'Contenders must exercise their own lock wiring, not journal recovery');
  const lockPath = join(root, '.pstack/mutation.lock');
  const assertOwner = () => {
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    const lock = inspectInstallationLock(lockPath);
    assert.equal(lock.status, 'active'); assert.equal(lock.owner.pid, child.pid); assert.equal(lock.owner.token, message.token);
  };
  assertOwner();
  return { assertOwner, finish: async () => {
    const done = once(child, 'message'); child.send('continue');
    const [message] = await done; assert.equal(message.done, 'applied', JSON.stringify(message));
    const [code, signal] = await exited; assert.equal(signal, null); assert.equal(code, 0, output);
    assert.equal(inspectInstallationLock(lockPath).status, 'absent');
  } };
}
function refused(result, expectedLock) {
  assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Installation busy \(active\)/);
  assert.ok(result.stderr.includes(expectedLock), result.stderr);
}

test('public install, rollback and uninstall refuse a live scope owner through canonical aliases without writes', { timeout: 30000 }, async t => {
  const f = fixture(t), args = ['--project', f.root];
  ok(f.run('install', [...args, '--target', 'cursor']));
  writeFileSync(join(f.source, 'README.md'), 'second selected release');
  ok(f.run('install', [...args, '--target', 'cursor']));
  writeFileSync(join(f.source, 'README.md'), 'third selected release');
  const alias = join(f.base, 'alias'); symlinkSync(f.root, alias);
  const held = await owner(t, f, f.root, { target: 'cursor' });
  const before = tree(f.root), homeBefore = tree(f.home);
  for (const [script, extra] of [['install', ['--target', 'cursor']], ['rollback', []], ['uninstall', []]]) {
    refused(f.run(script, ['--project', alias, ...extra]), join(f.root, '.pstack/mutation.lock'));
    assert.deepEqual(tree(f.root), before, `${script} changed destination while owner was live`);
    assert.deepEqual(tree(f.home), homeBefore); held.assertOwner();
  }
  const independent = join(f.base, 'independent'); mkdirSync(independent);
  ok(f.run('install', ['--project', independent, '--target', 'cursor']));
  held.assertOwner(); assert.deepEqual(tree(f.root), before);
  await held.finish();
  ok(f.run('rollback', args)); ok(f.run('uninstall', args));
  assert.equal(readFileSync(join(f.root, 'user.txt'), 'utf8'), 'unrelated project content');
});

test('public global install locks its shared external OpenCode root across distinct homes', { timeout: 30000 }, async t => {
  const f = fixture(t), held = await owner(t, f, f.home, { global: true, target: 'opencode' });
  const otherHome = join(f.base, 'other-home'); mkdirSync(otherHome);
  // Pre-create parent metadata: partial lock acquisition may create this empty
  // directory, but must remove its lock and preserve every existing byte.
  mkdirSync(join(otherHome, '.pstack')); writeFileSync(join(otherHome, 'user.txt'), 'other home');
  const external = join(f.env.XDG_CONFIG_HOME, 'opencode');
  const before = tree(f.home), sharedBefore = tree(external), otherBefore = tree(otherHome);
  refused(f.run('install', ['--global', '--target', 'opencode'], { ...f.env, HOME: otherHome }), join(external, '.pstack-mutation.lock'));
  assert.deepEqual(tree(f.home), before); assert.deepEqual(tree(external), sharedBefore); assert.deepEqual(tree(otherHome), otherBefore);
  assert.equal(inspectInstallationLock(join(otherHome, '.pstack/mutation.lock')).status, 'absent');
  held.assertOwner(); await held.finish();
  assert.equal(inspectInstallationLock(join(external, '.pstack-mutation.lock')).status, 'absent');
  ok(f.run('uninstall', ['--global']));
  assert.equal(readFileSync(join(otherHome, 'user.txt'), 'utf8'), 'other home');
});
