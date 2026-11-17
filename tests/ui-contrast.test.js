// UI contrast regression tests — pure Node.
//
// Control boundaries must remain identifiable in both themes. The text palette
// is checked visually elsewhere; this pins the non-text 3:1 boundary rule.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass += 1; console.log(`PASS | ${name}`); })
  .catch((error) => {
    fail += 1;
    console.log(`FAIL | ${name} | ${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error}`);
  });

function palette(source, part) {
  const section = source.split('@media (prefers-color-scheme: dark)')[part];
  assert.ok(section, 'theme section is missing');
  return Object.fromEntries(
    [...section.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]),
  );
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

(async () => {
  await t('popup control borders meet 3:1 against every adjacent surface', () => {
    const source = read('popup/popup.css');
    for (const [mode, index] of [['light', 0], ['dark', 1]]) {
      const colors = palette(source, index);
      assert.ok(colors['control-border'], `${mode} popup is missing --control-border`);
      for (const surface of ['card', 'surface-2', 'bg']) {
        const ratio = contrast(colors['control-border'], colors[surface]);
        assert.ok(ratio >= 3, `${mode} popup control border vs ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  await t('options control borders meet 3:1 against every adjacent surface', () => {
    const source = read('options/options.html');
    for (const [mode, index] of [['light', 0], ['dark', 1]]) {
      const colors = palette(source, index);
      assert.ok(colors['control-border'], `${mode} options is missing --control-border`);
      for (const surface of ['card', 'surface-2', 'bg']) {
        const ratio = contrast(colors['control-border'], colors[surface]);
        assert.ok(ratio >= 3, `${mode} options control border vs ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  await t('popup and options share the same control-border palette', () => {
    const popup = read('popup/popup.css');
    const options = read('options/options.html');
    for (const [mode, index] of [['light', 0], ['dark', 1]]) {
      assert.ok(palette(popup, index)['control-border'], `${mode} popup is missing --control-border`);
      assert.ok(palette(options, index)['control-border'], `${mode} options is missing --control-border`);
      assert.strictEqual(
        palette(popup, index)['control-border'],
        palette(options, index)['control-border'],
        `${mode} control-border drifted between entry pages`,
      );
    }
  });

  await t('control-border is applied to inputs and buttons', () => {
    const popup = read('popup/popup.css');
    const options = read('options/options.html');
    assert.match(popup, /border:\s*1px solid var\(--control-border\)/);
    assert.ok(
      (options.match(/border:\s*1px solid var\(--control-border\)/g) || []).length >= 2,
      'options must apply --control-border to both form controls and buttons',
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
