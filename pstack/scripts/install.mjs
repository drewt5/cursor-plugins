#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hosts } from './lib/installation-state.mjs';
import { previewInstallation, applyPublicInstallation } from './lib/installation-public.mjs';
import { renderOperation } from './lib/cli-output.mjs';
const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const help = `Usage: node pstack/scripts/install.mjs [--target all|${hosts.join('|')}] [--project PATH|--global] [--uninstall] [--dry-run] [--recover-dead-locks] [--verbose]
Defaults: current project; fresh install selects the only usable CLI host or requires --target.
Re-run/update/uninstall without --target uses recorded hosts; explicit additions are additive.
--uninstall removes only the selected hosts. --target all selects Codex, OpenCode, and Claude Code.
Requires Node.js 20+. Existing skills and local edits are preserved.`;

function parse(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--global', '--uninstall', '--help', '--dry-run', '--recover-dead-locks', '--verbose'].includes(arg)) options[arg.slice(2)] = true;
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
  const input = { source, root, globalRoot: homedir(), options, env: process.env };
  const prepared = options['dry-run'] ? await previewInstallation(input) : null;
  const { targets, plan, report, failures, discoveryFailures } = prepared || {};
  if (options['dry-run']) {
    console.log(JSON.stringify({ root, targets, selectedTargets: prepared.selected, files: plan?.snapshot.wanted.length ?? 0, remove: plan?.operations.filter(op => op.action === 'remove').map(op => op.path) ?? [], operations: plan?.operations ?? [], conflicts: plan?.conflicts ?? [], findings: report.findings, discovery: report.discovery }, null, 2));
    if (!plan || plan.conflicts.length || failures.length || discoveryFailures.length) process.exitCode = 1;
    return;
  }
  const outcome = await applyPublicInstallation(input, {
    onRecoveryReady: command => new Promise((resolve, reject) => process.stderr.write(`Recovery if interrupted: ${command}\n`, error => error ? reject(error) : resolve()))
  });
  const output = renderOperation(outcome, { root, global: !!options.global, uninstall: !!options.uninstall, verbose: !!options.verbose, scriptsRoot: join(source, 'scripts') });
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  if (['preflight-failed', 'verification-failed-restored'].includes(outcome.status)) process.exitCode = 1;
}
try {
  const options = parse(process.argv.slice(2));
  if (options.help) console.log(help); else await run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
