import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDiscoveryCatalog, inspectNativeDiscovery, inspectClaudePlugin, inspectExistingInstallation } from '../scripts/lib/installation-discovery.mjs';
import { codexSkills } from '../scripts/lib/native-catalog.mjs';
import { discoveryCommand } from '../scripts/lib/discovery-process.mjs';
import { loadHosts } from '../scripts/lib/tested-hosts.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-discovery-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = name => { const path = join(root, name); mkdirSync(join(path, 'skills/how'), { recursive: true }); writeFileSync(join(path, 'skills/how/SKILL.md'), 'fixture'); return path; };
  const one = bundle('one'), two = bundle('two'), foreign = join(root, 'foreign.md'); writeFileSync(foreign, 'independent');
  return { root, one, two, foreign, entries: path => [{ name: 'how', path: join(path, 'skills/how/SKILL.md') }] };
}
test('catalogs allow unrelated entries but identify shadowing, duplicates, missing and malformed origins', t => {
  const f = fixture(t), entries = f.entries(f.one);
  assert.equal(classifyDiscoveryCatalog([...entries, { name: 'unrelated', path: '/not-read' }], ['how'], [f.one]).classification, 'identified-source');
  assert.equal(classifyDiscoveryCatalog([...entries, ...f.entries(f.two)], ['how'], [f.one, f.two]).classification, 'ambiguous-sources');
  assert.equal(classifyDiscoveryCatalog([...entries, { name: 'how', path: f.foreign }], ['how'], [f.one]).classification, 'conflicting-registration');
  assert.equal(classifyDiscoveryCatalog([{ name: 'how', path: f.foreign }], ['how'], [f.one]).classification, 'missing-registration');
  for (const invalid of [{}, [{ name: 'how' }], [{ name: 'how', path: '/missing-file' }]]) assert.throws(() => classifyDiscoveryCatalog(invalid, ['how'], [f.one]));
  assert.equal(classifyDiscoveryCatalog([...entries, { name: 'unrelated', path: f.foreign }], ['how'], [f.one], { exact: true }).classification, 'missing-registration');
});
test('supplied projects share the native runner without installation or clean-fixture substitution', async t => {
  const f = fixture(t), executable = join(f.root, 'catalog');
  writeFileSync(executable, `#!${process.execPath}\nconsole.log(JSON.stringify([{name:'how',location:process.cwd()+'/skills/how/SKILL.md'},{name:'unrelated',location:'/not-read'}]));\n`, { mode: 0o755 });
  const row = loadHosts().find(row => row.host === 'opencode');
  for (const project of [f.one, f.two]) {
    const result = await inspectNativeDiscovery({ host: row.host, executable, project, scope: 'project', env: {}, expected: ['how'], bundles: [project], actualVersion: row.version, environmentOwnership: 'isolated-test' });
    assert.equal(result.status, 'observed', JSON.stringify(result)); assert.equal(result.classification, 'identified-source'); assert.ok(result.entries[0].origin.endsWith(project.slice(-3) + '/skills/how/SKILL.md'));
    assert.equal(readFileSync(join(project, 'skills/how/SKILL.md'), 'utf8'), 'fixture');
  }
});
test('automatic existing discovery and unsupported methods never execute supplied readers', async t => {
  const f = fixture(t), base = { executable: '/never-launch', project: f.one, scope: 'project', env: {}, expected: ['how'], bundles: [f.one], catalogReader: () => assert.fail('must not launch') };
  for (const host of ['codex', 'opencode', 'claude-code', 'cursor']) {
    const result = await inspectNativeDiscovery({ ...base, host, actualVersion: loadHosts().find(row => row.host === host)?.version }); assert.equal(result.status, 'unavailable'); assert.equal(result.safety.automaticReadOnly, false);
  }
  assert.equal((await inspectNativeDiscovery({ ...base, host: 'codex', actualVersion: '999.0.0' })).status, 'unavailable');
  assert.equal((await inspectClaudePlugin({ ...base, source: f.root })).status, 'unavailable');
});
test('bounded runners retain failure diagnostics, reject malformed catalog and terminate timeouts/output floods', async t => {
  const f = fixture(t), options = { project: f.one, env: {}, timeout: 150 };
  await assert.rejects(discoveryCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options), /timedOut.*true/);
  await assert.rejects(discoveryCommand(process.execPath, ['-e', "console.error('retained diagnostic');process.exit(9)"], { ...options, timeout: 2000 }), /retained diagnostic/);
  await assert.rejects(discoveryCommand(process.execPath, ['-e', "console.log('x'.repeat(100000))"], { ...options, timeout: 2000, maxBytes: 1000 }), /oversized.*true/);
  await assert.rejects(discoveryCommand('/missing-provider', [], options), /ENOENT/);
  const result = await inspectNativeDiscovery({ host: 'codex', executable: '/unused', project: f.one, scope: 'project', env: {}, expected: ['how'], bundles: [f.one], actualVersion: loadHosts().find(row => row.host === 'codex').version, environmentOwnership: 'isolated-test', catalogReader: () => [{ name: 'how' }] });
  assert.equal(result.status, 'failed'); assert.match(result.evidence.error, /missing origin/);
});

test('existing installation caller diagnoses supplied scope without installing a fixture', async t => {
  const f = fixture(t), before = readdirSync(f.one);
  const report = await inspectExistingInstallation({ root: f.one, globalRoot: f.root, targets: ['cursor'], env: {} });
  assert.equal(report.scope.root.endsWith('/one'), true);
  assert.equal(report.state, 'uninstalled'); assert.equal(report.discovery.probes[0].host, 'cursor');
  assert.deepEqual(readdirSync(f.one), before);
});

test('Codex app-server timeout and missing executable are bounded', async t => {
  const f = fixture(t), executable = join(f.root, 'hanging-codex');
  writeFileSync(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(codexSkills(f.one, {}, { executable, timeout: 150 }), /timed out/);
  assert.ok(Date.now() - started < 5000, 'requested timeout was ignored');
  await assert.rejects(codexSkills(f.one, {}, { executable: '/missing-codex', timeout: 150 }), /ENOENT/);
});
