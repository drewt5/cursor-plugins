import { startTiming } from './ci-timing.mjs';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Files avoid native CLIs truncating large JSON when stdout is a pipe.
export async function discoveryCommand(executable, args, { project, env, timeout = 20000, maxBytes = 4 * 1024 * 1024, timingName = 'discovery command', signal }) {
  signal?.throwIfAborted();
  const finishTiming = startTiming('native-command', timingName);
  let status = 'failed';
  const temporary = mkdtempSync(join(tmpdir(), 'pstack-discovery-output-'));
  const output = join(temporary, 'stdout'), descriptor = openSync(output, 'w');
  const proc = spawn(executable, args, { cwd: project, env: { ...env, PWD: project }, detached: process.platform !== 'win32', stdio: ['ignore', descriptor, 'pipe'] });
  let errorTail = '', timedOut = false, oversized = false;
  const kill = signal => { if (!proc.pid) return; try { process.platform === 'win32' ? proc.kill(signal) : process.kill(-proc.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  const abort = () => kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; kill('SIGKILL'); }, timeout);
  const sizeCheck = setInterval(() => { if (statSync(output).size > maxBytes) { oversized = true; kill('SIGKILL'); } }, 50);
  proc.stderr.on('data', chunk => { errorTail = (errorTail + chunk).slice(-4000); });
  try {
    const result = await new Promise(done => { proc.once('error', error => done({ error: error.code || error.message })); proc.once('close', (code, signal) => done({ code, signal })); });
    const bytes = statSync(output).size;
    if (signal?.aborted || timedOut || oversized || bytes > maxBytes || result.error || result.code !== 0) throw new Error(JSON.stringify({ command: [executable, ...args], ...result, timedOut, oversized: oversized || bytes > maxBytes, stderr: errorTail }));
    const body = readFileSync(output, 'utf8');
    status = 'passed';
    return body;
  } finally { signal?.removeEventListener('abort', abort); clearTimeout(timer); clearInterval(sizeCheck); kill('SIGKILL'); closeSync(descriptor); rmSync(temporary, { recursive: true, force: true }); finishTiming({ status, timedOut }); }
}
