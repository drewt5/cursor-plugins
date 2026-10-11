import { loadHosts } from '../../scripts/lib/tested-hosts.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
// Unit/lifecycle fixtures only; native lanes keep the actual PATH.
export function withHostVersionFixtures(root, env, selected = ['codex', 'opencode', 'claude-code']) {
  const bin = join(root, 'fixture-bin'); mkdirSync(bin, { recursive: true });
  for (const row of loadHosts().filter(row => selected.includes(row.host))) {
    const program = process.platform === 'win32'
      ? `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(99);\nconsole.log(${JSON.stringify(row.version)});\n`
      : `#!/bin/sh\n[ "$1" = --version ] || exit 99\nprintf '%s\\n' '${row.version}'\n`;
    writeFileSync(join(bin, row.executable), program, { mode: 0o755 });
  }
  return { ...env, PATH: bin + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '') };
}
