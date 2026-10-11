#!/usr/bin/env node
// Explicit network integration check; never part of offline PR unit jobs.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolatedEnvironment } from './lib/test-environment.mjs';
import { digest } from './lib/installation-state.mjs';
const url = 'https://github.com/drewt5/cursor-plugins.git', help = 'Usage: node pstack/scripts/check-public-lifecycle.mjs --candidate COMMIT --output FILE\nRequires Git, Node 20+ and the pinned Codex CLI. Fresh public HTTPS clone; isolated home/projects; no paid calls or release publication.';
const options = {};
for (let i = 2; i < process.argv.length; i += 2) { if (process.argv[i] === '--help') { console.log(help); process.exit(0); } assert.ok(['--candidate', '--output'].includes(process.argv[i]) && process.argv[i + 1], help); options[process.argv[i].slice(2)] = process.argv[i + 1]; }
assert.match(options.candidate || '', /^[a-f0-9]{40}$/, help); assert.ok(options.output, help);
const temporary = mkdtempSync(join(tmpdir(), 'pstack-public-clone-')), clone = join(temporary, 'checkout'), project = join(temporary, 'project'); mkdirSync(project);
let activeProject = project;
const env = { ...isolatedEnvironment(temporary), GIT_CONFIG_GLOBAL: '/dev/null' }, logs = [], cases = [];
const command = (exe, args, cwd = activeProject, commandEnv = env) => {
  const result = spawnSync(exe, args, { cwd, env: commandEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  logs.push({ command: [exe, ...args], exitCode: result.status, output: result.stdout, error: result.stderr });
  assert.ok(!result.error && result.status === 0, result.error?.message || result.stderr || result.stdout); return result.stdout;
};
let index = 0;
const record = (name, assertions) => { const log = logs.slice(index); index = logs.length; cases.push({ name, status: 'passed', logDigest: digest(JSON.stringify(log)), assertions }); };
const inventory = directory => readdirSync(directory).sort().flatMap(name => { const path = join(directory, name), stat = lstatSync(path); return [[name, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? digest(readFileSync(path)) : 'directory'], ...(stat.isDirectory() ? inventory(path).map(item => [name + '/' + item[0], ...item.slice(1)]) : [])]; });
try {
  command('git', ['clone', '--no-local', '--no-checkout', url, clone], temporary); command('git', ['fetch', 'origin', '--tags'], clone); command('git', ['switch', '--detach', options.candidate], clone);
  assert.equal(command('git', ['rev-parse', 'HEAD'], clone).trim(), options.candidate);
  command('git', ['init', '-q'], project);
  const source = join(clone, 'pstack'), { packageDigest } = await import(pathToFileURL(join(source, 'scripts/lib/package-provenance.mjs')).href), { loadHosts, observeHost } = await import(pathToFileURL(join(source, 'scripts/lib/tested-hosts.mjs')).href), { inspectNativeDiscovery } = await import(pathToFileURL(join(source, 'scripts/lib/installation-discovery.mjs')).href);
  const metadata = JSON.parse(readFileSync(join(source, 'release.json'))), expected = readdirSync(join(source, 'skills')).sort(), codex = loadHosts().find(row => row.host === 'codex');
  observeHost('codex', env); command(process.execPath, [join(source, 'scripts/release.mjs'), '--check'], clone);
  const run = (script, args = [], scope = project) => command(process.execPath, [join(source, 'scripts', script + '.mjs'), ...(scope === 'global' ? ['--global'] : ['--project', scope]), ...args]);
  const thirdParty = join(project, '.agents/skills/independent-poteto'), thirdBytes = '---\nname: poteto-mode\ndescription: Independent public-clone fixture\n---\n\nIndependent user workflow.\n'; mkdirSync(thirdParty, { recursive: true }); writeFileSync(join(thirdParty, 'SKILL.md'), thirdBytes); chmodSync(join(thirdParty, 'SKILL.md'), 0o640);
  run('install', ['--target', 'codex'], 'global');
  const catalog = await inspectNativeDiscovery({ host: 'codex', executable: 'codex', project, scope: 'global', env, expected, bundles: [join(env.HOME, '.pstack/package')], actualVersion: codex.version, environmentOwnership: 'isolated-test' });
  assert.equal(catalog.classification, 'identified-source', JSON.stringify(catalog)); assert.ok(catalog.independentIdentities.includes('poteto-mode')); assert.ok(catalog.entries.some(entry => entry.name === 'poteto-mode' && entry.origin.endsWith('/independent-poteto/SKILL.md')));
  assert.equal(readFileSync(join(thirdParty, 'SKILL.md'), 'utf8'), thirdBytes); assert.equal(lstatSync(join(thirdParty, 'SKILL.md')).mode & 0o777, 0o640);
  logs.push({ nativeCatalog: catalog }); record('coherent-coexistence', { qualifiedGlobalBundle: true, independentSameNameProjectSkill: true, userBytesAndModePreserved: true }); run('uninstall', [], 'global');
  mkdirSync(join(project, '.pstack'), { recursive: true }); const config = '{"version":1,"roles":{}}\n'; writeFileSync(join(project, '.pstack/models.json'), config);
  run('install', ['--target', 'codex']); const receipt = () => JSON.parse(readFileSync(join(project, '.pstack/install.json'))), first = receipt(); assert.equal(first.provenance.sourceCommit, options.candidate); assert.equal(first.provenance.dirty, false); assert.equal(first.generation.digest, packageDigest(source));
  run('install'); const doctor = JSON.parse(run('doctor', ['--json'])); assert.equal(doctor.integrity.status, 'verified');
  for (const [name] of inventory(project).filter(([name]) => name.startsWith('.agents/') || name === '.pstack/opencode-models.json')) {
    const artifact = join(project, name), stat = lstatSync(artifact);
    const content = stat.isSymbolicLink() ? readlinkSync(artifact) : stat.isFile() ? readFileSync(artifact, 'utf8') : '';
    assert.ok(!content.includes('/Users/') && !content.includes(clone), name);
  }
  record('public-clone', { exactCandidate: options.candidate, packageDigest: first.generation.digest, oneSelectedCheckoutApply: true, doctor: doctor.integrity.status, staticProductionVisibility: doctor.discovery.status });
  const owned = join(project, '.agents/skills/how'), receiptBytes = readFileSync(join(project, '.pstack/install.json')); rmSync(owned); mkdirSync(owned); writeFileSync(join(owned, 'SKILL.md'), thirdBytes);
  const conflict = spawnSync(process.execPath, [join(source, 'scripts/install.mjs'), '--project', project], { env, encoding: 'utf8', timeout: 30000 }); logs.push({ command: ['install', '--project', project], exitCode: conflict.status, error: conflict.stderr }); assert.equal(conflict.status, 1); assert.deepEqual(readFileSync(join(project, '.pstack/install.json')), receiptBytes); assert.equal(readFileSync(join(owned, 'SKILL.md'), 'utf8'), thirdBytes);
  renameSync(owned, join(project, 'preserved-third-party')); run('install');
  const payload = join(project, '.pstack/package/README.md'), original = readFileSync(payload); writeFileSync(payload, 'local user edit'); const localEdit = spawnSync(process.execPath, [join(source, 'scripts/install.mjs'), '--project', project], { env, encoding: 'utf8', timeout: 30000 }); assert.equal(localEdit.status, 1); assert.equal(readFileSync(payload, 'utf8'), 'local user edit'); logs.push({ localEditExit: localEdit.status, error: localEdit.stderr }); writeFileSync(payload, original);
  record('ownership-conflict', { laterReplacementPreserved: true, immutableLocalEditPreserved: true, receiptPreserved: true, explicitUserPreservationBeforeRepair: true });
  const before = readFileSync(join(project, '.pstack/install.json')), child = fork(join(source, 'tests/fixtures/public-activation-child.mjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); let output = '', error = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => error += bytes);
  child.on('message', message => { if (message.boundary === 'mutation:0') child.kill('SIGKILL'); else if (message.boundary) child.send('continue'); else if (message.error) error += message.error; }); child.send({ source, root: project, globalRoot: env.HOME, options: { target: 'cursor' } });
  const [code, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL', error); assert.equal(code, null); const recovery = readFileSync(join(project, '.pstack/recovery.txt'), 'utf8').trim(); assert.ok(output.includes(recovery));
  const movedClone = clone + '-temporarily-absent'; renameSync(clone, movedClone); const restored = JSON.parse(command('/bin/sh', ['-c', recovery + ' --recover-dead-locks'])); assert.equal(restored.restored, true); assert.deepEqual(readFileSync(join(project, '.pstack/install.json')), before); renameSync(movedClone, clone);
  record('interrupted-recovery', { sourceAbsent: true, exactPrintedCommand: true, safeDeadLockRecovery: true, priorReceiptExact: true });
  run('install', ['--target', 'cursor']); assert.ok(receipt().targets.includes('cursor')); run('rollback'); assert.deepEqual(receipt().targets, ['codex']); assert.equal(readFileSync(join(project, '.pstack/models.json'), 'utf8'), config); record('rollback', { previousTargetSet: ['codex'], currentConfigPreserved: true, packageDigest: receipt().generation.digest });
  const relocated = join(temporary, 'relocated-project'); renameSync(project, relocated); activeProject = relocated; const savedUser = inventory(relocated).filter(([name]) => name === '.pstack/models.json' || name.startsWith('.agents/skills/independent-poteto/') || name.startsWith('preserved-third-party/'));
  run('uninstall', [], relocated); assert.deepEqual(inventory(relocated).filter(([name]) => name === '.pstack/models.json' || name.startsWith('.agents/skills/independent-poteto/') || name.startsWith('preserved-third-party/')), savedUser); assert.equal(readdirSync(join(relocated, '.pstack')).includes('releases'), false); record('relocation-uninstall', { userBytesAndModesExact: true, noManagedExecutableStorage: true });
  const portableTags = command('git', ['tag', '--list', 'pstack-v*', '--sort=-version:refname'], clone).trim().split('\n').filter(tag => tag && tag !== `pstack-v${metadata.version}`), baseline = portableTags[0] || '6fc8c8956bfdbd52194204876155be0d9f9d497d';
  const oldCheckout = join(temporary, 'historical-checkout'); command('git', ['worktree', 'add', '--detach', oldCheckout, baseline], clone); const old = join(oldCheckout, 'pstack'), baselineProject = join(temporary, 'baseline-project'); mkdirSync(baselineProject);
  command(process.execPath, [join(old, 'scripts/install.mjs'), '--project', baselineProject, '--target', 'codex']); run('install', [], baselineProject); const upgraded = JSON.parse(readFileSync(join(baselineProject, '.pstack/install.json'))); assert.equal(upgraded.previous.state.generation.digest, packageDigest(old)); run('rollback', [], baselineProject); assert.equal(JSON.parse(readFileSync(join(baselineProject, '.pstack/install.json'))).generation.digest, packageDigest(old)); run('install', [], baselineProject); run('uninstall', [], baselineProject);
  record('historical-upgrade', { baseline, baselineCommit: command('git', ['rev-parse', 'HEAD'], oldCheckout).trim(), previousPackageDigest: upgraded.previous.state.generation.digest, actualHistoricalInstaller: true, publicUpgradeRollbackUpdateUninstall: true });
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=all'], clone).trim(), '');
  const report = { schemaVersion: 1, kind: 'public-clone-lifecycle', status: 'passed', candidate: { sourceCommit: options.candidate, packageDigest: packageDigest(source), upstreamCommit: metadata.upstreamCommit }, environment: { cloneUrl: url, cloneSourceCommit: options.candidate, maintainerCredentials: false, existingInstallation: false, prerequisites: { node: process.version, codex: codex.version } }, cases, limits: ['Provider unknown-version transitions are covered by offline version fixtures and advisory canaries, not a real provider upgrade here.', 'Native calls use isolated disposable state. Mock invocation/paid-model reasoning and Cursor GUI are separate or unverified.', 'Duplicate full project/global bundles and OpenCode same-name shadowing remain unsupported as documented.'] };
  const outputPath = resolve(options.output); mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); writeFileSync(outputPath + '.logs.json', JSON.stringify(logs, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ output: outputPath, candidate: report.candidate, status: report.status }));
} finally { rmSync(temporary, { recursive: true, force: true }); }
