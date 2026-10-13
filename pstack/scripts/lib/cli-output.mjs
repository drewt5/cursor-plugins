import { quote } from './activation-journal.mjs';

const safeText = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
const lines = values => values.length ? values.join('\n') + '\n' : '';
const subject = finding => safeText(finding.subject);
const explanations = {
  DISCOVERY_UNAVAILABLE: () => 'Host loading was not checked. Installed files and host loading are separate checks.',
  HOST_VERSION_UNKNOWN: finding => `${subject(finding)} version ${safeText(finding.evidence?.actualVersion)} differs from the recorded tested version ${safeText(finding.evidence?.testedVersion)}. Compatibility is unverified.`,
  DUPLICATE_PSTACK: finding => `${subject(finding)} is installed in multiple scopes: ${(finding.evidence?.scopes || []).map(safeText).join(', ')}. The active source is unknown.`,
  HOST_MISSING: finding => `${subject(finding)} executable was not found.`,
  HOST_PROBE_TIMEOUT: finding => `${subject(finding)} did not answer the version check in time.`,
  HOST_PROBE_FAILED: finding => `${subject(finding)} could not complete the version check.`,
  HOST_VERSION_INVALID: finding => `${subject(finding)} did not report a usable version.`,
  OWNED_MISSING: finding => `Managed file is missing: ${subject(finding)}.`,
  OWNED_MODIFIED: finding => `Managed path was modified: ${subject(finding)}. User content was preserved.`,
  OWNED_REPLACED: finding => `Managed path was replaced: ${subject(finding)}. User content was preserved.`,
  PATH_UNSAFE: finding => `Managed path cannot be accessed safely: ${subject(finding)}. User content was preserved.`,
  OWNED_MODE_CHANGED: finding => `Managed executable permissions changed: ${subject(finding)}.`,
  ROLLBACK_UNAVAILABLE: finding => `The previous installation cannot be restored from ${subject(finding)}.`,
  MODEL_ADAPTERS_STALE: finding => `Installed model adapters no longer match current settings in ${subject(finding)}.`,
  MODEL_CONFIG_INVALID: finding => `Model settings cannot be loaded in ${subject(finding)}.`,
  GENERATION_INVALID: finding => `Retained package integrity failed: ${subject(finding)}. User content was preserved.`,
  PACKAGE_DIGEST_CHANGED: finding => `Managed package contents differ from the recorded installation in ${subject(finding)}. User content was preserved.`,
  INSPECTION_DENIED: finding => `Installation inspection was denied in ${subject(finding)}.`,
  RECEIPT_INVALID: finding => `Installation ownership records cannot be read in ${subject(finding)}.`,
  RECOVERY_STATE_INVALID: finding => `Recovery state cannot be read in ${subject(finding)}.`,
  RECOVERY_CLEANUP_PENDING: finding => `Operation cleanup remains unfinished in ${subject(finding)}.`,
  RECOVERY_REQUIRED: finding => `An interrupted operation requires recovery in ${subject(finding)}.`,
  HOST_ROOT_CHANGED: finding => `${subject(finding)} now uses ${safeText(finding.evidence?.configuredRoot)}; installed files remain in ${safeText(finding.evidence?.recordedRoot)}.`,
  SCOPE_INSPECTION_UNAVAILABLE: finding => `The other installation scope could not be inspected: ${subject(finding)}. The active source is unknown.`,
  DIAGNOSTIC_EXECUTION_FAILED: finding => `Installation verification could not complete for ${subject(finding)}.`
};
function command(context, name, scope = context.global ? '--global' : `--project ${quote(context.root)}`) {
  return safeText(`node ${quote(`${context.scriptsRoot || 'pstack/scripts'}/${name}.mjs`)} ${scope}`);
}
function findingText(finding, context) {
  const explain = Object.hasOwn(explanations, finding.code) ? explanations[finding.code] : null;
  let action = finding.code === 'DISCOVERY_UNAVAILABLE' ? '' : safeText(finding.action);
  if (finding.code === 'DUPLICATE_PSTACK') action = `Inspect each scope with ${command(context, 'doctor')} and ${command(context, 'doctor', '--global')}. Remove the unwanted scope with ${command(context, 'uninstall')} --target ${safeText(finding.subject)}, or use --global for the global scope.`;
  const detail = context.verbose ? ` [${safeText(finding.code)}; verification ${safeText(finding.verification || 'unavailable')}]` : '';
  return `${finding.severity === 'error' ? 'Error' : finding.severity === 'warning' ? 'Warning' : 'Note'}: ${explain ? explain(finding) : `${safeText(finding.code)}: ${subject(finding)}.`}${action ? ` ${action}` : ''}${detail}`;
}
function findingLines(findings, context, omittedSubjects = new Set()) {
  const seen = new Set();
  return findings.filter(finding => {
    const key = finding.code === 'DISCOVERY_UNAVAILABLE' ? finding.code : `${finding.code}\0${finding.subject}`;
    if (seen.has(key) || omittedSubjects.has(finding.subject)) return false;
    seen.add(key); return true;
  }).map(finding => ({ severity: finding.severity, text: findingText(finding, context) }));
}
function discoveryFailures(probes, context) {
  return probes.map(probe => `Host loading could not be verified for ${safeText(probe.host)}. Preserve the installation and inspect its registered skill sources with ${command(context, 'doctor')}.${context.verbose ? ` [${safeText(probe.status)}; ${safeText(probe.classification)}]` : ''}`);
}
function details(report) {
  if (!report) return [];
  const output = [];
  if (report.provenance) output.push(`Release identity: ${safeText(report.provenance.version || 'unknown')}; ${safeText(report.provenance.classification)}; source ${safeText(report.provenance.sourceCommit || 'unknown')}; digest ${safeText(report.provenance.packageDigest || 'unknown')}.`);
  for (const host of report.hosts || []) output.push(`${safeText(host.host)} version ${safeText(host.evidence?.actualVersion || 'unavailable')}; tested ${safeText(host.evidence?.testedVersion)}; status ${safeText(host.status)}.`);
  for (const [host, path] of Object.entries(report.configuredRoots || {})) output.push(`${safeText(host)} configured path: ${safeText(path)}.`);
  for (const probe of report.discovery?.probes || []) output.push(`${safeText(probe.host)} discovery: ${safeText(probe.status)}; ${safeText(probe.classification)}.`);
  return output;
}
export function renderPreflight(prepared, context) {
  const conflicts = prepared.plan?.conflicts || [];
  const output = conflicts.map(conflict => {
    const action = conflict.code === 'unsafe-parent'
      ? 'Choose a project path without symlinked host directories, or restore the intended directory yourself.'
      : conflict.ownership === 'unowned' || conflict.code === 'unowned'
        ? 'Pstack cannot adopt existing content. Choose a separate project installation, or move your content before retrying.'
        : conflict.code === 'legacy-conflict'
          ? 'Preserve or move this content before retrying migration.'
          : 'Preserve your edits and restore the recorded managed path before retrying.';
    return `Error: Conflicting path: ${safeText(conflict.path)}. User content was preserved. ${action}${context.verbose ? ` [${safeText(conflict.code || 'conflict')}]` : ''}`;
  });
  output.push(...findingLines([...(prepared.failures || []), ...(prepared.report?.findings || []).filter(item => item.severity === 'warning')], context, new Set(conflicts.map(conflict => conflict.path))).map(item => item.text));
  output.push(...discoveryFailures(prepared.discoveryFailures || [], context));
  return lines([...new Set(output)]);
}
export function renderOperation(outcome, context) {
  const prepared = outcome.prepared, targets = prepared.targets || [];
  const stdout = [`Scope: ${context.global ? 'global' : 'project'} ${safeText(context.root)}.`], stderr = [];
  if (outcome.recovered && outcome.recovered.status !== 'no-operation') stdout.push(outcome.recovered.restored || outcome.recovered.status === 'restored-prior' ? 'Automatic recovery restored the prior installation.' : 'Automatic recovery finished cleanup from an earlier operation.');
  if (outcome.status === 'preflight-failed') {
    stderr.push(outcome.recovered && outcome.recovered.status !== 'no-operation'
      ? 'Preflight rejected the requested operation after automatic recovery. The requested changes were not applied.'
      : 'Preflight rejected the requested operation before activation. No installation files changed.');
    stderr.push(renderPreflight(prepared, context).trimEnd());
  } else if (outcome.status === 'verification-failed-restored') {
    stderr.push(`Verification failed for the attempted ${context.uninstall ? 'removal' : 'installation'} of ${(prepared.selected || targets).map(safeText).join(', ')} in ${safeText(context.root)}. ${outcome.restored ? 'The prior installation was restored; it has not passed a new verification.' : 'Restoration is incomplete.'} Run ${command(context, 'doctor')} to inspect the current state and any retained recovery command before retrying.`);
    if (outcome.failure) stderr.push('The installation diagnostic check could not complete.');
  } else if (context.uninstall) {
    const previous = prepared.plan?.snapshot.previous.targets || [];
    const removed = previous.filter(host => !targets.includes(host));
    stdout.push(removed.length ? `Removed pstack for ${removed.map(safeText).join(', ')}. Remaining hosts: ${targets.map(safeText).join(', ') || 'none'}. User configuration and other files were preserved.` : `Nothing needed removal. Remaining hosts: ${targets.map(safeText).join(', ') || 'none'}.`);
  } else {
    stdout.push(outcome.status === 'unchanged' ? `Pstack is already installed for ${targets.map(safeText).join(', ')}. Nothing needed installation.` : `Pstack files installed for ${targets.map(safeText).join(', ')}.`);
    if (outcome.changed) stdout.push('Restart the affected hosts to load the changed instructions. No model configuration is required.');
  }
  const report = outcome.status === 'preflight-failed' ? null : outcome.report || (outcome.status === 'unchanged' ? prepared.report : null);
  for (const finding of findingLines(report?.findings || [], context)) (['warning', 'error'].includes(finding.severity) ? stderr : stdout).push(finding.text);
  if (!context.uninstall && report?.discovery?.status === 'unavailable' && !report.findings?.some(item => item.code === 'DISCOVERY_UNAVAILABLE')) stdout.push(explanations.DISCOVERY_UNAVAILABLE());
  if (outcome.status === 'verification-failed-restored') stderr.push(...discoveryFailures((report?.discovery?.probes || []).filter(probe => probe.status === 'failed' || ['ambiguous-sources', 'conflicting-registration', 'missing-registration', 'invalid-evidence'].includes(probe.classification)), context));
  if (outcome.cleanupPending) stderr.push(`Warning: Operation cleanup is unfinished in ${safeText(context.root)}. Run ${command(context, 'doctor')} for the retained recovery command.`);
  for (const item of outcome.cleanup?.preserved || []) stderr.push(`Warning: Cleanup remains for ${safeText(item.path)}. Content was preserved. ${safeText(item.action)}`);
  if (context.verbose) stdout.push(...details(report || (outcome.status === 'preflight-failed' ? prepared.report : null)));
  return { stdout: lines(stdout.filter(Boolean)), stderr: lines(stderr.filter(Boolean)) };
}
export function renderDoctor(report, context) {
  const output = [`Pstack: ${safeText(report.state)}`, `Scope: ${safeText(report.scope.kind)} ${safeText(report.scope.root)}`, `Targets: ${(report.selectedTargets || []).map(safeText).join(', ') || 'none recorded'}`, `File integrity: ${safeText(report.integrity.status)}`];
  for (const host of [...(report.hosts || []), ...(report.detectedHosts || [])]) output.push(`${safeText(host.host)}: ${safeText(host.evidence?.actualVersion || 'version unavailable')}; tested ${safeText(host.evidence?.testedVersion)}.`);
  output.push(...findingLines(report.findings, context).map(item => item.text));
  if (report.discovery.status === 'unavailable' && !report.findings.some(item => item.code === 'DISCOVERY_UNAVAILABLE')) output.push(explanations.DISCOVERY_UNAVAILABLE());
  output.push(...discoveryFailures((report.discovery.probes || []).filter(probe => probe.status === 'failed'), context));
  if (context.verbose) output.push(...details(report));
  output.push('Existing running sessions may retain old skills until restart. Restart the host after changing an installation.');
  return lines(output);
}
