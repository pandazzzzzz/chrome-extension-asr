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
let newTestFailures = 0;

async function test(name, fn) {
  try {
    await fn();
  } catch (error) {
    newTestFailures += 1;
    console.error(`FAIL | ${name} | ${error.message}`);
  }
}

function makeSandbox({ hangStreamStop = false, hangTabStop = false } = {}) {
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
            const hungStop = msg.target === 'offscreen'
              && ((msg.type === 'asr:stream-stop' && hangStreamStop)
                || (msg.type === 'asr:tab-record-stop' && hangTabStop));
            if (hungStop) return; // Never answer: model a wedged offscreen document.
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

function shortenLongTimeouts(page) {
  const timeoutHits = [];
  const timer = setTimeout;
  const shortened = new Set([9000, 15000, 19000]);
  page.sandbox.setTimeout = (fn, ms, ...args) => {
    if (shortened.has(ms)) timeoutHits.push(ms);
    return timer(fn, shortened.has(ms) ? 5 : ms, ...args);
  };
  return timeoutHits;
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
      frameId: 0,
    });
    assert.strictEqual(approved?.ok, true, 'approved diagnostic page must subscribe');

    const framed = await dispatch(page, 'asr:debug-subscribe', {}, {
      tab: { id: 9 },
      url: 'http://localhost:18923/tests/stream-debug.html',
      frameId: 1,
    });
    assert.strictEqual(framed?.ok, false, 'diagnostic subscription must originate from the top frame');

    for (const url of [
      'http://localhost:8080/tests/stream-debug.html',
      'http://127.0.0.1:18923/not-the-debug-page.html',
      'https://localhost:18923/tests/stream-debug.html',
    ]) {
      const denied = await dispatch(page, 'asr:debug-subscribe', {}, { tab: { id: 9 }, url, frameId: 0 });
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
      frameId: 0,
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

  await test('stale STREAM_ENDED cannot release a newer stream lease', async () => {
    const page = makeSandbox();
    let releaseEndedSet;
    let endedSetBlocked = false;
    const originalSet = page.storage.session.set.bind(page.storage.session);
    page.storage.session.set = async (obj) => {
      if (!endedSetBlocked && obj.streaming === false) {
        endedSetBlocked = true;
        await new Promise((resolve) => { releaseEndedSet = resolve; });
      }
      return originalSet(obj);
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });

    const ended = dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    while (!endedSetBlocked) await new Promise((resolve) => setTimeout(resolve, 0));
    await dispatch(page, 'asr:stream-stop');
    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true, 'new stream must start after the old stop releases its lease');

    releaseEndedSet();
    await ended;
    const token = await vm.runInContext('activeOffscreenToken', page.sandbox);
    const owner = await vm.runInContext('audioOwner', page.sandbox);
    assert.strictEqual(token?.kind, 'stream', 'old STREAM_ENDED must not clear the new token');
    assert.strictEqual(owner?.kind, 'stream', 'old STREAM_ENDED must not release the new stream lease');
    assert.strictEqual(page.storage.session.values.streaming, true, 'old STREAM_ENDED must not clear the new streaming flag');
    assert.strictEqual(page.contexts.length, 1, 'old STREAM_ENDED must not close the new offscreen session');
    console.log('PASS | stale STREAM_ENDED cannot release a newer stream lease');
  });

  await test('recovered STREAM_STOP cannot tear down a newer stream', async () => {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });

    // Model an SW restart: the offscreen document survives, but in-memory
    // ownership is gone and the persisted streaming flag is stale/absent.
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null', page.sandbox);
    page.storage.session.values.streaming = false;

    let releaseTabLookup;
    let tabLookupStarted = false;
    const originalGet = page.storage.session.get.bind(page.storage.session);
    page.storage.session.get = async (key) => {
      if (key === 'tabRecording' && !tabLookupStarted) {
        tabLookupStarted = true;
        await new Promise((resolve) => { releaseTabLookup = resolve; });
      }
      return originalGet(key);
    };

    const stopped = dispatch(page, 'asr:stream-stop');
    while (!tabLookupStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true, 'new stream must start while the recovered stop is still checking state');

    releaseTabLookup();
    await stopped;
    const token = await vm.runInContext('activeOffscreenToken', page.sandbox);
    const owner = await vm.runInContext('audioOwner', page.sandbox);
    assert.strictEqual(token?.kind, 'stream', 'recovered stop must not clear a newer stream token');
    assert.strictEqual(owner?.kind, 'stream', 'recovered stop must not release a newer stream lease');
    assert.strictEqual(page.storage.session.values.streaming, true, 'recovered stop must not clear the newer streaming flag');
    assert.strictEqual(page.contexts.length, 1, 'recovered stop must not close the newer offscreen session');
    console.log('PASS | recovered STREAM_STOP cannot tear down a newer stream');
  });

  await test('failed stream-ended close retains ownership and blocks restart', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const ended = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(ended?.data?.stale, false);
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'stream');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'stream');
    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.error?.code, 'ALREADY_RECORDING');
    assert.strictEqual(page.contexts.length, 1);
    console.log('PASS | failed close retains ownership and blocks restart');
  });

  await test('close failure for an already-closed document releases stream ownership', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      page.contexts.pop();
      throw new Error('No current offscreen document');
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const ended = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(ended?.data?.closeFailed, undefined);
    assert.strictEqual(page.contexts.length, 0);
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true);
    console.log('PASS | already-closed document release does not leak stream ownership');
  });

  await test('close retries after a transient failure and releases stream ownership', async () => {
    const page = makeSandbox();
    let closeCalls = 0;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      closeCalls++;
      if (closeCalls === 1) throw new Error('Cannot close while the document is being created');
      page.contexts.pop();
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const ended = await dispatch(page, 'asr:stream-ended', { streamGeneration: 1 });
    assert.strictEqual(ended?.data?.closeFailed, undefined);
    assert.ok(closeCalls >= 2, 'close must be retried after a transient failure');
    assert.strictEqual(page.contexts.length, 0);
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true);
    console.log('PASS | transient close failure is retried');
  });

  await test('ownership read failure fails closed for a new capture', async () => {
    const page = makeSandbox();
    await vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    page.storage.session.get = async () => { throw new Error('storage unavailable'); };
    const started = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(started?.error?.code, 'ALREADY_RECORDING');
    assert.strictEqual(page.contexts.length, 0);
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    console.log('PASS | ownership read failure fails closed');
  });

  await test('failed tab stop close retains its ownership and state', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });
    await dispatch(page, 'asr:tab-record-start', {});
    const stopped = await dispatch(page, 'asr:tab-record-stop', {});
    assert.strictEqual(stopped?.ok, true);
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'tab');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'tab');
    assert.strictEqual(page.storage.session.values.tabRecording, true);
    const restartedStream = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(restartedStream?.error?.code, 'ALREADY_RECORDING');
    assert.strictEqual(page.contexts.length, 1);
    console.log('PASS | failed tab stop close retains ownership');
  });

  await test('STREAM_STOP timeout closes the document and releases the stream lease', async () => {
    const page = makeSandbox({ hangStreamStop: true });
    const timeoutHits = shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const started = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(started?.ok, true);
    assert.strictEqual(page.contexts.length, 1);

    const stopped = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.deepStrictEqual(timeoutHits, [19000, 15000], 'START/STOP must keep their timeout budgets');
    assert.strictEqual(page.contexts.length, 0, 'timed-out STOP must close the offscreen document');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.streaming, false);

    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true, 'a stream must be able to start after a timed-out STOP');
    console.log('PASS | STREAM_STOP timeout releases the stream lease');
  });

  await test('TAB_RECORD_STOP timeout closes the document and releases the tab lease', async () => {
    const page = makeSandbox({ hangTabStop: true });
    const timeoutHits = shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const started = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(started?.ok, true);
    assert.strictEqual(page.contexts.length, 1);

    const stopped = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.deepStrictEqual(timeoutHits, [9000, 19000], 'Tab START/STOP must keep their timeout budgets');
    assert.strictEqual(page.contexts.length, 0, 'timed-out STOP must close the offscreen document');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.tabRecording, false);

    const restarted = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(restarted?.ok, true, 'Tab recording must be able to start after a timed-out STOP');
    console.log('PASS | TAB_RECORD_STOP timeout releases the tab lease');
  });

  await test('STREAM_STOP timeout close failure retains ownership until a retry succeeds', async () => {
    const page = makeSandbox({ hangStreamStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    const stopped = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 1, 'failed close must leave the possibly-active document alive');
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'stream');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'stream');
    assert.strictEqual(page.storage.session.values.streaming, true);

    const blocked = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(blocked?.error?.code, 'ALREADY_RECORDING', 'failed close must block a second capture');

    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    const retried = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(retried?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 0, 'retry must close the recovered document');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.streaming, false);

    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm3' });
    assert.strictEqual(restarted?.ok, true, 'a successful retry must restore capture capability');
    console.log('PASS | STREAM_STOP timeout close failure retains ownership until retry');
  });

  await test('TAB_RECORD_STOP timeout close failure retains ownership until a retry succeeds', async () => {
    const page = makeSandbox({ hangTabStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:tab-record-start', {});
    const stopped = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 1, 'failed close must leave the possibly-active document alive');
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'tab');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'tab');
    assert.strictEqual(page.storage.session.values.tabRecording, true);

    const blocked = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(blocked?.error?.code, 'ALREADY_RECORDING', 'failed close must block a second capture');

    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    const retried = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(retried?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 0, 'retry must close the recovered document');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.tabRecording, false);

    const restarted = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(restarted?.ok, true, 'a successful retry must restore capture capability');
    console.log('PASS | TAB_RECORD_STOP timeout close failure retains ownership until retry');
  });

  await test('STREAM_STOP timeout cleanup cannot tear down a replacement stream', async () => {
    const page = makeSandbox({ hangStreamStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    let replacement;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      page.contexts.pop();
      replacement = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'new' });
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'old' });
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const stopped = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(replacement?.ok, true, 'new stream must start during the timeout cleanup');
    const token = await vm.runInContext('activeOffscreenToken', page.sandbox);
    assert.strictEqual(token?.kind, 'stream');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'stream');
    assert.strictEqual(page.contexts.length, 1);
    assert.strictEqual(page.storage.session.values.streaming, true);
    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    console.log('PASS | STREAM_STOP timeout cleanup preserves a replacement stream');
  });

  await test('TAB_RECORD_STOP timeout cleanup cannot tear down a replacement tab recording', async () => {
    const page = makeSandbox({ hangTabStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    let replacement;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      page.contexts.pop();
      replacement = await dispatch(page, 'asr:tab-record-start', {});
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:tab-record-start', {});
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const stopped = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(replacement?.ok, true, 'new tab recording must start during the timeout cleanup');
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'tab');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'tab');
    assert.strictEqual(page.contexts.length, 1);
    assert.strictEqual(page.storage.session.values.tabRecording, true);
    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    console.log('PASS | TAB_RECORD_STOP timeout cleanup preserves a replacement tab recording');
  });

  await test('STREAM_STOP timeout cleanup cannot tear down a replacement tab recording', async () => {
    const page = makeSandbox({ hangStreamStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    let replacement;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      page.contexts.pop();
      replacement = await dispatch(page, 'asr:tab-record-start', {});
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'old' });
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const stopped = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(replacement?.ok, true, 'tab recording must start during the stream timeout cleanup');
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'tab');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'tab');
    assert.strictEqual(page.contexts.length, 1);
    assert.strictEqual(page.storage.session.values.tabRecording, true);
    assert.strictEqual(page.storage.session.values.streaming, false);
    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    console.log('PASS | STREAM_STOP timeout cleanup preserves a replacement tab recording');
  });

  await test('TAB_RECORD_STOP timeout cleanup cannot tear down a replacement stream', async () => {
    const page = makeSandbox({ hangTabStop: true });
    const closeDocument = page.sandbox.chrome.offscreen.closeDocument;
    let replacement;
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      page.contexts.pop();
      replacement = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'new' });
    };
    shortenLongTimeouts(page);
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    await dispatch(page, 'asr:tab-record-start', {});
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const stopped = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(replacement?.ok, true, 'stream must start during the tab timeout cleanup');
    assert.strictEqual((await vm.runInContext('activeOffscreenToken', page.sandbox))?.kind, 'stream');
    assert.strictEqual((await vm.runInContext('audioOwner', page.sandbox))?.kind, 'stream');
    assert.strictEqual(page.contexts.length, 1);
    assert.strictEqual(page.storage.session.values.streaming, true);
    assert.strictEqual(page.storage.session.values.tabRecording, false);
    page.sandbox.chrome.offscreen.closeDocument = closeDocument;
    console.log('PASS | TAB_RECORD_STOP timeout cleanup preserves a replacement stream');
  });

  await test('STREAM_STOP timeout after SW restart self-heals before restart', async () => {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const started = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(started?.ok, true);
    assert.strictEqual(page.contexts.length, 1);
    assert.strictEqual(page.storage.session.values.streaming, true);

    // SW restart: the offscreen document and persisted flag survive, but the
    // in-memory token/owner are gone.
    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const originalSend = page.sandbox.chrome.runtime.sendMessage;
    page.sandbox.chrome.runtime.sendMessage = (msg, callback) => {
      page.sent.push(msg);
      if (msg.target === 'offscreen' && msg.type === 'asr:stream-stop') return;
      return originalSend(msg, callback);
    };
    shortenLongTimeouts(page);

    const stopped = await dispatch(page, 'asr:stream-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 0, 'timed-out STOP must close the recovered document');
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.streaming, true, 'stale flag is reconciled by the next state check');

    const restarted = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.strictEqual(restarted?.ok, true, 'isStreaming must clear the stale flag before granting the new stream');
    assert.strictEqual(page.storage.session.values.streaming, true);
    console.log('PASS | STREAM_STOP timeout after SW restart self-heals');
  });

  await test('TAB_RECORD_STOP timeout after SW restart self-heals state and restart', async () => {
    const page = makeSandbox();
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const started = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(started?.ok, true);
    assert.strictEqual(page.storage.session.values.tabRecording, true);

    await vm.runInContext('activeOffscreenToken = null; audioOwner = null;', page.sandbox);
    const originalSend = page.sandbox.chrome.runtime.sendMessage;
    page.sandbox.chrome.runtime.sendMessage = (msg, callback) => {
      page.sent.push(msg);
      if (msg.target === 'offscreen' && msg.type === 'asr:tab-record-stop') return;
      return originalSend(msg, callback);
    };
    shortenLongTimeouts(page);

    const stopped = await dispatch(page, 'asr:tab-record-stop');
    assert.strictEqual(stopped?.error?.code, 'TIMEOUT');
    assert.strictEqual(page.contexts.length, 0, 'timed-out STOP must close the recovered document');
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);
    assert.strictEqual(page.storage.session.values.tabRecording, true, 'stale flag awaits reconciliation');

    const state = await dispatch(page, 'asr:tab-record-state');
    assert.strictEqual(state?.data?.recording, false, 'state query must reconcile the missing document');
    assert.strictEqual(page.storage.session.values.tabRecording, false);

    const restarted = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(restarted?.ok, true, 'tab recording must restart after timed-out recovery');
    assert.strictEqual(page.storage.session.values.tabRecording, true);
    console.log('PASS | TAB_RECORD_STOP timeout after SW restart self-heals');
  });

  await test('stream start failure releases the lease when offscreen close fails', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.runtime.sendMessage = (msg, callback) => {
      if (msg.target === 'offscreen' && msg.type === 'asr:stream-start') {
        callback({ ok: false, error: { code: 'RECORD_ERROR', message: 'start failed' } });
        return;
      }
      if (callback) callback({ ok: true });
      else return Promise.resolve({ ok: true });
    };
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const failed = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(failed?.error?.code, 'RECORD_ERROR', 'close failure must preserve the original start error');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null, 'failed stream start must release the lease');
    assert.strictEqual(await vm.runInContext('audioReservation', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);

    const retried = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm2' });
    assert.notStrictEqual(retried?.error?.code, 'ALREADY_RECORDING', 'a failed start must not poison the next attempt');
    console.log('PASS | failed stream start releases the lease when close fails');
  });

  await test('tab start failure releases the lease when offscreen close fails', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.runtime.sendMessage = (msg, callback) => {
      if (msg.target === 'offscreen' && msg.type === 'asr:tab-record-start') {
        callback({ ok: false, error: { code: 'RECORD_ERROR', message: 'start failed' } });
        return;
      }
      if (callback) callback({ ok: true });
      else return Promise.resolve({ ok: true });
    };
    page.sandbox.chrome.offscreen.closeDocument = async () => {
      throw new Error('close failed');
    };
    vm.runInContext(fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'), page.sandbox, { filename: 'background/background.js' });

    const failed = await dispatch(page, 'asr:tab-record-start', {});
    assert.strictEqual(failed?.error?.code, 'RECORD_ERROR', 'close failure must preserve the original start error');
    assert.strictEqual(await vm.runInContext('audioOwner', page.sandbox), null, 'failed tab start must release the lease');
    assert.strictEqual(await vm.runInContext('audioReservation', page.sandbox), null);
    assert.strictEqual(await vm.runInContext('activeOffscreenToken', page.sandbox), null);

    const retried = await dispatch(page, 'asr:tab-record-start', {});
    assert.notStrictEqual(retried?.error?.code, 'ALREADY_RECORDING', 'a failed tab start must not poison the next attempt');
    console.log('PASS | failed tab start releases the lease when close fails');
  });

  process.exit(newTestFailures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
