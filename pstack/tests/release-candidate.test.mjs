import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareReleaseCandidate, supportedUpgradeBaseline } from '../scripts/release-candidate.mjs';
import { digest } from '../scripts/lib/installation-state.mjs';
import { compareUpstream } from '../scripts/lib/upstream-review.mjs';
import { lifecycleFixture } from './fixtures/lifecycle-evidence.mjs';
import { evidenceFixture } from './fixtures/release-evidence.mjs';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-candidate-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repository'), source = join(repo, 'pstack'), reports = join(root, 'reports'); mkdirSync(source, { recursive: true }); mkdirSync(reports);
  const git = args => { const r = spawnSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(['init', '-q']); git(['config', 'user.email', 'fixture@localhost']); git(['config', 'user.name', 'Fixture']);
  mkdirSync(join(source, 'skills/one'), { recursive: true }); writeFileSync(join(source, 'skills/one/SKILL.md'), 'upstream instruction'); git(['add', '.']); git(['commit', '-qm', 'upstream']); const upstreamCommit = git(['rev-parse', 'HEAD']);
  writeFileSync(join(source, 'skills/one/SKILL.md'), 'host capability adaptation'); mkdirSync(join(source, 'skills/runtime')); writeFileSync(join(source, 'skills/runtime/SKILL.md'), 'explicit limits');
  writeFileSync(join(source, 'release.json'), JSON.stringify({ schemaVersion: 1, version: '1.2.3', upstreamCommit }));
  for (const name of ['package.json', 'plugin.json', '.cursor-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) { mkdirSync(join(source, name, '..'), { recursive: true }); writeFileSync(join(source, name), JSON.stringify({ version: '1.2.3', type: 'module' })); }
  mkdirSync(join(source, 'scripts')); cpSync(join(packageRoot, 'scripts/release.mjs'), join(source, 'scripts/release.mjs')); cpSync(join(packageRoot, 'tested-hosts.json'), join(source, 'tested-hosts.json'));
  git(['add', '.']); git(['commit', '-qm', 'candidate']); const head = git(['rev-parse', 'HEAD']);
  const evidence = evidenceFixture(head);
  for (const item of evidence.reports) { const dir = join(reports, item.report.artifact); mkdirSync(dir); writeFileSync(join(dir, 'report.json'), item.bytes); for (const [name, body] of Object.entries(item.logs)) writeFileSync(join(dir, name), body); }
  const comparison = compareUpstream(source, upstreamCommit, head), review = { schemaVersion: 1, ...comparison, deviations: [{ paths: comparison.changedPaths, rationale: 'Fixture checks preserve purpose while adding capability resolution.' }], upstreamCandidates: [], limitations: ['Synthetic evidence only; not actual native reasoning.'], upgradeBaseline: { kind: 'legacy-receipts', schemas: [1, 2] } };
  const save = (name, data) => { const path = join(root, name); writeFileSync(path, JSON.stringify(data)); return path; };
  const options = { source, tag: 'pstack-v1.2.3', reports, 'run-meta': save('run.json', evidence.run), jobs: save('jobs.json', { jobs: evidence.jobs }), 'checkout-log': join(root, 'checkout.log'), review: save('review.json', review), run: '123', attempt: '1', output: join(root, 'candidate.json') }; writeFileSync(options['checkout-log'], evidence.checkoutLog);
  return { root, repo, source, git, head, comparison, options, evidence };
}
test('candidate validates pre-tag and existing-tag identity, deterministic self-contained record and read-only source', t => {
  const f = fixture(t), result = prepareReleaseCandidate(f.options); assert.equal(result.status, 'candidate-validated'); assert.equal(result.identity.tagState, 'pre-tag-candidate');
  const record = JSON.parse(readFileSync(f.options.output)); assert.equal(record.requiredEvidence.reports.length, 6); assert.equal(record.lifecycleGate.status, 'pending'); assert.deepEqual(record.upgradeBaseline, { kind: 'legacy-receipts', schemas: [1, 2] });
  const second = { ...f.options, output: join(f.root, 'second.json') }; prepareReleaseCandidate(second); assert.equal(readFileSync(second.output, 'utf8'), readFileSync(f.options.output, 'utf8')); assert.equal(f.git(['status', '--porcelain']), ''); assert.equal(f.git(['tag', '--list']), '');
  f.git(['tag', 'pstack-v1.2.3']); const existing = prepareReleaseCandidate({ ...f.options, output: join(f.root, 'existing.json') }); assert.equal(existing.identity.tagState, 'verified-existing-tag');
});
test('candidate rejects dirty/version/tag/commit/missing-input problems before output mutation', t => {
  for (const kind of ['dirty', 'version', 'tag', 'commit', 'missing-input', 'inside-output']) {
    const f = fixture(t);
    if (kind === 'dirty') writeFileSync(join(f.source, 'untracked'), 'dirty');
    if (kind === 'version') { writeFileSync(join(f.source, 'plugin.json'), '{"version":"9.9.9"}'); f.git(['add', '.']); f.git(['commit', '-qm', 'version mismatch']); }
    if (kind === 'tag') f.options.tag = 'pstack-v9.9.9';
    if (kind === 'commit') { const run = JSON.parse(readFileSync(f.options['run-meta'])); run.head_sha = 'b'.repeat(40); writeFileSync(f.options['run-meta'], JSON.stringify(run)); }
    if (kind === 'missing-input') rmSync(join(f.options.reports, f.evidence.reports[0].report.artifact), { recursive: true });
    if (kind === 'inside-output') f.options.output = join(f.source, 'generated-evidence.json');
    assert.throws(() => prepareReleaseCandidate(f.options)); assert.equal(existsSync(f.options.output), false);
  }
});
test('initial/previous baseline and clean CLI selection are explicit without publication', t => {
  const f = fixture(t);
  assert.throws(() => supportedUpgradeBaseline(f.source, f.options.tag, { kind: 'unknown' }));
  f.git(['tag', 'pstack-v1.2.3']); const nextTag = 'pstack-v1.2.4';
  assert.throws(() => supportedUpgradeBaseline(f.source, nextTag, { kind: 'legacy-receipts', schemas: [1, 2] }));
  const proof = { schemaVersion: 1, kind: 'release-upgrade-fixture', status: 'passed', from: { tag: 'pstack-v1.2.3', sourceCommit: f.head, packageDigest: 'a'.repeat(64) }, to: { tag: nextTag, sourceCommit: f.head, runId: '123', runAttempt: 1 }, cases: [{ name: 'previous-to-current upgrade', status: 'passed' }] };
  const prior = { kind: 'previous-release', ...proof.from, upgradeFixtureDigest: digest(JSON.stringify(proof)) }, current = { sourceHeadSha: f.head, runId: '123', runAttempt: 1 };
  assert.throws(() => supportedUpgradeBaseline(f.source, nextTag, prior));
  assert.equal(supportedUpgradeBaseline(f.source, nextTag, prior, proof, current).upgradeEvidence.status, 'passed');
  assert.throws(() => supportedUpgradeBaseline(f.source, nextTag, { ...prior, sourceCommit: 'c'.repeat(40) }, proof, current));
  assert.throws(() => supportedUpgradeBaseline(f.source, nextTag, prior, { ...proof, status: 'failed' }, current));
  assert.throws(() => supportedUpgradeBaseline(f.source, nextTag, prior, proof, { ...current, runAttempt: 2 }));
  const command = spawnSync(process.execPath, [join(packageRoot, 'scripts/release-candidate.mjs'), '--source', f.source, '--inspect-upstream'], { encoding: 'utf8' }); assert.equal(command.status, 0, command.stderr); assert.deepEqual(JSON.parse(command.stdout), f.comparison);
  const invalid = spawnSync(process.execPath, [join(packageRoot, 'scripts/release-candidate.mjs'), '--bogus'], { encoding: 'utf8' }); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Unknown/);
});

test('CLI lifecycle evidence validates deterministically and rejects bad costs without output or source changes', t => {
  const f = fixture(t);
  prepareReleaseCandidate(f.options);
  const pending = JSON.parse(readFileSync(f.options.output));
  assert.equal(pending.lifecycleGate.status, 'pending');
  const proof = lifecycleFixture(pending.identity, pending.requiredEvidence, pending.upstreamReview);
  const proofPath = join(f.root, 'lifecycle.json');
  const cli = options => spawnSync(process.execPath, [join(packageRoot, 'scripts/release-candidate.mjs'), ...Object.entries(options).flatMap(([key, value]) => ['--' + key, value])], { encoding: 'utf8' });
  const options = { ...f.options, 'lifecycle-evidence': proofPath, output: join(f.root, 'verified.json') };
  writeFileSync(proofPath, JSON.stringify(proof));
  let result = cli(options); assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(options.output));
  assert.equal(record.lifecycleGate.status, 'verified-for-maintainer-review');
  assert.deepEqual(record.lifecycleGate.evidence, proof);
  const repeated = { ...options, output: join(f.root, 'repeated.json') };
  result = cli(repeated); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(options.output, 'utf8'), readFileSync(repeated.output, 'utf8'));
  for (const sample of ['current', 'baseline']) {
    const bad = structuredClone(proof); bad.cost[sample].jobs = Array.from({ length: 8 }, () => ({}));
    writeFileSync(proofPath, JSON.stringify(bad));
    const rejected = { ...options, output: join(f.root, `rejected-${sample}.json`) };
    result = cli(rejected); assert.equal(result.status, 1); assert.match(result.stderr, /cost jobs/);
    assert.equal(existsSync(rejected.output), false);
  }
  const contradictory = structuredClone(proof);
  contradictory.cost.current.jobs[0].steps[0].durationSeconds = 1e12;
  writeFileSync(proofPath, JSON.stringify(contradictory));
  const rejectedTiming = { ...options, output: join(f.root, 'rejected-timing.json') };
  result = cli(rejectedTiming); assert.equal(result.status, 1); assert.match(result.stderr, /exceeds enclosing job/);
  assert.equal(existsSync(rejectedTiming.output), false);
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.equal(f.git(['rev-parse', 'HEAD']), f.head);
  assert.equal(f.git(['tag', '--list']), '');
});
