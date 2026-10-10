import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stagePackage, verifyGeneration, renderStagedArtifacts } from '../scripts/lib/installation-storage.mjs';
import { packageInventory } from '../scripts/lib/package-provenance.mjs';
import { safePath } from '../scripts/lib/installation-state.mjs';
const original = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-storage-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source'), root = join(base, 'project'); mkdirSync(root);
  cpSync(original, source, { recursive: true, filter: path => !path.split('/').includes('node_modules') && !path.endsWith('/.git') });
  return { base, source, root };
}
test('staging verifies and reuses complete bytes/modes without activation or receipt publication', async t => {
  const { source, root } = fixture(t); mkdirSync(join(root, '.pstack')); writeFileSync(join(root, '.pstack/install.json'), 'receipt sentinel');
  const first = stagePackage({ source, root }), second = stagePackage({ source, root });
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(first.digest, second.digest);
  assert.deepEqual(packageInventory(verifyGeneration(root, first)), packageInventory(source));
  assert.equal(readFileSync(join(root, '.pstack/install.json'), 'utf8'), 'receipt sentinel'); assert.equal(existsSync(join(root, '.pstack/package')), false);
  writeFileSync(join(root, first.name, 'README.md'), 'modified');
  assert.throws(() => stagePackage({ source, root }), /digest mismatch/);
});
test('failed writes, corrupt copies, unsafe parents and source symlinks preserve active paths and receipt', t => {
  const { source, root, base } = fixture(t); mkdirSync(join(root, '.pstack/package'), { recursive: true });
  writeFileSync(join(root, '.pstack/package/sentinel'), 'active'); writeFileSync(join(root, '.pstack/install.json'), 'receipt');
  for (const write of [() => { throw new Error('ENOSPC'); }, (path, data, options) => writeFileSync(path, path.endsWith('README.md') ? 'bad bytes' : data, options)]) {
    assert.throws(() => stagePackage({ source, root, write }), /ENOSPC|digest mismatch/);
    assert.equal(readFileSync(join(root, '.pstack/package/sentinel'), 'utf8'), 'active');
    assert.equal(readFileSync(join(root, '.pstack/install.json'), 'utf8'), 'receipt');
    assert.deepEqual(readdirSync(join(root, '.pstack/releases')), []);
  }
  symlinkSync(join(source, 'README.md'), join(source, 'unexpected-link')); assert.throws(() => stagePackage({ source, root }), /source symlink/); rmSync(join(source, 'unexpected-link'));
  rmSync(join(root, '.pstack/releases'), { recursive: true }); mkdirSync(join(base, 'external')); symlinkSync(join(base, 'external'), join(root, '.pstack/releases'));
  assert.throws(() => stagePackage({ source, root }), /symlink/);
});
test('retained renderer accepts effective config without editing it and stable references survive relocation/source removal', async t => {
  const { source, root, base } = fixture(t), generation = stagePackage({ source, root });
  const config = { version: 1, roles: { worker: ['vendor/example-model'] } };
  const rendered = await renderStagedArtifacts({ root, generation, targets: ['codex', 'opencode', 'claude-code', 'cursor'], opencodeRoot: '.opencode', config });
  assert.equal(existsSync(join(root, '.pstack/models.json')), false); assert.equal(existsSync(join(root, '.pstack/package')), false);
  assert.equal(rendered.state.entries['.pstack/package'].to, `releases/${generation.digest}`);
  assert.ok(rendered.contents.get('@opencode/commands/poteto-mode.md').includes('.pstack/package/skills/poteto-mode/'));
  assert.ok([...rendered.contents.keys()].some(name => name.startsWith('@opencode/agents/pstack-model-')));
  // Fixture activation creates only the proposed links; public installer remains unchanged.
  symlinkSync(rendered.state.entries['.pstack/package'].to, join(root, '.pstack/package'));
  for (const target of ['.agents', '.opencode', '.claude', '.cursor']) {
    const name = `${target}/skills/poteto-mode`, entry = rendered.state.entries[target === '.opencode' ? '@opencode/skills/poteto-mode' : name];
    mkdirSync(join(root, target, 'skills'), { recursive: true }); symlinkSync(entry.to, join(root, name));
    assert.ok(readFileSync(join(root, name, 'playbooks/feature.md'), 'utf8').length);
  }
  assert.throws(() => safePath(root, '.pstack/package/README.md'), /symlink/);
  rmSync(source, { recursive: true }); const relocated = join(base, 'relocated'); renameSync(root, relocated);
  assert.ok(readFileSync(join(relocated, '.agents/skills/poteto-mode/SKILL.md'), 'utf8').includes('poteto'));
  const helper = spawnSync(process.execPath, [join(relocated, '.pstack/package/scripts/release.mjs'), '--check'], { encoding: 'utf8' }); assert.equal(helper.status, 0, helper.stderr);
  assert.equal(await renderStagedArtifacts({ root: relocated, generation, targets: ['codex'], opencodeRoot: '.opencode', config }).then(result => result.state.provenance.packageDigest), generation.digest);
});
test('stored extra files, symlinks, mode changes and provenance edits are never accepted as verified payloads', t => {
  const { source, root } = fixture(t), generation = stagePackage({ source, root }), path = join(root, generation.name);
  writeFileSync(join(path, 'extra.log'), 'unexpected'); assert.throws(() => verifyGeneration(root, generation), /Unexpected stored files/); rmSync(join(path, 'extra.log'));
  symlinkSync('/tmp', join(path, 'unowned')); assert.throws(() => verifyGeneration(root, generation), /symlink/); rmSync(join(path, 'unowned'));
  chmodSync(join(path, 'README.md'), 0o755); assert.throws(() => verifyGeneration(root, generation), /digest mismatch/); chmodSync(join(path, 'README.md'), 0o644);
  writeFileSync(join(path, 'pstack-provenance.json'), '{}'); assert.throws(() => verifyGeneration(root, generation), /provenance mismatch/);
});

test('identical payload reuses verified stored identity even when the selected source metadata changes', t => {
  const { source, root } = fixture(t), first = stagePackage({ source, root });
  writeFileSync(join(source, 'pstack-provenance.json'), JSON.stringify({ ...first.provenance, sourceCommit: 'a'.repeat(40), evidence: 'different-checkout' }));
  const reused = stagePackage({ source, root });
  assert.equal(reused.reused, true); assert.deepEqual(reused.provenance, first.provenance);
});
