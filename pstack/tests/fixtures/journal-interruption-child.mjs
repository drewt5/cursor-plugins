import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { applyStagedActivation } from '../../scripts/lib/installation-activation.mjs';
const rename = fs.renameSync;
let writes = 0;
fs.renameSync = (...args) => {
  if (String(args[1]).endsWith('/.pstack/activation.json') && ++writes === 2) {
    process.send({ boundary: 'journal-written-before-rename' });
    // The small IPC message is queued before blocking at the real fs boundary.
    // Only the parent's SIGKILL ends this wait; there is no timing-based race.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return rename(...args);
};
syncBuiltinESMExports();
process.on('message', async ({ prepared }) => {
  prepared.plan.artifacts.contents = new Map(prepared.plan.artifacts.contents);
  try { await applyStagedActivation(prepared); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
});
