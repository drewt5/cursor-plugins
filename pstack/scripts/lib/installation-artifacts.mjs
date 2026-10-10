import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { loadModelConfig, inherits } from '../../skills/pstack-runtime/scripts/models.mjs';
import { digest, files, pathFor as resolvePath } from './installation-state.mjs';

export function renderArtifacts({ source, root, targets, opencodeRoot, global = false, config }) {
  const options = { global };
  const pathFor = (name, state) => resolvePath(root, name, state, false);
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
        const modelConfig = config ?? loadModelConfig({ project: root, host: 'opencode' });
        const models = [...new Set(Object.values(modelConfig.roles).flat().filter(model => !inherits(model)))].sort();
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
  return { state: plannedState, contents };
}
