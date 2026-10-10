import { recoverInstallation } from '../../scripts/lib/installation-recovery.mjs';
process.once('message', async ({ root }) => {
  try {
    const result = await recoverInstallation(root, { recoverDeadLocks: true, boundary: async name => {
      process.send({ boundary: name }); await new Promise(resolve => process.once('message', resolve));
    } });
    process.send({ done: result.status }); process.disconnect();
  } catch (error) { process.send({ error: error.message }); process.disconnect(); process.exitCode = 1; }
});
