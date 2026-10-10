#!/usr/bin/env node
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hosts } from './lib/installation-state.mjs';
import { inspectExistingInstallation } from './lib/installation-discovery.mjs';
import { probeHostVersion } from './lib/installation-diagnostics.mjs';
import { loadHosts } from './lib/tested-hosts.mjs';
import { diagnosticExitCode, formatDoctor } from './lib/doctor-output.mjs';
const help = `Usage: node pstack/scripts/doctor.mjs [--project PATH|--global] [--target all|${hosts.join('|')}] [--json]
Defaults: current project and recorded targets. Uninstalled scopes show detected CLI versions.
Read-only, offline static checks; native visibility limits remain explicit. No repair or model request.
Exit: 0 no actionable failure (including advisory unknown), 1 actionable failure, 2 usage/internal error.
Exit 0 does not imply complete verification; inspect JSON verification states.`;
export function parseDoctor(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (['--global', '--json', '--help'].includes(args[i])) options[args[i].slice(2)] = true;
    else if (['--project', '--target'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  if (options.global && options.project) throw new Error('Choose --project PATH or --global, not both.');
  if (options.target !== undefined && ![...hosts, 'all'].includes(options.target)) throw new Error('Invalid --target; choose ' + [...hosts, 'all'].join(', '));
  return options;
}
export async function runDoctor(options, { env = process.env, globalRoot = homedir(), inspector = inspectExistingInstallation, versionProbe = probeHostVersion } = {}) {
  const targets = options.target === undefined ? undefined : options.target === 'all' ? hosts.slice(0, 3) : [options.target];
  const report = await inspector({ root: resolve(options.global ? globalRoot : options.project || process.cwd()), global: !!options.global, globalRoot, targets, env, versionProbe });
  if (report.receipt.status === 'absent' && targets === undefined) report.detectedHosts = loadHosts().map(row => ({ host: row.host, ...versionProbe(row, env) }));
  report.session = { restartRequiredAfterChanges: true, reason: 'Existing running sessions may retain old skills until restart.' };
  return { report, exitCode: diagnosticExitCode(report) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDoctor(process.argv.slice(2));
    if (options.help) console.log(help);
    else {
      const { report, exitCode } = await runDoctor(options);
      process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatDoctor(report));
      process.exitCode = exitCode;
    }
  } catch (error) { console.error(`Doctor could not complete: ${error.message}\n${help}`); process.exitCode = 2; }
}
