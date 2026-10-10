#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { rollbackInstallation } from './lib/installation-rollback.mjs';
import { formatPreflight } from './lib/installation-preflight.mjs';
const help = 'Usage: node pstack/scripts/rollback.mjs [--project PATH|--global] [--recover-dead-locks]\nRestores one previous installation while preserving current user settings and providers.';
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--global') options.global = true;
    else if (arg === '--recover-dead-locks') options.recoverDeadLocks = true;
    else if (arg === '--project' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options.project = process.argv[++i];
    else if (arg === '--help') { console.log(help); process.exit(0); } else throw new Error(help);
  }
  if (options.global && options.project) throw new Error('Choose one scope. ' + help);
  const result = await rollbackInstallation({ ...options, root: resolve(options.global ? homedir() : options.project || process.cwd()), globalRoot: homedir() });
  if (result.status === 'preflight-failed') { console.error(formatPreflight(result.prepared)); process.exitCode = 1; }
  else { console.log(JSON.stringify(result)); if (!['applied', 'unchanged'].includes(result.status)) process.exitCode = 1; }
} catch (error) { console.error(error.message); process.exitCode = 1; }
