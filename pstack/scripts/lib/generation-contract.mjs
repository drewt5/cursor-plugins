import assert from 'node:assert/strict';
import { validateProvenance } from './package-provenance.mjs';
export function generationDescriptor(value) {
  const result = { digest: value.digest, name: value.name, provenance: value.provenance, renderer: value.renderer };
  validateGeneration(result); return result;
}
export function validateGeneration(value) {
  assert.ok(value && Object.keys(value).every(key => ['digest', 'name', 'provenance', 'renderer'].includes(key)), 'Invalid retained generation fields');
  assert.match(value.digest, /^[a-f0-9]{64}$/); assert.equal(value.name, `.pstack/releases/${value.digest}`);
  validateProvenance(value.provenance); assert.equal(value.provenance.packageDigest, value.digest);
  if (value.renderer !== null) assert.deepEqual(value.renderer, { module: 'scripts/lib/installation-artifacts.mjs', export: 'renderArtifacts', contract: 1 }, 'Unsupported retained renderer');
}
