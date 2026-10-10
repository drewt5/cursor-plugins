import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, existsSync, writeFileSync, rmSync, symlinkSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(root, 'scripts/install.mjs');
const skills = readdirSync(join(root, 'skills')).sort();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pstack port '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function install(dir, target = 'all', args = []) {
  return spawnSync(process.execPath, [installer, '--target', target, '--project', dir, ...args], { encoding: 'utf8', env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config') } });
}
function ok(result) { assert.equal(result.status, 0, result.stderr); }

test('every skill has a portable name, description, and reachable runtime contract', () => {
  for (const name of skills) {
    const body = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.match(body, new RegExp(`^---\\nname: ${name}\\n`));
    assert.match(body, /\ndescription: /);
    assert.equal((body.split('\n---\n')[0].match(/^metadata:/gm) || []).length, 1, name);
    if (name !== 'pstack-runtime') assert.match(body, /pstack-runtime/);
    if (body.includes('disable-model-invocation: true')) {
      assert.match(readFileSync(join(root, 'skills', name, 'agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
      assert.match(body, /opencode\/autoinvoke: "false"/);
    }
  }
});

for (const target of ['codex', 'opencode', 'claude-code', 'cursor', 'all']) {
  test(`${target} install discovers every skill and preserves relative resources`, t => {
    const dir = fixture(t);
    ok(install(dir, target));
    assert.ok(!existsSync(join(dir, '.pstack/package/cursor-team-kit')));
    assert.ok(!existsSync(join(dir, '.pstack/package/.claude-plugin/marketplace.json')));
    const locations = target === 'all' ? ['.agents', '.claude', '.opencode'] : [target === 'claude-code' ? '.claude' : target === 'cursor' ? '.cursor' : target === 'opencode' ? '.opencode' : '.agents'];
    for (const location of locations) {
      for (const name of skills) {
        const entry = join(dir, location, 'skills', name);
        assert.equal(realpathSync(entry), realpathSync(join(dir, '.pstack/package/skills', name)));
        assert.ok(existsSync(join(entry, 'SKILL.md')));
      }
      assert.ok(existsSync(join(dir, location, 'skills/poteto-mode/playbooks/feature.md')));
      assert.ok(existsSync(resolve(realpathSync(join(dir, location, 'skills/pstack-runtime')), '../../agents/comment-sicko.md')));
    }
    if (['all', 'opencode'].includes(target)) {
      assert.match(readFileSync(join(dir, '.opencode/agents/poteto-agent.md'), 'utf8'), /mode: subagent/);
    }
    const before = readFileSync(join(dir, '.pstack/install.json'), 'utf8');
    ok(install(dir, target));
    assert.equal(readFileSync(join(dir, '.pstack/install.json'), 'utf8'), before);
    writeFileSync(join(dir, '.pstack/models.json'), '{"version":1,"roles":{}}');
    ok(install(dir, target, ['--uninstall']));
    assert.ok(existsSync(join(dir, '.pstack/models.json')));
    assert.ok(!existsSync(join(dir, locations[0], 'skills/poteto-mode')));
  });
}

test('conflicting user skill aborts before writing package files', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, '.agents/skills/how'), { recursive: true });
  writeFileSync(join(dir, '.agents/skills/how/SKILL.md'), 'user skill');
  const result = install(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Install conflict/);
  assert.equal(readFileSync(join(dir, '.agents/skills/how/SKILL.md'), 'utf8'), 'user skill');
  assert.ok(!existsSync(join(dir, '.pstack/package')));
});

test('updates and uninstall preserve modified owned files', t => {
  const dir = fixture(t);
  ok(install(dir));
  const file = join(dir, '.pstack/package/skills/how/SKILL.md');
  writeFileSync(file, 'local edit');
  for (const args of [[], ['--uninstall']]) {
    const result = install(dir, 'all', args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Locally modified/);
    assert.equal(readFileSync(file, 'utf8'), 'local edit');
  }
});

test('symlinked installation parent is rejected before writing outside project', t => {
  const dir = fixture(t);
  const outside = fixture(t);
  symlinkSync(outside, join(dir, '.agents'), 'dir');
  const result = install(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /symlink/);
  assert.deepEqual(readdirSync(outside), []);
});

test('adding targets preserves other hosts and targeted uninstall preserves shared skills', t => {
  const dir = fixture(t);
  ok(install(dir, 'all'));
  writeFileSync(join(dir, '.claude/agents/user.md'), 'user agent');
  ok(install(dir, 'codex'));
  assert.ok(existsSync(join(dir, '.claude/skills/poteto-mode')));
  ok(install(dir, 'claude-code', ['--uninstall']));
  assert.ok(!existsSync(join(dir, '.claude/skills/poteto-mode')));
  assert.equal(readFileSync(join(dir, '.claude/agents/user.md'), 'utf8'), 'user agent');
  assert.ok(existsSync(join(dir, '.agents/skills/poteto-mode/SKILL.md')));
});

test('portable, Codex, Claude and Cursor manifests agree', () => {
  const manifests = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json'].map(path => JSON.parse(readFileSync(join(root, path), 'utf8')));
  for (const manifest of manifests) {
    assert.equal(manifest.name, 'pstack');
    assert.equal(manifest.version, manifests[0].version);
  }
  assert.equal(manifests[1].skills, './skills/');
  const marketplace = JSON.parse(readFileSync(join(root, '../.claude-plugin/marketplace.json'), 'utf8'));
  const entries = marketplace.plugins.filter(p => p.name === 'pstack');
  assert.equal(entries.length, 1);
  assert.equal(realpathSync(resolve(root, '..', entries[0].source)), realpathSync(root));
});

test('shared workflows do not require Cursor tool arguments or private paths', () => {
  function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]); }
  for (const path of walk(join(root, 'skills'))) {
    if (!path.endsWith('.md') || path.includes('/pstack-runtime/')) continue;
    const body = readFileSync(path, 'utf8');
    assert.doesNotMatch(body, /subagent_type|run_in_background|cloud_base_branch|~\/\.cursor\/projects|pstack-models\.mdc|grok-4\.7|claude-opus-5-5/, path);
  }
});

test('global installation uses user skill roots and the OpenCode config directory', t => {
  const dir = fixture(t);
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') };
  const result = spawnSync(process.execPath, [installer, '--target', 'all', '--global'], { env, encoding: 'utf8' });
  ok(result);
  assert.ok(existsSync(join(dir, '.agents/skills/poteto-mode/SKILL.md')));
  assert.ok(existsSync(join(dir, '.claude/skills/poteto-mode/SKILL.md')));
  assert.ok(existsSync(join(dir, 'config/opencode/agents/poteto-agent.md')));
});

test('installer rejects a destination inside its own source tree', () => {
  const result = install(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the pstack source/);
});

test('updates replace an unmodified prior version and restore missing owned links', t => {
  const dir = fixture(t);
  ok(install(dir, 'codex'));
  const name = '.pstack/package/README.md';
  const manifestPath = join(dir, '.pstack/install.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const old = 'previous version';
  writeFileSync(join(dir, name), old);
  manifest.entries[name].hash = createHash('sha256').update(old).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  rmSync(join(dir, '.agents/skills/poteto-mode'));
  ok(install(dir, 'codex'));
  assert.equal(readFileSync(join(dir, name), 'utf8'), readFileSync(join(root, 'README.md'), 'utf8'));
  assert.ok(existsSync(join(dir, '.agents/skills/poteto-mode/SKILL.md')));
  const script = 'skills/poteto-mode/scripts/worktree-audit.sh';
  assert.equal(statSync(join(dir, '.pstack/package', script)).mode & 0o777, statSync(join(root, script)).mode & 0o777);
});

 test('global installation supports external XDG config and targeted removal', t => {
  const home = fixture(t), config = fixture(t);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: config };
  const run = args => spawnSync(process.execPath, [installer, '--global', ...args], { env, encoding: 'utf8' });
  ok(run([]));
  assert.ok(existsSync(join(config, 'opencode/agents/poteto-agent.md')));
  assert.ok(existsSync(join(config, 'opencode/skills/poteto-mode/SKILL.md')));
  ok(run(['--target', 'opencode', '--uninstall']));
  assert.ok(!existsSync(join(config, 'opencode/agents/poteto-agent.md')));
  assert.ok(existsSync(join(home, '.agents/skills/poteto-mode/SKILL.md')));
  ok(run(['--uninstall']));
});

test('dry-run writes nothing and generated agent prompts are relocatable', t => {
  const dir = fixture(t);
  ok(install(dir, 'all', ['--dry-run']));
  assert.deepEqual(readdirSync(dir), []);
  ok(install(dir));
  for (const host of ['.claude', '.opencode']) {
    assert.ok(!readFileSync(join(dir, host, 'agents/poteto-agent.md'), 'utf8').includes(dir));
  }
});

test('OpenCode model overrides generate and remove native model agents', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, '.pstack'));
  const config = join(dir, '.pstack/models.json');
  writeFileSync(config, JSON.stringify({ version: 1, hosts: { opencode: { roles: { 'bug-fix': 'provider/test' } } } }));
  ok(install(dir, 'opencode'));
  const mapping = JSON.parse(readFileSync(join(dir, '.pstack/opencode-models.json'), 'utf8'));
  const agent = join(dir, '.opencode/agents', mapping.agents['provider/test'] + '.md');
  assert.match(readFileSync(agent, 'utf8'), /model: "provider\/test"/);
  writeFileSync(config, '{"version":1,"roles":{}}');
  ok(install(dir, 'opencode'));
  assert.ok(!existsSync(agent));
});


test('moving a project preserves links and subsequent updates and removal', t => {
  const parent = fixture(t), dir = join(parent, 'before'), moved = join(parent, 'after');
  mkdirSync(dir); ok(install(dir)); renameSync(dir, moved);
  assert.ok(existsSync(join(moved, '.agents/skills/poteto-mode/SKILL.md')));
  ok(install(moved));
  ok(install(moved, 'all', ['--uninstall']));
  assert.ok(!existsSync(join(moved, '.opencode/commands/poteto-mode.md')));
});


test('portable package preserves the full skill, agent, playbook, and automation catalog', () => {
  const expected = JSON.parse(readFileSync(join(root, 'tests/catalog.json'), 'utf8'));
  assert.deepEqual(skills, expected.skills);
  assert.deepEqual(readdirSync(join(root, 'agents')).filter(name => name.endsWith('.md')).sort(), expected.agents);
  assert.deepEqual(readdirSync(join(root, 'skills/poteto-mode/playbooks')).filter(name => name.endsWith('.md')).sort(), expected.playbooks);
  for (const path of expected.automationSkills) assert.ok(existsSync(join(root, path)), path);
});
