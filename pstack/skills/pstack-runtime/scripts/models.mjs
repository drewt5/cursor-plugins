#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const panelRoles = ['arena runners', 'arena cross-judge pool', 'architect runners', 'interrogate reviewers'];
export const roles = ['feature, refactoring', 'bug-fix', 'perf-issue', 'hillclimb', 'judgment and prose', 'hardest tasks', 'how explorer', 'how explainer', 'why investigators', 'why synthesizer', 'reflect tooling', 'reflect judgment, divergent, synthesizer', 'arena runners', 'arena cross-judge pool', 'swarm workers', 'architect runners', 'interrogate reviewers'];
export const hosts = ['codex', 'opencode', 'claude-code', 'cursor'];
export const inherits = model => ['inherit-parent', 'auto'].includes(model);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateLayer(layer, label) {
  if (!object(layer)) throw new Error(`${label} must be an object`);
  if (layer.reasoning !== undefined && (typeof layer.reasoning !== 'string' || !layer.reasoning.trim())) throw new Error(`${label}.reasoning must be a nonempty string`);
  if (layer.roles !== undefined && !object(layer.roles)) throw new Error(`${label}.roles must be an object`);
  for (const [role, value] of Object.entries(layer.roles || {})) {
    if (!roles.includes(role)) throw new Error(`${label}: unknown role ${role}`);
    const values = panelRoles.includes(role) ? value : [value];
    if (!Array.isArray(values) || values.length === 0 || values.some(model => typeof model !== 'string' || !model.trim() || model !== model.trim())) throw new Error(`${label}: ${role} requires ${panelRoles.includes(role) ? 'a nonempty array of model names' : 'one model name'}`);
  }
}
export function readConfig(path) {
  if (!existsSync(path)) return {};
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`Invalid model configuration ${path}: ${error.message}`); }
  if (!object(value) || value.version !== 1) throw new Error(`${path}: expected model configuration version 1`);
  validateLayer(value, path);
  if (value.hosts !== undefined && !object(value.hosts)) throw new Error(`${path}.hosts must be an object`);
  for (const [host, layer] of Object.entries(value.hosts || {})) {
    if (!hosts.includes(host)) throw new Error(`${path}: unknown host ${host}`);
    validateLayer(layer, `${path}.hosts.${host}`);
  }
  return value;
}
export function loadModelConfig({ project = process.cwd(), home = homedir(), configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'), host }) {
  if (!hosts.includes(host)) throw new Error(`Expected host: ${hosts.join(', ')}`);
  const userPath = join(configHome, 'pstack/models.json');
  const projectPath = join(project, '.pstack/models.json');
  const user = readConfig(userPath), local = readConfig(projectPath);
  const result = { version: 1, host, roles: Object.fromEntries(roles.map(role => [role, panelRoles.includes(role) ? Array(role === 'arena cross-judge pool' ? 1 : 2).fill('inherit-parent') : 'inherit-parent'])) };
  for (const layer of [user, user.hosts?.[host], local, local.hosts?.[host]]) {
    if (!layer) continue;
    Object.assign(result.roles, layer.roles || {});
    if (layer.reasoning !== undefined) result.reasoning = layer.reasoning;
  }
  return result;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i += 2) {
      const key = process.argv[i];
      if (!['--host', '--project'].includes(key) || !process.argv[i + 1]) throw new Error('Usage: node models.mjs --host HOST [--project PATH]');
      options[key.slice(2)] = process.argv[i + 1];
    }
    console.log(JSON.stringify(loadModelConfig(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
