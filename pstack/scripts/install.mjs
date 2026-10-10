#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hosts } from './lib/installation-state.mjs';
import { prepareInstallation, applyPreparedInstallation, formatPreflight } from './lib/installation-preflight.mjs';
const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const help = `Usage: node pstack/scripts/install.mjs [--target all|${hosts.join('|')}] [--project PATH|--global] [--uninstall] [--dry-run]
Defaults: current project; fresh install selects the only usable CLI host or requires --target.
Re-run/update/uninstall without --target uses recorded hosts; explicit additions are additive.
--uninstall removes only the selected hosts. --target all selects Codex, OpenCode, and Claude Code.
Requires Node.js 20+. Existing skills and local edits are preserved.`;

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--global', '--uninstall', '--help', '--dry-run'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--target', '--project'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}\n${help}`);
  }
  if (options.help) return options;
  if (options.target !== undefined && ![...hosts, 'all'].includes(options.target)) throw new Error(help);
  if (options.global && options.project) throw new Error('Choose --project PATH or --global, not both.');
  if (!options.global && !options.project) options.project = process.cwd();
  return options;
}
async function run(options) {
  const requestedRoot = resolve(options.global ? homedir() : options.project);
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  if (root === source || root.startsWith(source + sep)) throw new Error('Install into a project outside the pstack source package.');
  const prepared = await prepareInstallation({ source, root, globalRoot: homedir(), options });
  const { targets, plan, report, failures, discoveryFailures } = prepared;
  if (options['dry-run']) {
    console.log(JSON.stringify({ root, targets, selectedTargets: prepared.selected, files: plan?.snapshot.wanted.length ?? 0, remove: plan?.operations.filter(op => op.action === 'remove').map(op => op.path) ?? [], operations: plan?.operations ?? [], conflicts: plan?.conflicts ?? [], findings: report.findings, discovery: report.discovery }, null, 2));
    if (!plan || plan.conflicts.length || failures.length || discoveryFailures.length) process.exitCode = 1;
    return;
  }
  console.log(formatPreflight(prepared));
  const outcome = await applyPreparedInstallation(prepared);
  if (outcome.status === 'preflight-failed') {
    console.error('Preflight failed; no files changed. ' + formatPreflight(prepared));
    process.exitCode = 1; return;
  }
  if (outcome.status === 'post-apply-failed') {
    console.error('Files were installed but post-apply verification failed. Automatic restoration is not yet available. Preserve diagnostics, run doctor, and restart after resolving the failure. ' + JSON.stringify(outcome.report.findings) + ' ' + JSON.stringify(outcome.report.discovery));
    process.exitCode = 1; return;
  }
  for (const probe of outcome.report.discovery.probes || []) console.log(`${probe.host} discovery: ${probe.status} (${probe.classification}). ${probe.reason || 'Native origins observed.'}`);
  console.log(!targets.length
    ? `Removed selected pstack hosts from ${root}. User configuration and other files were preserved.`
    : `Pstack files installed for ${targets.join(', ')} in ${root}. Static integrity: ${outcome.report.integrity.status}; discovery: ${outcome.report.discovery.status}. Restart the host to discover skills. No model configuration required.`);
}
try {
  const options = parse(process.argv.slice(2));
  if (options.help) console.log(help); else await run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
