import { join } from 'node:path';
import { applyPublicInstallation } from '../../scripts/lib/installation-public.mjs';
import { inspectExistingInstallation } from '../../scripts/lib/installation-discovery.mjs';
import { inspectInstallationLock } from '../../scripts/lib/installation-lock.mjs';

// Pause the real public operation before its journal exists. Pausing activation
// instead would let every contender fail through recovery's lock alone.
process.once('message', async options => {
  try {
    let paused = false;
    const result = await applyPublicInstallation({ ...options, env: process.env, diagnose: async args => {
      const report = await inspectExistingInstallation(args);
      const lock = inspectInstallationLock(join(options.root, '.pstack/mutation.lock'));
      if (!paused && lock.owner?.pid === process.pid) {
        paused = true;
        const continued = new Promise(resolve => process.once('message', resolve));
        process.send({ ready: true, token: lock.owner.token });
        await continued;
      }
      return report;
    } });
    if (!paused) throw new Error('Public operation never reached its owned mutation checkpoint');
    process.send({ done: result.status });
    process.disconnect();
    if (result.status !== 'applied') process.exitCode = 1;
  } catch (error) {
    process.send({ error: error.stack }); process.disconnect(); process.exitCode = 1;
  }
});
