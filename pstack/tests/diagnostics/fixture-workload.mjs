// Run from a candidate checkout against one fixed package payload:
// node pstack/tests/diagnostics/fixture-workload.mjs /path/to/baseline/pstack
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageInventory } from '../../scripts/lib/package-provenance.mjs';
import { copyRuntimeSource } from '../fixtures/runtime-source.mjs';
import { copyActivationSource } from '../fixtures/activation-fixtures.mjs';
assert.ok(process.argv[2], 'Supply one fixed package source');
const source = resolve(process.argv[2]);
const temporary = mkdtempSync(join(tmpdir(), 'pstack-fixture-workload-'));
const inventory = packageInventory(source);
function size(path) {
  const rows = packageInventory(path);
  return { files: rows.length, bytes: rows.reduce((sum, row) => sum + statSync(join(path, row.path)).size, 0) };
}
try {
  const full = size(source);
  const runtime = size(copyRuntimeSource(source, join(temporary, 'runtime')));
  const activation = size(copyActivationSource(source, join(temporary, 'activation')));
  const lifecycle = Object.fromEntries(['files', 'bytes'].map(key => [key, {
    // Eight compact matrix rows, each installing fresh twice; one shared source prep.
    before: 16 * full[key], after: 17 * runtime[key], saved: 16 * full[key] - 17 * runtime[key],
  }]));
  const recoverySourcePreparation = Object.fromEntries(['files', 'bytes'].map(key => [key, {
    // One control, 22 crash cases, five other compact recovery scenarios.
    before: 28 * activation[key], after: activation[key], saved: 27 * activation[key],
  }]));
  assert.deepEqual(packageInventory(source), inventory, 'Fixture measurement modified its source');
  console.log(JSON.stringify({ source, full, runtime, activation, lifecycle, recoverySourcePreparation }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
