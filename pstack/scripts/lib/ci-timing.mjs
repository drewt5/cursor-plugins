import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { availableParallelism, cpus } from 'node:os';

export function runtimeTiming() {
  return { node: process.version, platform: process.platform, architecture: process.arch, cpuCount: cpus().length, availableParallelism: availableParallelism() };
}

export function timingEnvironment() {
  return Object.fromEntries(['PSTACK_TIMING_DIR', 'PSTACK_TIMING_ORIGIN', 'PSTACK_TIMING_SCOPE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
}

let writtenBytes = 0;
export function timingEvent(event) {
  const directory = process.env.PSTACK_TIMING_DIR;
  if (!directory) return;
  const file = join(directory, `${process.pid}.jsonl`);
  const offsetMs = Number(process.hrtime.bigint() - BigInt(process.env.PSTACK_TIMING_ORIGIN)) / 1e6;
  const line = JSON.stringify({ ...event, offsetMs, pid: process.pid }) + '\n';
  if (Buffer.byteLength(line) > 4096 || writtenBytes + Buffer.byteLength(line) > 256 * 1024) throw new Error('CI timing evidence exceeded its size limit');
  appendFileSync(file, line);
  writtenBytes += Buffer.byteLength(line);
}

export function startTiming(kind, name) {
  if (!process.env.PSTACK_TIMING_DIR || (kind === 'native-command' && !['setup', 'discovery', 'invocation'].includes(process.env.PSTACK_TIMING_SCOPE))) return () => {};
  const id = randomUUID();
  const started = process.hrtime.bigint();
  timingEvent({ event: 'start', id, kind, name });
  return result => timingEvent({ event: 'end', id, kind, name, durationMs: Number(process.hrtime.bigint() - started) / 1e6, ...result });
}
