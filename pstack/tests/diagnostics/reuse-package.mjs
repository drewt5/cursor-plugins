import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, payload] = process.argv.slice(2).map(path => resolve(path));
assert.ok(checkout && payload, 'Usage: node reuse-package.mjs CHECKOUT IMMUTABLE_PAYLOAD');
let retained, releases, reads;
const readFileSync = fs.readFileSync;
fs.readFileSync = function (path, ...options) {
  const value = readFileSync.call(this, path, ...options);
  if (reads && typeof path === 'string') {
    const name = resolve(path);
    if (name.startsWith(retained + sep)) {
      const kind = name === join(retained, 'pstack-provenance.json') ? 'provenance' : 'payload';
      reads[kind].count++;
      reads[kind].bytes += Buffer.byteLength(value);
    } else if (name.startsWith(releases + sep)) {
      reads.metadata.count++;
      reads.metadata.bytes += Buffer.byteLength(value);
    }
  }
  return value;
};
syncBuiltinESMExports();
const { stagePackage } = await import(pathToFileURL(join(checkout, 'pstack/scripts/lib/installation-storage.mjs')));
const { packageInventory } = await import(pathToFileURL(join(checkout, 'pstack/scripts/lib/package-provenance.mjs')));
const inventory = packageInventory(payload);
const bytes = inventory.reduce((total, item) => total + fs.statSync(join(payload, item.path)).size, 0);
const samples = [];
for (let sample = 0; sample < 6; sample++) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'pstack-reuse-measure-')));
  try {
    const first = stagePackage({ source: payload, root });
    retained = join(root, first.name);
    releases = join(root, '.pstack/releases');
    reads = Object.fromEntries(['payload', 'provenance', 'metadata'].map(kind => [kind, { count: 0, bytes: 0 }]));
    const start = performance.now();
    const second = stagePackage({ source: payload, root });
    const elapsedMs = performance.now() - start;
    const measured = reads;
    reads = null;
    assert.ok(measured.payload.count >= inventory.length, 'Retained payload reads must be observed');
    assert.equal(second.reused, true);
    assert.equal(second.digest, first.digest);
    assert.deepEqual(second.provenance, first.provenance);
    samples.push({ warmup: sample === 0, elapsedMs, reads: measured, digest: second.digest });
  } finally {
    reads = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const times = samples.slice(1).map(sample => sample.elapsedMs).sort((a, b) => a - b);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, checkout, payload, files: inventory.length, bytes, failures: 0, medianMs: times[2], samples }, null, 2));
