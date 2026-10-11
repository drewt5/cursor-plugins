import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, lstatSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stagePackage, verifyGeneration, renderStagedArtifacts } from '../scripts/lib/installation-storage.mjs';
import { packageInventory } from '../scripts/lib/package-provenance.mjs';
import { inventoryName, ownershipName } from '../scripts/lib/release-cleanup.mjs';
import { canonicalPath, safePath } from '../scripts/lib/installation-state.mjs';
const original = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-storage-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'source'), root = join(base, 'project'); mkdirSync(root);
  cpSync(original, source, { recursive: true, filter: path => !path.split('/').includes('node_modules') && !path.endsWith('/.git') });
  return { base, source, root };
}
test('staging verifies and reuses complete bytes/modes without activation or receipt publication', async t => {
  const { source, root } = fixture(t); mkdirSync(join(root, '.pstack')); writeFileSync(join(root, '.pstack/install.json'), 'receipt sentinel');
  const first = stagePackage({ source, root });
  assert.equal(existsSync(join(root, '.pstack/package')), false);
  symlinkSync(`releases/${first.digest}`, join(root, '.pstack/package'));
  const second = stagePackage({ source, root });
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(first.digest, second.digest);
  assert.deepEqual(packageInventory(verifyGeneration(root, first)), packageInventory(source));
  assert.equal(readFileSync(join(root, '.pstack/install.json'), 'utf8'), 'receipt sentinel'); assert.equal(readlinkSync(join(root, '.pstack/package')), `releases/${first.digest}`);
  assert.deepEqual(second.provenance, first.provenance);
  writeFileSync(join(root, first.name, 'README.md'), 'modified');
  assert.throws(() => stagePackage({ source, root }), /digest mismatch/);
  assert.equal(readFileSync(join(root, first.name, 'README.md'), 'utf8'), 'modified');
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
test('unowned stored special files are rejected before a body read can block on a named pipe', t => {
  const { source, root } = fixture(t), generation = stagePackage({ source, root }), pipe = join(root, generation.name, 'user-pipe');
  const created = spawnSync('/usr/bin/mkfifo', [pipe], { encoding: 'utf8', timeout: 2000 }); assert.equal(created.status, 0, created.stderr);
  const module = new URL('../scripts/lib/installation-storage.mjs', import.meta.url).href;
  const program = `import { verifyGeneration, stagePackage } from ${JSON.stringify(module)}; for (const check of [() => verifyGeneration(${JSON.stringify(root)}, ${JSON.stringify(generation)}), () => stagePackage({ root: ${JSON.stringify(root)}, source: ${JSON.stringify(source)} })]) { try { check(); process.exit(99); } catch (error) { console.log(error.message); } }`;
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 2000 });
  assert.equal(checked.status, 0, checked.error?.message || checked.stderr); assert.match(checked.stdout, /Unexpected stored path kind: user-pipe/); assert.equal(existsSync(pipe), true);
});

for (const mutation of ['mode', 'provenance', 'source-inventory', 'inventory-content', 'inventory-json', 'inventory-oversized', 'inventory-directory', 'inventory-symlink']) {
  test(`reuse rejects later ${mutation} changes without overwriting them`, t => {
    const { source, root } = fixture(t), generation = stagePackage({ source, root });
    const payload = join(root, generation.name, 'README.md');
    const provenance = join(root, generation.name, 'pstack-provenance.json');
    const inventory = join(root, inventoryName(generation.digest));
    let changed = inventory;
    let expected = /inventory|JSON|Unexpected token|Expected property/i;
    if (mutation === 'mode') {
      changed = payload;
      chmodSync(payload, lstatSync(payload).mode ^ 0o100);
      expected = /digest mismatch/;
    } else if (mutation === 'provenance') {
      changed = provenance;
      writeFileSync(provenance, '{}');
      expected = /Invalid installed provenance/;
    } else if (mutation === 'source-inventory') {
      changed = provenance;
      writeFileSync(provenance, JSON.stringify({ ...generation.provenance, packageDigest: 'a'.repeat(64) }));
      expected = /Retained inventory differs from package identity/;
    } else if (mutation === 'inventory-content') writeFileSync(inventory, '[]');
    else if (mutation === 'inventory-json') writeFileSync(inventory, '{');
    else if (mutation === 'inventory-oversized') writeFileSync(inventory, ' '.repeat(4 * 1024 * 1024 + 1));
    else {
      rmSync(inventory);
      if (mutation === 'inventory-directory') mkdirSync(inventory);
      else symlinkSync(payload, inventory);
    }
    const before = lstatSync(changed);
    const bytes = before.isFile() ? readFileSync(changed) : null;
    assert.throws(() => stagePackage({ source, root }), expected);
    assert.equal(lstatSync(changed).mode, before.mode);
    if (bytes) assert.deepEqual(readFileSync(changed), bytes);
    if (before.isSymbolicLink()) assert.equal(readlinkSync(changed), payload);
  });
}
for (const ownership of ['matching', 'absent', 'mismatched']) {
  test(`missing inventory regeneration requires ${ownership} ownership`, t => {
    const { source, root } = fixture(t), generation = stagePackage({ source, root });
    const inventory = join(root, inventoryName(generation.digest));
    const marker = join(root, ownershipName(generation.digest));
    const expected = readFileSync(inventory);
    rmSync(inventory);
    if (ownership === 'absent') rmSync(marker);
    if (ownership === 'mismatched') writeFileSync(marker, JSON.stringify({ ...generation, name: '.pstack/releases/unowned' }));
    const payload = join(root, generation.name, 'README.md'), bytes = readFileSync(payload);
    if (ownership === 'matching') {
      const reused = stagePackage({ source, root });
      assert.equal(reused.reused, true);
      assert.deepEqual(reused.provenance, generation.provenance);
      assert.deepEqual(readFileSync(inventory), expected);
      assert.equal(verifyGeneration(root, reused), join(canonicalPath(root), generation.name));
    } else {
      assert.throws(() => stagePackage({ source, root }), /Unowned|strictly deep-equal/);
      assert.equal(existsSync(inventory), false);
    }
    assert.deepEqual(readFileSync(payload), bytes);
  });
}

test('reuse rejects a stored inventory pipe without blocking or changing it', t => {
  const { source, root } = fixture(t), generation = stagePackage({ source, root });
  const inventory = join(root, inventoryName(generation.digest));
  rmSync(inventory);
  const created = spawnSync('/usr/bin/mkfifo', [inventory], { encoding: 'utf8', timeout: 2000 });
  assert.equal(created.status, 0, created.stderr);
  const module = new URL('../scripts/lib/installation-storage.mjs', import.meta.url).href;
  const program = `import { stagePackage } from ${JSON.stringify(module)}; try { stagePackage({ source: ${JSON.stringify(source)}, root: ${JSON.stringify(root)} }); process.exit(99); } catch (error) { console.log(error.message); }`;
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 2000 });
  assert.equal(checked.status, 0, checked.error?.message || checked.stderr);
  assert.match(checked.stdout, /Retained inventory must be a bounded regular file/);
  assert.equal(lstatSync(inventory).isFIFO(), true);
});
test('missing inventory with matching ownership still rejects edited payload bytes', t => {
  const { source, root } = fixture(t), generation = stagePackage({ source, root });
  const inventory = join(root, inventoryName(generation.digest));
  const payload = join(root, generation.name, 'README.md');
  rmSync(inventory);
  writeFileSync(payload, 'user edit');
  assert.throws(() => stagePackage({ source, root }), /digest mismatch/);
  assert.equal(existsSync(inventory), false);
  assert.equal(readFileSync(payload, 'utf8'), 'user edit');
});
