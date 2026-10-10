import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, files, isPackagePath, present } from './installation-state.mjs';
const sha = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function packageInventory(source) {
  return files(source).map(name => ({ path: name.replaceAll('\\', '/'), kind: 'file', executableMode: lstatSync(join(source, name)).mode & 0o111, hash: digest(readFileSync(join(source, name))) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function packageDigest(source) { return digest(JSON.stringify(packageInventory(source))); }
function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return !result.error && result.status === 0 ? result.stdout.trimEnd() : null;
}
export function readSourceProvenance(source) {
  const metadata = JSON.parse(readFileSync(join(source, 'release.json'), 'utf8'));
  if (metadata.schemaVersion !== 1 || !semver.test(metadata.version) || !sha.test(metadata.upstreamCommit)) throw new Error('Invalid portable release metadata');
  const payloadDigest = packageDigest(source);
  const provenance = { schemaVersion: 1, version: metadata.version, sourceCommit: null, upstreamCommit: metadata.upstreamCommit, packageDigest: payloadDigest, classification: 'development', dirty: null, tag: null, evidence: 'local-content-only' };
  const head = git(source, ['rev-parse', 'HEAD']);
  const trackedSource = git(source, ['ls-files', '--error-unmatch', 'release.json']);
  if (head && sha.test(head) && trackedSource !== null) {
    const changed = git(source, ['diff', 'HEAD', '--name-only', '--relative', '-z', '--', '.']);
    const untracked = git(source, ['ls-files', '--others', '-z', '--', '.']);
    if (changed === null || untracked === null) return { ...provenance, sourceCommit: head, evidence: 'git-state-unavailable' };
    const dirty = [...changed.split('\0'), ...untracked.split('\0')].filter(Boolean).some(isPackagePath);
    const tag = `pstack-v${metadata.version}`;
    const tagged = git(source, ['tag', '--points-at', 'HEAD'])?.split('\n').includes(tag);
    const upstream = git(source, ['merge-base', '--is-ancestor', metadata.upstreamCommit, head]) !== null;
    return { ...provenance, sourceCommit: head, dirty, tag: tagged ? tag : null, classification: !dirty && tagged && upstream ? 'release' : 'development', evidence: 'local-git-and-content' };
  }
  const detached = join(source, 'pstack-provenance.json');
  if (present(detached)) {
    if (!lstatSync(detached).isFile()) throw new Error('Detached provenance must be a regular file');
    const supplied = JSON.parse(readFileSync(detached, 'utf8'));
    validateProvenance(supplied);
    if (supplied.version !== provenance.version || supplied.upstreamCommit !== provenance.upstreamCommit || supplied.packageDigest !== payloadDigest) throw new Error('Detached provenance does not match the source archive');
    return { ...supplied, evidence: 'supplied-metadata-content-match-untrusted' };
  }
  return provenance;
}
export function readLegacyProvenance(source) {
  let version = null;
  for (const name of ['package.json', 'plugin.json']) {
    try { const observed = JSON.parse(readFileSync(join(source, name), 'utf8')).version; if (typeof observed === 'string' && semver.test(observed)) { version = observed; break; } } catch {}
  }
  return { schemaVersion: 1, version, sourceCommit: null, upstreamCommit: null, packageDigest: packageDigest(source), classification: 'legacy-unknown', dirty: null, tag: null, evidence: 'legacy-owned-content-original-identity-unknown' };
}
export function validateProvenance(value) {
  const legacy = value?.classification === 'legacy-unknown';
  if (!value || Object.keys(value).some(key => !['schemaVersion', 'version', 'sourceCommit', 'upstreamCommit', 'packageDigest', 'classification', 'dirty', 'tag', 'evidence'].includes(key)) || value.schemaVersion !== 1 || (legacy && value.version === null ? false : typeof value.version !== 'string' || !semver.test(value.version))
      || value.sourceCommit !== null && !sha.test(value.sourceCommit) || (legacy && value.upstreamCommit === null ? false : !sha.test(value.upstreamCommit)) || !hash.test(value.packageDigest)
      || !['release', 'development', 'legacy-unknown'].includes(value.classification) || ![true, false, null].includes(value.dirty)
      || value.tag !== null && value.tag !== `pstack-v${value.version}` || typeof value.evidence !== 'string') throw new Error('Invalid installed provenance');
  if (legacy && (value.sourceCommit !== null || value.upstreamCommit !== null || value.dirty !== null || value.tag !== null || value.evidence !== 'legacy-owned-content-original-identity-unknown')) throw new Error('Legacy provenance must preserve unknown original identity');
  if (value.classification === 'release' && (!value.sourceCommit || value.dirty !== false || value.tag !== `pstack-v${value.version}`)) throw new Error('Release provenance lacks exact clean tagged identity');
}
