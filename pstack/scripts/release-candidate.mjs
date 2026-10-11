#!/usr/bin/env node
import { validateLifecycleEvidence } from './lib/lifecycle-evidence.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalPath, digest } from './lib/installation-state.mjs';
import { readSourceProvenance } from './lib/package-provenance.mjs';
import { validateHosts } from './lib/tested-hosts.mjs';
import { candidateGit, compareUpstream, validateUpstreamReview } from './lib/upstream-review.mjs';
import { validateReleaseEvidence } from './lib/release-evidence.mjs';
const defaultSource = fileURLToPath(new URL('..', import.meta.url));
const help = 'Usage: release-candidate.mjs [--source PATH] --tag pstack-vVERSION --reports DIR --run-meta FILE --jobs FILE --checkout-log FILE --review FILE [--upgrade-evidence FILE] [--lifecycle-evidence FILE] --run ID --attempt N --output FILE\nOr: release-candidate.mjs [--source PATH] --inspect-upstream\nConsumes exact required-baseline evidence. Writes only a new explicit output outside the package. No tag/release/provider/user installation mutation.';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
export function supportedUpgradeBaseline(source, tag, supplied, proof, currentEvidence) {
  const tags = candidateGit(source, ['tag', '--list', 'pstack-v*', '--sort=-version:refname']).split('\n').filter(value => value && value !== tag);
  if (!tags.length) { assert.deepEqual(supplied, { kind: 'legacy-receipts', schemas: [1, 2] }, 'Initial portable baseline must be explicit legacy receipt schemas 1/2'); return supplied; }
  assert.ok(supplied && supplied.kind === 'previous-release' && supplied.tag === tags[0], 'Select the immediately previous supported portable release and its upgrade fixture');
  assert.equal(candidateGit(source, ['rev-parse', `${supplied.tag}^{commit}`]), supplied.sourceCommit, 'Previous release commit mismatch');
  const prefix = candidateGit(source, ['rev-parse', '--show-prefix']);
  const previousMetadata = JSON.parse(candidateGit(source, ['show', `${supplied.tag}:${prefix}release.json`]));
  assert.equal(supplied.tag, `pstack-v${previousMetadata.version}`, 'Previous tag disagrees with its portable version');
  assert.match(supplied.packageDigest, /^[a-f0-9]{64}$/); assert.match(supplied.upgradeFixtureDigest, /^[a-f0-9]{64}$/, 'Retain exact previous-release upgrade-fixture evidence');
  assert.ok(proof && proof.schemaVersion === 1 && proof.kind === 'release-upgrade-fixture' && proof.status === 'passed', 'Supply --upgrade-evidence with successful exact previous-to-current fixture results');
  assert.deepEqual(proof.from, { tag: supplied.tag, sourceCommit: supplied.sourceCommit, packageDigest: supplied.packageDigest }, 'Upgrade fixture used a different previous release');
  assert.deepEqual(proof.to, { tag, sourceCommit: currentEvidence.sourceHeadSha, runId: currentEvidence.runId, runAttempt: currentEvidence.runAttempt }, 'Upgrade fixture used a stale candidate/run/attempt');
  assert.ok(Array.isArray(proof.cases) && proof.cases.length && new Set(proof.cases.map(item => item.name)).size === proof.cases.length && proof.cases.every(item => typeof item.name === 'string' && item.name && item.status === 'passed'), 'Incomplete/failed upgrade fixture cases');
  assert.equal(digest(JSON.stringify(proof)), supplied.upgradeFixtureDigest, 'Upgrade fixture digest mismatch');
  return { ...supplied, upgradeEvidence: proof };
}
export function prepareReleaseCandidate(options) {
  const source = canonicalPath(options.source || defaultSource), metadata = json(join(source, 'release.json'));
  const sourceCommit = candidateGit(source, ['rev-parse', 'HEAD']);
  const comparison = compareUpstream(source, metadata.upstreamCommit, sourceCommit);
  if (options['inspect-upstream']) return comparison;
  for (const key of ['tag', 'reports', 'run-meta', 'jobs', 'checkout-log', 'review', 'run', 'attempt', 'output']) assert.ok(options[key], `Missing --${key}. ${help}`);
  assert.ok(/^[1-9]\d*$/.test(options.run) && /^[1-9]\d*$/.test(options.attempt), 'Expected numeric run ID and attempt');
  assert.equal(candidateGit(source, ['status', '--porcelain', '--untracked-files=all']), '', 'Candidate must be clean; commit package changes and keep evidence outputs outside the checkout');
  const validation = spawnSync(process.execPath, [join(source, 'scripts/release.mjs'), '--release', '--tag', options.tag], { encoding: 'utf8', timeout: 10000 });
  assert.ok(!validation.error && validation.status === 0, validation.error?.message || validation.stderr.trim() || 'Source/version/tag validation failed');
  const identity = JSON.parse(validation.stdout), provenance = readSourceProvenance(source);
  assert.equal(identity.sourceCommit, sourceCommit); assert.equal(provenance.sourceCommit, sourceCommit); assert.equal(provenance.dirty, false);
  const review = json(options.review), upstreamReview = validateUpstreamReview(comparison, review);
  const reports = readdirSync(options.reports, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(options.reports, entry.name)).filter(path => existsSync(join(path, 'report.json'))).map(path => {
    const bytes = readFileSync(join(path, 'report.json')), report = JSON.parse(bytes), logs = {};
    for (const phase of report.phases || []) { assert.ok(/^[a-z][a-z0-9-]*\.log$/.test(phase.log), 'Unsafe/missing phase log path'); logs[phase.log] = readFileSync(join(path, phase.log), 'utf8'); }
    return { report, bytes, logs };
  });
  const requiredEvidence = validateReleaseEvidence({ sourceCommit, run: json(options['run-meta']), jobs: json(options.jobs).jobs, reports, hosts: validateHosts(json(join(source, 'tested-hosts.json'))), checkoutLog: readFileSync(options['checkout-log'], 'utf8'), runId: options.run, attempt: Number(options.attempt) });
  const baseline = supportedUpgradeBaseline(source, options.tag, review.upgradeBaseline, options['upgrade-evidence'] ? json(options['upgrade-evidence']) : undefined, requiredEvidence);
  const tagExists = candidateGit(source, ['tag', '--points-at', sourceCommit]).split('\n').includes(options.tag);
  const record = { schemaVersion: 1, kind: 'portable-release-candidate', status: 'candidate-validated', identity: { ...identity, packageDigest: provenance.packageDigest, tagState: tagExists ? 'verified-existing-tag' : 'pre-tag-candidate' }, upgradeBaseline: baseline, upstreamReview, requiredEvidence, lifecycleGate: { status: 'pending', issue: 'https://github.com/drewt5/cursor-plugins/issues/23', reason: 'Candidate validation alone is not release readiness or model reasoning/GUI verification.' } };
  if (options['lifecycle-evidence']) record.lifecycleGate = validateLifecycleEvidence(json(options['lifecycle-evidence']), record.identity, requiredEvidence, upstreamReview);
  const output = canonicalPath(options.output);
  assert.ok(output !== source && !output.startsWith(source + sep), 'Keep generated evidence outside the hashed source package');
  assert.equal(candidateGit(source, ['rev-parse', 'HEAD']), sourceCommit, 'Source head changed during collection');
  assert.equal(candidateGit(source, ['status', '--porcelain', '--untracked-files=all']), '', 'Candidate changed during collection');
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return { output, evidenceDigest: digest(JSON.stringify(record)), identity: record.identity, status: record.status };
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--help') { console.log(help); process.exit(0); }
      if (arg === '--inspect-upstream') options['inspect-upstream'] = true;
      else if (['source', 'tag', 'reports', 'run-meta', 'jobs', 'checkout-log', 'review', 'upgrade-evidence', 'lifecycle-evidence', 'run', 'attempt', 'output'].some(key => arg === '--' + key) && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options[arg.slice(2)] = process.argv[++i];
      else throw new Error(`Unknown/incomplete option ${arg}. ${help}`);
    }
    console.log(JSON.stringify(prepareReleaseCandidate(options), null, 2));
  } catch (error) { console.error(`Candidate rejected: ${error.message}`); process.exitCode = 1; }
}
