#!/usr/bin/env node
import { nativeFixtures, runNativeFixtures } from './lib/native-fixtures.mjs';
import { timingEnvironment } from './lib/ci-timing.mjs';
import { installLegacy } from '../tests/fixtures/legacy-installation.mjs';
import { prepareStagedActivation, applyStagedActivation } from './lib/installation-activation.mjs';
import { rollbackInstallation } from './lib/installation-rollback.mjs';
import { removeInstallation } from './lib/installation-removal.mjs';
import { stateFrom } from './lib/installation-state.mjs';
import { stagePackage, renderStagedArtifacts, verifyGeneration } from './lib/installation-storage.mjs';
import { observeHost, loadHosts } from './lib/tested-hosts.mjs';
import { inspectNativeDiscovery, inspectClaudePlugin } from './lib/installation-discovery.mjs';
import { checkScopeContracts } from './lib/scope-contracts.mjs';
import { isolatedEnvironment } from './lib/test-environment.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, symlinkSync, mkdtempSync, mkdirSync, readdirSync, rmSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = readdirSync(join(source, 'skills')).sort();
const temporary = mkdtempSync(join(tmpdir(), 'pstack-hosts-'));
const project = join(temporary, 'project');
mkdirSync(project);
const isolated = { ...isolatedEnvironment(temporary), ...timingEnvironment() };
const cancellation = new AbortController();
const cancel = () => cancellation.abort();
process.on('SIGTERM', cancel); process.on('SIGINT', cancel);
const signal = cancellation.signal;
let commandNumber = 0;
function command(executable, args, env = {}) {
  signal.throwIfAborted();
  const output = join(temporary, `command-${commandNumber++}.txt`);
  const descriptor = openSync(output, "w");
  const result = spawnSync(executable, args, { cwd: project, env: { ...isolated, PWD: project, ...env }, encoding: 'utf8', stdio: ['ignore', descriptor, 'pipe'], timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  closeSync(descriptor);
  const details = `${executable} ${args.join(' ')}: ${result.error?.message || result.status}\n${result.stderr?.slice(-4000)}\n${readFileSync(output, 'utf8').slice(-4000)}`;
  assert.ok(!result.error && result.status === 0, details);
  return readFileSync(output, 'utf8');
}
function checkNames(names) {
  assert.deepEqual([...new Set(names.map(name => name.replace(/^pstack:/, '')))].sort(), expected);
}


try {
  const install = (target, remove = false) => command(process.execPath, [join(source, 'scripts/install.mjs'), '--target', target, '--project', project, ...(remove ? ['--uninstall'] : [])], { XDG_CONFIG_HOME: join(temporary, 'config') });
  async function stagedFixture(target) {
    const generation = stagePackage({ source, root: project });
    const artifacts = await renderStagedArtifacts({ root: project, generation, targets: [target], opencodeRoot: '.opencode' });
    for (const [name, bytes] of artifacts.contents) {
      const path = join(project, name.replace('@opencode/', '.opencode/'));
      assert.equal(readFileSync(path, 'utf8'), bytes.toString(), `Retained renderer differs: ${name}`);
    }
    if (stateFrom(join(project, '.pstack/install.json')).version === 4) return () => {};
    rmSync(join(project, '.pstack/package'), { recursive: true });
    symlinkSync(artifacts.state.entries['.pstack/package'].to, join(project, '.pstack/package'));
    return () => {
      rmSync(join(project, '.pstack/package'));
      cpSync(verifyGeneration(project, generation), join(project, '.pstack/package'), { recursive: true });
    };
  }
  command('git', ['init', '-q']);
  const host = process.argv[2] || 'all';
  assert.ok(['all', 'codex', 'opencode', 'claude-code'].includes(host), 'Expected all, codex, opencode, or claude-code');
  const scenario = process.argv[3] === '--scenario' && process.argv[4];
  assert.ok(process.argv.length === 3 || process.argv.length === 2 || process.argv.length === 5 && nativeFixtures(host).some(item => item.host === host && item.scenario === scenario), 'Invalid native fixture selection');
  if (!scenario) {
    for (const row of loadHosts().filter(row => host === 'all' || row.host === host)) observeHost(row.host, { ...isolated, PSTACK_HOST_VERSION: process.env.PSTACK_HOST_VERSION || '' });
    await runNativeFixtures(nativeFixtures(host).map(item => ({
      name: `${item.host}:${item.scenario}`, executable: process.execPath,
      args: [fileURLToPath(import.meta.url), item.host, '--scenario', item.scenario],
      env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, ...timingEnvironment() },
    })), { signal });
  } else {
  const selected = name => scenario === name;
  if (selected('initial') && host === 'claude-code') {
    const generation = stagePackage({ source, root: project });
    const inventory = await inspectClaudePlugin({ executable: 'claude', source: verifyGeneration(project, generation), project, env: isolated, environmentOwnership: 'isolated-test', signal });
    checkNames(inventory.skills);
    assert.deepEqual(inventory.agents.sort(), ['comment-sicko', 'poteto-agent']);
    console.log(`Claude Code: manifest validated; all ${expected.length} skills and both plugin agents discovered.`);
  }
  if (selected('initial') && host === 'opencode') {
    mkdirSync(join(project, '.pstack'), { recursive: true });
    writeFileSync(join(project, '.pstack/models.json'), JSON.stringify({ version: 1, hosts: { opencode: { roles: { 'bug-fix': 'pstack-fixture/test' } } } }));
    install('opencode');
    const restoreCopiedFixture = await stagedFixture('opencode');
    const env = { XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'), OPENCODE_DISABLE_MODELS_FETCH: 'true' };
    const mapping = JSON.parse(readFileSync(join(project, '.pstack/opencode-models.json'), 'utf8'));
    const discovery = await inspectNativeDiscovery({ host: 'opencode', executable: 'opencode', project, scope: 'project', env: { ...isolated, ...env }, expected, bundles: [join(project, '.pstack/package')], agents: ['poteto-agent', 'comment-sicko', mapping.agents['pstack-fixture/test']], actualVersion: process.env.PSTACK_HOST_VERSION || loadHosts().find(row => row.host === 'opencode').version, environmentOwnership: 'isolated-test', signal });
    assert.equal(discovery.status, 'observed', JSON.stringify(discovery));
    assert.equal(discovery.classification, 'identified-source', JSON.stringify(discovery));
    assert.match(JSON.stringify(discovery.agents.at(-1).model), /pstack-fixture/);
    restoreCopiedFixture();
    install('opencode', true);
    console.log(`OpenCode: all ${expected.length} skills and native subagent discovered.`);
  }
  if (selected('rollback') && host === 'opencode') {
    const env = { XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'), OPENCODE_DISABLE_MODELS_FETCH: 'true' };
    const rollbackProject = join(temporary, 'rollback-project'), candidate = join(temporary, 'rollback-source'); mkdirSync(rollbackProject); cpSync(source, candidate, { recursive: true });
    const lifecycleEnv = { ...isolated, ...env }, lifecycle = { source: candidate, root: rollbackProject, globalRoot: isolated.HOME, options: { target: 'opencode' }, env: lifecycleEnv };
    mkdirSync(join(rollbackProject, '.pstack'));
    const modelPath = join(rollbackProject, '.pstack/models.json');
    writeFileSync(modelPath, JSON.stringify({ version: 1, roles: { 'bug-fix': 'pstack-fixture/model-A' } }));
    assert.equal((await applyStagedActivation(await prepareStagedActivation(lifecycle))).status, 'applied');
    writeFileSync(join(candidate, 'native-rollback-fixture.txt'), 'updated release');
    assert.equal((await applyStagedActivation(await prepareStagedActivation(lifecycle))).status, 'applied');
    const configB = JSON.stringify({ version: 1, roles: { 'bug-fix': 'pstack-fixture/model-B' } }); writeFileSync(modelPath, configB);
    const rolled = await rollbackInstallation({ root: rollbackProject, globalRoot: isolated.HOME, env: lifecycleEnv }); assert.equal(rolled.status, 'applied'); assert.equal(rolled.regenerated, true); assert.equal(readFileSync(modelPath, 'utf8'), configB);
    const nativeMap = JSON.parse(readFileSync(join(rollbackProject, '.pstack/opencode-models.json')));
    assert.deepEqual(Object.keys(nativeMap.agents), ['pstack-fixture/model-B']);
    const rolledDiscovery = await inspectNativeDiscovery({ host: 'opencode', executable: 'opencode', project: rollbackProject, scope: 'project', env: lifecycleEnv, expected, bundles: [join(rollbackProject, '.pstack/package')], agents: ['poteto-agent', 'comment-sicko', nativeMap.agents['pstack-fixture/model-B']], actualVersion: process.env.PSTACK_HOST_VERSION || loadHosts().find(row => row.host === 'opencode').version, environmentOwnership: 'isolated-test', signal });
    assert.equal(rolledDiscovery.classification, 'identified-source', JSON.stringify(rolledDiscovery)); assert.match(JSON.stringify(rolledDiscovery.agents.at(-1).model), /model-B/);
    assert.equal((await removeInstallation({ root: rollbackProject })).status, 'applied');
    console.log('OpenCode rollback: retained previous renderer produced current model-B agents; native catalog confirmed identity and current model; config preserved.');

  }
  if (selected('initial') && host === 'codex') {
    install('codex');
    await stagedFixture('codex');
    const discovery = await inspectNativeDiscovery({ host: 'codex', executable: 'codex', project, scope: 'project', env: isolated, expected, bundles: [join(project, '.pstack/package')], actualVersion: process.env.PSTACK_HOST_VERSION || loadHosts().find(row => row.host === 'codex').version, environmentOwnership: 'isolated-test', signal });
    assert.equal(discovery.status, 'observed', JSON.stringify(discovery));
    assert.equal(discovery.classification, 'identified-source', JSON.stringify(discovery));
    console.log(`Codex: all ${expected.length} skills discovered with no loading errors.`);
  }
  if (selected('legacy') && ['codex', 'opencode'].includes(host)) for (const legacyHost of ['codex', 'opencode'].filter(value => host === 'all' || host === value)) {
    const legacyProject = join(temporary, 'legacy-' + legacyHost); mkdirSync(legacyProject);
    const schema = legacyHost === 'codex' ? 1 : 2; installLegacy({ source, root: legacyProject, targets: [legacyHost], schema });
    const args = ['--project', legacyProject];
    command(process.execPath, [join(source, 'scripts/install.mjs'), ...args]);
    command(process.execPath, [join(source, 'scripts/rollback.mjs'), ...args]);
    const legacyDiscovery = await inspectNativeDiscovery({ host: legacyHost, executable: legacyHost, project: legacyProject, scope: 'project', env: isolated, expected, bundles: [join(legacyProject, '.pstack/package')], ...(legacyHost === 'opencode' ? { agents: ['poteto-agent', 'comment-sicko'] } : {}), actualVersion: process.env.PSTACK_HOST_VERSION || loadHosts().find(row => row.host === legacyHost).version, environmentOwnership: 'isolated-test', signal });
    assert.equal(legacyDiscovery.classification, 'identified-source', JSON.stringify(legacyDiscovery));
    command(process.execPath, [join(source, 'scripts/install.mjs'), ...args]); command(process.execPath, [join(source, 'scripts/uninstall.mjs'), ...args]);
    assert.equal(stateFrom(join(legacyProject, '.pstack/install.json')).targets.length, 0);
    console.log(`${legacyHost}: schema-${schema} legacy layout migrated, rolled back, native-discovered, updated and uninstalled through public commands.`);
  }
  if (selected('scopes')) await checkScopeContracts({ host, source, expected, signal });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
  rmSync(temporary, { recursive: true, force: true });
}
