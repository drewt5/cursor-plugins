#!/usr/bin/env node
import { isolatedEnvironment } from './lib/test-environment.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'pstack-invocation-'));
const project = join(temporary, 'project');
mkdirSync(project);
const env = {
  ...isolatedEnvironment(temporary), PWD: project,
  XDG_CONFIG_HOME: join(temporary, 'config'), XDG_DATA_HOME: join(temporary, 'data'),
  XDG_CACHE_HOME: join(temporary, 'cache'), XDG_STATE_HOME: join(temporary, 'state'),
  CLAUDE_CONFIG_DIR: join(temporary, 'claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  OPENCODE_DISABLE_MODELS_FETCH: 'true', ANTHROPIC_API_KEY: 'pstack-local-fixture', OPENAI_API_KEY: 'pstack-local-fixture',
};
const marker = 'PSTACK_NATIVE_SKILL_OK';
let requests = [];
const server = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.url.includes('count_tokens')) { response.setHeader('Content-Type', 'application/json'); response.end('{"input_tokens":100}'); return; }
    if (!request.url.includes('messages') && !request.url.includes('responses')) { response.writeHead(404); response.end('{}'); return; }
    requests.push(body);
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.setHeader('Content-Type', 'text/event-stream');
    if (request.url.includes('messages')) {
      const message = { id: 'msg_pstack_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
      send({ type: 'message_start', message });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: marker } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      send({ type: 'message_stop' });
    } else {
      const item = { id: 'msg_pstack_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: marker, annotations: [] }] };
      const result = { id: 'resp_pstack_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      send({ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } });
      send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: marker });
      send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: marker });
      send({ type: 'response.output_item.done', output_index: 0, item });
      send({ type: 'response.completed', response: result });
    }
    response.end();
  } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
});
async function run(executable, args, extraEnv = {}) {
  requests = [];
  const child = spawn(executable, args, { cwd: project, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { errors += value; });
  const code = await new Promise((resolveCode, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${executable} invocation timed out: ${errors.slice(-2000)}`)); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', value => { clearTimeout(timer); resolveCode(value); });
  });
  assert.equal(code, 0, `${executable}: ${errors}\n${output.slice(-2000)}`);
  assert.ok(requests.length > 0, `${executable} never reached the local test API: ${output} ${errors}`);
  assert.ok(requests.some(body => JSON.stringify(body).includes('## Non-negotiables') && JSON.stringify(body).includes('pstack-runtime')), `${executable} did not expand poteto-mode into the model request`);
  assert.ok(output.includes(marker), `${executable} did not return the fixture response`);
}
try {
  const selected = process.argv[2] || 'all';
  assert.ok(['all', 'codex', 'opencode', 'claude-code'].includes(selected), 'Expected all, codex, opencode, or claude-code');
  const install = (target, uninstall = false) => {
    const result = spawnSync(process.execPath, [join(source, 'scripts/install.mjs'), '--target', target, '--project', project, ...(uninstall ? ['--uninstall'] : [])], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  assert.equal(spawnSync('git', ['init', '-q', project], { env }).status, 0);
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const base = `http://127.0.0.1:${server.address().port}`;
  if (selected === 'all' || selected === 'claude-code') {
    install('claude-code');
    const common = [ '--setting-sources', 'project', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', '', '-p', '--output-format', 'json'];
    await run('claude', [...common, '/poteto-mode Read-only installation smoke test.'], { ANTHROPIC_BASE_URL: base });
    install('claude-code', true);
    await run('claude', ['--plugin-dir', source, ...common, '/pstack:poteto-mode Read-only installation smoke test.'], { ANTHROPIC_BASE_URL: base });
    console.log('Claude Code: standalone and native-plugin commands expand the actual skill and complete a local API round trip.');
  }
  if (selected === 'all' || selected === 'opencode') {
    install('opencode');
    writeFileSync(join(project, 'opencode.json'), JSON.stringify({ model: 'pstack-fixture/test', provider: { 'pstack-fixture': { npm: '@ai-sdk/anthropic', name: 'Local test fixture', options: { baseURL: base + '/v1', apiKey: 'pstack-local-fixture' }, models: { test: { name: 'Local test fixture', limit: { context: 200000, output: 1000 } } } } } }));
    await run('opencode', ['--pure', 'run', '--dir', project, '--format', 'json', '--command', 'poteto-mode', 'Read-only installation smoke test.']);
    install('opencode', true);
    console.log('OpenCode: slash command expands the actual skill and completes a local API round trip.');
  }
  if (selected === 'all' || selected === 'codex') {
    install('codex');
    const provider = `model_providers.pstack_fixture={name="Local test fixture",base_url="${base}/v1",wire_api="responses",requires_openai_auth=false}`;
    await run('codex', ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '-c', 'model_provider="pstack_fixture"', '-c', provider, '-m', 'pstack-fixture', '--json', '$pstack:poteto-mode Read-only installation smoke test.']);
    install('codex', true);
    console.log('Codex: skill invocation expands the actual skill and completes a local API round trip.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(done => server.close(done));
  rmSync(temporary, { recursive: true, force: true });
}
