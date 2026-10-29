'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const POPUP_SCRIPTS = [
  'app-state.js',
  'app-ui.js',
  'app-recording.js',
  'app-streaming.js',
  'app-actions.js',
  'app-config.js',
  'app.js',
];

function loadPopupRuntime(vm, sandbox) {
  for (const name of POPUP_SCRIPTS) {
    const source = fs.readFileSync(path.join(root, 'popup', name), 'utf8');
    vm.runInContext(source, sandbox, { filename: `popup/${name}` });
  }
}

module.exports = { POPUP_SCRIPTS, loadPopupRuntime };
