#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadModelConfig, inherits } from '../skills/pstack-runtime/scripts/models.mjs';

const source = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const hosts = ['codex', 'opencode', 'claude-code', 'cursor'];
const digest = value => createHash('sha256').update(value).digest('hex');
const help = `Usage: node pstack/scripts/install.mjs [--target all|${hosts.join('|')}] [--project PATH|--global] [--uninstall] [--dry-run]
Defaults: all three requested hosts in the current project. Re-run to update; targets are additive.
--uninstall removes only the selected hosts. --target all selects Codex, OpenCode, and Claude Code.
Requires Node.js 20+. Existing skills and local edits are preserved.`;

function present(path) {
  try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function parse(args) {
  const options = { target: 'all' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--global', '--uninstall', '--help', '--dry-run'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--target', '--project'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${arg}\n${help}`);
  }
  if (options.help) return options;
  if (![...hosts, 'all'].includes(options.target)) throw new Error(help);
  if (options.global && options.project) throw new Error('Choose --project PATH or --global, not both.');
  if (!options.global && !options.project) options.project = process.cwd();
  return options;
}
function files(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (['node_modules', '.git', '.DS_Store'].includes(entry.name) || entry.name.endsWith('.log')) return [];
    const name = join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${name}`);
    return entry.isDirectory() ? files(join(directory, entry.name), name) : [name];
  });
}
function matches(path, entry) {
  const stat = present(path);
  if (!stat) return false;
  if (entry.kind === 'link') return stat.isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === resolve(dirname(path), entry.to);
  return stat.isFile() && digest(readFileSync(path)) === entry.hash;
}
function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}
function safePath(root, name) {
  const path = resolve(root, name);
  if (isAbsolute(name) || path === root || !path.startsWith(root + sep)) throw new Error(`Invalid install path: ${name}`);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    const stat = present(parent);
    if (stat?.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${parent}`);
    if (stat && !stat.isDirectory()) throw new Error(`Install parent is not a directory: ${parent}`);
  }
  return path;
}
function stateFrom(path) {
  if (!present(path)) return { version: 2, targets: [], entries: {} };
  if (!lstatSync(path).isFile()) throw new Error(`Install manifest is not a regular file: ${path}`);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (![1, 2].includes(state.version) || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object') throw new Error('Invalid pstack install manifest.');
  if (state.version === 1) state.targets = state.target === 'all' ? hosts.slice(0, 3) : [state.target];
  if (!Array.isArray(state.targets) || state.targets.some(target => !hosts.includes(target))) throw new Error('Invalid installed targets.');
  if (Object.keys(state.entries).some(name => name.startsWith('@opencode/')) && typeof state.opencodeRoot !== 'string') throw new Error('Invalid OpenCode install root.');
  for (const [name, entry] of Object.entries(state.entries)) {
    if (!entry || !['file', 'link'].includes(entry.kind) || (entry.kind === 'file' ? typeof entry.hash !== 'string' : typeof entry.to !== 'string')) throw new Error(`Invalid manifest entry: ${name}`);
  }
  return state;
}
function run(options) {
  const requestedRoot = resolve(options.global ? homedir() : options.project);
  const root = existsSync(requestedRoot) ? realpathSync(requestedRoot) : requestedRoot;
  if (root === source || root.startsWith(source + sep)) throw new Error('Install into a project outside the pstack source package.');
  const statePath = safePath(root, '.pstack/install.json');
  const previous = stateFrom(statePath);
  const selected = options.target === 'all' ? hosts.slice(0, 3) : [options.target];
  const targets = options.uninstall ? previous.targets.filter(target => !selected.includes(target)) : [...new Set([...previous.targets, ...selected])].sort();
  const opencodeRoot = options.global ? canonicalPath(resolve(process.env.XDG_CONFIG_HOME || join(root, '.config'), 'opencode')) : '.opencode';
  const pathFor = (name, state) => name.startsWith('@opencode/') ? safePath(resolve(root, state.opencodeRoot), name.slice('@opencode/'.length)) : safePath(root, name);
  const plannedState = { version: 2, targets, opencodeRoot, entries: {} };
  const planned = plannedState.entries;
  const contents = new Map();
  const addFile = (name, data, mode = 0o644) => { name = name.split(sep).join('/'); planned[name] = { kind: 'file', hash: digest(data), mode }; contents.set(name, data); };
  const addLink = (name, destination) => { name = name.split(sep).join('/'); planned[name] = { kind: 'link', to: relative(dirname(pathFor(name, plannedState)), join(root, destination)) }; };
  if (targets.length) {
    for (const name of files(source)) addFile(join('.pstack/package', name), readFileSync(join(source, name)), lstatSync(join(source, name)).mode & 0o777);
    for (const target of targets) {
      const skillDir = target === 'claude-code' ? '.claude/skills' : target === 'cursor' ? '.cursor/skills' : target === 'opencode' ? '@opencode/skills' : '.agents/skills';
      for (const name of readdirSync(join(source, 'skills')).sort()) addLink(join(skillDir, name), join('.pstack/package/skills', name));
      if (target === 'codex') continue;
      const agentDir = target === 'claude-code' ? '.claude/agents' : target === 'cursor' ? '.cursor/agents' : '@opencode/agents';
      if (target === 'opencode') {
        // Explicit native commands work even on hosts predating skill slash metadata.
        for (const skill of readdirSync(join(source, 'skills')).sort()) {
          const skillBody = readFileSync(join(source, 'skills', skill, 'SKILL.md'), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
          const location = options.global ? `~/.pstack/package/skills/${skill}/` : `.pstack/package/skills/${skill}/`;
          addFile(`@opencode/commands/${skill}.md`, `---\ndescription: ${JSON.stringify('Run the pstack ' + skill + ' skill')}\n---\n\nApply the following installed skill. Resolve its relative references from ${location}, not from this command file.\n\n${skillBody}\n\nUser request: $ARGUMENTS\n`);
        }
        const config = loadModelConfig({ project: root, host: 'opencode' });
        const models = [...new Set(Object.values(config.roles).flat().filter(model => !inherits(model)))].sort();
        const agents = {};
        for (const model of models) {
          const name = `pstack-model-${digest(model).slice(0, 12)}`;
          agents[model] = name;
          addFile(`@opencode/agents/${name}.md`, `---\ndescription: ${JSON.stringify('Pstack worker for configured model ' + model)}\nmode: subagent\nmodel: ${JSON.stringify(model)}\n---\n\nFollow the parent worker brief and its scope. Read the installed pstack-runtime skill before work. The parent supplies the task-specific role and prompt. Do not assume a code-writing role for a review task.\n`);
        }
        addFile('.pstack/opencode-models.json', JSON.stringify({ version: 1, agents }, null, 2) + '\n');
      }
      for (const name of readdirSync(join(source, 'agents')).filter(name => name.endsWith('.md'))) {
        let body = readFileSync(join(source, 'agents', name), 'utf8');
        if (target === 'opencode') body = body.replace(/\n---\n/, '\nmode: subagent\n---\n');
        body += `\nResolve the installed pstack skill directory from the host catalog. The complete package is at ${options.global ? '`~/.pstack/package/skills/`' : '`.pstack/package/skills/` relative to this project installation'}, including all playbooks and references. Read the original skill file there before resolving relative links.\n`;
        addFile(`${agentDir}/${name}`, body);
      }
    }
  }
  const previousPaths = new Map(Object.entries(previous.entries).map(([name, entry]) => [pathFor(name, previous), entry]));
  const plannedPaths = new Map(Object.entries(planned).map(([name, entry]) => [pathFor(name, plannedState), entry]));
  for (const [path, entry] of previousPaths) {
    if (present(path) && !matches(path, entry) && !(plannedPaths.has(path) && matches(path, plannedPaths.get(path)))) throw new Error(`Locally modified pstack file; preserve or move it before retrying: ${path}`);
  }
  for (const [path, entry] of plannedPaths) {
    if (present(path) && !previousPaths.has(path) && !matches(path, entry)) throw new Error(`Install conflict; no files changed: ${path}\nUse a project installation to keep existing user skills, or move the conflicting skill yourself.`);
  }
  if (options['dry-run']) {
    console.log(JSON.stringify({ root, targets, files: plannedPaths.size, remove: [...previousPaths.keys()].filter(path => !plannedPaths.has(path)) }, null, 2));
    return;
  }
  for (const [name, entry] of Object.entries(planned)) {
    const path = pathFor(name, plannedState);
    if (matches(path, entry)) {
      if (entry.kind === 'file' && entry.mode !== undefined) chmodSync(path, entry.mode);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (entry.kind === 'link') {
      if (present(path)) rmSync(path);
      symlinkSync(process.platform === 'win32' ? resolve(dirname(path), entry.to) : entry.to, path, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      const temp = `${path}.pstack-${process.pid}.tmp`;
      writeFileSync(temp, contents.get(name), { flag: 'wx', mode: entry.mode });
      renameSync(temp, path);
    }
  }
  for (const path of previousPaths.keys()) {
    if (!plannedPaths.has(path) && present(path)) rmSync(path);
  }
  if (!targets.length) {
    if (existsSync(statePath)) rmSync(statePath);
    console.log(`Removed selected pstack hosts from ${root}. User configuration and other files were preserved.`);
  } else {
    mkdirSync(dirname(statePath), { recursive: true });
    const temp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(plannedState, null, 2) + '\n', { flag: 'wx' });
    renameSync(temp, statePath);
    console.log(`Pstack installed for ${targets.join(', ')} in ${root}. Restart the host to discover skills. No model configuration required.`);
  }
}
try {
  const options = parse(process.argv.slice(2));
  if (options.help) console.log(help); else run(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
