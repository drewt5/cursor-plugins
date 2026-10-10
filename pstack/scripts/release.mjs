#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionFiles = ['package.json', 'plugin.json', '.cursor-plugin/plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const marketplaces = ['.cursor-plugin/marketplace.json', '.claude-plugin/marketplace.json'];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
function git(args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.error?.message || result.stderr.trim()}. Release validation requires a Git checkout with upstream history.`);
  return result.stdout.trim();
}

try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  let tag;
  if (args[0] === '--tag' && args.length === 2) tag = args[1];
  else if (args.length) throw new Error('Unexpected arguments.');
  if (!['--check', '--sync', '--release'].includes(mode) || (mode === '--release') !== Boolean(tag)) {
    throw new Error('Usage: node pstack/scripts/release.mjs --check|--sync|--release --tag pstack-vX.Y.Z');
  }
  const metadata = read(join(root, 'release.json'));
  if (metadata.schemaVersion !== 1) throw new Error('release.json: expected schemaVersion 1');
  if (typeof metadata.version !== 'string' || !semver.test(metadata.version)) throw new Error('release.json: expected a SemVer version');
  if (typeof metadata.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/.test(metadata.upstreamCommit)) throw new Error('release.json: expected a full upstream commit SHA');
  const consumers = versionFiles.map(file => ({ file, path: join(root, file), document: read(join(root, file)) }));
  for (const file of marketplaces) {
    const path = resolve(root, '..', file);
    if (!existsSync(path)) continue;
    const document = read(path);
    const entries = document.plugins.filter(entry => entry.name === 'pstack');
    if (entries.length !== 1) throw new Error(`${file}: expected exactly one pstack entry`);
    if (Object.hasOwn(entries[0], 'version')) consumers.push({ file: `../${file} (pstack)`, path, document, entry: entries[0] });
  }
  const mismatches = [];
  for (const consumer of consumers) {
    const entry = consumer.entry || consumer.document;
    if (entry.version === metadata.version) continue;
    if (mode !== '--sync') {
      mismatches.push(`${consumer.file}: expected version ${metadata.version}, found ${JSON.stringify(entry.version)}`);
      continue;
    }
    entry.version = metadata.version;
    const original = readFileSync(consumer.path, 'utf8');
    const indent = original.match(/\n([\t ]+)"/)?.[1] || '  ';
    writeFileSync(consumer.path, JSON.stringify(consumer.document, null, indent) + '\n');
  }
  if (mismatches.length) throw new Error(mismatches.join('\n'));
  if (mode === '--release') {
    const expectedTag = `pstack-v${metadata.version}`;
    if (tag !== expectedTag) throw new Error(`Release tag: expected ${expectedTag}, found ${tag}`);
    const sourceCommit = git(['rev-parse', 'HEAD']);
    git(['cat-file', '-e', `${metadata.upstreamCommit}^{commit}`]);
    git(['merge-base', '--is-ancestor', metadata.upstreamCommit, sourceCommit]);
    if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Release validation requires a clean source checkout; commit or remove local changes first.');
    const existing = spawnSync('git', ['-C', root, 'show-ref', '--verify', '--quiet', `refs/tags/${tag}`]);
    if (existing.status === 0 && git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== sourceCommit) throw new Error(`${tag}: existing tag does not identify source commit ${sourceCommit}`);
    if (existing.error || ![0, 1].includes(existing.status)) throw new Error(`Cannot inspect tag ${tag}`);
    console.log(JSON.stringify({ ...metadata, tag, sourceCommit }, null, 2));
  } else console.log(`PASS: portable version ${metadata.version} (${mode.slice(2)})`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
