import { startTiming } from './ci-timing.mjs';
import { timingEnvironment } from './ci-timing.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnvironment } from './test-environment.mjs';
import { inspectNativeDiscovery, classifyDiscoveryCatalog } from './installation-discovery.mjs';
import { characterizeDiscoverySafety } from './discovery-safety-check.mjs';
import { loadHosts } from './tested-hosts.mjs';

export const classifyScopeCatalog = classifyDiscoveryCatalog;
// Assertions for the pinned native fixture; policy must not rewrite observations.
export function assertScopeObservation({ host, scenario, result, expected, bundles, independent }) {
  const label = `${host} ${scenario}`;
  assert.equal(result.status, 'observed', label);
  const canonical = bundles.map(bundle => realpathSync(bundle));
  const ordered = entries => entries.map(entry => JSON.stringify(entry)).sort();
  const entry = (name, bundle) => ({ name: host === 'codex' ? `pstack:${name}` : name, origin: join(bundle, 'skills', name, 'SKILL.md') });
  let wanted = expected.map(name => entry(name, canonical[0]));
  let classification = 'identified-source', completeBundles = [canonical[0]], coherentBundle = canonical[0];
  const independentIdentities = [];
  if (scenario === 'both-scopes' && host === 'codex') {
    wanted = canonical.flatMap(bundle => expected.map(name => entry(name, bundle)));
    classification = 'ambiguous-sources'; completeBundles = canonical; coherentBundle = null;
  } else if (scenario === 'both-scopes' && host === 'opencode') {
    // Pinned OpenCode scans can select either project-only or mixed origins.
    // All-global resolution has not been observed in this fixture baseline.
    wanted = expected.map(name => {
      const matches = result.entries.filter(item => item.name === name);
      assert.equal(matches.length, 1, `${label}: exactly one ${name}`);
      assert.ok(canonical.some(bundle => matches[0].origin === entry(name, bundle).origin), `${label}: unexpected origin for ${name}`);
      return matches[0];
    });
    const projectCount = wanted.filter(item => item.origin === entry(item.name, canonical[0]).origin).length;
    assert.ok(projectCount > 0, `${label}: unobserved all-global resolution`);
    if (projectCount !== expected.length) { classification = 'ambiguous-sources'; completeBundles = []; coherentBundle = null; }
  }
  if (scenario === 'independent-same-name' && host === 'codex') {
    wanted.push({ name: 'poteto-mode', origin: realpathSync(independent) });
    independentIdentities.push('poteto-mode');
  }
  assert.deepEqual(ordered(result.entries), ordered(wanted), `${label}: identities and exact origins`);
  assert.equal(result.classification, classification, `${label}: classification`);
  assert.equal(result.coherentBundle, coherentBundle, `${label}: coherent bundle`);
  assert.deepEqual([...result.completeBundles].sort(), [...completeBundles].sort(), `${label}: complete bundles`);
  assert.deepEqual(result.missing, [], `${label}: missing identities`);
  assert.deepEqual(result.unexpected, [], `${label}: unexpected identities`);
  assert.deepEqual(result.independentIdentities, independentIdentities, `${label}: independent identities`);
}

export function assertIndependentOrigin(entries, independent) {
  const matching = entries.filter(entry => entry.name === 'poteto-mode');
  assert.equal(matching.length, 1, 'Separate project must resolve exactly one independent poteto-mode');
  assert.equal(realpathSync(matching[0].location), realpathSync(independent));
}
export async function checkScopeContracts({ host, source, expected, signal }) {
  const selected = loadHosts().filter(row => host === 'all' || row.host === host);
  for (const row of selected) {
    const temporary = mkdtempSync(join(tmpdir(), `pstack-scopes-${row.host}-`));
    const env = { ...isolatedEnvironment(temporary), ...timingEnvironment() }, project = join(temporary, 'project');
    // Match the default standalone Claude root while retaining a temporary home.
    env.CLAUDE_CONFIG_DIR = join(env.HOME, '.claude'); mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
    mkdirSync(project);
    let number = 0;
    const command = (exe, args, cwd = project) => {
      signal?.throwIfAborted();
      const output = join(temporary, `command-${number++}.txt`);
      const descriptor = openSync(output, 'w');
      const finishTiming = ['opencode', 'claude'].includes(exe) ? startTiming('native-command', exe === 'opencode' ? 'opencode debug skill' : 'claude plugin details') : () => {};
      const result = spawnSync(exe, args, { cwd, env: { ...env, PWD: cwd }, encoding: 'utf8', stdio: ['ignore', descriptor, 'pipe'], timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      finishTiming({ status: !result.error && result.status === 0 ? 'passed' : 'failed', exitCode: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT' });
      closeSync(descriptor);
      assert.ok(!result.error && result.status === 0, `${exe} ${args.join(' ')}: ${result.error?.message || result.stderr}`);
      return readFileSync(output, 'utf8');
    };
    const install = (scope, uninstall = false) => command(process.execPath, [join(source, 'scripts/install.mjs'), '--target', row.host, ...(scope === 'global' ? ['--global'] : ['--project', project]), ...(uninstall ? ['--uninstall'] : [])]);
    const bundle = scope => join(scope === 'global' ? env.HOME : project, '.pstack/package');
    const results = [];
    const inspect = async (scenario, scopes, independent) => {
      if (row.host === 'claude-code') {
        results.push({ scenario, classification: 'unavailable-evidence', reason: 'No standalone catalog/origin command is exposed; standalone mock invocation is separate evidence.' });
        return;
      }
      const result = await inspectNativeDiscovery({ host: row.host, executable: row.executable, project, scope: scopes.join('+'), env, expected, bundles: scopes.map(bundle), actualVersion: process.env.PSTACK_HOST_VERSION || row.version, environmentOwnership: 'isolated-test', signal });
      assertScopeObservation({ host: row.host, scenario, result, expected, bundles: scopes.map(bundle), independent });
      results.push({ scenario, ...result, ...(scenario === 'both-scopes' ? { policy: { supported: false, reason: 'Use one pstack installation scope; catalog resolution does not establish safe duplicate-scope precedence.' } } : {}) });
    };
    try {
      command('git', ['init', '-q']);
      install('project'); await inspect('project-only', ['project']);
      const safety = await characterizeDiscoverySafety({ temporary, project, env, row, expected, signal, bundles: [bundle('project')] });
      results.push({ scenario: 'existing-environment-safety', classification: 'unavailable-evidence', ...safety });
      install('project', true);
      install('global'); await inspect('global-only', ['global']);
      install('project'); await inspect('both-scopes', ['project', 'global']);
      install('global', true);
      const directory = row.host === 'opencode' ? join(env.XDG_CONFIG_HOME, 'opencode/skills/independent-poteto')
        : row.host === 'claude-code' ? join(env.CLAUDE_CONFIG_DIR, 'skills/independent-poteto') : join(env.HOME, '.agents/skills/independent-poteto');
      mkdirSync(directory, { recursive: true });
      const independentPath = join(directory, 'SKILL.md');
      const independentContent = '---\nname: poteto-mode\ndescription: Independent same-name fixture\n---\n\nIndependent fixture; never invoke a model.\n';
      writeFileSync(independentPath, independentContent);
      await inspect('independent-same-name', ['project'], independentPath);
      if (row.host === 'codex') {
        results.at(-1).coexistence = { status: 'coherent', pstackScope: 'project', independentScope: 'global', sameNameQualified: true };
      }
      if (row.host === 'opencode') {
        const same = results.at(-1);
        same.coexistence = { status: 'unsupported', reason: 'Observed project precedence hides the independent global same-name skill in this project. Use a separate project for the independent skill.' };
        const independentProject = join(temporary, 'independent-project'); mkdirSync(independentProject);
        const independent = JSON.parse(command('opencode', ['--pure', 'debug', 'skill'], independentProject));
        assertIndependentOrigin(independent, independentPath);
        results.push({ scenario: 'independent-separate-project', classification: 'identified-source', identity: 'poteto-mode', origin: join(directory, 'SKILL.md'), reason: 'Project-scoped pstack leaves the independent global skill available in another project.' });
      }
      if (row.host === 'claude-code') {
        const inventory = command('claude', ['--plugin-dir', source, 'plugin', 'details', 'pstack']);
        assert.equal(Number(inventory.match(/Skills \((\d+)\)/)?.[1]), expected.length);
        results.push({ scenario: 'native-plugin-plus-standalone', classification: 'conflicting-registration', reason: 'Native plugin inventory registers pstack:poteto-mode while standalone roots also exist; origin precedence is not observable. Use one pstack method per scope.' });
      }
      assert.equal(readFileSync(independentPath, 'utf8'), independentContent, 'Independent skill bytes changed');
      const report = { schemaVersion: 1, host: row.host, expectedVersion: process.env.PSTACK_HOST_VERSION || row.version, results };
      const reportDirectory = process.env.PSTACK_REPORT_DIR || (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'pstack-evidence') : null);
      if (reportDirectory) { mkdirSync(reportDirectory, { recursive: true }); writeFileSync(join(reportDirectory, `installation-contract-${row.host}.json`), JSON.stringify(report, null, 2) + '\n'); }
      console.log(`${row.host} scope contract: ${results.map(result => `${result.scenario}=${result.classification}`).join(', ')}`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
