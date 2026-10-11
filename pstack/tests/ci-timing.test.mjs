import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const reporter = new URL('../scripts/ci-report.mjs', import.meta.url).pathname;
const preload = new URL('../scripts/lib/test-file-timing.mjs', import.meta.url).href;
const discovery = new URL('../scripts/lib/discovery-process.mjs', import.meta.url).href;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pstack-timing-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    run(phase, command, extra = {}) {
      return spawnSync(process.execPath, [reporter, 'run', phase, '--', ...command], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_TEST_CONTEXT: undefined, PSTACK_REPORT_DIR: directory, ...extra } });
    },
    events(phase) { return readdirSync(join(directory, `${phase}-timing`)).flatMap(name => readFileSync(join(directory, `${phase}-timing`, name), 'utf8').trim().split('\n').map(JSON.parse)); },
  };
}
test('real test children record overlapping process intervals and failure without replacing stdout', t => {
  const f = fixture(t);
  for (const [name, body] of [['pass', "await new Promise(resolve => setTimeout(resolve, 30));"], ['fail', "throw new Error('expected fixture failure');"]]) {
    writeFileSync(join(f.directory, `${name}.test.mjs`), `import test from 'node:test'; test('${name}', async () => { ${body} });`);
  }
  const result = f.run('unit', [process.execPath, '--test', '--test-concurrency=2', '--import', preload, join(f.directory, 'pass.test.mjs'), join(f.directory, 'fail.test.mjs')]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected fixture failure/);
  const events = f.events('unit');
  assert.equal(events.length, 4);
  assert.deepEqual(events.filter(event => event.event === 'end').map(event => event.status).sort(), ['failed', 'passed']);
  for (const end of events.filter(event => event.event === 'end')) {
    const start = events.find(event => event.id === end.id && event.event === 'start');
    assert.equal(start.name, end.name);
    assert.ok(end.offsetMs >= start.offsetMs);
    assert.ok(end.durationMs >= 0);
  }
  assert.equal(new Set(events.map(event => event.pid)).size, 2);
});
test('killed test process retains an incomplete interval and failed phase', t => {
  const f = fixture(t);
  const path = join(f.directory, 'killed.test.mjs');
  writeFileSync(path, "process.kill(process.pid, 'SIGKILL');");
  assert.equal(f.run('unit', [process.execPath, '--test', '--import', preload, path]).status, 1);
  const events = f.events('unit');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'start');
});
test('native command timing preserves success, nonzero exit, spawn failure and timeout', t => {
  const ends = [];
  for (const [label, executable, args, timeout] of [
    ['success', process.execPath, ['-e', 'console.log("fixture output")'], 10000],
    ['nonzero', process.execPath, ['-e', 'process.exit(7)'], 10000],
    ['missing', process.execPath + '-missing', [], 10000],
    ['timeout', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 20],
  ]) {
    const f = fixture(t);
    const code = `import { discoveryCommand } from ${JSON.stringify(discovery)}; console.log(await discoveryCommand(${JSON.stringify(executable)}, ${JSON.stringify(args)}, { project: process.cwd(), env: process.env, timeout: ${timeout}, timingName: '${label}' }));`;
    const result = f.run('discovery', [process.execPath, '--input-type=module', '-e', code]);
    assert.equal(result.status, label === 'success' ? 0 : 1, result.stderr);
    if (label === 'success') assert.match(result.stdout, /fixture output/);
    ends.push(...f.events('discovery').filter(event => event.event === 'end'));
  }
  assert.deepEqual(ends.map(event => [event.name, event.status]).sort(), [['missing', 'failed'], ['nonzero', 'failed'], ['success', 'passed'], ['timeout', 'failed']]);
  assert.equal(ends.find(event => event.name === 'timeout').timedOut, true);
});
