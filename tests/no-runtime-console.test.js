// No-runtime-console regression tests — pure Node.
//
// The shipped extension must not emit unconditional console.log/debug noise.
// Diagnostics go through the debug bridge or through console.error/warn inside
// catch paths, never as a bare log on every load or injection.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

// Runtime contexts only: debug/ and tests/ are dev-time and may log freely.
const dirs = [
  'background',
  'content',
  'offscreen',
  'popup',
  'sidepanel',
  'options',
  'audio',
  'transcription',
  'store',
  'shared',
  'messaging',
];

let pass = 0;
let fail = 0;

const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS | ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL | ${name} | ${error.message}`);
  }
};

function runtimeFiles() {
  const files = [];
  for (const dir of dirs) {
    const fullDir = path.join(root, dir);
    if (!fs.existsSync(fullDir)) continue;
    for (const name of fs.readdirSync(fullDir)) {
      if (!name.endsWith('.js')) continue;
      const fullPath = path.join(fullDir, name);
      if (!fs.statSync(fullPath).isFile()) continue;
      files.push({ file: `${dir}/${name}`, source: fs.readFileSync(fullPath, 'utf8') });
    }
  }
  return files;
}

t('runtime scripts have no unconditional console.log or console.debug', () => {
  const offenders = [];
  for (const { file, source } of runtimeFiles()) {
    source.split('\n').forEach((line, index) => {
      if (/^\s*console\.(log|debug)\s*\(/.test(line)) {
        offenders.push(`${file}:${index + 1}`);
      }
    });
  }
  assert.strictEqual(
    offenders.length,
    0,
    `unconditional logs found at: ${offenders.join(', ')}`,
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
