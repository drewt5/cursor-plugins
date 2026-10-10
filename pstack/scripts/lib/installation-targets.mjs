import { hosts } from './installation-state.mjs';
import { probeHostVersion } from './installation-diagnostics.mjs';
import { loadHosts } from './tested-hosts.mjs';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function selectInstallationTargets(options, previous, { probe = row => probeHostVersion(row), root = process.cwd() } = {}) {
  if (options.target !== undefined && ![...hosts, 'all'].includes(options.target)) throw new Error('Invalid requested target');
  const rows = loadHosts(), observations = new Map();
  const observe = host => {
    if (!observations.has(host)) observations.set(host, probe(rows.find(row => row.host === host)));
    return observations.get(host);
  };
  let selected;
  if (options.target !== undefined) selected = options.target === 'all' ? hosts.slice(0, 3) : [options.target];
  else if (options.uninstall || previous.targets.length) selected = previous.targets;
  else {
    const usable = rows.filter(row => observe(row.host).status !== 'failed');
    if (usable.length !== 1) {
      const example = usable[0]?.host || 'cursor';
      throw new Error(`Found ${usable.length} usable CLI hosts (${usable.map(row => row.host).join(', ') || 'none'}); no files changed. Choose --target codex, opencode, claude-code, all, or cursor.\nRun: node pstack/scripts/install.mjs ${options.global ? '--global' : '--project ' + quote(root)} --target ${example}\nInstall a missing CLI through its provider's supported tooling; Cursor is explicit static coverage.`);
    }
    selected = [usable[0].host];
  }
  if (!options.uninstall) {
    const failures = [...new Set([...previous.targets, ...selected])].filter(host => host !== 'cursor' && observe(host).status === 'failed');
    if (failures.length) throw new Error(`Selected CLI hosts are missing or unusable; no files changed: ${failures.map(host => `${host} (${observations.get(host).code})`).join(', ')}. Install/repair the providers through their supported tooling, or uninstall an unwanted recorded target first.`);
  }
  return { selected, observations: [...observations].map(([host, observation]) => ({ host, ...observation })) };
}
