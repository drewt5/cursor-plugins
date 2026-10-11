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
    const inspect = async (scenario, scopes) => {
      if (row.host === 'claude-code') {
        results.push({ scenario, classification: 'unavailable-evidence', reason: 'No standalone catalog/origin command is exposed; standalone mock invocation is separate evidence.' });
        return;
      }
      const result = await inspectNativeDiscovery({ host: row.host, executable: row.executable, project, scope: scopes.join('+'), env, expected, bundles: scopes.map(bundle), actualVersion: process.env.PSTACK_HOST_VERSION || row.version, environmentOwnership: 'isolated-test', signal });
      assert.equal(result.status, 'observed', JSON.stringify(result));
      results.push({ scenario, ...result });
      if (['project-only', 'global-only'].includes(scenario)) assert.equal(result.classification, 'identified-source', `${row.host} ${scenario}: ${result.classification}; ${result.completeBundles.length} complete bundles`);
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
      writeFileSync(join(directory, 'SKILL.md'), '---\nname: poteto-mode\ndescription: Independent same-name fixture\n---\n\nIndependent fixture; never invoke a model.\n');
      await inspect('independent-same-name', ['project']);
      if (row.host === 'codex') {
        assert.equal(results.at(-1).classification, 'identified-source');
        assert.ok(results.at(-1).independentIdentities.includes('poteto-mode'));
        assert.ok(results.at(-1).entries.some(entry => entry.name === 'pstack:poteto-mode'));
        assert.ok(results.at(-1).entries.some(entry => entry.name === 'poteto-mode' && entry.origin === realpathSync(join(directory, 'SKILL.md'))));
        results.at(-1).coexistence = { status: 'coherent', pstackScope: 'project', independentScope: 'global', sameNameQualified: true };
        assert.equal(readFileSync(join(directory, 'SKILL.md'), 'utf8').includes('Independent fixture'), true);
      }
      if (row.host === 'opencode') {
        const same = results.at(-1);
        same.classification = 'conflicting-registration'; same.coherentBundle = null;
        same.reason = 'The project registration shadows the independent global same-name skill. Same-project coexistence is not proven.';
        const independentProject = join(temporary, 'independent-project'); mkdirSync(independentProject);
        const independent = JSON.parse(command('opencode', ['--pure', 'debug', 'skill'], independentProject));
        assert.ok(independent.some(entry => entry.name === 'poteto-mode' && realpathSync(entry.location) === realpathSync(join(directory, 'SKILL.md'))));
        results.push({ scenario: 'independent-separate-project', classification: 'identified-source', identity: 'poteto-mode', origin: join(directory, 'SKILL.md'), reason: 'Project-scoped pstack leaves the independent global skill available in another project.' });
      }
      if (row.host === 'claude-code') {
        const inventory = command('claude', ['--plugin-dir', source, 'plugin', 'details', 'pstack']);
        assert.equal(Number(inventory.match(/Skills \((\d+)\)/)?.[1]), expected.length);
        results.push({ scenario: 'native-plugin-plus-standalone', classification: 'conflicting-registration', reason: 'Native plugin inventory registers pstack:poteto-mode while standalone roots also exist; origin precedence is not observable. Use one pstack method per scope.' });
      }
      const report = { schemaVersion: 1, host: row.host, expectedVersion: process.env.PSTACK_HOST_VERSION || row.version, results };
      const reportDirectory = process.env.PSTACK_REPORT_DIR || (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'pstack-evidence') : null);
      if (reportDirectory) { mkdirSync(reportDirectory, { recursive: true }); writeFileSync(join(reportDirectory, `installation-contract-${row.host}.json`), JSON.stringify(report, null, 2) + '\n'); }
      console.log(`${row.host} scope contract: ${results.map(result => `${result.scenario}=${result.classification}`).join(', ')}`);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}
