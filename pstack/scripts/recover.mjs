#!/usr/bin/env node
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { recoverInstallation } from './lib/installation-recovery.mjs';
const help = 'Usage: node <verified-retained-package>/scripts/recover.mjs [--project PATH|--global] [--recover-dead-locks]\nPreserves live/unknown locks and changed user paths. No providers or model requests are launched.';
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (['--global', '--recover-dead-locks'].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === '--project' && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) options.project = process.argv[++i];
    else if (arg === '--help') { console.log(help); process.exit(0); }
    else throw new Error(help);
  }
  if (options.global && options.project) throw new Error('Choose one scope. ' + help);
  const result = await recoverInstallation(resolve(options.global ? homedir() : options.project || process.cwd()), { recoverDeadLocks: !!options['recover-dead-locks'], executablePackage: fileURLToPath(new URL('..', import.meta.url)) });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
