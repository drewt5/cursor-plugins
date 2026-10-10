import { applyPublicInstallation } from '../../scripts/lib/installation-public.mjs';
process.once('message', async options => {
  try {
    const result = await applyPublicInstallation({ ...options, env: process.env }, { boundary: async (name, journal) => {
      process.send({ boundary: name, state: journal.state }); await new Promise(resolve => process.once('message', resolve));
    } });
    process.send({ done: result.status }); process.disconnect();
  } catch (error) { process.send({ error: error.message }); process.disconnect(); process.exitCode = 1; }
});
