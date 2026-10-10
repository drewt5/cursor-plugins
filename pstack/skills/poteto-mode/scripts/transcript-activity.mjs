#!/usr/bin/env node
// An explicitly scoped export is optional; never search a host's private history.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const [directory, worktree] = process.argv.slice(2);
let latest = 0;
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) {
      const content = readFileSync(file, 'utf8');
      if ([worktree + '/', worktree + '"'].some(needle => content.includes(needle))) latest = Math.max(latest, statSync(file).mtimeMs);
    }
  }
}
try {
  if (directory && worktree) visit(directory);
  console.log(`${Math.floor(latest / 1000)}\t${latest ? new Date(latest).toISOString().slice(0, 10) : '-'}`);
} catch (error) {
  console.error(`Transcript activity unavailable: ${error.message}`);
  console.log('0\t-');
}
