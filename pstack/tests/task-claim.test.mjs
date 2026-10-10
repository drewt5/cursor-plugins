import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { acquire, release, verify, remoteClaim, git, claimRef, forkRemote } from '../scripts/task-claim.mjs';

const moduleUrl = new URL('../scripts/task-claim.mjs', import.meta.url).href;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-claim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  git(root, ['init', '--bare', remote]);
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a);
  git(a, ['init', '-b', 'main']);
  git(a, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base']);
  git(a, ['remote', 'add', 'origin', remote]);
  git(a, ['push', 'origin', 'main']);
  git(root, ['clone', '-b', 'main', remote, b]);
  return { root, remote, a, b };
}

test('claims coordinate separate clones without changing their branches or working trees', t => {
  const { remote, a, b } = fixture(t);
  const original = git(a, ['rev-parse', 'HEAD']);
  const token = acquire(a, remote, 'issue-4', 'Codex local session A');
  assert.equal(remoteClaim(b, remote, 'issue-4'), token);
  verify(b, remote, 'issue-4', token);
  assert.throws(() => acquire(b, remote, 'issue-4', 'Claude local session B'), /Already claimed/);
  assert.throws(() => release(b, remote, 'issue-4', '0'.repeat(40)), /not yours/);
  assert.equal(remoteClaim(a, remote, 'issue-4'), token);
  release(a, remote, 'issue-4', token);
  assert.equal(remoteClaim(b, remote, 'issue-4'), null);
  const next = acquire(b, remote, 'issue-4', 'replacement session');
  assert.notEqual(next, token);
  assert.throws(() => release(a, remote, 'issue-4', token), /not yours/);
  // Exercise the server-side lease too, as if replacement happened after release's read.
  assert.throws(() => git(a, ['push', `--force-with-lease=refs/heads/claims/issue-4:${token}`, remote, ':refs/heads/claims/issue-4']));
  assert.equal(remoteClaim(b, remote, 'issue-4'), next);
  assert.equal(git(a, ['rev-parse', 'HEAD']), original);
  assert.equal(git(a, ['status', '--porcelain']), '');
  assert.equal(git(b, ['status', '--porcelain']), '');
});

test('two contenders pass the initial read but exactly one atomic creation wins', { timeout: 20000 }, async t => {
  const { remote, a, b } = fixture(t);
  const contenders = [a, b].map(cwd => {
    const code = `import { acquire } from ${JSON.stringify(moduleUrl)};
      import { readSync } from 'node:fs';
      try {
        acquire(${JSON.stringify(cwd)}, ${JSON.stringify(remote)}, 'issue-3', 'local contender', () => {
          process.stdout.write('ready\\n');
          readSync(0, Buffer.alloc(1), 0, 1, null);
        });
      } catch { process.exitCode = 1; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
    const ready = new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Contender exited before barrier')));
    });
    return { child, done, ready };
  });
  await Promise.all(contenders.map(c => c.ready));
  for (const c of contenders) c.child.stdin.end('x');
  assert.deepEqual((await Promise.all(contenders.map(c => c.done))).sort(), [0, 1]);
  assert.match(remoteClaim(a, remote, 'issue-3'), /^[0-9a-f]{40}$/);
});

test('invalid keys, unavailable remotes, and incorrect fork destinations fail closed', t => {
  const { root, remote, a } = fixture(t);
  for (const key of ['issue-0', '../main', 'main', 'issue-1:main', 'task-']) assert.throws(() => claimRef(key));
  assert.throws(() => acquire(a, remote, 'issue-1', 'bad\nowner'));
  assert.throws(() => acquire(a, join(root, 'missing'), 'issue-1', 'session'));
  assert.equal(remoteClaim(a, remote, 'issue-1'), null);
  assert.throws(() => forkRemote(a), /origin must/);
  git(a, ['remote', 'set-url', 'origin', 'git@github.com:drewt5/cursor-plugins.git']);
  assert.equal(forkRemote(a), 'git@github.com:drewt5/cursor-plugins.git');
  git(a, ['remote', 'set-url', '--add', '--push', 'origin', 'https://github.com/cursor/plugins.git']);
  assert.throws(() => forkRemote(a), /origin must/);
});
