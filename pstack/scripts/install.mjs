#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hosts, canonicalPath, safePath, stateFrom, installationSnapshot } from './lib/installation-state.mjs';
import { selectInstallationTargets } from './lib/installation-targets.mjs';
import { renderArtifacts } from './lib/installation-artifacts.mjs';
import { planInstallation, applyInstallation } from './lib/installation-plan.mjs';
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
function run(options) {
  const requestedRoot = resolve(options.global ? homedir() : options.project);
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  if (root === source || root.startsWith(source + sep)) throw new Error('Install into a project outside the pstack source package.');
  const statePath = safePath(root, '.pstack/install.json');
  const previous = stateFrom(statePath);
  const selection = selectInstallationTargets(options, previous, { root });
  const selected = selection.selected;
  for (const observation of selection.observations.filter(item => item.code === 'HOST_VERSION_UNKNOWN')) console.error(`${observation.host}: untested version ${observation.evidence.actualVersion}; structural checks apply, native compatibility remains unknown.`);
  const targets = options.uninstall ? previous.targets.filter(target => !selected.includes(target)) : [...new Set([...previous.targets, ...selected])].sort();
  const opencodeRoot = options.global ? canonicalPath(resolve(process.env.XDG_CONFIG_HOME || join(root, '.config'), 'opencode')) : '.opencode';
  const artifacts = renderArtifacts({ source, root, targets, opencodeRoot, global: options.global });
  const snapshot = installationSnapshot({ root, desired: artifacts.state });
  const plan = planInstallation(snapshot, artifacts);
  if (options['dry-run']) {
    console.log(JSON.stringify({ root, targets, files: snapshot.wanted.length, remove: plan.operations.filter(op => op.action === 'remove').map(op => op.path), operations: plan.operations, conflicts: plan.conflicts }, null, 2));
    if (plan.conflicts.length) process.exitCode = 1;
    return;
  }
  applyInstallation(plan);
  console.log(!targets.length
    ? `Removed selected pstack hosts from ${root}. User configuration and other files were preserved.`
    : `Pstack installed for ${targets.join(', ')} in ${root}. Restart the host to discover skills. No model configuration required.`);
}
try {
  const options = parse(process.argv.slice(2));
  if (options.help) console.log(help); else run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
