#!/usr/bin/env node
import { observeHost, loadHosts } from './lib/tested-hosts.mjs';
import { codexSkills } from './lib/native-catalog.mjs';
import { checkScopeContracts } from './lib/scope-contracts.mjs';
import { isolatedEnvironment } from './lib/test-environment.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expected = readdirSync(join(source, 'skills')).sort();
const temporary = mkdtempSync(join(tmpdir(), 'pstack-hosts-'));
const project = join(temporary, 'project');
mkdirSync(project);
const isolated = isolatedEnvironment(temporary);
let commandNumber = 0;
function command(executable, args, env = {}) {
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
  command('git', ['init', '-q']);
  const host = process.argv[2] || 'all';
  assert.ok(['all', 'codex', 'opencode', 'claude-code'].includes(host), 'Expected all, codex, opencode, or claude-code');
  for (const row of loadHosts().filter(row => host === 'all' || row.host === host)) observeHost(row.host, { ...isolated, PSTACK_HOST_VERSION: process.env.PSTACK_HOST_VERSION || '' });
  if (host === 'all' || host === 'claude-code') {
    command('claude', ['plugin', 'validate', source]);
    const inventory = command('claude', ['--plugin-dir', source, 'plugin', 'details', 'pstack']);
    const skills = inventory.match(/^\s+Skills \(\d+\)\s+(.+)$/m);
    const agents = inventory.match(/^\s+Agents \(\d+\)\s+(.+)$/m);
    assert.ok(skills && agents, `Claude did not return its plugin component inventory: ${inventory}`);
    checkNames(skills[1].split(', '));
    assert.deepEqual(agents[1].split(', ').sort(), ['comment-sicko', 'poteto-agent']);
    console.log(`Claude Code: manifest validated; all ${expected.length} skills and both plugin agents discovered.`);
  }
  if (host === 'all' || host === 'opencode') {
    mkdirSync(join(project, '.pstack'), { recursive: true });
    writeFileSync(join(project, '.pstack/models.json'), JSON.stringify({ version: 1, hosts: { opencode: { roles: { 'bug-fix': 'pstack-fixture/test' } } } }));
    install('opencode');
    const env = { XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'), OPENCODE_DISABLE_MODELS_FETCH: 'true' };
    const skills = JSON.parse(command('opencode', ['--pure', 'debug', 'skill'], env));
    checkNames(skills.filter(skill => skill.location.replaceAll('\\', '/').includes('/project/')).map(skill => skill.name));
    const agent = JSON.parse(command('opencode', ['--pure', 'debug', 'agent', 'poteto-agent'], env));
    assert.equal(agent.name, 'poteto-agent');
    assert.equal(agent.mode, 'subagent');
    const mapping = JSON.parse(readFileSync(join(project, '.pstack/opencode-models.json'), 'utf8'));
    const modelAgent = JSON.parse(command('opencode', ['--pure', 'debug', 'agent', mapping.agents['pstack-fixture/test']], env));
    assert.match(JSON.stringify(modelAgent.model), /pstack-fixture/);
    install('opencode', true);
    console.log(`OpenCode: all ${expected.length} skills and native subagent discovered.`);
  }
  if (host === 'all' || host === 'codex') {
    install('codex');
    const result = await codexSkills(project, isolated);
    const entry = result.data[0];
    assert.deepEqual(entry.errors, []);
    checkNames(entry.skills.filter(skill => skill.path.replaceAll('\\', '/').includes('/project/')).map(skill => skill.name));
    console.log(`Codex: all ${expected.length} skills discovered with no loading errors.`);
  }
  await checkScopeContracts({ host, source, expected });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
