// Background offscreen-lifecycle regression tests (pure Node, no browser).
//
// Covers #68: STREAM_ENDED must reclaim the offscreen document when the SW
// restarted and lost its in-memory generation token, but must never reclaim
// a newer generation's document when a stale event arrives (#72).
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

function makeSandbox() {
  const sent = [];
  const listeners = [];
  const storage = {
    session: {
      values: {},
      async get(key) { return { [key]: this.values[key] }; },
      async set(obj) { Object.assign(this.values, obj); },
    },
  };
  const contexts = [];
  const sandbox = {
    console,
    Date,
    setTimeout,
    clearTimeout,
    importScripts: (...files) => {
      for (const f of files) {
        const resolved = path.resolve(root, 'background', f);
        vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: f });
      }
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onInstalled: { addListener() {} },
        sendMessage: (msg, callback) => {
          sent.push(msg);
          if (callback) {
            const response = msg.target === 'offscreen' && msg.type === 'asr:stream-start'
              ? { ok: true, data: { streaming: true } }
              : { ok: true };
            callback(response);
            return;
          }
          return Promise.resolve({ ok: true });
        },
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => contexts,
      },
      storage: {
        session: storage.session,
        sync: { async get() { return {}; }, async remove() {} },
      },
      offscreen: {
        createDocument: async () => { contexts.push({}); },
        closeDocument: async () => { contexts.pop(); },
      },
      tabs: {
        query: async () => [{ id: 1 }],
        onRemoved: { addListener() {} },
        sendMessage: async () => {},
      },
      commands: { onCommand: { addListener() {} } },
      sidePanel: { open: async () => {} },
      windows: { WINDOW_ID_CURRENT: -2 },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, sent, listeners, storage, contexts };
}

async function dispatch(sandbox, type, payload = {}) {
  const results = await Promise.all(sandbox.listeners.map((fn) => new Promise((resolve) => {
    fn({ type, payload, target: 'background' }, {}, resolve);
  })));
  return results.find((r) => r !== undefined);
}

(async () => {
  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const resp = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(resp.data.stale, false);
    assert.strictEqual(page.contexts.length, 0, 'offscreen document must be reclaimed after STREAM_ENDED');
    console.log('PASS | STREAM_ENDED reclaims the offscreen document');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    // Simulate SW restart: in-memory token is lost, but session storage stays.
    await vm.runInContext('activeOffscreenToken = null', page.sandbox);
    const resp = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(resp.data.stale, false);
    assert.strictEqual(page.contexts.length, 0, 'both-null STREAM_ENDED must reclaim after SW restart (#68)');
    console.log('PASS | STREAM_ENDED reclaims after SW restart (#68)');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    // A stale event from stream generation 1 arrives while generation 2 is active.
    await vm.runInContext('activeOffscreenToken = 2', page.sandbox);
    const resp = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(resp.data.stale, true);
    assert.strictEqual(page.contexts.length, 1, 'stale STREAM_ENDED must not close the newer session (#72)');
    console.log('PASS | stale STREAM_ENDED does not close a newer session (#72)');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    // Model a retained/reused offscreen document: two sequential stream starts
    // must give distinct stream generations even when streamSeq resets to 1.
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    await dispatch(page, 'asr:stream-stop');
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const resp = await dispatch(page, 'asr:stream-ended', { streamGeneration: 2 });
    assert.strictEqual(resp.data.stale, false, 'second stream must not be judged stale by document-local seq');
    assert.strictEqual(page.contexts.length, 0, 'second stream remote end must reclaim the offscreen document');
    console.log('PASS | sequential streams use distinct generations (#80)');
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
