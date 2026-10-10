#!/usr/bin/env node
// Contributor coordination only. This is not part of the installed pstack lifecycle.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf8', timeout: 60000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

export function claimRef(key) {
  if (!/^(issue-[1-9][0-9]*|task-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(key || '') || key.length > 100) {
    throw new Error('Use issue-N for an existing issue, or task-short-description for work without an issue.');
  }
  return `refs/heads/claims/${key}`;
}

export function remoteClaim(cwd, remote, key) {
  const ref = claimRef(key);
  const result = git(cwd, ['ls-remote', '--refs', remote, ref]);
  return result ? result.split(/\s+/)[0] : null;
}

export function acquire(cwd, remote, key, owner, announce = () => {}) {
  const ref = claimRef(key);
  if (!owner || owner.length > 200 || /[\r\n\x00-\x1f]/.test(owner)) {
    throw new Error('Supply a short owner description identifying this local agent session.');
  }
  const existing = remoteClaim(cwd, remote, key);
  if (existing) throw new Error(`Already claimed: ${key} ${existing}. Inspect status; do not start duplicate work.`);
  const base = git(cwd, ['ls-remote', '--refs', remote, 'refs/heads/main']).split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('Cannot resolve remote main. No claim acquired.');
  git(cwd, ['fetch', '--no-tags', remote, base]);
  const tree = git(cwd, ['rev-parse', `${base}^{tree}`]);
  const metadata = { key, owner, session: randomUUID(), createdAt: new Date().toISOString(), base };
  const token = git(cwd, ['-c', 'user.name=Pstack task claim', '-c', 'user.email=task-claim@localhost',
    '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', base], `${JSON.stringify(metadata)}\n`);
  // Announce before the network operation: a lost response can be resolved with verify.
  announce({ ...metadata, token });
  // Empty expected value requires an absent ref, even if another clone wins after our read.
  git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:`, remote, `${token}:${ref}`]);
  return token;
}

export function verify(cwd, remote, key, token) {
  if (!/^[0-9a-f]{40}$/.test(token || '')) throw new Error('Supply the exact 40-character token printed by acquire.');
  const actual = remoteClaim(cwd, remote, key);
  if (actual !== token) throw new Error(`Claim is not yours: ${key}; current token: ${actual || 'none'}. Stop edits and hand off.`);
}

export function release(cwd, remote, key, token) {
  verify(cwd, remote, key, token);
  const ref = claimRef(key);
  // Compare-and-delete prevents a delayed release from deleting a replacement claim.
  git(cwd, ['push', '--porcelain', `--force-with-lease=${ref}:${token}`, remote, `:${ref}`]);
}

export function forkRemote(cwd) {
  const urls = git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']).split('\n');
  if (urls.length !== 1 || !/^(git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)drewt5\/cursor-plugins(?:\.git)?$/.test(urls[0])) {
    throw new Error('origin must have one push URL pointing to drewt5/cursor-plugins on github.com. No remote changed.');
  }
  return urls[0];
}

function main(args) {
  const [command, key, value] = args;
  if (command === '--help') {
    console.log('Usage: node pstack/scripts/task-claim.mjs acquire KEY "local session description"\n       node pstack/scripts/task-claim.mjs status KEY\n       node pstack/scripts/task-claim.mjs verify KEY TOKEN\n       node pstack/scripts/task-claim.mjs release KEY TOKEN\nKEY: issue-N, or task-short-description when no issue exists. See pstack/docs/task-claims.md.');
    return;
  }
  if (!['acquire', 'status', 'verify', 'release'].includes(command) || args.length !== (command === 'status' ? 2 : 3)) {
    throw new Error('Invalid arguments. Run with --help.');
  }
  claimRef(key);
  const cwd = process.cwd();
  const remote = forkRemote(cwd);
  if (command === 'acquire') {
    acquire(cwd, remote, key, value, metadata => console.log(`Claim candidate (save token; ownership requires success or verify):\n${JSON.stringify(metadata, null, 2)}`));
    console.log('Claim acquired. You may start the task.');
  } else if (command === 'status') {
    const token = remoteClaim(cwd, remote, key);
    if (!token) { console.log('Unclaimed. Acquire before starting; this observation is not a reservation.'); return; }
    git(cwd, ['fetch', '--no-tags', remote, token]);
    console.log(`${key} ${token}\n${git(cwd, ['show', '-s', '--format=%B', token])}`);
  } else if (command === 'verify') {
    verify(cwd, remote, key, value);
    console.log('Claim verified.');
  } else {
    release(cwd, remote, key, value);
    console.log('Claim released.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(`Task claim failed: ${error.message}\nDo not assume ownership after a failure. If acquisition lost its response, verify the printed candidate token.`);
    process.exitCode = 1;
  }
}
