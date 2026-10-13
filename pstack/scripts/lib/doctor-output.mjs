// Exit zero includes advisory unknowns. Consumers must inspect verification states.
export function diagnosticExitCode(report) {
  return report.findings.some(finding => finding.severity === 'error') ? 1 : 0;
}
