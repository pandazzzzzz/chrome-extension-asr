// offscreen-streaming.js 消息监听器单元测试 —— 纯 Node，无浏览器依赖。
//
// 覆盖 #61 的回归面：
//   1. 模型回落必须打点 model-fallback（popup 时代有，#51 迁移时丢失）——
//      诊断页据此知道用户的 Custom 模型名为何被换成默认模型。
//   2. STREAM_SET_SUBTITLES 关闭时必须发 SUBTITLE_HIDE（#57 item 1）——该修复
//      落地后此文件继续为它守住回归面。
//   3. 开启时必须立即发 SUBTITLE_SHOW 镜像当前文本（#57 item 2）——
//      否则开关联动滞后到下一句话，用户以为开关无效。
//   4. 会话收尾必须广播 STREAM_UPDATE kind:'ended'（#60）——popup 的复位分支
//      依赖它把 Stop 按钮还原，kind:'error-status' 的兜底掩盖不了正常收尾路径。
//
// 覆盖 #58 的回归面：offscreen 文档加载两个 onMessage 监听器（offscreen.js 先
// 注册、offscreen-streaming.js 后注册）。Chrome 只取第一个实际调用 sendResponse
// 的监听器，先注册者若对不属于自己的消息家族抢答，后注册者的真实结果会被丢弃。
// 用例按消息家族断言：STREAM_* 的真实结果必须由流式监听器回包，tab-record-* 由
// 录音监听器回包，谁都不能替对方家族抢答 UNKNOWN_ACTION。
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

// 同文档共存场景（#58 的真实故障形态）：offscreen.js 先注册（HTML 中先加载），
// offscreen-streaming.js 后注册。tab-record 侧只需最小 mock —— 本套件只验消息
// 家族路由，不驱动录音逻辑。
function makeCoexistenceSandbox() {
  const base = makeSandbox();
  vm.runInContext(fs.readFileSync(path.join(root, 'offscreen/offscreen.js'), 'utf8'), base.sandbox, { filename: 'offscreen/offscreen.js' });
  return base;
}

// 模拟 Chrome 的广播语义：所有监听器都收到消息，只有实际调用 sendResponse
// 的结果会到达发送方（这里用 resolve 收第一个，与 Chrome 的取首个语义一致）。
function dispatch(listeners, type, payload) {
  return new Promise((resolve) => {
    listeners.forEach((l) => l({ target: 'offscreen', type, payload }, {}, resolve));
  });
}

async function startSession(sandbox, listeners, overrides = {}) {
  const payloadOverrides = overrides.payload || {};
  delete overrides.payload;
  // 最小 provider：非法模型 → 回落 defaultStreamModel
  let sessionCallbacks = null;
  sandbox.PROVIDERS.push({
    id: 'qwen', supportsStreaming: true, defaultStreamModel: 'fallback-model',
    sampleRateFor: () => 16000,
    isStreamModel: (m) => m === 'fallback-model',
    createStreamSession: async (opts) => {
      sessionCallbacks = opts;
      return {
        ready: Promise.resolve(),
        sendAudio() {},
        stop: async () => {},
        close() {},
      };
    },
    emitResult: (r) => sessionCallbacks?.onResult?.(r),
    ...overrides,
  });
  return withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'my-bad-model', endpoint: undefined,
      subtitles: false, targetTabId: 42, audioInput: '',
      ...payloadOverrides,
  }));
}

async function startSessionRaw(sandbox, listeners) {
  return startSession(sandbox, listeners);
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

  await t('STREAM_STATE: responds even with the tab-record listener registered first (#58)', async () => {
    const { sandbox, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners);
    const state = await withTimeout(new Promise((resolve) => {
      listeners.forEach((l) => l({ target: 'offscreen', type: 'asr:stream-state', payload: {} }, {}, resolve));
    }));
    assert.ok(state, 'STREAM_STATE got no response (offscreen listener never calls sendResponse — issue #58)');
    assert.strictEqual(state.ok, true);
    assert.strictEqual(state.data.model, 'fallback-model');
    assert.strictEqual(state.data.streaming, true);
  });

  await t('STREAM_START: success response reaches the caller (#58)', async () => {
    const { sandbox, listeners } = makeCoexistenceSandbox();
    const started = await withTimeout(startSessionRaw(sandbox, listeners));
    assert.ok(started, 'STREAM_START got no response (issue #58)');
    assert.strictEqual(started.ok, true);
    assert.strictEqual(started.data.streaming, true);
    assert.strictEqual(started.data.model, 'fallback-model');
    assert.strictEqual(started.data.micFallback, false);
  });

  await t('unknown STREAM_* action: answered by the streaming listener, not hijacked (#58)', async () => {
    const { listeners } = makeCoexistenceSandbox();
    const resp = await withTimeout(dispatch(listeners, 'asr:stream-unknown', {}));
    assert.ok(resp, 'STREAM_* got no response (issue #58)');
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error.code, 'UNKNOWN_ACTION');
  });

  await t('unknown tab-record action: still answered by the tab-record listener', async () => {
    const { listeners } = makeCoexistenceSandbox();
    const resp = await withTimeout(new Promise((resolve) => {
      listeners.forEach((l) => l({ target: 'offscreen', type: 'asr:tab-record-unknown', payload: {} }, {}, resolve));
    }));
    assert.ok(resp, 'tab-record listener must keep answering its own family');
    assert.strictEqual(resp.ok, false);
    assert.strictEqual(resp.error.code, 'UNKNOWN_ACTION');
  });

  // ---- #57：字幕开关的即时联动 ----
  async function setSubtitles(listeners, value) {
    return withTimeout(dispatch(listeners, 'asr:stream-set-subtitles', { subtitles: value }));
  }

  await t('setSubtitles(false): sends SUBTITLE_HIDE so the overlay is removed (#57)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners, { subtitles: true });
    sent.length = 0; // 丢弃启动期广播，只看开关动作
    const resp = await setSubtitles(listeners, false);
    assert.ok(resp?.ok, 'STREAM_SET_SUBTITLES got no response');
    const hide = sent.find((m) => m.type === 'asr:subtitle-hide');
    assert.ok(hide, '关闭字幕必须发 SUBTITLE_HIDE，否则浮层残留直到刷新页面');
    assert.strictEqual(hide.target, 'background');
    assert.strictEqual(hide.payload.tabId, 42);
  });

  await t('setSubtitles(true): immediately mirrors current text via SUBTITLE_SHOW (#57)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners, { subtitles: false });
    // 让会话产生已确认文本（provider onResult 驱动）。
    const provider = sandbox.PROVIDERS[0];
    provider.emitResult?.({ text: 'hello', sentenceEnd: true });
    sent.length = 0;
    const resp = await setSubtitles(listeners, true);
    assert.ok(resp?.ok);
    const show = sent.find((m) => m.type === 'asr:subtitle-show');
    assert.ok(show, '开启字幕必须立即镜像当前文本，否则开关滞后到下一句话');
    assert.strictEqual(show.payload.done, false);
    assert.strictEqual(show.payload.tabId, 42);
  });

  // ---- #60：STREAM_UPDATE 的 ended 广播 ----
  await t('endSession: broadcasts STREAM_UPDATE ended so the popup resets (#60)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners, { subtitles: false });
    sent.length = 0;
    const resp = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(resp?.ok, 'STREAM_STOP got no response');
    const ended = sent.find((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'ended');
    assert.ok(ended, '会话收尾必须广播 kind:"ended"，popup 的按钮复位分支依赖它');
    assert.strictEqual(ended.target, 'ui');
  });

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
