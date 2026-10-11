import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { startTiming, timingEvent } from './ci-timing.mjs';

export function nativeFixtures(host) {
  return (host === 'all' ? ['codex', 'opencode', 'claude-code'] : [host]).flatMap(target =>
    (target === 'opencode' ? ['initial', 'rollback', 'legacy', 'scopes'] : target === 'codex' ? ['initial', 'legacy', 'scopes'] : ['initial', 'scopes']).map(scenario => ({ host: target, scenario })));
}

export async function runNativeFixtures(tasks, { concurrency = Math.min(2, availableParallelism()), signal, timeout = 180000 } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error('Native fixture concurrency must be one or two');
  const measured = process.env.PSTACK_TIMING_SCOPE === 'discovery';
  if (measured) timingEvent({ event: 'native-fixtures', concurrency, count: tasks.length });
  let next = 0, failure;
  const active = new Set();
  const fail = error => {
    failure ??= error;
    for (const worker of active) worker.stop();
  };
  const abort = () => fail(new Error('Native fixtures cancelled'));
  if (signal?.aborted) throw new Error('Native fixtures cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  async function work() {
    while (!failure && next < tasks.length) {
      const task = tasks[next++];
      const finishTiming = measured ? startTiming('native-fixture', task.name) : () => {};
      const child = spawn(task.executable, task.args, { env: task.env, cwd: task.cwd, stdio: task.stdio ?? 'inherit', detached: process.platform !== 'win32' });
      const kill = signal => {
        if (!child.pid) return;
        try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      let force;
      const worker = { stop() {
        if (force) return;
        kill('SIGTERM');
        force = setTimeout(() => kill('SIGKILL'), 500);
      } };
      active.add(worker);
      const timer = setTimeout(() => fail(new Error(`Native fixture timed out: ${task.name}`)), timeout);
      try {
        const result = await new Promise(resolve => {
          child.once('error', error => { fail(new Error(`Native fixture failed to start: ${task.name}: ${error.message}`)); });
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        finishTiming({ status: result.code === 0 && !failure ? 'passed' : 'failed', exitCode: result.code, signal: result.signal });
        if (result.code !== 0) fail(new Error(`Native fixture failed: ${task.name} (${result.code ?? result.signal})`));
      } finally {
        clearTimeout(timer); clearTimeout(force); kill('SIGKILL'); active.delete(worker);
      }
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => work().catch(fail))); }
  finally { signal?.removeEventListener('abort', abort); }
  if (failure) throw failure;
}
