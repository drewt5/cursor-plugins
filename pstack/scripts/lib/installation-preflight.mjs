import { join, resolve } from 'node:path';
import { canonicalPath, safePath, stateFrom, installationSnapshot } from './installation-state.mjs';
import { renderArtifacts } from './installation-artifacts.mjs';
import { planInstallation, applyInstallation } from './installation-plan.mjs';
import { selectInstallationTargets } from './installation-targets.mjs';
import { probeHostVersion } from './installation-diagnostics.mjs';
import { inspectExistingInstallation } from './installation-discovery.mjs';
const skippedVersion = row => ({ status: 'unavailable', code: null, evidence: { command: [row.executable, '--version'], testedVersion: row.version, actualVersion: null, reason: 'Uninstall does not launch host executables.' } });
export function mandatoryDiscoveryFailures(report) {
  if (report.discovery.status === 'failed' && !(report.discovery.probes || []).length) return [{ host: 'selected hosts', status: 'failed', classification: 'invalid-evidence' }];
  return (report.discovery.probes || []).filter(probe => probe.status === 'failed' || probe.status === 'observed' && ['ambiguous-sources', 'conflicting-registration', 'missing-registration', 'invalid-evidence'].includes(probe.classification));
}
export async function prepareInstallation({ source, root, globalRoot, options, env = process.env, diagnose = inspectExistingInstallation, versionProbe = probeHostVersion }) {
  const observations = new Map();
  const probe = row => {
    if (options.uninstall) return skippedVersion(row);
    if (!observations.has(row.host)) observations.set(row.host, versionProbe(row, env));
    return observations.get(row.host);
  };
  const diagnosticOptions = { root, global: !!options.global, globalRoot, env, versionProbe: probe };
  let previous;
  try { previous = stateFrom(safePath(root, '.pstack/install.json')); }
  catch {
    const report = await diagnose({ ...diagnosticOptions, targets: [] });
    return { root, targets: [], selected: [], plan: null, report, failures: report.findings.filter(item => item.severity === 'error'), discoveryFailures: [], options, diagnosticOptions };
  }
  const { selected } = selectInstallationTargets(options, previous, { root, probe, validate: false });
  const targets = options.uninstall ? previous.targets.filter(target => !selected.includes(target)) : [...new Set([...previous.targets, ...selected])].sort();
  const opencodeRoot = options.global ? canonicalPath(resolve(env.XDG_CONFIG_HOME || join(root, '.config'), 'opencode')) : '.opencode';
  const artifacts = renderArtifacts({ source, root, targets, opencodeRoot, global: options.global });
  const snapshot = installationSnapshot({ root, desired: artifacts.state });
  const plan = planInstallation(snapshot, artifacts);
  const report = await diagnose({ ...diagnosticOptions, targets: options.uninstall ? selected : targets });
  // Missing owned artifacts can be restored/removed by this concrete safe plan.
  const failures = report.findings.filter(item => item.severity === 'error' && !(item.code === 'OWNED_MISSING' && plan.operations.some(op => op.path === item.subject && op.action !== 'conflict')));
  const discoveryFailures = options.uninstall ? [] : mandatoryDiscoveryFailures(report);
  return { root, targets, selected, plan, report, failures, discoveryFailures, options, diagnosticOptions };
}
export async function applyPreparedInstallation(prepared, { apply = applyInstallation, diagnose = inspectExistingInstallation } = {}) {
  if (!prepared.plan || prepared.plan.conflicts.length || prepared.failures.length || prepared.discoveryFailures.length) return { status: 'preflight-failed', changed: false, report: prepared.report };
  apply(prepared.plan);
  let report;
  try { report = await diagnose({ ...prepared.diagnosticOptions, targets: prepared.targets }); }
  catch (error) {
    report = { ...prepared.report, discovery: { status: 'failed', probes: [] }, findings: [...prepared.report.findings, { code: 'DIAGNOSTIC_EXECUTION_FAILED', severity: 'error', subject: prepared.root, verification: 'failed', evidence: { error: error.message }, action: 'Files were applied. Preserve diagnostics and run doctor after resolving the diagnostic execution failure; automatic restoration is not yet available.' }] };
  }
  const failed = report.findings.some(item => item.severity === 'error') || !prepared.options.uninstall && mandatoryDiscoveryFailures(report).length > 0;
  return { status: failed ? 'post-apply-failed' : 'applied', changed: true, report };
}
export function formatPreflight(prepared) {
  const lines = [`Scope: ${prepared.options.global ? 'global' : 'project'} ${prepared.root}; selected targets: ${prepared.selected.join(', ') || 'none'}`];
  for (const item of prepared.report.findings) lines.push(`${item.code} [${item.verification}]: ${item.subject}. ${item.action}`);
  for (const conflict of prepared.plan?.conflicts || []) lines.push(`${conflict.code}: ${conflict.reason}: ${conflict.path}`);
  for (const probe of prepared.discoveryFailures) lines.push(`DISCOVERY_FAILED: ${probe.host} ${probe.classification}. Preserve this installation and resolve the conflicting source.`);
  return lines.join('\n');
}
