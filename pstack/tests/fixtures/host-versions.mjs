import { loadHosts } from '../../scripts/lib/tested-hosts.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// Unit/lifecycle fixtures only; native lanes keep the actual PATH.
export function withHostVersionFixtures(root, env, selected = ['codex', 'opencode', 'claude-code']) {
  const bin = join(root, 'fixture-bin'); mkdirSync(bin, { recursive: true });
  for (const row of loadHosts().filter(row => selected.includes(row.host))) {
    writeFileSync(join(bin, row.executable), `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(99);\nconsole.log(${JSON.stringify(row.version)});\n`, { mode: 0o755 });
  }
  return { ...env, PATH: bin + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '') };
}
