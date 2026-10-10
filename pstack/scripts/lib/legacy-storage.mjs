import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { digest, observe, present, safePath } from './installation-state.mjs';
import { stagePackage } from './installation-storage.mjs';
import { generationDescriptor } from './generation-contract.mjs';
export function legacyTree(directory, receipt, { allowMissing = false } = {}) {
  const owned = new Map(Object.entries(receipt.entries).filter(([name]) => name.startsWith('.pstack/package/')).map(([name, entry]) => [name.slice(16), entry]));
  assert.ok(owned.size, 'Legacy package has no recorded owned payload');
  const directories = new Set();
  for (const name of owned.keys()) for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) directories.add(parent);
  const found = new Set(), rows = [];
  function visit(path, prefix = '') {
    assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Legacy package must be a real directory');
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, file = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), `Legacy symlink conflict: ${name}`);
      if (entry.isDirectory()) { assert.ok(directories.has(name), `Unowned legacy directory: ${name}`); rows.push({ name, kind: 'directory', mode: lstatSync(file).mode & 0o777 }); visit(file, name); }
      else {
        const recorded = owned.get(name), actual = observe(file);
        assert.ok(recorded?.kind === 'file' && actual.kind === 'file' && recorded.hash === actual.hash, `Modified or unowned legacy file: ${name}`);
        found.add(name); rows.push({ name, ...actual });
      }
    }
  }
  visit(directory); if (!allowMissing) assert.equal(found.size, owned.size, 'Legacy package is incomplete; restore missing owned payload before migration');
  return { digest: digest(JSON.stringify(rows)), entries: rows.length, rows };
}
export function captureLegacyPackage(root, receipt) {
  const path = safePath(root, '.pstack/package');
  assert.ok(present(path)?.isDirectory() && !present(path).isSymbolicLink(), 'Legacy package must be a real directory');
  const tree = legacyTree(path, receipt);
  const generation = generationDescriptor(stagePackage({ source: path, root, legacyIdentityUnknown: receipt.version < 3 }));
  assert.equal(legacyTree(path, receipt).digest, tree.digest, 'Legacy package changed while capturing');
  return { treeDigest: tree.digest, treeRows: tree.rows, generation };
}
