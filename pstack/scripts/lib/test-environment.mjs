import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function isolatedEnvironment(root, base = process.env) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TMP', 'TEMP']) {
    if (base[key]) env[key] = base[key];
  }
  for (const [key, folder] of Object.entries({ HOME: 'home', USERPROFILE: 'home', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', BUN_INSTALL_CACHE_DIR: 'bun-cache' })) {
    env[key] = join(root, folder);
    mkdirSync(env[key], { recursive: true });
  }
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', OPENCODE_DISABLE_MODELS_FETCH: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}
