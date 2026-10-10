import { withInstallationMutation } from '../../scripts/lib/installation-lock.mjs';
import { installationSnapshot } from '../../scripts/lib/installation-state.mjs';
import { planInstallation, applyInstallation } from '../../scripts/lib/installation-plan.mjs';
const [root, opencodeRoot] = process.argv.slice(2);
await withInstallationMutation({ root, opencodeRoot }, async () => {
  const artifacts = { state: { version: 2, targets: [], entries: {} }, contents: new Map() };
  const plan = planInstallation(installationSnapshot({ root, desired: artifacts.state }), artifacts);
  process.send({ ready: true });
  const message = await new Promise(resolve => process.once('message', resolve));
  if (message.exit) process.exit(0);
  applyInstallation(plan);
});
process.disconnect();
