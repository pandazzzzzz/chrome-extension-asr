// background 三路录音仲裁回归测试（纯 Node，无浏览器依赖）。
//
// 麦克风录音的 MediaRecorder 仍留在 popup/sidepanel，但“能否开始”必须由
// background 统一裁决；否则一个窗口开麦后，另一个窗口仍能启动 Tab 或 Live
// Stream，违反三路互斥。这里用长连接端口模拟麦克风租约的 acquire/release。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
const MIC_PORT = 'asr:mic-record';
const MIC_ACQUIRE = 'asr:mic-record-acquire';
const MIC_RELEASE = 'asr:mic-record-release';

function makeSandbox(options = {}) {
  const listeners = [];
  const connectListeners = [];
  const contexts = [];
  const storageSession = {
    values: {},
    async get(key) { return { [key]: this.values[key] }; },
    async set(obj) { Object.assign(this.values, obj); },
  };
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
        lastError: null,
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onConnect: { addListener: (fn) => connectListeners.push(fn) },
        onInstalled: { addListener() {} },
        sendMessage: (msg, callback) => {
          if (callback) {
            const response = msg.target === 'offscreen'
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
        session: storageSession,
        sync: { async get() { return {}; }, async remove() {} },
      },
      offscreen: {
        createDocument: async () => { contexts.push({}); },
        closeDocument: async () => { contexts.pop(); },
      },
      tabs: {
        query: options.tabsQuery || (async () => [{ id: 1 }]),
        sendMessage: async () => {},
        onRemoved: { addListener() {} },
      },
      tabCapture: {
        getMediaStreamId: async () => 'stream-id',
      },
      commands: { onCommand: { addListener() {} } },
      sidePanel: { open: async () => {} },
      windows: { WINDOW_ID_CURRENT: -2 },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'),
    sandbox,
    { filename: 'background/background.js' },
  );
  return { sandbox, listeners, connectListeners, contexts, storageSession };
}

async function dispatch(page, type, payload = {}) {
  const results = await Promise.all(page.listeners.map((fn) => new Promise((resolve) => {
    fn({ type, payload, target: 'background' }, {}, resolve);
  })));
  return results.find((r) => r !== undefined);
}

function openMicPort(page) {
  const responses = [];
  const messageListeners = [];
  const disconnectListeners = [];
  const port = {
    name: MIC_PORT,
    disconnected: false,
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    postMessage(msg) {
      for (const fn of messageListeners) fn(msg);
    },
    disconnect() {
      if (port.disconnected) return;
      port.disconnected = true;
      for (const fn of disconnectListeners) fn();
    },
  };
  page.connectListeners.forEach((fn) => fn(port));
  return {
    port,
    responses,
    acquire() {
      port.postMessage({ type: MIC_ACQUIRE });
      return new Promise((resolve) => setTimeout(() => resolve(responses.at(-1)), 0));
    },
    release() {
      port.postMessage({ type: MIC_RELEASE });
      port.disconnect();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

(async () => {
  {
    const page = makeSandbox();
    const mic = openMicPort(page);
    // Response capture is installed by the background onConnect handler.
    const originalPost = mic.port.postMessage;
    mic.port.postMessage = (msg) => {
      if (Object.prototype.hasOwnProperty.call(msg, 'ok')) mic.responses.push(msg);
      else originalPost(msg);
    };
    const acquired = await mic.acquire();
    assert.strictEqual(acquired?.ok, true, 'background must grant the first mic lease');

    const tab = await dispatch(page, 'asr:tab-record-start');
    assert.strictEqual(tab?.error?.code, 'ALREADY_RECORDING', 'active mic must block Tab recording');
    const stream = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(stream?.error?.code, 'ALREADY_RECORDING', 'active mic must block Live Stream');

    mic.release();
    await flush();
    const streamAfter = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(streamAfter?.ok, true, 'releasing the mic lease must unlock other audio paths');
    console.log('PASS | active mic lease blocks Tab and Stream starts');
  }

  {
    const page = makeSandbox();
    const stream = await dispatch(page, 'asr:stream-start', { providerId: 'qwen', apiKey: 'x', model: 'm' });
    assert.strictEqual(stream?.ok, true);

    const mic = openMicPort(page);
    const originalPost = mic.port.postMessage;
    mic.port.postMessage = (msg) => {
      if (Object.prototype.hasOwnProperty.call(msg, 'ok')) mic.responses.push(msg);
      else originalPost(msg);
    };
    const acquired = await mic.acquire();
    assert.strictEqual(acquired?.error?.code, 'ALREADY_RECORDING', 'active stream must reject a mic lease');
    console.log('PASS | active Stream lease rejects microphone startup');
  }

  {
    const page = makeSandbox({
      tabsQuery: async () => { throw new Error('tabs.query failed'); },
    });
    page.sandbox.console = { ...console, error() {} };
    const tab = await dispatch(page, 'asr:tab-record-start');
    assert.strictEqual(tab?.ok, false, 'tab start should report the query failure');

    const mic = openMicPort(page);
    const originalPost = mic.port.postMessage;
    mic.port.postMessage = (msg) => {
      if (Object.prototype.hasOwnProperty.call(msg, 'ok')) mic.responses.push(msg);
      else originalPost(msg);
    };
    const acquired = await mic.acquire();
    assert.strictEqual(acquired?.ok, true, 'failed tab start must release the audio reservation');
    console.log('PASS | failed Tab start releases the audio reservation');
  }

  {
    const page = makeSandbox();
    // Model an offscreen crash: the persisted flag and in-memory owner survive,
    // but no offscreen document exists to justify the lock.
    page.storageSession.values.streaming = true;
    await vm.runInContext("audioOwner = { kind: 'stream' }", page.sandbox);
    await vm.runInContext("activeOffscreenToken = { kind: 'stream', generation: 1 }", page.sandbox);

    const mic = openMicPort(page);
    const originalPost = mic.port.postMessage;
    mic.port.postMessage = (msg) => {
      if (Object.prototype.hasOwnProperty.call(msg, 'ok')) mic.responses.push(msg);
      else originalPost(msg);
    };
    const acquired = await mic.acquire();
    assert.strictEqual(acquired?.ok, true, 'stale Stream ownership must be reconciled before rejecting mic');
    assert.strictEqual(page.storageSession.values.streaming, false);
    assert.strictEqual(await vm.runInContext('audioOwner.kind', page.sandbox), 'mic');
    console.log('PASS | crashed Stream owner is reconciled before the next lease');
  }

  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
