import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installLegacy } from './fixtures/legacy-installation.mjs';
import { stateFrom, digest } from '../scripts/lib/installation-state.mjs';
const source = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'pstack-public-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project'), home = join(base, 'home'); mkdirSync(root); mkdirSync(home);
  const env = { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: join(home, '.config') };
  const run = (script = 'install', args = []) => spawnSync(process.execPath, [join(source, 'scripts', script + '.mjs'), '--project', root, ...args], { env, encoding: 'utf8' });
  return { base, root, home, env, run };
}
function tree(path) { return readdirSync(path).sort().flatMap(name => { const file = join(path, name), stat = lstatSync(file); return [[file, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(file) : stat.isFile() ? digest(readFileSync(file)) : 'directory'], ...(stat.isDirectory() ? tree(file) : [])]; }); }
const ok = result => assert.equal(result.status, 0, result.stderr);
test('public schema 1/2 migration, rollback, repair, relocation and uninstall preserve config/user skills without receipt edits', t => {
  for (const schema of [1, 2]) {
    const f = fixture(t); installLegacy({ source, root: f.root, schema });
    mkdirSync(join(f.root, '.cursor/skills/user-skill')); writeFileSync(join(f.root, '.cursor/skills/user-skill/SKILL.md'), 'unrelated');
    const cfg = '{"version":2,"future":"settings unrelated to Cursor adapters"}'; writeFileSync(join(f.root, '.pstack/models.json'), cfg);
    const before = tree(f.root); ok(f.run('install', ['--dry-run'])); assert.deepEqual(tree(f.root), before);
    ok(f.run()); const state = stateFrom(join(f.root, '.pstack/install.json')); assert.equal(state.version, 4); assert.equal(state.previous.state.provenance.classification, 'legacy-unknown'); assert.equal(state.previous.state.provenance.sourceCommit, null);
    ok(f.run('rollback')); assert.equal(readFileSync(join(f.root, '.pstack/models.json'), 'utf8'), cfg);
    ok(f.run()); rmSync(join(f.root, '.cursor/skills/poteto-mode')); ok(f.run()); assert.match(readFileSync(join(f.root, '.cursor/skills/poteto-mode/SKILL.md'), 'utf8'), /Non-negotiables/);
    const relocated = join(f.base, 'relocated'); renameSync(f.root, relocated);
    const removal = spawnSync(process.execPath, [join(source, 'scripts/uninstall.mjs'), '--project', relocated], { env: f.env, encoding: 'utf8' }); ok(removal);
    assert.equal(readFileSync(join(relocated, '.pstack/models.json'), 'utf8'), cfg); assert.equal(readFileSync(join(relocated, '.cursor/skills/user-skill/SKILL.md'), 'utf8'), 'unrelated'); assert.equal(readdirSync(join(relocated, '.pstack')).includes('releases'), false);
  }
});
test('legacy edited files, unowned additions and host conflicts are all listed before any scope mutation', t => {
  const f = fixture(t); installLegacy({ source, root: f.root });
  for (const name of ['README.md', 'package.json']) writeFileSync(join(f.root, '.pstack/package', name), 'user edit');
  mkdirSync(join(f.root, '.pstack/package/user-directory')); writeFileSync(join(f.root, '.pstack/package/user-directory/keep.txt'), 'user'); writeFileSync(join(f.root, '.cursor/agents/poteto-agent.md'), 'edited host');
  const before = tree(f.root); const result = f.run(); assert.equal(result.status, 1);
  for (const name of ['README.md', 'package.json', 'user-directory', 'keep.txt', 'poteto-agent.md']) assert.ok((result.stdout + result.stderr).includes(name), name);
  assert.deepEqual(tree(f.root), before); assert.equal(readdirSync(join(f.root, '.pstack')).includes('releases'), false);
});
test('unchanged legacy full uninstall takes the transaction path and removes captured executable packages', t => {
  const f = fixture(t); installLegacy({ source, root: f.root }); ok(f.run('uninstall'));
  assert.equal(stateFrom(join(f.root, '.pstack/install.json')).targets.length, 0); assert.equal(readdirSync(f.root).includes('.pstack'), false);
});
test('public fresh and legacy operations killed after stable transition recover from exact retained command with source deleted and stale lock', { timeout: 20000 }, async t => {
  const { fork } = await import('node:child_process'), { once } = await import('node:events');
  for (const legacy of [false, true]) {
    const f = fixture(t), candidate = join(f.base, 'selected-source'); cpSync(source, candidate, { recursive: true });
    if (legacy) installLegacy({ source: candidate, root: f.root });
    const before = tree(f.root), child = fork(join(candidate, 'tests/fixtures/public-activation-child.mjs'), [], { env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', error = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => error += bytes);
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    child.on('message', message => { if (message.boundary === (legacy ? 'mutation:1' : 'mutation:0')) child.kill('SIGKILL'); else if (message.boundary) child.send('continue'); else if (message.error) error += message.error; });
    child.send({ source: candidate, root: f.root, globalRoot: f.home, options: { target: 'cursor' } }); const [code, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', error); assert.equal(code, null);
    const command = readFileSync(join(f.root, '.pstack/recovery.txt'), 'utf8').trim(); assert.ok(output.includes(command)); rmSync(candidate, { recursive: true });
    const recovered = spawnSync('/bin/sh', ['-c', command + ' --recover-dead-locks'], { env: f.env, encoding: 'utf8' }); ok(recovered); assert.equal(JSON.parse(recovered.stdout).restored, true);
    const active = tree(f.root).filter(([path]) => !path.includes('/.pstack/releases') && path !== join(f.root, '.pstack'));
    const original = before.filter(([path]) => path !== join(f.root, '.pstack')); assert.deepEqual(active.filter(([, , value]) => value !== 'directory'), original.filter(([, , value]) => value !== 'directory'));
    ok(spawnSync('/bin/sh', ['-c', command], { env: f.env, encoding: 'utf8' }));
  }
});
test('public mandatory discovery failure restores an absent installation with only its unchanged new artifacts removed', async t => {
  const f = fixture(t), { applyPublicInstallation } = await import('../scripts/lib/installation-public.mjs');
  const result = await applyPublicInstallation({ source, root: f.root, globalRoot: f.home, env: f.env, options: { target: 'cursor' } }, { diagnose: async () => ({ findings: [], discovery: { status: 'failed', probes: [{ host: 'cursor', status: 'failed' }] } }) });
  assert.equal(result.status, 'verification-failed-restored'); assert.equal(result.restored, true); assert.equal(stateFrom(join(f.root, '.pstack/install.json')).targets.length, 0); assert.equal(readdirSync(f.root).includes('.cursor'), false);
});
