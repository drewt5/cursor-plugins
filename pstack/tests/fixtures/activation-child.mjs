import { prepareStagedActivation, applyStagedActivation } from '../../scripts/lib/installation-activation.mjs';
const boundary = async (name, journal) => {
  process.send({ boundary: name, state: journal.state, progress: journal.progress });
  await new Promise(resolve => process.once('message', resolve));
};
process.once('message', async options => {
  try {
    const prepared = options.prepared || await prepareStagedActivation({ ...options, env: process.env, options: { target: 'cursor' } });
    if (options.prepared) prepared.plan.artifacts.contents = new Map(prepared.plan.artifacts.contents);
    const result = await applyStagedActivation(prepared, { boundary, onRecoveryReady: command => new Promise((resolve, reject) => process.stderr.write(`Recovery if interrupted: ${command}\n`, error => error ? reject(error) : resolve())) });
    process.send({ done: result.status }); process.disconnect();
  } catch (error) { process.send({ error: error.message }); process.disconnect(); process.exitCode = 1; }
});
