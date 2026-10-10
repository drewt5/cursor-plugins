import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8')).version;
const tag = `pstack-v${version}`;
const files = ['package.json', 'plugin.json', '.cursor-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack release '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'pstack');
  mkdirSync(pkg);
  for (const file of ['release.json', ...files, 'scripts/release.mjs', 'scripts/test.mjs', 'scripts/lib/test-environment.mjs']) {
    mkdirSync(dirname(join(pkg, file)), { recursive: true });
    cpSync(join(root, file), join(pkg, file));
  }
  return { dir, pkg, run: (...args) => spawnSync(process.execPath, [join(pkg, 'scripts/release.mjs'), ...args], { encoding: 'utf8' }) };
}
function edit(path, mutate) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutate(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}
function ok(result) { assert.equal(result.status, 0, result.stderr); }
function git(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } });
  ok(result);
  return result.stdout.trim();
}

test('each version consumer reports its mismatch without writes; sync is idempotent', t => {
  const f = fixture(t);
  ok(f.run('--check'));
  for (const file of files) {
    edit(join(f.pkg, file), value => { value.version = '0.0.1'; });
    const before = readFileSync(join(f.pkg, file), 'utf8');
    const result = f.run('--check');
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${file}: expected version ${version}`), result.stderr);
    assert.equal(readFileSync(join(f.pkg, file), 'utf8'), before);
    ok(f.run('--sync'));
    const synced = readFileSync(join(f.pkg, file), 'utf8');
    ok(f.run('--sync'));
    assert.equal(readFileSync(join(f.pkg, file), 'utf8'), synced);
  }
});

test('marketplace versions are checked when present and unrelated entries survive sync', t => {
  const f = fixture(t);
  for (const name of ['.cursor-plugin', '.claude-plugin']) {
    mkdirSync(join(f.dir, name));
    const path = join(f.dir, name, 'marketplace.json');
    writeFileSync(path, JSON.stringify({ plugins: [{ name: 'other', version: '9.0.0' }, { name: 'pstack', version: '0.0.1' }] }, null, 2) + '\n');
    assert.equal(f.run('--check').status, 1);
    assert.ok(f.run('--check').stderr.includes(`${name}/marketplace.json (pstack): expected version ${version}`));
    ok(f.run('--sync'));
    assert.deepEqual(JSON.parse(readFileSync(path)).plugins, [{ name: 'other', version: '9.0.0' }, { name: 'pstack', version }]);
  }
});

test('required portable entry point rejects an isolated manifest mismatch', t => {
  const f = fixture(t);
  edit(join(f.pkg, '.codex-plugin/plugin.json'), value => { value.version = '0.0.1'; });
  const result = spawnSync(process.execPath, [join(f.pkg, 'scripts/test.mjs'), '--unit'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`.codex-plugin/plugin.json: expected version ${version}`), result.stderr);
});

test('release identity validates tag, clean source and upstream ancestry', t => {
  const f = fixture(t);
  git(f.dir, 'init');
  writeFileSync(join(f.dir, 'upstream'), 'original');
  git(f.dir, 'add', 'upstream');
  git(f.dir, 'commit', '-m', 'upstream');
  const upstreamCommit = git(f.dir, 'rev-parse', 'HEAD');
  edit(join(f.pkg, 'release.json'), value => { value.upstreamCommit = upstreamCommit; });
  git(f.dir, 'add', '.');
  git(f.dir, 'commit', '-m', 'portable');
  const sourceCommit = git(f.dir, 'rev-parse', 'HEAD');
  const result = f.run('--release', '--tag', tag);
  ok(result);
  assert.equal(JSON.parse(result.stdout).sourceCommit, sourceCommit);
  assert.equal(JSON.parse(result.stdout).upstreamCommit, upstreamCommit);
  assert.ok(f.run('--release', '--tag', 'wrong-tag').stderr.includes(`expected ${tag}`));
  git(f.dir, 'tag', tag, upstreamCommit);
  assert.match(f.run('--release', '--tag', tag).stderr, /existing tag does not identify source commit/);
  git(f.dir, 'tag', '-d', tag);
  git(f.dir, 'tag', '-a', tag, '-m', 'release');
  ok(f.run('--release', '--tag', tag));
  writeFileSync(join(f.dir, 'local'), 'edit');
  assert.match(f.run('--release', '--tag', tag).stderr, /clean source checkout/);
  rmSync(join(f.dir, 'local'));
  edit(join(f.pkg, 'release.json'), value => { value.upstreamCommit = '0'.repeat(40); });
  assert.match(f.run('--release', '--tag', tag).stderr, /cat-file.*failed/);
  git(f.dir, 'checkout', '--orphan', 'unrelated');
  git(f.dir, 'rm', '-rf', '.');
  writeFileSync(join(f.dir, 'unrelated'), 'separate history');
  git(f.dir, 'add', '.');
  git(f.dir, 'commit', '-m', 'unrelated');
  const unrelated = git(f.dir, 'rev-parse', 'HEAD');
  git(f.dir, 'checkout', '-f', sourceCommit);
  edit(join(f.pkg, 'release.json'), value => { value.upstreamCommit = unrelated; });
  assert.match(f.run('--release', '--tag', tag).stderr, /merge-base.*failed/);
});

test('malformed release metadata is rejected', t => {
  for (const change of [value => { value.version = '01.2.3'; }, value => { value.schemaVersion = 2; }, value => { value.upstreamCommit = 'main'; }]) {
    const f = fixture(t);
    edit(join(f.pkg, 'release.json'), change);
    assert.equal(f.run('--check').status, 1);
  }
});
