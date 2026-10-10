#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { loadHosts } from './lib/tested-hosts.mjs';

try {
  if (process.argv.length !== 2) throw new Error('Usage: node pstack/scripts/host-matrix.mjs');
  const matrix = JSON.stringify({ include: loadHosts() });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`);
  console.log(matrix);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
