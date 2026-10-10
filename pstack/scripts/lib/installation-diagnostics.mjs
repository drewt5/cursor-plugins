import { inspectInterruptedOperation } from './activation-journal.mjs';
import { verifyGeneration } from './installation-storage.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { isolatedEnvironment } from './test-environment.mjs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { isManagedEntryName, canonicalPath, digest, isPackagePath, entryOwner, hosts, installationSnapshot, present, safePath, stateFrom } from './installation-state.mjs';
import { loadHosts } from './tested-hosts.mjs';

export function probeHostVersion(row, env = process.env, timeout = 3000) {
  const command = [row.executable, '--version'];
  const scratch = mkdtempSync(join(tmpdir(), 'pstack-version-probe-'));
  let result;
  try {
    const isolated = isolatedEnvironment(scratch, env);
    if (env.PATH !== undefined) isolated.PATH = env.PATH.split(delimiter).map(path => resolve(path || '.')).join(delimiter);
    const temporary = join(scratch, 'tmp'); mkdirSync(temporary);
    Object.assign(isolated, { TMPDIR: temporary, TMP: temporary, TEMP: temporary, PWD: scratch });
    result = spawnSync(command[0], command.slice(1), { cwd: scratch, env: isolated, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8192 });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  const evidence = { command, environment: 'disposable-home-project-config-cache-state', exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    output: String(result.stdout || '').slice(-1024), error: String(result.stderr || '').slice(-1024), testedVersion: row.version };
  if (result.error?.code === 'ENOENT') return { code: 'HOST_MISSING', status: 'failed', evidence };
  if (result.error?.code === 'ETIMEDOUT') return { code: 'HOST_PROBE_TIMEOUT', status: 'failed', evidence };
  if (result.error || result.status !== 0) return { code: 'HOST_PROBE_FAILED', status: 'failed', evidence };
  const version = result.stdout.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0];
  if (!version) return { code: 'HOST_VERSION_INVALID', status: 'failed', evidence };
  return { code: version === row.version ? null : 'HOST_VERSION_UNKNOWN', status: version === row.version ? 'observed-baseline' : 'unavailable-compatibility', evidence: { ...evidence, actualVersion: version } };
}
export function inspectInstallation({ root, global = false, targets, env = process.env, globalRoot = homedir(), versionProbe = probeHostVersion, snapshotReader = installationSnapshot, operationId }) {
  if (targets !== undefined && (!Array.isArray(targets) || targets.some(host => !hosts.includes(host)))) throw new Error('Invalid diagnostic host selection');
  const findings = [];
  const finding = (code, severity, subject, evidence, action, verification = 'verified') => findings.push({ code, severity, subject, evidence, action, verification });
  const result = { schemaVersion: 1, scope: { kind: global ? 'global' : 'project', root: resolve(root) }, state: 'uninstalled', receipt: { status: 'absent' }, targets: [], configuredRoots: {}, recordedRoots: {}, otherScopes: [], integrity: { status: 'not-installed', missing: [], modified: [], replacements: [] }, hosts: [], discovery: { status: 'unavailable' }, provenance: { status: 'unknown', classification: 'unknown', sourceCommit: null, packageDigest: null }, findings };
  let previous;
  try {
    result.scope.root = canonicalPath(root);
    const path = safePath(result.scope.root, '.pstack/install.json');
    previous = stateFrom(path);
    if (Object.keys(previous.entries).some(name => !isManagedEntryName(name))) throw new Error('Receipt contains paths outside managed package/host locations');
    result.receipt = { path, status: present(path) ? 'valid' : 'absent', schemaVersion: present(path) ? previous.version : null };
    result.targets = previous.targets;
    result.installedHostObservations = previous.version >= 3 ? previous.hostObservations : [];
    if (result.receipt.status === 'valid') {
      const selected = targets ?? previous.targets;
      const snapshot = snapshotReader({ root: result.scope.root, desired: previous, includeEntry: name => entryOwner(name) === 'shared-package' || selected.includes(entryOwner(name)) });
      result.state = 'installed'; result.integrity.status = 'verified';
      for (const item of snapshot.owned) {
        const actual = snapshot.observed[item.path], baseline = item.entry;
        const evidence = { path: item.path, recorded: baseline, observed: actual };
        if (actual.kind === 'absent') {
          result.integrity.missing.push(item.path);
          finding('OWNED_MISSING', 'error', item.path, evidence, 'Re-run install from the selected release checkout to restore the missing managed artifact.');
        } else if (actual.kind === 'unsafe-parent' || actual.kind !== baseline.kind) {
          result.integrity.replacements.push(item.path);
          finding(actual.kind === 'unsafe-parent' ? 'PATH_UNSAFE' : 'OWNED_REPLACED', 'error', item.path, evidence, 'Preserve the replacement and restore the intended managed path or choose a separate project installation.');
        } else if (baseline.kind === 'file' ? actual.hash !== baseline.hash : resolve(item.path, '..', actual.to) !== resolve(item.path, '..', baseline.to)) {
          result.integrity.modified.push(item.path);
          finding('OWNED_MODIFIED', 'error', item.path, evidence, 'Preserve the local edit; restore the recorded artifact before update or uninstall.');
        } else if (baseline.kind === 'file' && baseline.mode !== undefined && actual.mode !== baseline.mode) {
          finding('OWNED_MODE_CHANGED', 'warning', item.path, evidence, 'Re-run install to repair managed executable permissions without replacing matching bytes.');
        }
      }
      if (findings.some(item => item.severity === 'error')) result.integrity.status = 'failed';
      if (previous.version >= 3) {
        const payload = snapshot.owned.filter(item => item.name.startsWith('.pstack/package/') && isPackagePath(item.name.slice('.pstack/package/'.length))).map(item => {
          const actual = snapshot.observed[item.path];
          return { path: item.name.slice('.pstack/package/'.length), kind: actual.kind, executableMode: actual.mode & 0o111, hash: actual.hash };
        }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        let observedPackageDigest = payload.every(item => item.kind === 'file') ? digest(JSON.stringify(payload)) : null;
        if (previous.version === 4) {
          try { verifyGeneration(result.scope.root, previous.generation); observedPackageDigest = previous.generation.digest; }
          catch (error) { observedPackageDigest = null; finding('GENERATION_INVALID', 'error', previous.generation.name, { error: error.message }, 'Preserve the retained package and resolve its recorded integrity conflict before mutation.'); }
        }
        const matches = observedPackageDigest === previous.provenance.packageDigest;
        result.provenance = { ...previous.provenance, status: matches ? 'matches-recorded-payload' : 'modified', classification: matches ? previous.provenance.classification : 'modified', recordedClassification: previous.provenance.classification, observedPackageDigest };
        if (!matches) result.integrity.status = 'failed';
        if (!matches) finding('PACKAGE_DIGEST_CHANGED', 'error', result.scope.root, { recorded: previous.provenance.packageDigest, observed: observedPackageDigest }, 'Preserve the modified managed payload; restore recorded files or reinstall from an explicitly selected source after resolving ownership conflicts.');
      }

    }
  } catch (error) {
    result.state = result.receipt.status === 'valid' ? 'inspection-unavailable' : 'invalid';
    if (result.receipt.status !== 'valid') result.receipt.status = 'invalid';
    result.integrity.status = 'unavailable';
    finding(['EACCES', 'EPERM'].includes(error.code) ? 'INSPECTION_DENIED' : 'RECEIPT_INVALID', 'error', result.scope.root, { errorCode: error.code ?? null, error: error.message }, 'Preserve the installation; restore access or a known valid receipt from backup. Do not edit receipt ownership fields or retry mutation blindly.');
  }
  const interrupted = inspectInterruptedOperation(result.scope.root); result.operation = interrupted;
  if (interrupted.status !== 'absent' && interrupted.id !== operationId) {
    result.state = interrupted.status === 'cleanup-pending' ? result.state : 'interrupted';
    finding(interrupted.status === 'invalid' ? 'RECOVERY_STATE_INVALID' : interrupted.status === 'cleanup-pending' ? 'RECOVERY_CLEANUP_PENDING' : 'RECOVERY_REQUIRED', interrupted.status === 'cleanup-pending' ? 'warning' : 'error', result.scope.root, interrupted,
      interrupted.command ? `Run ${interrupted.command}. For a demonstrably dead lock add --recover-dead-locks; live/unknown owners are preserved.` : 'Preserve the interrupted state and restore its valid journal/generation or original scope location before retrying recovery.');
  }
  const selected = targets ?? previous?.targets ?? [];
  if (!Array.isArray(selected) || selected.some(host => !hosts.includes(host))) throw new Error('Invalid diagnostic host selection');
  result.selectedTargets = [...new Set(selected)].sort();
  for (const host of result.selectedTargets) {
    const hostRoot = host === 'opencode' ? global ? resolve(env.XDG_CONFIG_HOME || join(result.scope.root, '.config'), 'opencode') : '.opencode'
      : host === 'codex' ? '.agents' : host === 'claude-code' ? '.claude' : '.cursor';
    result.configuredRoots[host] = global && host === 'claude-code' && env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : resolve(result.scope.root, hostRoot);
    result.recordedRoots[host] = host === 'opencode' && previous?.opencodeRoot ? resolve(result.scope.root, previous.opencodeRoot) : resolve(result.scope.root, host === 'claude-code' ? '.claude' : hostRoot);
    if (previous?.targets.includes(host) && result.recordedRoots[host] !== result.configuredRoots[host]) finding('HOST_ROOT_CHANGED', 'warning', host, { recordedRoot: result.recordedRoots[host], configuredRoot: result.configuredRoots[host] }, host === 'claude-code' ? 'Use a project installation or the externally managed native plugin for a custom Claude configuration root.' : 'Re-run the selected host install with the intended XDG root to migrate only recorded owned paths.');
    const row = loadHosts().find(row => row.host === host);
    if (row) {
      const observation = versionProbe(row, env); result.hosts.push({ host, ...observation });
      if (observation.code) finding(observation.code, observation.code === 'HOST_VERSION_UNKNOWN' ? 'warning' : 'error', host, observation.evidence,
        observation.code === 'HOST_VERSION_UNKNOWN' ? 'Use the recorded tested provider version in an isolated environment, or collect native compatibility evidence before accepting this version.' : 'Check the selected host executable and PATH, then retry the bounded --version probe; install or repair the provider through its own supported tooling.', observation.status === 'unavailable-compatibility' ? 'unavailable' : 'verified');
    }
    finding('DISCOVERY_UNAVAILABLE', 'info', host, { origin: 'No native discovery probe was launched', configuredRoot: result.configuredRoots[host] }, 'Use the host-specific safe discovery adapter when available; Cursor remains static coverage.', 'unavailable');
  }
  if (!global && selected.length && canonicalPath(globalRoot) !== result.scope.root) {
    try {
      const other = stateFrom(safePath(canonicalPath(globalRoot), '.pstack/install.json'));
      result.otherScopes.push({ kind: 'global', root: canonicalPath(globalRoot), targets: other.targets, receipt: 'valid-or-absent' });
      for (const host of selected.filter(host => previous?.targets.includes(host) && other.targets.includes(host))) {
        finding('DUPLICATE_PSTACK', 'warning', host, { scopes: [result.scope.root, canonicalPath(globalRoot)], registrations: 'recorded', activeDiscovery: 'unavailable' }, 'Keep one pstack scope for this host unless native evidence identifies a complete coherent bundle. Use target-scoped uninstall for the unwanted scope.', 'unavailable');
      }
    } catch (error) {
      finding('SCOPE_INSPECTION_UNAVAILABLE', 'warning', globalRoot, { error: error.message, errorCode: error.code ?? null }, 'Restore access to the selected global receipt or inspect that scope separately; active discovery remains unknown.', 'unavailable');
    }
  }
  return result;
}
