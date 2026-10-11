import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyScopeCatalog, assertScopeObservation, assertIndependentOrigin } from '../scripts/lib/scope-contracts.mjs';
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

test('pinned scope assertions reject changed native classification and origins', t => {
  const f = fixture(t);
  const entries = f.entries.flat();
  const result = { status: 'observed', ...classifyScopeCatalog(entries, f.expected, f.bundles) };
  const check = result => assertScopeObservation({ host: 'codex', scenario: 'both-scopes', result, expected: f.expected, bundles: f.bundles });
  check(result);
  assert.throws(() => check({ ...result, classification: 'identified-source' }));
  assert.throws(() => check({ ...result, entries: result.entries.slice(1) }));
});

test('OpenCode both-scope assertions accept coherent or mixed catalogs, reject corrupt evidence', t => {
  const f = fixture(t), bare = f.entries.map(entries => entries.map(entry => ({ ...entry, name: entry.name.replace('pstack:', '') })));
  const observation = entries => ({ status: 'observed', ...classifyScopeCatalog(entries, f.expected, f.bundles) });
  const check = result => assertScopeObservation({ host: 'opencode', scenario: 'both-scopes', result, expected: f.expected, bundles: f.bundles });
  const project = observation(bare[0]), mixed = observation([bare[0][0], bare[1][1]]);
  check(project); check(mixed);
  // A coherent global result is structurally valid; sampled runs do not establish precedence.
  check(observation(bare[1]));
  for (const result of [
    { ...project, classification: 'ambiguous-sources' },
    { ...mixed, classification: 'identified-source' },
    { ...project, entries: project.entries.slice(1) },
    { ...project, entries: [...project.entries, project.entries[0]] },
    { ...project, entries: [{ ...project.entries[0], origin: project.entries[1].origin }, project.entries[1]] },
    { ...project, entries: [{ ...project.entries[0], origin: '/unknown/SKILL.md' }, project.entries[1]] },
    { ...project, coherentBundle: f.bundles[1] },
    { ...mixed, completeBundles: project.completeBundles },
    { ...project, missing: ['one'] },
    { ...project, unexpected: ['other'] },
    { ...project, independentIdentities: ['one'] },
    { ...observation(bare[1]), coherentBundle: project.coherentBundle },
  ]) assert.throws(() => check(result));
});
test('independent-name assertions prove exact project origins and preserve raw classification', t => {
  const f = fixture(t), independent = join(f.root, 'independent.md'); writeFileSync(independent, 'independent');
  f.expected.push('poteto-mode');
  const poteto = join(f.bundles[0], 'skills/poteto-mode/SKILL.md'); mkdirSync(join(f.bundles[0], 'skills/poteto-mode')); writeFileSync(poteto, 'poteto');
  f.entries[0].push({ name: 'pstack:poteto-mode', path: poteto });
  for (const host of ['codex', 'opencode']) {
    const entries = f.entries[0].map(entry => ({ ...entry, name: host === 'codex' ? entry.name : entry.name.replace('pstack:', '') }));
    if (host === 'codex') entries.push({ name: 'poteto-mode', path: independent });
    const result = { status: 'observed', ...classifyScopeCatalog(entries, f.expected, [f.bundles[0]]) };
    const before = structuredClone(result);
    const check = result => assertScopeObservation({ host, scenario: 'independent-same-name', result, expected: f.expected, bundles: [f.bundles[0]], independent });
    check(result); assert.deepEqual(result, before);
    assert.throws(() => check({ ...result, classification: 'conflicting-registration' }));
    assert.throws(() => check({ ...result, entries: result.entries.map((entry, index) => index ? entry : { ...entry, origin: independent }) }));
  }
  const check = entries => assertIndependentOrigin(entries, independent);
  check([{ name: 'poteto-mode', location: independent }]);
  assert.throws(() => check([]));
  assert.throws(() => check([{ name: 'poteto-mode', location: f.entries[0][0].path }]));
  assert.throws(() => check([{ name: 'poteto-mode', location: independent }, { name: 'poteto-mode', location: independent }]));
});
