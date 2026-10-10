import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/poteto-mode/scripts/worktree-audit.sh');
test('audit handles worktree paths with spaces and does not clear a closed unmerged PR', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pstack audit '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  const branch = join(dir, 'work tree');
  const bin = join(dir, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  const git = args => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  git(['-c', 'user.name=Pstack test', '-c', 'user.email=pstack@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'initial']);
  git(['worktree', 'add', '-q', '-b', 'candidate', branch]);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'jq'), '#!/bin/sh\necho "#1/CLOSED"\n', { mode: 0o755 });
  const result = spawnSync('bash', [script, repo], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PSTACK_TRANSCRIPTS_DIR: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  const row = lines[1].split('\t');
  assert.equal(row[5], '#1/CLOSED');
  assert.equal(row[6], '-');
  assert.equal(row[7], 'review');
  assert.equal(row[8], realpathSync(branch));
});


test('transcript activity supports spaces and does not match a longer worktree name', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pstack history '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'one chat.jsonl'), '{"cwd":"/work/my tree"}');
  const helper = join(dirname(script), 'transcript-activity.mjs');
  const run = wt => spawnSync(process.execPath, [helper, dir, wt], { encoding: 'utf8' });
  const found = run('/work/my tree');
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /^[1-9][0-9]*\t[0-9]{4}-[0-9]{2}-[0-9]{2}/);
  assert.equal(run('/work/my').stdout, '0\t-\n');
});
