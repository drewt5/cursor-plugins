import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Lifecycle scenarios need the real installer/renderer/recovery dependency tree
// and representative skills and agents. Catalog/resource integration tests use
// the complete shipped package separately.
export function copyRuntimeSource(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const name of [
    'scripts', 'skills/pstack-runtime', 'skills/how', 'skills/why', 'agents',
    'skills/poteto-mode/SKILL.md', 'skills/poteto-mode/playbooks/feature.md',
    'skills/poteto-mode/scripts/worktree-audit.sh',
    'release.json', 'package.json', 'tested-hosts.json', 'README.md',
  ]) cpSync(join(source, name), join(destination, name), { recursive: true });
  return destination;
}
