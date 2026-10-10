import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { digest } from './installation-state.mjs';
export function candidateGit(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed; fetch full incorporated upstream history and select the exact source checkout: ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trimEnd();
}
export function compareUpstream(source, upstreamCommit, sourceCommit) {
  candidateGit(source, ['merge-base', '--is-ancestor', upstreamCommit, sourceCommit]);
  const sharedWorkflowDiff = candidateGit(source, ['diff', '--no-ext-diff', '--no-textconv', upstreamCommit, sourceCommit, '--', 'skills', 'agents']);
  const changedPaths = candidateGit(source, ['diff', '--name-only', '-z', upstreamCommit, sourceCommit, '--', 'skills', 'agents']).split('\0').filter(Boolean).sort();
  const prefix = candidateGit(source, ['rev-parse', '--show-prefix']);
  const skills = commit => candidateGit(source, ['ls-tree', '-r', '--full-name', '--name-only', commit, '--', 'skills']).split('\n').filter(path => path.startsWith(prefix + 'skills/') && /^skills\/[^/]+\/SKILL\.md$/.test(path.slice(prefix.length))).map(path => path.slice(prefix.length + 7, -9)).sort();
  const previous = skills(upstreamCommit), current = skills(sourceCommit);
  return { upstreamCommit, sharedWorkflowDiffDigest: digest(sharedWorkflowDiff), changedPaths, inventory: { upstreamSkillCount: previous.length, currentSkillCount: current.length, added: current.filter(name => !previous.includes(name)), removed: previous.filter(name => !current.includes(name)) } };
}
export function validateUpstreamReview(comparison, review) {
  assert.equal(review.schemaVersion, 1, 'Unsupported upstream review schema'); assert.equal(review.upstreamCommit, comparison.upstreamCommit, 'Upstream review is for another incorporated base');
  assert.equal(review.sharedWorkflowDiffDigest, comparison.sharedWorkflowDiffDigest, 'Shared workflow delta changed; refresh only affected upstream intent review');
  assert.deepEqual(review.inventory, comparison.inventory, 'Account for added/removed skills explicitly');
  assert.ok(Array.isArray(review.deviations), 'Material workflow deviations need review rationale');
  const accounted = review.deviations.flatMap(group => { assert.ok(typeof group.rationale === 'string' && group.rationale.trim().length >= 20, 'Deviation rationale is missing'); assert.ok(Array.isArray(group.paths), 'Deviation paths missing'); return group.paths; });
  assert.deepEqual(accounted.slice().sort(), comparison.changedPaths, 'Account for every changed shared workflow path once');
  assert.ok(Array.isArray(review.upstreamCandidates) && Array.isArray(review.limitations), 'Identify upstreamable fixes and semantic verification limits');
  assert.ok(review.limitations.length && review.limitations.every(item => typeof item === 'string' && item.trim()), 'Record known verification limits');
  return { ...comparison, deviations: review.deviations, upstreamCandidates: review.upstreamCandidates, limitations: review.limitations, reviewDigest: digest(JSON.stringify(review)) };
}
