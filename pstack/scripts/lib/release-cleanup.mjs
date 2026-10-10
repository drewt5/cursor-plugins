import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readActivationJournal } from './activation-journal.mjs';
import { canonicalPath, present, safePath, stateFrom } from './installation-state.mjs';
import { validateGeneration } from './generation-contract.mjs';
import { verifyGeneration } from './installation-storage.mjs';
export const ownershipName = digest => `.pstack/releases/.owned-${digest}.json`;
export function cleanupReleases(root) {
  root = canonicalPath(root); const directory = safePath(root, '.pstack/releases');
  const result = { removed: [], preserved: [] }; if (!present(directory)) return result;
  const state = stateFrom(safePath(root, '.pstack/install.json')), journal = readActivationJournal(root);
  const protectedDigests = new Set([state.generation, state.previous?.state.generation, journal?.generation, journal?.recoveryGeneration, journal?.legacyGeneration, journal?.priorReceipt.generation, journal?.priorReceipt.previous?.state.generation, journal?.intendedReceipt.generation, journal?.intendedReceipt.previous?.state.generation].filter(Boolean).map(value => value.digest));
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.owned-')) continue;
    const path = safePath(root, `.pstack/releases/${name}`);
    if (protectedDigests.has(name)) continue;
    try {
      if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('Unknown retained directory');
      const marker = safePath(root, ownershipName(name));
      if (!present(marker)?.isFile()) throw new Error('No local storage ownership evidence');
      const generation = JSON.parse(readFileSync(marker)); validateGeneration(generation);
      if (generation.digest !== name) throw new Error('Storage ownership differs from directory');
      verifyGeneration(root, generation); rmSync(path, { recursive: true }); rmSync(marker); result.removed.push(path);
    } catch (error) { result.preserved.push({ path, reason: error.message, action: 'Preserve or move this content yourself before retrying cleanup/uninstall.' }); }
  }
  return result;
}
