// Compare public installation implementations against one immutable package payload.
// node public-reuse.mjs CHECKOUT PAYLOAD [SAMPLES]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [checkoutArg, payloadArg, samplesArg = '5'] = process.argv.slice(2);
assert.ok(checkoutArg && payloadArg, 'Supply implementation checkout and immutable payload');
const checkout = fs.realpathSync(resolve(checkoutArg));
const source = fs.realpathSync(resolve(payloadArg));
const samples = Number(samplesArg);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && samples <= 100);
const { packageInventory } = await import(pathToFileURL(join(checkout, 'pstack/scripts/lib/package-provenance.mjs')));
const inventory = packageInventory(source);
const payloadNames = new Set(inventory.map(row => row.path));
const originalRead = fs.readFileSync, originalSpawn = cp.spawnSync;
let measured;
fs.readFileSync = function (path, ...args) {
  const bytes = originalRead.call(this, path, ...args);
  if (measured) {
    const name = String(path);
    const relative = name.startsWith(source + '/') ? name.slice(source.length + 1) : null;
    const retained = name.match(/\/\.pstack\/releases\/[a-f0-9]{64}\/(.+)$/)?.[1];
    const category = payloadNames.has(relative) ? 'source' : payloadNames.has(retained) ? 'retained' : null;
    if (category) {
      measured[category].reads++;
      measured[category].bytes += Buffer.byteLength(bytes);
    }
  }
  return bytes;
};
cp.spawnSync = function (command, ...args) {
  if (measured) {
    measured.processes++;
    if (command === 'git') measured.gitQueries++;
  }
  return originalSpawn.call(this, command, ...args);
};
syncBuiltinESMExports();
const { applyPublicInstallation } = await import(pathToFileURL(join(checkout, 'pstack/scripts/lib/installation-public.mjs')));
const results = [];
const log = console.log;
console.log = () => {};
try {
  for (let sample = 0; sample <= samples; sample++) {
    const temporary = fs.mkdtempSync(join(tmpdir(), 'pstack-public-reuse-'));
    try {
      const root = join(temporary, 'project'), home = join(temporary, 'home');
      fs.mkdirSync(root); fs.mkdirSync(home);
      const options = { source, root, globalRoot: home, options: { target: 'cursor' }, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, '.config') } };
      assert.equal((await applyPublicInstallation(options)).status, 'applied');
      const receipt = fs.readFileSync(join(root, '.pstack/install.json'));
      measured = { source: { reads: 0, bytes: 0 }, retained: { reads: 0, bytes: 0 }, processes: 0, gitQueries: 0 };
      const started = performance.now();
      const result = await applyPublicInstallation(options);
      const observation = { ...measured, durationMs: performance.now() - started };
      measured = null;
      assert.equal(result.status, 'unchanged');
      assert.deepEqual(fs.readFileSync(join(root, '.pstack/install.json')), receipt);
      if (sample) results.push(observation);
    } finally {
      measured = null;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  assert.deepEqual(packageInventory(source), inventory, 'Measurement changed the fixed payload');
} finally {
  console.log = log;
  fs.readFileSync = originalRead;
  cp.spawnSync = originalSpawn;
  syncBuiltinESMExports();
}
console.log(JSON.stringify({ checkout, source, files: inventory.length, payloadBytes: inventory.reduce((sum, row) => sum + fs.statSync(join(source, row.path)).size, 0), warmups: 1, results }, null, 2));
