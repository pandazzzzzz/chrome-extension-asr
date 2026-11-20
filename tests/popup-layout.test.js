// Popup layout regression tests (issues #178) — pure Node.
//
// The popup must present recording actions and result actions before the
// one-time provider/audio configuration.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
const sidepanelHtml = fs.readFileSync(path.join(root, 'sidepanel/sidepanel.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'popup/popup.css'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`PASS | ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL | ${name} | ${error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error}`);
  }
};

const row = (className) => {
  const match = html.match(new RegExp(`<div class="${className}">([\\s\\S]*?)</div>`));
  assert.ok(match, `${className} row is missing`);
  return match[1];
};

t('recording actions are grouped into two readable rows', () => {
  const recording = row('btn-row record-actions');
  const recordingSecondary = row('btn-row recording-actions');
  assert.match(recording, /id="recordBtn"/);
  assert.match(recording, /id="streamBtn"/);
  assert.doesNotMatch(recording, /id="tabRecordBtn"|id="saveBtn"/);
  assert.match(recordingSecondary, /id="tabRecordBtn"/);
  assert.match(recordingSecondary, /id="saveBtn"/);
});

t('result actions appear before one-time settings', () => {
  const resultIndex = html.indexOf('id="result"');
  const resultActions = html.indexOf('class="btn-row result-actions"');
  const settings = html.indexOf('<details class="settings">');
  assert.ok(resultIndex > 0 && resultActions > resultIndex, 'result actions must follow the result field');
  assert.ok(settings > resultActions, 'one-time settings must follow the result actions');
});

t('provider and audio settings live in a collapsed disclosure', () => {
  const match = html.match(/<details class="settings">([\s\S]*?)<\/details>/);
  assert.ok(match, 'settings disclosure is missing');
  assert.doesNotMatch(match[0], /<details[^>]*\sopen(?:\s|>)/);
  for (const id of ['provider', 'apiKey', 'region', 'audioInput', 'audioType', 'model', 'testModelBtn']) {
    assert.match(match[1], new RegExp(`id="${id}"`), `${id} must stay available inside the disclosure`);
  }
});

t('sidepanel groups recording actions the same way as the popup', () => {
  const sidepanelRow = (className) => {
    const match = sidepanelHtml.match(new RegExp(`<div class="${className}">([\\s\\S]*?)</div>`));
    assert.ok(match, `${className} row is missing from the side panel`);
    return match[1];
  };
  const recording = sidepanelRow('btn-row record-actions');
  const recordingSecondary = sidepanelRow('btn-row recording-actions');
  assert.match(recording, /id="recordBtn"/);
  assert.match(recording, /id="streamBtn"/);
  assert.doesNotMatch(recording, /id="tabRecordBtn"|id="saveBtn"/);
  assert.match(recordingSecondary, /id="tabRecordBtn"/);
  assert.match(recordingSecondary, /id="saveBtn"/);
});

t('audio format and model fields stack instead of clipping the model label', () => {
  assert.match(css, /\.row\s*\{[^}]*flex-wrap:\s*wrap;/, '.row must wrap at narrow widths');
  assert.match(css, /\.field\s*\{[^}]*flex:\s*1 1 280px;/, '.field must grow to full width below 600px');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
