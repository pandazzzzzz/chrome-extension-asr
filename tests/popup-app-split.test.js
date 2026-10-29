// Structural guard for issue #32: popup/sidepanel share one classic-script
// runtime, but the UI logic must not regress into a single 1,200-line file.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const { POPUP_SCRIPTS } = require('./popup-runtime');

const root = path.resolve(__dirname, '..');
const expectedFiles = [
  'popup/app-state.js',
  'popup/app-ui.js',
  'popup/app-recording.js',
  'popup/app-streaming.js',
  'popup/app-actions.js',
  'popup/app-config.js',
  'popup/app.js',
];
const expectedByPage = {
  'popup/popup.html': expectedFiles.map((file) => path.basename(file)),
  'sidepanel/sidepanel.html': expectedFiles.map((file) => `../${file}`),
};

function lines(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).length;
}

function scriptOrder(htmlFile) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((match) => match[1])
    .filter((src) => /(?:^|\/)app(?:-[a-z]+)?\.js$/.test(src));
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS | ${name}`);
  } catch (error) {
    console.log(`FAIL | ${name} | ${error.message}`);
    process.exitCode = 1;
  }
}

test('popup runtime is split into focused files', () => {
  assert.deepStrictEqual(
    POPUP_SCRIPTS,
    expectedFiles.map((file) => path.basename(file)),
    'test runtime load order drifted from the structural contract',
  );
  for (const file of expectedFiles) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
    assert.ok(lines(file) <= 450, `${file} is still ${lines(file)} lines`);
  }
});

test('popup and side panel load the split scripts in dependency order', () => {
  for (const [htmlFile, expectedOrder] of Object.entries(expectedByPage)) {
    assert.deepStrictEqual(scriptOrder(htmlFile), expectedOrder, `${htmlFile} script order`);
  }
});

test('app.js remains a thin bootstrap', () => {
  assert.ok(lines('popup/app.js') <= 120, `popup/app.js is ${lines('popup/app.js')} lines`);
});

if (process.exitCode) {
  console.log('\nFAILED');
} else {
  console.log('\nALL PASS (3/3)');
}
