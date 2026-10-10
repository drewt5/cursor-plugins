#!/usr/bin/env node
import { loadHosts } from './lib/tested-hosts.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const [operation, ...args] = process.argv.slice(2);
const env = process.env;
const reportDirectory = env.PSTACK_REPORT_DIR || (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, 'pstack-evidence') : null);
const directory = reportDirectory ? resolve(reportDirectory) : null;
const safeName = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const escape = value => String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;');
function save(name, value) {
  const path = join(directory, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  renameSync(`${path}.tmp`, path);
}
function identity() {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  return {
    repository: env.GITHUB_REPOSITORY || 'local',
    pullRequest: event.pull_request?.number || event.number || null,
    event: env.GITHUB_EVENT_NAME || 'local',
    runId: env.GITHUB_RUN_ID || 'local',
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT || 1),
    sourceHeadSha: event.pull_request?.head?.sha || null,
    testedSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    check: env.PSTACK_CHECK || 'local',
  };
}
async function run() {
  const [phase, separator, ...command] = args;
  assert.ok(safeName(phase) && separator === '--' && command.length, 'Usage: ci-report.mjs run PHASE -- COMMAND [ARGS]');
  const timeoutMs = Number(env.PSTACK_PHASE_TIMEOUT_MS || 180000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Invalid phase timeout');
  const record = { schemaVersion: 1, identity: identity(), phase, command, reproduce: command.map(quote).join(' '), status: 'failed', exitCode: null, signal: null, error: null, durationMs: 0, log: `${phase}.log` };
  const log = join(directory, record.log);
  writeFileSync(log, '');
  const started = Date.now();
  const token = randomUUID();
  console.log(`::stop-commands::${token}`);
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const logLimit = 4 * 1024 * 1024;
  let tail = Buffer.alloc(0);
  let truncated = false;
  const capture = chunk => {
    process.stdout.write(chunk);
    truncated ||= tail.length + chunk.length > logLimit;
    tail = Buffer.concat([tail, chunk]).subarray(-logLimit);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const kill = signal => {
    if (!child.pid) return;
    try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let force;
  const timer = setTimeout(() => {
    record.error = `Timed out after ${timeoutMs} ms`;
    kill('SIGTERM');
    force = setTimeout(() => kill('SIGKILL'), 1000);
  }, timeoutMs);
  child.on('error', error => { record.error = error.message; });
  await new Promise(done => child.once('close', (code, signal) => { record.exitCode = code; record.signal = signal; done(); }));
  clearTimeout(timer);
  clearTimeout(force);
  kill('SIGKILL');
  writeFileSync(log, truncated ? Buffer.concat([Buffer.from('[Earlier output truncated; retaining last 4 MiB]\n'), tail]) : tail);
  console.log(`\n::${token}::`);
  record.durationMs = Date.now() - started;
  record.status = record.exitCode === 0 && !record.error ? 'passed' : 'failed';
  if (record.status === 'failed' && !record.error) record.error = `Command exited ${record.exitCode ?? record.signal}`;
  save(`${phase}.json`, record);
  if (record.status === 'failed') process.exitCode = 1;
}
function finalize() {
  assert.ok(args.length > 0 && args.every(safeName) && new Set(args).size === args.length, 'Expected unique phase names');
  const current = identity();
  const steps = JSON.parse(env.PSTACK_STEPS || '{}');
  const phases = args.map(phase => {
    try {
      const record = JSON.parse(readFileSync(join(directory, `${phase}.json`), 'utf8'));
      assert.equal(record.schemaVersion, 1);
      assert.deepEqual(record.identity, current);
      assert.equal(record.phase, phase);
      assert.ok(['passed', 'failed'].includes(record.status));
      assert.ok(Array.isArray(record.command) && record.command.length && record.command.every(value => typeof value === 'string'));
      assert.ok(Number.isFinite(record.durationMs) && record.durationMs >= 0);
      assert.equal(record.log, `${phase}.log`);
      readFileSync(join(directory, record.log));
      assert.ok(record.status !== 'passed' || (record.exitCode === 0 && record.error === null));
      assert.equal(typeof record.reproduce, 'string');
      if (record.status === 'passed' && steps[phase] && steps[phase].outcome !== 'success') throw new Error(`GitHub step outcome is ${steps[phase].outcome}`);
      return record;
    } catch (error) {
      return { phase, status: 'not-run', command: [], reproduce: null, exitCode: null, signal: null, durationMs: 0, log: null, error: `Missing or invalid evidence: ${error.message}` };
    }
  });
  const failures = Object.entries(steps).filter(([, step]) => ['failure', 'cancelled'].includes(step.outcome)).map(([name, step]) => `${name}: ${step.outcome}`);
  let host = null;
  if (env.PSTACK_HOST) {
    let actualVersion = null;
    try { actualVersion = readFileSync(join(directory, 'host-version.txt'), 'utf8').trim(); } catch {}
    const baseline = loadHosts().find(row => row.host === env.PSTACK_HOST);
    assert.ok(baseline, `Unknown native host: ${env.PSTACK_HOST}`);
    host = { name: baseline.host, package: baseline.package, executable: baseline.executable, testedVersion: baseline.version, requiredNode: baseline.node, capabilities: baseline.capabilities, expectedVersion: env.PSTACK_HOST_VERSION || baseline.version, actualVersion };
    if (actualVersion !== host.expectedVersion) failures.push(`Host version mismatch: expected ${host.expectedVersion}, observed ${actualVersion}`);
  }
  const report = { schemaVersion: 1, ...current, os: process.platform, node: process.version, host, artifact: env.PSTACK_ARTIFACT || null, status: phases.every(phase => phase.status === 'passed') && failures.length === 0 ? 'passed' : 'failed', failures, phases };
  save('report.json', report);
  const lines = [`## Pstack ${escape(report.check)}: ${report.status}`, '', `Source head: ${escape(report.sourceHeadSha || 'not a pull request')}`, `Tested checkout: ${escape(report.testedSha)}`, `Run: ${escape(report.runId)}, attempt ${report.runAttempt}`, `Artifact: ${escape(report.artifact || directory)}`, `Node: ${escape(report.node)}${host ? `; ${escape(host.name)}: ${escape(host.actualVersion || 'unavailable')} (expected ${escape(host.expectedVersion)})` : ''}`, '', '| Phase | Status | Duration | Reproduce |', '| --- | --- | --- | --- |', ...phases.map(phase => `| ${escape(phase.phase)} | ${phase.status} | ${phase.durationMs} ms | ${escape(phase.reproduce || 'Fix setup or missing evidence first')} |`), '', ...failures.map(error => `- ${escape(error)}`)];
  for (const phase of phases.filter(phase => phase.status !== 'passed')) {
    lines.push('', `### ${escape(phase.phase)}`, '', escape(phase.error));
    if (phase.log) lines.push('', '<pre>', escape(readFileSync(join(directory, phase.log), 'utf8').slice(-4000)), '</pre>');
  }
  const summary = lines.join('\n') + '\n';
  writeFileSync(join(directory, 'summary.md'), summary);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
  console.log(`Pstack ${report.check}: ${report.status}. Evidence: ${directory}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
function gate() {
  const needs = JSON.parse(env.PSTACK_NEEDS || '{}');
  const hosts = loadHosts();
  assert.deepEqual(Object.keys(needs).sort(), ['prepare', 'portable', 'helpers', 'native'].sort(), 'Expected exact prerequisite jobs: prepare, portable, helpers, native');
  const matrix = JSON.parse(needs.prepare.outputs?.matrix || 'null');
  assert.deepEqual(matrix, { include: hosts }, 'Prepared matrix does not match the complete tested baseline');
  const failed = Object.entries(needs).filter(([, job]) => job.result !== 'success');
  assert.equal(failed.length, 0, `Prerequisite jobs did not succeed: ${failed.map(([name, job]) => `${name}=${job.result}`).join(', ')}`);
  console.log('All pstack job groups passed.');
}
try {
  if (operation === 'gate') gate();
  else {
    assert.ok(directory, 'PSTACK_REPORT_DIR or RUNNER_TEMP is required');
    mkdirSync(directory, { recursive: true });
    if (operation === 'run') await run();
    else if (operation === 'finalize') finalize();
    else throw new Error('Expected run, finalize, or gate');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
