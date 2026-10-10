#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProviders } from './lib/provider-resolution.mjs';
const directory = process.env.PSTACK_REPORT_DIR || join(process.env.RUNNER_TEMP || '', 'pstack-evidence');
try {
  if (process.env.GITHUB_EVENT_NAME && ['schedule', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
    && process.env.GITHUB_REF_NAME !== process.env.PSTACK_DEFAULT_BRANCH) throw new Error('Canary must run against the fork default branch; dispatch it with --ref main.');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const report = await resolveProviders({ sourceCommit });
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'provider-resolution.json');
  writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path);
  for (const result of report.results) console.log(`${result.host}: ${result.status === 'resolved' ? `${result.row.version}; Node ${result.row.resolution.nodeEngine}; resolved ${result.row.resolution.resolvedAt}` : result.error}`);
  if (report.status !== 'resolved') throw new Error('Provider resolution failed; inspect provider-resolution.json. No partial matrix was emitted.');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(report.matrix)}\n`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
