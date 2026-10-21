// Stream lifecycle predicate tests - pure Node, no DOM/browser dependencies.
//
// Regression: pagehide during stream startup used to finalize the previous
// session's result text because `busy` also covers microphone permission and
// WebSocket setup. Only a session that has actually started capturing may be
// finalized while stopping.
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'popup/stream-lifecycle.js'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

const shouldFinalize = globalThis.StreamLifecycle.shouldFinalizeOnPageHide;

t('idle popup -> do not finalize', () => {
  assert.strictEqual(shouldFinalize({ streaming: false, busy: false, everStarted: false }), false);
});

t('starting before capture -> do not finalize the previous result', () => {
  assert.strictEqual(shouldFinalize({ streaming: false, busy: true, everStarted: false }), false);
});

t('active stream -> finalize on pagehide', () => {
  assert.strictEqual(shouldFinalize({ streaming: true, busy: false, everStarted: true }), true);
});

t('stopping after a started capture -> finalize while stop is busy', () => {
  assert.strictEqual(shouldFinalize({ streaming: false, busy: true, everStarted: true }), true);
});

t('pagehide already claimed -> finalize only once', () => {
  assert.strictEqual(shouldFinalize({ streaming: true, busy: true, everStarted: true, closing: true }), false);
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
