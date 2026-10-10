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
