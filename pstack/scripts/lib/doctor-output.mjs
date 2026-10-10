// Exit zero includes advisory unknowns. Consumers must inspect verification states.
export function diagnosticExitCode(report) {
  return report.findings.some(finding => finding.severity === 'error') ? 1 : 0;
}
export function formatDoctor(report) {
  const lines = [`Pstack: ${report.state}`, `Scope: ${report.scope.kind} ${report.scope.root}`, `Release identity: ${report.provenance?.identity || 'unknown (legacy receipt or uninstalled)'}`, `Targets: ${report.selectedTargets.join(', ') || 'none recorded'}`, `File integrity: ${report.integrity.status}`, `Native discovery: ${report.discovery.status}`];
  for (const host of [...report.hosts, ...(report.detectedHosts || [])]) lines.push(`${host.host}: ${host.evidence.command[0]} ${host.evidence.actualVersion || 'version unavailable'} (${host.status}; tested ${host.evidence.testedVersion})`);
  for (const finding of report.findings) {
    lines.push(`${finding.severity.toUpperCase()} ${finding.code} [${finding.verification}] ${finding.subject}`, `  ${finding.action}`);
  }
  lines.push('Existing running sessions may retain old skills until restart. Restart the host after changing an installation.', 'Provider changes are manual: use the provider’s supported installation tooling to update or return to the reported tested version. Doctor changes no provider packages or plugins.');
  return lines.join('\n') + '\n';
}
