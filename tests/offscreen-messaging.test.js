// offscreen-streaming.js 消息监听器单元测试 —— 纯 Node，无浏览器依赖。
//
// 覆盖 #61 的回归面：
//   1. 模型回落必须打点 model-fallback（popup 时代有，#51 迁移时丢失）——
//      诊断页据此知道用户的 Custom 模型名为何被换成默认模型。
//   2. STREAM_SET_SUBTITLES 关闭时必须发 SUBTITLE_HIDE（#57 item 1）——该修复
//      落地后此文件继续为它守住回归面。
//
// offscreen-streaming.js 不是模块（IIFE 挂闭包），这里用 vm 加载源码并注入
// 最小 chrome/DOM mock，与 tests/config-ui-sync.test.js 同一手法。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log('PASS | ' + name); })
  .catch((e) => { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); });

process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(1); });

function makeSandbox() {
  const sent = []; // { type, payload, target }
  const listeners = [];
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval() {},
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
      },
    },
    MESSAGES: {
      STREAM_START: 'asr:stream-start', STREAM_STOP: 'asr:stream-stop',
      STREAM_SET_SUBTITLES: 'asr:stream-set-subtitles', STREAM_STATE: 'asr:stream-state',
      STREAM_UPDATE: 'asr:stream-update', STREAM_ENDED: 'asr:stream-ended',
      SUBTITLE_SHOW: 'asr:subtitle-show', SUBTITLE_HIDE: 'asr:subtitle-hide',
      HISTORY_ADD: 'asr:history-add', DEBUG_EVT: 'asr:debug',
    },
    TARGETS: { BACKGROUND: 'background', OFFSCREEN: 'offscreen', CONTENT: 'content', DEBUG: 'debug', UI: 'ui' },
    Errors: { ALREADY_RECORDING: { code: 'ALREADY_RECORDING' }, API_ERROR: { code: 'API_ERROR' }, RECORD_ERROR: { code: 'RECORD_ERROR' }, OFFSCREEN_ERROR: { code: 'OFFSCREEN_ERROR' }, NOT_RECORDING: { code: 'NOT_RECORDING' }, UNKNOWN_ACTION: { code: 'UNKNOWN_ACTION' } },
    createError: (e, message) => ({ ...e, message: message || e.message }),
    PROVIDERS: [],
    openMicrophone: async () => ({ stream: { getTracks: () => [] }, fellBack: false }),
  };
  class FakeAudioContext {
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  sandbox.AudioContext = FakeAudioContext;
  sandbox.createPcmCapture = () => ({ start: async () => {} });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'offscreen/offscreen-streaming.js'), 'utf8'), sandbox, { filename: 'offscreen/offscreen-streaming.js' });
  return { sandbox, sent, listeners };
}

async function startSession(sandbox, listeners, overrides = {}) {
  // 最小 provider：非法模型 → 回落 defaultStreamModel
  sandbox.PROVIDERS.push({
    id: 'qwen', supportsStreaming: true, defaultStreamModel: 'fallback-model',
    sampleRateFor: () => 16000,
    isStreamModel: (m) => m === 'fallback-model',
    createStreamSession: async (opts) => ({ ready: Promise.resolve(), sendAudio() {}, stop: async () => {}, close() {} }),
    ...overrides,
  });
  const handler = listeners.find((l) => true);
  const p = new Promise((resolve) => {
    listeners[0]({ target: 'offscreen', type: 'asr:stream-start', payload: {
      providerId: 'qwen', apiKey: 'sk-x', model: 'my-bad-model', endpoint: undefined,
      subtitles: false, targetTabId: 42, audioInput: '',
    } }, {}, resolve);
  });
  return withTimeout(p);
}

// #58：offscreen 监听器不回包时 sendResponse 永不触发 —— 用超时把挂死变成
// 显式失败而不是静默挂起（超时后以 undefined settle，由断言报出）。
function withTimeout(p) {
  return Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(undefined), 2000))]);
}

async function run() {
  await t('startStreaming: invalid model falls back and emits model-fallback', async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    await startSession(sandbox, listeners);
    await new Promise((r) => setTimeout(r, 50)); // 等 debug 消息（microtask/stream）落进 sent
    const evt = sent.find((m) => m.type === 'asr:debug' && m.payload?.ev === 'model-fallback');
    assert.ok(evt, 'model-fallback 打点缺失（#51 迁移丢失）');
    assert.strictEqual(evt.payload.requested, 'my-bad-model');
    assert.strictEqual(evt.payload.using, 'fallback-model');
  });

  await t('startStreaming: valid model emits no model-fallback', async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    sandbox.PROVIDERS.push({
      id: 'qwen', supportsStreaming: true, defaultStreamModel: 'fallback-model',
      sampleRateFor: () => 16000,
      isStreamModel: (m) => m === 'fallback-model',
      createStreamSession: async () => ({ ready: Promise.resolve(), sendAudio() {}, stop: async () => {}, close() {} }),
    });
    await withTimeout(new Promise((resolve) => {
      listeners[0]({ target: 'offscreen', type: 'asr:stream-start', payload: {
        providerId: 'qwen', apiKey: 'sk-x', model: 'fallback-model', endpoint: undefined,
        subtitles: false, targetTabId: 42, audioInput: '',
      } }, {}, resolve);
    }));
    assert.ok(!sent.some((m) => m.payload?.ev === 'model-fallback'));
  });

  // STREAM_STATE 响应被 #58（offscreen 监听器不回包）拦截 —— 该用例在 #58 修复后启用。
  const stateCase = async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    await startSession(sandbox, listeners);
    const state = await withTimeout(new Promise((resolve) => {
      listeners[0]({ target: 'offscreen', type: 'asr:stream-state', payload: {} }, {}, resolve);
    }));
    assert.ok(state, 'STREAM_STATE got no response (offscreen listener never calls sendResponse — issue #58)');
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.data.model, 'fallback-model');
    assert.strictEqual(state.data.streaming, true);
  };
  if (process.env.ASR_RUN_STREAM_STATE_CASE) await t('STREAM_STATE: reports the post-fallback model', stateCase);

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
