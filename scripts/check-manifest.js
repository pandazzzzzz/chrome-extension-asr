#!/usr/bin/env node
/**
 * check-manifest.js — validate manifest.json and every path it declares.
 *
 * The extension has no bundler, so a typo'd path in manifest.json fails
 * silently until Chrome refuses to load the unpacked directory. This catches
 * that in CI (and locally) instead.
 *
 * Checks:
 *   1. manifest.json parses as JSON.
 *   2. manifest_version is 3.
 *   3. Every referenced file exists — action popup/icons, side panel, options
 *      page, service worker, content scripts, and content CSS.
 *   4. Declared icon sizes match the actual PNG dimensions.
 *
 * Exits non-zero with a list of problems; prints a summary on success.
 * Run: node scripts/check-manifest.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error('✗ manifest.json is not valid JSON: ' + e.message);
  process.exit(1);
}

if (manifest.manifest_version !== 3) {
  problems.push(`manifest_version must be 3 (got ${manifest.manifest_version})`);
}

// Collect every file path the manifest points at, keeping a label for reports.
const refs = [];
const add = (label, p) => { if (typeof p === 'string') refs.push({ label, p }); };

add('action.default_popup', manifest.action?.default_popup);
for (const [size, p] of Object.entries(manifest.action?.default_icon ?? {})) add(`action icon ${size}`, p);
for (const [size, p] of Object.entries(manifest.icons ?? {})) add(`icon ${size}`, p);
add('side_panel.default_path', manifest.side_panel?.default_path);
add('options_ui.page', manifest.options_ui?.page);
add('background.service_worker', manifest.background?.service_worker);
for (const cs of manifest.content_scripts ?? []) {
  for (const p of cs.js ?? []) add('content script', p);
  for (const p of cs.css ?? []) add('content css', p);
}

const seen = new Set();
for (const { label, p } of refs) {
  if (seen.has(p)) continue;
  seen.add(p);
  if (!fs.existsSync(path.join(ROOT, p))) problems.push(`${label}: missing file "${p}"`);
}

// Icon size declarations are easy to get wrong; verify against the real PNGs.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
for (const [declared, p] of Object.entries(manifest.icons ?? {})) {
  const abs = path.join(ROOT, p);
  if (!fs.existsSync(abs)) continue; // already reported above
  const buf = fs.readFileSync(abs);
  if (!buf.subarray(0, 4).equals(PNG_SIG)) {
    problems.push(`icon ${declared}: "${p}" is not a PNG`);
    continue;
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (String(width) !== declared || String(height) !== declared) {
    problems.push(`icon ${declared}: "${p}" is actually ${width}x${height}`);
  }
}

if (problems.length) {
  console.error('✗ manifest validation failed:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`✓ manifest.json valid — ${seen.size} referenced paths exist, icons match declared sizes`);
