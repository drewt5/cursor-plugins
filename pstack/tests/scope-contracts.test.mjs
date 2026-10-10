import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyScopeCatalog } from '../scripts/lib/scope-contracts.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const expected = ['one', 'two'];
  const bundles = ['project', 'global'].map(scope => join(root, scope));
  const entries = bundles.map(bundle => expected.map(name => {
    const path = join(bundle, 'skills', name, 'SKILL.md'); mkdirSync(join(bundle, 'skills', name), { recursive: true }); writeFileSync(path, name);
    return { name: `pstack:${name}`, path };
  }));
  return { root, expected, bundles, entries };
}
test('a coherent catalog identifies its complete bundle through path aliases', t => {
  const f = fixture(t), alias = join(f.root, 'alias'); symlinkSync(f.bundles[0], alias);
  const result = classifyScopeCatalog(f.entries[0], f.expected, [alias]);
  assert.equal(result.classification, 'identified-source');
  assert.ok(result.coherentBundle.endsWith('/project'));
});
test('duplicate and mixed bundles cannot be mislabeled coherent', t => {
  const f = fixture(t);
  assert.equal(classifyScopeCatalog(f.entries.flat(), f.expected, f.bundles).classification, 'ambiguous-sources');
  assert.equal(classifyScopeCatalog([f.entries[0][0], f.entries[1][1]], f.expected, f.bundles).classification, 'ambiguous-sources');
});
test('qualified independent identity coexists while identical registered identity conflicts', t => {
  const f = fixture(t), path = join(f.root, 'independent.md'); writeFileSync(path, 'independent');
  const distinct = classifyScopeCatalog([...f.entries[0], { name: 'one', path }], f.expected, [f.bundles[0]]);
  assert.equal(distinct.classification, 'identified-source');
  assert.deepEqual(distinct.independentIdentities, ['one']);
  assert.equal(classifyScopeCatalog([...f.entries[0], { name: 'pstack:one', path }], f.expected, [f.bundles[0]]).classification, 'conflicting-registration');
});
test('Cursor static project/global installations preserve an independent same-name skill without claiming GUI resolution', t => {
  const f = fixture(t);
  const { env, project, run } = cursorFixture(f.root);
  assert.equal(run(['--project', project]).status, 0);
  assert.equal(run(['--global']).status, 0);
  const independent = join(env.HOME, '.cursor/skills/independent-poteto/SKILL.md');
  mkdirSync(join(env.HOME, '.cursor/skills/independent-poteto'), { recursive: true });
  const content = '---\nname: poteto-mode\ndescription: Independent Cursor fixture\n---\n\nKeep user-owned skill.\n';
  writeFileSync(independent, content);
  assert.equal(run(['--project', project, '--uninstall']).status, 0);
  assert.equal(run(['--global', '--uninstall']).status, 0);
  assert.equal(readFileSync(independent, 'utf8'), content);
});
function cursorFixture(root) {
  const env = isolatedEnvironment(root), project = join(root, 'cursor-project'); mkdirSync(project);
  const installer = new URL('../scripts/install.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(installer), '--target', 'cursor', ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { env, project, run };
}
