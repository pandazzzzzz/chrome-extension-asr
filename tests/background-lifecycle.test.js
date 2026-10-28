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
  const tabsSent = [];
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
    URL,
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
        onConnect: { addListener() {} },
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
      tabCapture: { getMediaStreamId: async () => 'stream-id' },
      tabs: {
        query: async () => [{ id: 1 }],
        onRemoved: { addListener() {} },
        sendMessage: async (tabId, message) => { tabsSent.push({ tabId, message }); },
      },
      commands: { onCommand: { addListener() {} } },
      sidePanel: { open: async () => {} },
      windows: { WINDOW_ID_CURRENT: -2 },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return { sandbox, sent, tabsSent, listeners, storage, contexts };
}

async function dispatch(sandbox, type, payload = {}, sender = {}) {
  const results = await Promise.all(sandbox.listeners.map((fn) => new Promise((resolve) => {
    fn({ type, payload, target: 'background' }, sender, resolve);
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
    const tab = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(tab?.ok, true, 'tab recording did not start');
    assert.strictEqual(page.contexts.length, 1);
    const resp = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(resp.data.stale, true, 'stream event must not claim a Tab-recording document');
    assert.strictEqual(page.contexts.length, 1, 'stale stream event must not close the Tab recording');
    console.log('PASS | STREAM_ENDED cannot reclaim a Tab-recording document');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const start = page.sent.find((m) => m.target === 'offscreen' && m.type === 'asr:stream-start');
    const activeToken = await vm.runInContext('activeOffscreenToken', page.sandbox);
    assert.strictEqual(
      start.payload.streamGeneration,
      activeToken.generation,
      'offscreen must receive the same generation that background records as active',
    );
    assert.strictEqual(activeToken.kind, 'stream');
    console.log('PASS | Stream start assigns generation before sending to offscreen');
  }

  {
    const page = makeSandbox();
    let closeStarted = false;
    let finishClose;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      closeStarted = true;
      await new Promise((resolve) => { finishClose = resolve; });
      page.contexts.pop();
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    const first = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(first?.ok, true);

    const ended = dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    while (!closeStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(
      second?.error?.code,
      'ALREADY_RECORDING',
      'a new Stream must not start while the ended session is still closing',
    );

    finishClose();
    await ended;
    assert.strictEqual(page.contexts.length, 0);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.streaming, false);
    console.log('PASS | STREAM_ENDED holds audio ownership until document close completes');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    const approved = await dispatch(page, 'asr:debug-subscribe', {}, {
      tab: { id: 9 },
      url: 'http://localhost:18923/tests/stream-debug.html',
    });
    assert.strictEqual(approved?.ok, true, 'approved diagnostic page must subscribe');

    for (const url of [
      'http://localhost:8080/tests/stream-debug.html',
      'http://127.0.0.1:18923/not-the-debug-page.html',
      'https://localhost:18923/tests/stream-debug.html',
    ]) {
      const denied = await dispatch(page, 'asr:debug-subscribe', {}, { tab: { id: 9 }, url });
      assert.strictEqual(denied?.ok, false, `unapproved diagnostic origin must be rejected: ${url}`);
    }
    console.log('PASS | diagnostic subscriptions require the approved loopback page');
  }

  {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    const sub = await dispatch(page, 'asr:debug-subscribe', {}, {
      tab: { id: 9 },
      url: 'http://localhost:18923/tests/stream-debug.html',
    });
    assert.strictEqual(sub?.ok, true);
    page.tabsSent.length = 0;
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.ok(
      page.tabsSent.some(({ tabId, message }) => tabId === 9 && message?.type === 'asr:debug'),
      'background lifecycle telemetry must reach subscribed diagnostic tabs',
    );
    console.log('PASS | background debug events are forwarded to subscribed tabs');
  }

  {
    const page = makeSandbox();
    let firstStart = true;
    let closeStarted = false;
    let finishClose;
    page.sandbox.chrome.runtime.sendMessage = (msg, callback) => {
      if (msg.target === 'offscreen' && msg.type === 'asr:stream-start') {
        if (firstStart) {
          firstStart = false;
          callback({ ok: false, error: { code: 'UNKNOWN', message: 'start failed' } });
        } else {
          callback({ ok: true, data: { streaming: true } });
        }
        return;
      }
      if (callback) callback({ ok: true });
      else return Promise.resolve({ ok: true });
    };
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      closeStarted = true;
      await new Promise((resolve) => { finishClose = resolve; });
      page.contexts.pop();
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const first = dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    while (!closeStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(second?.error?.code, 'ALREADY_RECORDING', 'failed-start cleanup must hold the audio lease until close completes');
    finishClose();
    await first;
    assert.strictEqual(page.contexts.length, 0, 'failed start must not leave an offscreen document');
    console.log('PASS | failed stream start cannot close a newer successful stream');
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
    await vm.runInContext("activeOffscreenToken = { kind: 'stream', generation: 2 }", page.sandbox);
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
