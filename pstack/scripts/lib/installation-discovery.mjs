import { realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { codexSkills } from './native-catalog.mjs';
import { discoveryCommand } from './discovery-process.mjs';
import { inspectInstallation } from './installation-diagnostics.mjs';
import { loadHosts } from './tested-hosts.mjs';

export function classifyDiscoveryCatalog(entries, expected, bundles, { exact = false } = {}) {
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' || !entry.path)) throw new Error('Malformed discovery catalog or missing origin path');
  const canonicalBundles = bundles.map(bundle => realpathSync(bundle));
  const relevant = entries.filter(entry => expected.includes(entry.name.replace(/^pstack:/, '')));
  const catalog = relevant.map(entry => ({ name: entry.name, origin: realpathSync(entry.path) }));
  const fromBundle = (entry, bundle) => entry.origin.startsWith(join(bundle, 'skills') + sep);
  const native = catalog.filter(entry => canonicalBundles.some(bundle => fromBundle(entry, bundle)));
  const nativeNames = new Set(native.map(entry => entry.name));
  const external = catalog.filter(entry => !canonicalBundles.some(bundle => fromBundle(entry, bundle)));
  const conflicts = external.filter(entry => nativeNames.has(entry.name));
  const missing = expected.filter(name => !native.some(entry => entry.name.replace(/^pstack:/, '') === name));
  const complete = canonicalBundles.filter(bundle => expected.every(name => native.some(entry => entry.origin === join(bundle, 'skills', name, 'SKILL.md'))));
  const sources = new Map();
  for (const entry of catalog) { if (!sources.has(entry.name)) sources.set(entry.name, new Set()); sources.get(entry.name).add(entry.origin); }
  const duplicate = [...sources.values()].some(origins => origins.size > 1);
  const unexpected = exact ? entries.filter(entry => !expected.includes(entry.name.replace(/^pstack:/, ''))).map(entry => entry.name) : [];
  const classification = conflicts.length ? 'conflicting-registration' : missing.length || unexpected.length ? 'missing-registration' : complete.length === 1 && !duplicate ? 'identified-source' : 'ambiguous-sources';
  return { classification, coherentBundle: classification === 'identified-source' ? complete[0] : null, completeBundles: complete, missing, unexpected, independentIdentities: external.filter(entry => !nativeNames.has(entry.name)).map(entry => entry.name), entries: catalog };
}

export async function inspectNativeDiscovery({ host, executable, project, scope, env, expected, bundles, agents = [], timeout = 20000, actualVersion, environmentOwnership = 'existing', exact = false, catalogReader, signal }) {
  if (!project || !scope || !env || !Array.isArray(expected) || !Array.isArray(bundles) || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60000) throw new Error('Discovery requires explicit project, scope, environment, identities, bundles and bounded timeout');
  const row = loadHosts().find(row => row.host === host);
  const safety = { version: actualVersion ?? null, testedVersion: row?.version ?? null, environmentOwnership, automaticReadOnly: false, catalogContract: actualVersion === row?.version ? 'tested-baseline' : 'candidate-unverified' };
  const result = { schemaVersion: 1, host, scope, project, safety, status: 'unavailable', classification: 'unavailable-evidence', agents: [], evidence: {} };
  if (host === 'cursor' || host === 'claude-code') return { ...result, reason: host === 'cursor' ? 'Cursor native GUI discovery is unverified; static integrity remains available.' : 'Claude exposes no safe standalone skills/agents origin inventory. Native plugin inventory and CI mock invocation are separate evidence.' };
  if (!row) throw new Error('Unsupported discovery host');
  if (environmentOwnership !== 'isolated-test') return { ...result, reason: 'Provider startup may write cache/state or load user extensions. Read-only safety is not established for existing environments; no host was launched.' };
  if (typeof actualVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(actualVersion)) return { ...result, reason: 'An observed provider version is required for isolated catalog evidence; no host was launched.' };
  if (!executable) throw new Error('An explicit executable is required for native discovery');
  try {
    let entries;
    if (catalogReader) entries = await catalogReader();
    else if (host === 'codex') {
      const catalog = await codexSkills(project, env, { executable, timeout, signal });
      const entry = catalog?.data?.find(entry => entry.cwd === project) ?? catalog?.data?.[0];
      if (entry?.cwd && realpathSync(entry.cwd) !== realpathSync(project)) throw new Error('Codex returned a catalog for another project');
      if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length) throw new Error('Codex returned an invalid catalog or skill-loading errors');
      entries = entry.skills.map(skill => ({ name: skill.name, path: skill.path }));
    } else {
      entries = JSON.parse(await discoveryCommand(executable, ['--pure', 'debug', 'skill'], { project, env, timeout, signal, timingName: 'opencode debug skill' })).map(skill => ({ name: skill.name, path: skill.location }));
      for (const name of agents) {
        const agent = JSON.parse(await discoveryCommand(executable, ['--pure', 'debug', 'agent', name], { project, env, timeout, signal, timingName: 'opencode debug agent' }));
        if (agent.name !== name || agent.mode !== 'subagent') throw new Error(`Missing or malformed agent: ${name}`);
        result.agents.push({ name, mode: agent.mode, model: agent.model ?? null });
      }
    }
    return { ...result, status: 'observed', ...classifyDiscoveryCatalog(entries, expected, bundles, { exact }), evidence: { catalogSize: entries.length, flags: host === 'codex' ? ['app-server', '--stdio', 'skills/list'] : ['--pure', 'debug', 'skill'], visibility: 'Supplied isolated environment; external user plugins/configuration are outside this view.' } };
  } catch (error) { return { ...result, status: 'failed', classification: 'invalid-evidence', evidence: { error: error.message.slice(-4000) }, reason: 'Native catalog failed; no source was selected.' }; }
}

export async function inspectClaudePlugin({ executable, source, project, env, timeout = 20000, environmentOwnership, signal }) {
  if (environmentOwnership !== 'isolated-test') return { status: 'unavailable', method: 'native-plugin-inventory', reason: 'Plugin validation/inventory startup is only enabled in an isolated test environment.' };
  await discoveryCommand(executable, ['plugin', 'validate', source], { project, env, timeout, signal, timingName: 'claude plugin validate' });
  const body = await discoveryCommand(executable, ['--plugin-dir', source, 'plugin', 'details', 'pstack'], { project, env, timeout, signal, timingName: 'claude plugin details' });
  const skills = body.match(/^\s+Skills \(\d+\)\s+(.+)$/m), agents = body.match(/^\s+Agents \(\d+\)\s+(.+)$/m);
  if (!skills || !agents) throw new Error('Malformed Claude native plugin inventory');
  return { status: 'observed', method: 'native-plugin-inventory', skills: skills[1].split(', '), agents: agents[1].split(', '), standaloneDiscovery: 'unavailable' };
}

export async function inspectExistingInstallation(options) {
  const report = inspectInstallation(options);
  const probes = [];
  for (const host of report.selectedTargets) {
    const row = loadHosts().find(row => row.host === host);
    const actualVersion = report.hosts.find(item => item.host === host)?.evidence.actualVersion;
    probes.push(await inspectNativeDiscovery({ host, executable: row?.executable, project: report.scope.root, scope: report.scope.kind, env: options.env ?? process.env, expected: [], bundles: [], actualVersion }));
  }
  report.discovery = { status: 'unavailable', probes };
  for (const finding of report.findings.filter(item => item.code === 'DISCOVERY_UNAVAILABLE')) {
    const probe = probes.find(item => item.host === finding.subject);
    finding.evidence = { ...finding.evidence, safety: probe.safety, reason: probe.reason };
    finding.action = 'Use static integrity evidence; native startup is not automatically read-only. Run isolated maintainer fixtures to collect limited native evidence.';
  }
  return report;
}
