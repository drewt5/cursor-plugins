import { basename } from 'node:path';
import { startTiming } from './ci-timing.mjs';

// The runner also imports this module; only isolated test-file processes have a file argument.
if (process.env.NODE_TEST_CONTEXT === 'child-v8' && process.argv[1]?.endsWith('.test.mjs')) {
  const finish = startTiming('test-file', basename(process.argv[1]));
  process.once('exit', exitCode => finish({ status: exitCode === 0 ? 'passed' : 'failed', exitCode }));
}
