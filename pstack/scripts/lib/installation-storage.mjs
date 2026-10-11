import { ownershipName, inventoryName } from './release-cleanup.mjs';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { canonicalPath, digest, files, present, safePath } from './installation-state.mjs';
import { packageDigest, packageInventory, readSourceProvenance, readLegacyProvenance, validateProvenance } from './package-provenance.mjs';

const generationDescriptorForMarker = ({ digest, name, provenance, renderer }) => ({ digest, name, provenance, renderer });
const generationName = digest => {
  assert.match(digest, /^[a-f0-9]{64}$/, 'Invalid generation digest');
  return `.pstack/releases/${digest}`;
};
function regularTree(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected stored symlink: ${name}`);
    if (entry.isDirectory()) return regularTree(path, name);
    assert.ok(entry.isFile(), `Unexpected stored path kind: ${name}`);
    return [name];
  }).sort();
}
function verifyPayload(path, provenance, inventory) {
  assert.ok(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), 'Generation must be a real directory');
  validateProvenance(provenance);
  assert.ok(Array.isArray(inventory) && inventory.length <= 10000, 'Missing or invalid retained package inventory');
  assert.equal(digest(JSON.stringify(inventory)), provenance.packageDigest, 'Retained inventory differs from package identity');
  assert.deepEqual(regularTree(path), [...inventory.map(item => item.path), 'pstack-provenance.json'].sort(), 'Unexpected stored files');
  assert.equal(packageDigest(path), provenance.packageDigest, 'Stored package digest mismatch');
  assert.deepEqual(JSON.parse(readFileSync(join(path, 'pstack-provenance.json'), 'utf8')), provenance, 'Stored provenance mismatch');
  return path;
}
export function verifyGeneration(root, generation) {
  root = canonicalPath(root);
  assert.equal(generation.name, generationName(generation.digest), 'Unexpected generation path');
  assert.equal(generation.provenance.packageDigest, generation.digest, 'Generation identity mismatch');
  const path = safePath(root, generation.name);
  const inventoryPath = safePath(root, inventoryName(generation.digest));
  assert.ok(present(inventoryPath)?.isFile() && present(inventoryPath).size <= 4 * 1024 * 1024, 'Retained inventory must be a bounded regular file');
  verifyPayload(path, generation.provenance, JSON.parse(readFileSync(inventoryPath)));
  return path;
}
export function stagePackage({ source, root, write = writeFileSync, legacyIdentityUnknown = false }) {
  root = canonicalPath(root); source = canonicalPath(source);
  const provenance = legacyIdentityUnknown ? readLegacyProvenance(source) : readSourceProvenance(source), inventory = packageInventory(source);
  const generation = { digest: provenance.packageDigest, name: generationName(provenance.packageDigest), provenance,
    renderer: present(join(source, 'scripts/lib/installation-artifacts.mjs'))?.isFile() && present(join(source, 'release.json'))?.isFile() ? { module: 'scripts/lib/installation-artifacts.mjs', export: 'renderArtifacts', contract: 1 } : null };
  const destination = safePath(root, generation.name);
  if (present(destination)) {
    // A directory name is never evidence of its contents or provenance.
    const stored = JSON.parse(readFileSync(join(destination, 'pstack-provenance.json'), 'utf8'));
    validateProvenance(stored);
    assert.equal(stored.version, provenance.version, 'Stored version mismatch');
    assert.ok(stored.upstreamCommit === provenance.upstreamCommit || stored.classification === 'legacy-unknown' || provenance.classification === 'legacy-unknown', 'Stored upstream mismatch');
    const retained = { ...generation, provenance: stored };
    assert.equal(digest(JSON.stringify(inventory)), stored.packageDigest, 'Retained inventory differs from package identity');
    const proof = safePath(root, inventoryName(generation.digest));
    if (present(proof)) {
      verifyGeneration(root, retained);
    } else {
      const marker = safePath(root, ownershipName(generation.digest));
      assert.ok(present(marker)?.isFile(), 'Unowned retained package cannot be adopted');
      assert.deepEqual(JSON.parse(readFileSync(marker)), generationDescriptorForMarker(retained));
      verifyPayload(destination, stored, inventory);
      writeFileSync(proof, JSON.stringify(inventory) + '\n', { flag: 'wx', mode: 0o600 });
    }
    return { ...retained, reused: true };
  }
  const releases = safePath(root, '.pstack/releases');
  mkdirSync(releases, { recursive: true });
  const scratch = mkdtempSync(join(releases, '.stage-'));
  try {
    for (const name of files(source)) {
      const input = join(source, name), output = safePath(scratch, name), mode = lstatSync(input).mode & 0o777;
      mkdirSync(dirname(output), { recursive: true });
      write(output, readFileSync(input), { flag: 'wx', mode });
      chmodSync(output, mode);
    }
    write(join(scratch, 'pstack-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    assert.ok(isDeepStrictEqual(packageInventory(source), inventory), 'Source changed during staging');
    verifyPayload(scratch, provenance, inventory);
    safePath(root, generation.name);
    assert.ok(!present(destination), 'Generation appeared during staging; retry under the scoped lock');
    renameSync(scratch, destination);
    writeFileSync(safePath(root, inventoryName(generation.digest)), JSON.stringify(inventory) + '\n', { flag: 'wx', mode: 0o600 });
    verifyGeneration(root, generation);
    writeFileSync(safePath(root, ownershipName(generation.digest)), JSON.stringify(generation) + '\n', { flag: 'wx', mode: 0o600 });
    return { ...generation, reused: false };
  } finally {
    // Only this invocation's unpredictable staging directory may be removed.
    rmSync(scratch, { recursive: true, force: true });
  }
}
export async function renderStagedArtifacts({ root, generation, ...options }) {
  const source = verifyGeneration(root, generation);
  assert.deepEqual(generation.renderer, { module: 'scripts/lib/installation-artifacts.mjs', export: 'renderArtifacts', contract: 1 }, 'Unsupported retained renderer contract');
  // Only a verified retained current/previous generation supplies this entry point.
  const { renderArtifacts } = await import(pathToFileURL(join(source, generation.renderer.module)).href);
  const result = renderArtifacts({ ...options, root, source, provenance: generation.provenance, includePackage: false });
  for (const name of Object.keys(result.state.entries)) if (name.startsWith('.pstack/package/')) { delete result.state.entries[name]; result.contents.delete(name); }
  if (result.state.targets.length) {
    result.state.entries['.pstack/package'] = { kind: 'link', to: relative(join(root, '.pstack'), join(root, generation.name)) };
    result.state.provenance = generation.provenance;
  }
  return result;
}
