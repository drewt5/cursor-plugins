import { prepareStagedActivation, applyStagedActivation } from '../../scripts/lib/installation-activation.mjs';
const boundary = async (name, journal) => {
  process.send({ boundary: name, state: journal.state, progress: journal.progress });
  await new Promise(resolve => process.once('message', resolve));
};
process.once('message', async options => {
  try {
    const prepared = await prepareStagedActivation({ ...options, env: process.env, options: { target: 'cursor' } });
    const result = await applyStagedActivation(prepared, { boundary });
    process.send({ done: result.status }); process.disconnect();
  } catch (error) { process.send({ error: error.message }); process.disconnect(); process.exitCode = 1; }
});
