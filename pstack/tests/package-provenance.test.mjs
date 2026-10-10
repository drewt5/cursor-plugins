import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageDigest, readSourceProvenance, validateProvenance } from '../scripts/lib/package-provenance.mjs';
import { stateFrom } from '../scripts/lib/installation-state.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'pstack-provenance-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
function git(root, args) { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); }
function repository(t) {
  const root = fixture(t), source = join(root, 'pstack'); mkdirSync(source);
  git(root, ['init', '-q']); git(root, ['config', 'user.email', 'fixture@localhost']); git(root, ['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'unrelated'), 'other plugin'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'upstream']); const upstreamCommit = git(root, ['rev-parse', 'HEAD']);
  writeFileSync(join(source, 'release.json'), JSON.stringify({ schemaVersion: 1, version: '1.2.3', upstreamCommit })); writeFileSync(join(source, 'payload'), 'one'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'portable']);
  return { root, source };
}
test('source identity distinguishes tagged, untagged, tracked/untracked/ignored dirty content and unrelated monorepo changes', t => {
  const f = repository(t); let p = readSourceProvenance(f.source); assert.equal(p.classification, 'development'); assert.equal(p.dirty, false); assert.equal(p.sourceCommit, git(f.root, ['rev-parse', 'HEAD']));
  git(f.root, ['tag', 'pstack-v1.2.3']); p = readSourceProvenance(f.source); assert.equal(p.classification, 'release');
  writeFileSync(join(f.root, 'unrelated'), 'outside change'); assert.deepEqual(readSourceProvenance(f.source), p);
  writeFileSync(join(f.source, 'payload'), 'changed'); assert.equal(readSourceProvenance(f.source).classification, 'development'); assert.equal(readSourceProvenance(f.source).dirty, true); writeFileSync(join(f.source, 'payload'), 'one');
  writeFileSync(join(f.source, 'new-file'), 'untracked'); assert.equal(readSourceProvenance(f.source).dirty, true); rmSync(join(f.source, 'new-file'));
  writeFileSync(join(f.root, '.gitignore'), 'pstack/ignored-payload\n'); writeFileSync(join(f.source, 'ignored-payload'), 'included ignored content'); assert.equal(readSourceProvenance(f.source).dirty, true); rmSync(join(f.source, 'ignored-payload'));
  mkdirSync(join(f.source, 'node_modules')); writeFileSync(join(f.source, 'node_modules/cache'), 'excluded'); assert.equal(readSourceProvenance(f.source).classification, 'release');
});
test('equivalent trees share deterministic digests while bytes/modes change them; metadata/cache/state do not self-hash', t => {
  const f = repository(t), clone = join(f.root, 'archive'); cpSync(f.source, clone, { recursive: true }); const original = packageDigest(f.source); assert.equal(packageDigest(clone), original);
  writeFileSync(join(clone, 'payload'), 'two'); assert.notEqual(packageDigest(clone), original); writeFileSync(join(clone, 'payload'), 'one'); chmodSync(join(clone, 'payload'), 0o755); assert.notEqual(packageDigest(clone), original); chmodSync(join(clone, 'payload'), 0o644);
  writeFileSync(join(clone, 'pstack-provenance.json'), 'excluded detached output'); mkdirSync(join(clone, '.pstack')); writeFileSync(join(clone, '.pstack/journal.json'), 'excluded'); writeFileSync(join(clone, 'debug.log'), 'excluded'); assert.equal(packageDigest(clone), original);
});
test('git-less archives retain unknown source or verify untrusted supplied metadata and reject mismatched digest', t => {
  const f = repository(t), archive = join(fixture(t), 'archive'); cpSync(f.source, archive, { recursive: true }); let p = readSourceProvenance(archive); assert.equal(p.sourceCommit, null); assert.equal(p.classification, 'development'); assert.equal(p.dirty, null);
  git(f.root, ['tag', 'pstack-v1.2.3']); const official = readSourceProvenance(f.source); writeFileSync(join(archive, 'pstack-provenance.json'), JSON.stringify(official)); p = readSourceProvenance(archive); assert.equal(p.sourceCommit, official.sourceCommit); assert.equal(p.packageDigest, official.packageDigest); assert.equal(p.evidence, 'supplied-metadata-content-match-untrusted');
  writeFileSync(join(archive, 'payload'), 'tampered'); assert.throws(() => readSourceProvenance(archive), /does not match/);
});
test('legacy receipts remain read-only and unknown, future schema cannot mutate, and doctor retains installed identity after source disappears', t => {
  const root = fixture(t), source = join(root, 'source'), project = join(root, 'project'), home = join(root, 'home'); mkdirSync(project); mkdirSync(home);
  cpSync(fileURLToPath(new URL('..', import.meta.url)), source, { recursive: true, filter: path => !path.split('/').includes('node_modules') });
  const env = withHostVersionFixtures(root, { HOME: home, PATH: '' });
  const run = (script, args, base = source) => spawnSync(process.execPath, [join(base, 'scripts', script + '.mjs'), '--project', project, ...args], { env, encoding: 'utf8' });
  assert.equal(run('install', ['--target', 'cursor']).status, 0);
  const receipt = join(project, '.pstack/install.json'), first = readFileSync(receipt, 'utf8'), state = JSON.parse(first); assert.equal(state.version, 3); assert.match(state.provenance.packageDigest, /^[a-f0-9]{64}$/);
  assert.equal(run('install', ['--target', 'cursor']).status, 0); assert.equal(readFileSync(receipt, 'utf8'), first);
  renameSync(source, join(root, 'source-moved')); const installed = join(project, '.pstack/package'); let result = run('doctor', ['--json'], installed); assert.equal(result.status, 0, result.stderr); let report = JSON.parse(result.stdout); assert.equal(report.provenance.packageDigest, state.provenance.packageDigest); assert.equal(report.provenance.status, 'matches-recorded-payload');
  writeFileSync(join(installed, 'README.md'), 'local edit'); result = run('doctor', ['--json'], installed); assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).provenance.classification, 'modified');
  for (const version of [1, 2]) {
    const legacy = { ...state, version }; delete legacy.provenance; delete legacy.hostObservations; if (version === 1) { legacy.target = 'cursor'; delete legacy.targets; }
    legacy.provenance = { classification: 'release', environment: 'legacy-metadata-marker' }; legacy.hostObservations = [{ environment: 'legacy-metadata-marker' }];
    writeFileSync(receipt, JSON.stringify(legacy)); const before = readFileSync(receipt, 'utf8'); assert.equal(stateFrom(receipt).targets[0], 'cursor'); result = run('doctor', ['--json'], installed); assert.equal(JSON.parse(result.stdout).provenance.status, 'unknown'); assert.ok(!result.stdout.includes('legacy-metadata-marker')); assert.equal(readFileSync(receipt, 'utf8'), before);
  }
  writeFileSync(join(installed, 'README.md'), readFileSync(join(root, 'source-moved/README.md')));
  for (const version of [1, 2]) {
    const legacy = { ...JSON.parse(readFileSync(receipt)), version }; delete legacy.provenance; delete legacy.hostObservations; if (version === 1) { legacy.target = 'cursor'; delete legacy.targets; }
    writeFileSync(receipt, JSON.stringify(legacy)); result = run('install', ['--target', 'cursor'], installed); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(readFileSync(receipt)).version, 3);
    assert.equal(JSON.parse(readFileSync(receipt)).entries['.pstack/package/README.md'].hash, state.entries['.pstack/package/README.md'].hash);
  }
  writeFileSync(join(installed, 'README.md'), 'local edit');
  writeFileSync(receipt, JSON.stringify({ ...state, version: 999 })); const before = readFileSync(receipt, 'utf8'); result = run('uninstall', [], installed); assert.equal(result.status, 1); assert.equal(readFileSync(receipt, 'utf8'), before); assert.equal(readFileSync(join(installed, 'README.md'), 'utf8'), 'local edit');
});

test('provenance never accepts unrelated metadata fields into installed evidence', t => {
  const f = repository(t), p = readSourceProvenance(f.source);
  assert.throws(() => validateProvenance({ ...p, environment: { SECRET: 'excluded' } }), /Invalid installed provenance/);
});
