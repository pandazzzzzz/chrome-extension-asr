// Accessibility markup regression tests (issue #151) — pure Node.
//
// These assert the static semantics screen readers depend on:
// - the side panel status area is a live region like the popup's
// - the options history list has a name and announces updates
// - the storage table uses row headers instead of bare cells
// - the subtitles toggle exposes its pressed state
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log('PASS | ' + name); })
  .catch((e) => { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e)); });

(async () => {
  await t('Side panel status is an ARIA live region', () => {
    const html = read('sidepanel/sidepanel.html');
    assert.match(html, /<div id="status" role="status"><\/div>/);
  });

  await t('Options history list has a name and live updates', () => {
    const html = read('options/options.html');
    assert.match(
      html,
      /<div id="historyList" role="region" aria-label="Transcription history" aria-live="polite">/,
    );
  });

  await t('Storage status table uses row headers', () => {
    const html = read('options/options.html');
    for (const label of [
      'API key storage',
      'Crypto key (IndexedDB)',
      'History entries',
      'Cloud sync',
    ]) {
      assert.ok(
        html.includes(`<th scope="row">${label}</th>`),
        `storage table is missing a row header for "${label}"`,
      );
    }
  });

  await t('Subtitles toggle exposes pressed state in both entry pages', () => {
    for (const file of ['popup/popup.html', 'sidepanel/sidepanel.html']) {
      const html = read(file);
      assert.match(
        html,
        /<button id="subtitleBtn" class="ghost" aria-pressed="false">Subtitles<\/button>/,
        `${file} is missing aria-pressed on the Subtitles toggle`,
      );
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
