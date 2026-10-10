import { loadHosts, validateHosts } from './tested-hosts.mjs';

export function resolvedHost(row, metadata, sourceCommit, resolvedAt) {
  if (!metadata || typeof metadata !== 'object' || metadata.name !== row.package
    || typeof metadata.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) throw new Error(`Invalid stable npm metadata for ${row.host}`);
  const engines = metadata.engines ?? {};
  if (!engines || Array.isArray(engines) || typeof engines !== 'object' || (engines.node !== undefined && typeof engines.node !== 'string')) throw new Error(`Invalid Node engines for ${row.host}`);
  return { ...row, version: metadata.version, resolution: { sourceCommit, resolvedAt, nodeEngine: engines.node ?? '*', registry: 'https://registry.npmjs.org', tag: 'latest' } };
}
export async function resolveProviders({ sourceCommit, fetchMetadata = async row => {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(row.package)}/latest`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Registry HTTP ${response.status} for ${row.package}`);
  return response.json();
}, now = () => new Date().toISOString() }) {
  const rows = loadHosts();
  const results = await Promise.all(rows.map(async row => {
    const resolvedAt = now();
    try { return { host: row.host, status: 'resolved', row: resolvedHost(row, await fetchMetadata(row), sourceCommit, resolvedAt) }; }
    catch (error) { return { host: row.host, status: 'failed', package: row.package, resolvedAt, error: error.message }; }
  }));
  const failures = results.filter(result => result.status !== 'resolved');
  const hosts = failures.length ? null : validateHosts({ schemaVersion: 1, hosts: results.map(result => result.row) });
  return { schemaVersion: 1, sourceCommit, results, status: failures.length ? 'failed' : 'resolved', matrix: hosts ? { include: hosts } : null };
}
