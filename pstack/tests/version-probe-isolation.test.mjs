import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { probeHostVersion } from '../scripts/lib/installation-diagnostics.mjs';

test('writing version programs cannot touch requested home/project/config/state or inherit credentials/hooks', t => {
  const root = mkdtempSync(join(tmpdir(), 'pstack-version-user-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), project = join(root, 'project'), executable = join(root, 'provider'); mkdirSync(home); mkdirSync(project);
  const marker = join(root, 'user-hook-executed');
  const environment = { HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home, XDG_DATA_HOME: home, API_KEY: 'do-not-inherit', NODE_OPTIONS: '--invalid-user-option', USER_HOOK: marker, PATH: process.env.PATH };
  writeFileSync(join(home, 'credentials.json'), 'user credential sentinel');
  writeFileSync(executable, `#!${process.execPath}\nconst{writeFileSync}=require('node:fs');\nif(process.env.API_KEY||process.env.USER_HOOK||process.env.NODE_OPTIONS)process.exit(7);\nif(process.cwd()===${JSON.stringify(project)}||process.env.HOME===${JSON.stringify(home)})process.exit(8);\nfor(const key of ['HOME','CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','XDG_DATA_HOME'])writeFileSync(process.env[key]+'/version-state','temporary');\nconsole.log('1.2.3');\n`, { mode: 0o755 });
  const before = readdirSync(home), result = probeHostVersion({ executable, version: '1.2.3' }, environment);
  assert.equal(result.status, 'observed-baseline', JSON.stringify(result)); assert.equal(result.evidence.environment, 'disposable-home-project-config-cache-state'); assert.deepEqual(readdirSync(home), before); assert.deepEqual(readdirSync(project), []); assert.equal(readFileSync(join(home, 'credentials.json'), 'utf8'), 'user credential sentinel'); assert.ok(!readdirSync(root).includes('user-hook-executed')); assert.ok(!JSON.stringify(result).includes('do-not-inherit'));
});
test('relative executable PATH entries retain their original resolution in isolated cwd', t => {
  const root = mkdtempSync(join(tmpdir(), 'pstack-version-path-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'fixture-provider'), `#!${process.execPath}\nconsole.log('1.2.3');\n`, { mode: 0o755 });
  const result = probeHostVersion({ executable: 'fixture-provider', version: '1.2.3' }, { PATH: relative(process.cwd(), root) }); assert.equal(result.status, 'observed-baseline', JSON.stringify(result));
});
