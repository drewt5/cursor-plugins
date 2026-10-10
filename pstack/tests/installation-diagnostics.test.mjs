import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../scripts/lib/installation-state.mjs';
import { inspectInstallation, probeHostVersion } from '../scripts/lib/installation-diagnostics.mjs';
import { loadHosts } from '../scripts/lib/tested-hosts.mjs';
import { isolatedEnvironment } from '../scripts/lib/test-environment.mjs';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-inspection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), env = isolatedEnvironment(root); mkdirSync(join(project, '.pstack/package'), { recursive: true });
  const path = join(project, '.pstack/package/file'); writeFileSync(path, 'owned');
  const state = { version: 2, targets: ['codex'], entries: { '.pstack/package/file': { kind: 'file', hash: digest('owned'), mode: 0o644 } } };
  const receipt = join(project, '.pstack/install.json'); writeFileSync(receipt, JSON.stringify(state));
  const options = { root: project, env, globalRoot: env.HOME, versionProbe: row => ({ code: null, status: 'observed-baseline', evidence: { actualVersion: row.version } }) };
  return { root, project, env, path, state, receipt, options };
}
test('clean and uninstalled inspection preserve bytes and keep discovery explicitly unavailable', t => {
  const f = fixture(t), before = readFileSync(f.receipt);
  const result = inspectInstallation(f.options);
  assert.equal(result.schemaVersion, 1); assert.equal(result.state, 'installed'); assert.equal(result.integrity.status, 'verified');
  assert.equal(result.discovery.status, 'unavailable');
  assert.ok(result.findings.some(finding => finding.code === 'DISCOVERY_UNAVAILABLE' && finding.verification === 'unavailable'));
  assert.deepEqual(readFileSync(f.receipt), before); assert.equal(readFileSync(f.path, 'utf8'), 'owned');
  rmSync(f.receipt);
  assert.equal(inspectInstallation(f.options).state, 'uninstalled');
});
test('missing, modified and replaced managed artifacts have stable actionable codes', t => {
  const f = fixture(t);
  writeFileSync(f.path, 'user edit');
  let result = inspectInstallation(f.options); assert.equal(result.findings[0].code, 'OWNED_MODIFIED'); assert.ok(result.findings[0].action);
  assert.equal(readFileSync(f.path, 'utf8'), 'user edit');
  rmSync(f.path); result = inspectInstallation(f.options); assert.equal(result.findings[0].code, 'OWNED_MISSING');
  symlinkSync('unrelated-target', f.path); result = inspectInstallation(f.options); assert.equal(result.findings[0].code, 'OWNED_REPLACED');
});
test('malformed, future and out-of-scope receipts are rejected without repair or reading unrelated bodies', t => {
  const f = fixture(t);
  for (const content of ['{broken', JSON.stringify({ ...f.state, version: 99 }), JSON.stringify({ ...f.state, entries: { '.ssh/private-key': { kind: 'file', hash: digest('secret') } } })]) {
    writeFileSync(f.receipt, content);
    const result = inspectInstallation(f.options);
    assert.equal(result.state, 'invalid'); assert.equal(result.findings[0].code, 'RECEIPT_INVALID');
    assert.equal(result.integrity.status, 'unavailable'); assert.equal(readFileSync(f.receipt, 'utf8'), content);
  }
});
test('relocation remains valid and permission denial remains actionable unavailable evidence', t => {
  const f = fixture(t), moved = join(f.root, 'moved'); renameSync(f.project, moved);
  assert.equal(inspectInstallation({ ...f.options, root: moved }).integrity.status, 'verified');
  const denied = inspectInstallation({ ...f.options, root: moved, snapshotReader: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); } });
  assert.equal(denied.findings[0].code, 'INSPECTION_DENIED'); assert.equal(denied.integrity.status, 'unavailable');
});
test('recorded scope overlap is not serialized as verified active duplicate discovery', t => {
  const f = fixture(t); mkdirSync(join(f.env.HOME, '.pstack'));
  writeFileSync(join(f.env.HOME, '.pstack/install.json'), JSON.stringify(f.state));
  const duplicate = inspectInstallation(f.options).findings.find(finding => finding.code === 'DUPLICATE_PSTACK');
  assert.equal(duplicate.verification, 'unavailable'); assert.equal(duplicate.evidence.activeDiscovery, 'unavailable');
});
test('bounded version probes distinguish missing, nonzero, malformed, timeout and unknown versions', t => {
  const f = fixture(t), row = { ...loadHosts()[0], executable: process.execPath };
  const cases = [
    [{ ...row, executable: join(f.root, 'absent') }, 'HOST_MISSING'],
  ];
  for (const [input, code] of cases) assert.equal(probeHostVersion(input, f.env).code, code);
  const scripts = [ ['process.exit(7)', 'HOST_PROBE_FAILED'], ['console.log("unknown")', 'HOST_VERSION_INVALID'], ['setInterval(() => {}, 100)', 'HOST_PROBE_TIMEOUT'], ['console.log("99.0.0")', 'HOST_VERSION_UNKNOWN'] ];
  for (const [body, code] of scripts) {
    const script = join(f.root, code); writeFileSync(script, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    assert.equal(probeHostVersion({ ...row, executable: script }, f.env, code === 'HOST_PROBE_TIMEOUT' ? 300 : 3000).code, code);
  }
});
test('diagnostics do not inspect unselected host files or follow a replaced external OpenCode root', t => {
  const f = fixture(t), external = join(f.root, 'opencode'), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(join(external, 'skills'), { recursive: true }); mkdirSync(join(elsewhere, 'skills'), { recursive: true });
  writeFileSync(join(elsewhere, 'skills/private'), 'unrelated bytes');
  f.state.targets.push('opencode'); f.state.opencodeRoot = external;
  f.state.entries['@opencode/skills/private'] = { kind: 'file', hash: digest('recorded') };
  rmSync(external, { recursive: true }); symlinkSync(elsewhere, external);
  writeFileSync(f.receipt, JSON.stringify(f.state));
  const codexOnly = inspectInstallation({ ...f.options, targets: ['codex'] });
  assert.equal(codexOnly.integrity.status, 'verified');
  assert.ok(!codexOnly.findings.some(finding => finding.code === 'PATH_UNSAFE'));
  const selected = inspectInstallation({ ...f.options, targets: ['opencode'] });
  assert.equal(selected.findings[0].code, 'PATH_UNSAFE');
  assert.equal(readFileSync(join(elsewhere, 'skills/private'), 'utf8'), 'unrelated bytes');
});

function tree(root) {
  return readdirSync(root).sort().flatMap(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [[path, stat.mode & 0o777, stat.isSymbolicLink() ? readlinkSync(path) : stat.isFile() ? digest(readFileSync(path)) : 'directory'], ...(stat.isDirectory() ? tree(path) : [])];
  });
}
test('inspection preserves the complete fixture tree and does not serialize environment values or file bodies', t => {
  const f = fixture(t); f.env.FAKE_CREDENTIAL = 'do-not-report-this-value';
  writeFileSync(join(f.root, 'user-config'), 'user-owned configuration'); symlinkSync('user-config', join(f.root, 'user-link'));
  const before = tree(f.root), report = inspectInstallation(f.options);
  assert.deepEqual(tree(f.root), before);
  assert.ok(!JSON.stringify(report).includes('do-not-report-this-value'));
  assert.ok(!JSON.stringify(report).includes('user-owned configuration'));
});
test('configured root drift is distinguished from the recorded owned root', t => {
  const f = fixture(t); f.state.targets = ['opencode']; f.state.opencodeRoot = join(f.root, 'old-opencode');
  writeFileSync(f.receipt, JSON.stringify(f.state));
  const result = inspectInstallation({ ...f.options, global: true });
  const drift = result.findings.find(finding => finding.code === 'HOST_ROOT_CHANGED');
  assert.equal(drift.evidence.recordedRoot, f.state.opencodeRoot);
  assert.equal(drift.evidence.configuredRoot, join(f.env.XDG_CONFIG_HOME, 'opencode'));
});
