import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectInstallationTargets } from '../scripts/lib/installation-targets.mjs';
import { withHostVersionFixtures } from './fixtures/host-versions.mjs';
const empty = { targets: [] };
const probe = available => row => ({ status: available.includes(row.host) ? 'passed' : 'failed', code: available.includes(row.host) ? 'HOST_VERSION_TESTED' : 'HOST_MISSING' });
test('selection is deterministic for zero, one, multiple, all and explicit Cursor', () => {
  for (const available of [[], ['codex', 'opencode']]) assert.throws(() => selectInstallationTargets({}, empty, { probe: probe(available), root: '/project with space' }), /--project '\/project with space' --target/);
  assert.deepEqual(selectInstallationTargets({}, empty, { probe: probe(['opencode']) }).selected, ['opencode']);
  assert.deepEqual(selectInstallationTargets({ target: 'all' }, empty, { probe: probe(['codex', 'opencode', 'claude-code']) }).selected, ['codex', 'opencode', 'claude-code']);
  assert.deepEqual(selectInstallationTargets({ target: 'cursor' }, empty, { probe: () => assert.fail('Cursor must not probe a CLI') }).selected, ['cursor']);
  assert.throws(() => selectInstallationTargets({ target: 'codex' }, empty, { probe: probe([]) }), /HOST_MISSING/);
});
test('recorded targets survive unrelated PATH changes and uninstall never probes', () => {
  for (const available of [['codex'], ['codex', 'opencode']]) assert.deepEqual(selectInstallationTargets({}, { targets: ['codex'] }, { probe: probe(available) }).selected, ['codex']);
  for (const previous of [empty, { targets: ['opencode', 'cursor'] }]) assert.deepEqual(selectInstallationTargets({ uninstall: true }, previous, { probe: () => assert.fail('uninstall must work offline') }).selected, previous.targets);
  assert.deepEqual(selectInstallationTargets({}, empty, { probe: row => row.host === 'codex' ? { status: 'unavailable-compatibility', code: 'HOST_VERSION_UNKNOWN' } : probe([])(row) }).selected, ['codex']);
});
test('public CLI auto-selection, ambiguity and receipt-backed offline removal preserve destination', t => {
  const temp = mkdtempSync(join(tmpdir(), 'pstack-targets-')); t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = join(temp, 'project'); mkdirSync(project);
  const run = (available, args = []) => {
    const env = withHostVersionFixtures(join(temp, available.join('-') || 'none'), { HOME: join(temp, 'home'), PATH: '' }, available);
    return spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/install.mjs', import.meta.url)), '--project', project, ...args], { env, encoding: 'utf8' });
  };
  for (const available of [[], ['codex', 'opencode']]) {
    const result = run(available); assert.equal(result.status, 1); assert.match(result.stderr, /Run: node .* --target/); assert.deepEqual(readdirSync(project), []);
  }
  assert.equal(run([], ['--uninstall']).status, 0); assert.deepEqual(readdirSync(project), []);
  assert.equal(run(['codex']).status, 0);
  const receipt = () => JSON.parse(readFileSync(join(project, '.pstack/install.json'))).targets;
  assert.deepEqual(receipt(), ['codex']);
  assert.equal(run(['codex', 'opencode']).status, 0); assert.deepEqual(receipt(), ['codex']);
  assert.equal(run(['codex', 'opencode'], ['--target', 'opencode']).status, 0); assert.deepEqual(receipt(), ['codex', 'opencode']);
  assert.equal(run([], ['--target', 'opencode', '--uninstall']).status, 0); assert.deepEqual(receipt(), ['codex']);
  assert.equal(run([], ['--uninstall']).status, 0); assert.ok(!existsSync(join(project, '.agents/skills/poteto-mode'))); assert.ok(!existsSync(join(project, '.pstack/install.json')));
});
