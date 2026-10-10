#!/usr/bin/env node
// Use the same ownership checks and target semantics as installation.
process.argv.push('--uninstall');
await import('./install.mjs');
