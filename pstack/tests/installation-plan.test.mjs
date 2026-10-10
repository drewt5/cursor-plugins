import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installationSnapshot, digest, observe } from '../scripts/lib/installation-state.mjs';
import { planInstallation, applyInstallation } from '../scripts/lib/installation-plan.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = new Map([['.pstack/package/example', 'new content']]);
  const state = { version: 2, targets: ['codex'], opencodeRoot: '.opencode', entries: {
    '.pstack/package/example': { kind: 'file', hash: digest('new content'), mode: 0o755 },
    '.agents/skills/example': { kind: 'link', to: '../../.pstack/package/example' },
  } };
  const artifacts = { contents, state };
  return { root, artifacts, plan: () => planInstallation(installationSnapshot({ root, desired: state }), artifacts) };
}
test('applying a plan produces exactly the intended files, modes and links and preserves user state', t => {
  const { root, plan } = fixture(t);
  writeFileSync(join(root, 'user'), 'user bytes'); chmodSync(join(root, 'user'), 0o600);
  symlinkSync('user', join(root, 'user-link'));
  const user = [observe(join(root, 'user')), observe(join(root, 'user-link'))];
  const first = plan();
  assert.deepEqual(first.operations.map(op => op.action), ['create', 'create']);
  applyInstallation(first);
  for (const op of first.operations) {
    const actual = observe(op.path);
    if (op.intended.kind === 'link') assert.equal(actual.to, op.intended.to);
    else assert.deepEqual(actual, op.intended);
  }
  assert.deepEqual([observe(join(root, 'user')), observe(join(root, 'user-link'))], user);
  assert.deepEqual(plan().operations.map(op => op.action), ['unchanged', 'unchanged']);
  const empty = { state: { version: 2, targets: [], entries: {} }, contents: new Map() };
  const removal = planInstallation(installationSnapshot({ root, desired: empty.state }), empty);
  assert.ok(removal.operations.every(op => op.action === 'remove'));
  applyInstallation(removal);
  assert.deepEqual([observe(join(root, 'user')), observe(join(root, 'user-link'))], user);
  assert.equal(observe(join(root, '.pstack/install.json')).kind, 'absent');
});
test('preview is read-only and collects every conflict in deterministic order', t => {
  const { root, plan } = fixture(t);
  mkdirSync(join(root, '.pstack/package'), { recursive: true });
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  writeFileSync(join(root, '.pstack/package/example'), 'other package');
  writeFileSync(join(root, '.agents/skills/example'), 'other skill');
  const before = [observe(join(root, '.pstack/package/example')), observe(join(root, '.agents/skills/example'))];
  const result = plan();
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.conflicts.map(op => op.path), [...result.conflicts.map(op => op.path)].sort());
  assert.throws(() => applyInstallation(result), /Install conflict/);
  assert.deepEqual([observe(join(root, '.pstack/package/example')), observe(join(root, '.agents/skills/example'))], before);
  assert.equal(observe(join(root, '.pstack/install.json')).kind, 'absent');
});
test('apply refuses changes made after inspection before writing any artifact', t => {
  const { root, plan } = fixture(t);
  const result = plan();
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/example'), 'arrived after preview');
  assert.throws(() => applyInstallation(result), /changed after planning/);
  assert.equal(observe(join(root, '.pstack/package/example')).kind, 'absent');
  assert.equal(readFileSync(join(root, '.agents/skills/example'), 'utf8'), 'arrived after preview');
});
test('unsafe manifest paths and malformed receipts fail before destination mutation', t => {
  const { root, plan } = fixture(t);
  mkdirSync(join(root, '.pstack'));
  const statePath = join(root, '.pstack/install.json');
  for (const value of ['{}', JSON.stringify({ version: 2, targets: [], entries: { '../escape': { kind: 'file', hash: digest('x') } } })]) {
    writeFileSync(statePath, value);
    assert.throws(plan);
    assert.equal(readFileSync(statePath, 'utf8'), value);
    assert.equal(observe(join(root, '.agents')).kind, 'absent');
  }
});
test('identical unowned files and symlinks are never adopted or removed by absent uninstall', t => {
  const { root, artifacts, plan } = fixture(t);
  mkdirSync(join(root, '.pstack/package'), { recursive: true });
  mkdirSync(join(root, '.agents/skills'), { recursive: true });
  writeFileSync(join(root, '.pstack/package/example'), 'new content');
  chmodSync(join(root, '.pstack/package/example'), 0o755);
  symlinkSync('../../.pstack/package/example', join(root, '.agents/skills/example'));
  const before = [observe(join(root, '.pstack/package/example')), observe(join(root, '.agents/skills/example'))];
  const result = plan();
  assert.equal(result.conflicts.length, 2);
  assert.ok(result.conflicts.every(op => op.code === 'unowned' && op.ownership === 'unowned'));
  assert.throws(() => applyInstallation(result), /cannot be adopted/);
  assert.equal(observe(join(root, '.pstack/install.json')).kind, 'absent');
  const empty = { state: { version: 2, targets: [], entries: {} }, contents: new Map() };
  applyInstallation(planInstallation(installationSnapshot({ root, desired: empty.state }), empty));
  assert.deepEqual([observe(join(root, '.pstack/package/example')), observe(join(root, '.agents/skills/example'))], before);
  assert.equal(artifacts.state.targets[0], 'codex');
});
test('managed edits remain conflicts even if they happen to match the requested new source', t => {
  const { root, artifacts, plan } = fixture(t);
  applyInstallation(plan());
  writeFileSync(join(root, '.pstack/package/example'), 'user edit');
  artifacts.state.entries['.pstack/package/example'].hash = digest('user edit');
  artifacts.contents.set('.pstack/package/example', 'user edit');
  const update = plan();
  assert.equal(update.conflicts[0].code, 'modified-owned');
  assert.throws(() => applyInstallation(update), /Locally modified/);
  assert.equal(readFileSync(join(root, '.pstack/package/example'), 'utf8'), 'user edit');
  const empty = { state: { version: 2, targets: [], entries: {} }, contents: new Map() };
  const uninstall = planInstallation(installationSnapshot({ root, desired: empty.state }), empty);
  assert.throws(() => applyInstallation(uninstall), /Locally modified/);
  assert.equal(readFileSync(join(root, '.pstack/package/example'), 'utf8'), 'user edit');
  assert.equal(observe(join(root, '.agents/skills/example')).kind, 'link');
});
test('unsafe parents and wrong kinds in separate host directories are reported together without following links', t => {
  const { root, artifacts, plan } = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'pstack-unowned-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'sentinel'), 'outside');
  symlinkSync(outside, join(root, '.agents'));
  mkdirSync(join(root, '.claude/skills/other'), { recursive: true });
  artifacts.state.entries['.claude/skills/other'] = { kind: 'link', to: '../../.pstack/package/example' };
  const result = plan();
  assert.deepEqual(result.conflicts.map(op => op.code), ['unsafe-parent', 'wrong-path-kind']);
  assert.ok(result.conflicts.every(op => op.attempted === 'replace' && op.reason.includes('project')));
  assert.throws(() => applyInstallation(result));
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside');
  assert.equal(observe(join(outside, 'skills')).kind, 'absent');
  assert.equal(observe(join(root, '.pstack/package/example')).kind, 'absent');
});
