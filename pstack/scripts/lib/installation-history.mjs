import { inherits } from '../../skills/pstack-runtime/scripts/models.mjs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { verifyGeneration } from './installation-storage.mjs';
import { readFileSync } from 'node:fs';
import { digest, pathFor, parseInstallationState, observe } from './installation-state.mjs';
export function renderingFingerprint(config, targets) {
  const models = targets.includes('opencode') ? [...new Set(Object.values(config.roles).flat().filter(model => !inherits(model)))].sort() : [];
  return digest(JSON.stringify(models));
}
export function validatePrevious(previous) {
  assert.ok(previous && Object.keys(previous).every(key => ['state', 'contents'].includes(key)), 'Invalid previous installation');
  assert.ok(!previous.state.previous, 'Only one previous installation is retained');
  const state = parseInstallationState(JSON.stringify(previous.state)); assert.equal(state.version, 4);
  assert.ok(previous.contents && typeof previous.contents === 'object' && !Array.isArray(previous.contents));
  const expected = Object.keys(state.entries).filter(name => state.entries[name].kind === 'file').sort();
  assert.deepEqual(Object.keys(previous.contents).sort(), expected, 'Incomplete retained artifacts');
  for (const name of expected) { assert.equal(typeof previous.contents[name], 'string'); assert.equal(digest(Buffer.from(previous.contents[name], 'base64')), state.entries[name].hash, 'Retained artifact differs from receipt'); }
  return previous;
}
export function capturePrevious(root, state, legacy) {
  if (!state.targets.length) return null;
  const retained = structuredClone(state); delete retained.previous;
  if (retained.version < 4) {
    assert.ok(legacy, 'Legacy baseline was not verified');
    retained.version = 4; retained.generation = legacy.generation; retained.provenance = legacy.generation.provenance; retained.hostObservations ??= [];
    for (const name of Object.keys(retained.entries)) if (name.startsWith('.pstack/package/')) delete retained.entries[name];
    retained.entries['.pstack/package'] = { kind: 'link', to: `releases/${legacy.generation.digest}` };
    const map = retained.entries['.pstack/opencode-models.json'];
    retained.renderingFingerprint = map ? digest(JSON.stringify(Object.keys(JSON.parse(readFileSync(pathFor(root, '.pstack/opencode-models.json', state))).agents).sort())) : digest(JSON.stringify([]));
  }
  const contents = {};
  for (const [name, entry] of Object.entries(retained.entries)) if (entry.kind === 'file') {
    const path = pathFor(root, name, state), actual = observe(path);
    assert.equal(actual.hash, entry.hash, `Cannot retain modified or missing artifact: ${path}`);
    const bytes = readFileSync(path); contents[name] = bytes.toString('base64'); entry.mode ??= actual.mode;
  }
  return validatePrevious({ state: retained, contents });
}

export async function selectRecoveryGeneration(root, state) {
  for (const generation of [state.generation, state.previous?.state.generation].filter(Boolean)) {
    try {
      const packageRoot = verifyGeneration(root, generation);
      const recovery = await import(pathToFileURL(join(packageRoot, 'scripts/lib/installation-recovery.mjs')).href);
      if (recovery.recoveryContract === 2) return generation;
    } catch { /* An unsupported/modified helper is never executed as recovery. */ }
  }
  throw new Error('No retained recovery executable supports this operation. Apply install.mjs from the current explicitly selected release checkout before rollback/uninstall.');
}
