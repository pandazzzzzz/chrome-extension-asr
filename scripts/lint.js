#!/usr/bin/env node
/**
 * lint.js — dependency-free syntax lint for every tracked JS file.
 *
 * The extension deliberately has no bundler or type system, so `node --check`
 * is the cheapest meaningful gate: it catches syntax errors before Chrome
 * fails to load a context. Style rules can be added later with a real linter;
 * until then this keeps `npm run lint` honest instead of a pure placeholder.
 */
'use strict';

const { execFileSync } = require('node:child_process');

const files = execFileSync('git', ['ls-files', '*.js'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

if (!files.length) {
  console.error('✗ no tracked JavaScript files found');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${file}\n${err.stderr}`);
  }
}

if (failed) {
  console.error(`\n✗ lint failed (${failed}/${files.length} files)`);
  process.exit(1);
}
console.log(`✓ lint passed — ${files.length} JS files parse cleanly`);
