import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeFixtures, runNativeFixtures } from '../scripts/lib/native-fixtures.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Timed out waiting for fixture handshake'); await pause(); }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-native-pool-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const task = (name, code) => ({ name, executable: process.execPath, args: ['--input-type=module', '-e', code], env: process.env, stdio: 'ignore' });
  const program = (id, block = true) => `import {writeFileSync,existsSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, `started-${id}`))},String(process.pid));${block ? `const timer=setInterval(()=>{if(existsSync(${JSON.stringify(join(root, `release-${id}`))}))clearInterval(timer);},10);` : ''}`;
  return { root, task, program, path: name => join(root, name) };
}
test('native fixture selection preserves every host scenario', () => {
  assert.deepEqual(nativeFixtures('all'), [
    ...['initial', 'legacy', 'scopes'].map(scenario => ({ host: 'codex', scenario })),
    ...['initial', 'rollback', 'legacy', 'scopes'].map(scenario => ({ host: 'opencode', scenario })),
    ...['initial', 'scopes'].map(scenario => ({ host: 'claude-code', scenario })),
  ]);
});
test('pool starts at most two workers and waits for every selected worker', async t => {
  const f = fixture(t), tasks = [0, 1, 2].map(i => f.task(String(i), f.program(i)));
  const done = runNativeFixtures(tasks, { concurrency: 2 });
  await until(() => existsSync(f.path('started-0')) && existsSync(f.path('started-1')));
  assert.equal(existsSync(f.path('started-2')), false);
  writeFileSync(f.path('release-0'), '');
  await until(() => existsSync(f.path('started-2')));
  writeFileSync(f.path('release-1'), ''); writeFileSync(f.path('release-2'), '');
  await done;
});
test('one-worker mode remains sequential and invalid concurrency is refused', async t => {
  const f = fixture(t);
  const done = runNativeFixtures([f.task('a', f.program(0)), f.task('b', f.program(1, false))], { concurrency: 1 });
  await until(() => existsSync(f.path('started-0')));
  assert.equal(existsSync(f.path('started-1')), false);
  writeFileSync(f.path('release-0'), ''); await done;
  for (const concurrency of [0, 3, 1.5]) await assert.rejects(runNativeFixtures([], { concurrency }), /concurrency/);
});
test('spawn errors and a failed worker cancel active peers and never start queued work', async t => {
  const f = fixture(t);
  await assert.rejects(runNativeFixtures([{ name: 'missing', executable: f.path('missing'), args: [] }]), /failed to start/);
  const blocker = f.task('blocker', f.program(0));
  const fail = f.task('failure', `import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(f.path('started-0'))}))process.exit(7);},10);`);
  await assert.rejects(runNativeFixtures([blocker, fail, f.task('queued', f.program(2, false))], { concurrency: 2 }), /failure/);
  assert.equal(existsSync(f.path('started-2')), false);
  assert.throws(() => process.kill(Number(readFileSync(f.path('started-0'))), 0), { code: 'ESRCH' });
});
test('timeout force-kills and awaits a worker that ignores SIGTERM', async t => {
  const f = fixture(t);
  const task = f.task('ignores-term', `process.on('SIGTERM',()=>{});${f.program(0)}`);
  const done = runNativeFixtures([task], { timeout: 1000 });
  await until(() => existsSync(f.path('started-0')));
  await assert.rejects(done, /timed out/);
  assert.throws(() => process.kill(Number(readFileSync(f.path('started-0'))), 0), { code: 'ESRCH' });
});
for (const provider of ['opencode', 'codex']) test(`cancellation awaits nested ${provider} process group even when provider ignores SIGTERM`, async t => {
  const f = fixture(t), controller = new AbortController();
  const executable = f.path('provider');
  writeFileSync(executable, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(f.path('provider-pid'))},String(process.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  const module = new URL(`../scripts/lib/${provider === 'codex' ? 'native-catalog' : 'discovery-process'}.mjs`, import.meta.url).href;
  const call = provider === 'codex' ? `codexSkills(${JSON.stringify(f.root)},process.env,{executable:${JSON.stringify(executable)},signal:controller.signal})` : `discoveryCommand(${JSON.stringify(executable)},[],{project:${JSON.stringify(f.root)},env:process.env,signal:controller.signal})`;
  const task = f.task('nested', `import {${provider === 'codex' ? 'codexSkills' : 'discoveryCommand'}} from ${JSON.stringify(module)};const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());try{await ${call};}catch{process.exitCode=1;}`);
  const done = runNativeFixtures([task], { signal: controller.signal });
  await until(() => existsSync(f.path('provider-pid'))); controller.abort();
  await assert.rejects(done, /cancelled/);
  assert.throws(() => process.kill(Number(readFileSync(f.path('provider-pid'))), 0), { code: 'ESRCH' });
});

test('timing write failure cancels and awaits other active workers', async t => {
  const f = fixture(t), directory = f.path('timing'); mkdirSync(directory);
  const keys = ['PSTACK_TIMING_DIR', 'PSTACK_TIMING_ORIGIN', 'PSTACK_TIMING_SCOPE'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { PSTACK_TIMING_DIR: directory, PSTACK_TIMING_ORIGIN: String(process.hrtime.bigint()), PSTACK_TIMING_SCOPE: 'discovery' });
  try {
    const done = runNativeFixtures([f.task('first', f.program(0)), f.task('peer', f.program(1))]);
    await until(() => existsSync(f.path('started-0')) && existsSync(f.path('started-1')));
    rmSync(directory, { recursive: true }); writeFileSync(f.path('release-0'), '');
    await assert.rejects(done, /ENOENT/);
    assert.throws(() => process.kill(Number(readFileSync(f.path('started-1'))), 0), { code: 'ESRCH' });
  } finally { for (const key of keys) old[key] === undefined ? delete process.env[key] : process.env[key] = old[key]; }
});
test('actual phase timeout reaps synchronous and detached providers before parent cleanup', async t => {
  const f = fixture(t), provider = f.path('provider');
  writeFileSync(provider, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`, { mode: 0o755 });
  const discovery = new URL('../scripts/lib/discovery-process.mjs', import.meta.url).href;
  const pool = new URL('../scripts/lib/native-fixtures.mjs', import.meta.url).href;
  const asyncCode = `import {discoveryCommand} from ${JSON.stringify(discovery)};const c=new AbortController();process.on('SIGTERM',()=>c.abort());try{await discoveryCommand(${JSON.stringify(provider)},[${JSON.stringify(f.path('async-pid'))}],{project:${JSON.stringify(f.root)},env:process.env,signal:c.signal});}catch{process.exitCode=1;}`;
  const syncCode = `import {spawnSync} from 'node:child_process';process.on('SIGTERM',()=>{});spawnSync(${JSON.stringify(provider)},[${JSON.stringify(f.path('sync-pid'))}],{stdio:'inherit'});`;
  const tasks = [asyncCode, syncCode].map((code, i) => ({ name: String(i), executable: process.execPath, args: ['--input-type=module', '-e', code], stdio: 'ignore' }));
  const parent = `import {runNativeFixtures} from ${JSON.stringify(pool)};const c=new AbortController();process.on('SIGTERM',()=>c.abort());try{await runNativeFixtures(${JSON.stringify(tasks)},{signal:c.signal});}catch{process.exitCode=1;}`;
  const child = spawn(process.execPath, [new URL('../scripts/ci-report.mjs', import.meta.url).pathname, 'run', 'discovery', '--', process.execPath, '--input-type=module', '-e', parent], { env: { ...process.env, PSTACK_REPORT_DIR: f.path('report'), PSTACK_PHASE_TIMEOUT_MS: '1500' }, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  await until(() => existsSync(f.path('async-pid')) && existsSync(f.path('sync-pid')));
  assert.equal(await closed, 1);
  for (const name of ['async-pid', 'sync-pid']) assert.throws(() => process.kill(Number(readFileSync(f.path(name))), 0), { code: 'ESRCH' });
  assert.match(JSON.parse(readFileSync(f.path('report/discovery.json'))).error, /Timed out/);
});
