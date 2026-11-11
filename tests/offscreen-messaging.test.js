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

let lastAudioContextOptions = null;
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
    Errors: { ALREADY_RECORDING: { code: 'ALREADY_RECORDING' }, API_ERROR: { code: 'API_ERROR' }, RECORD_ERROR: { code: 'RECORD_ERROR' }, OFFSCREEN_ERROR: { code: 'OFFSCREEN_ERROR' }, NOT_RECORDING: { code: 'NOT_RECORDING' }, STREAM_CANCELLED: { code: 'STREAM_CANCELLED' }, UNKNOWN_ACTION: { code: 'UNKNOWN_ACTION' } },
    createError: (e, message) => ({ ...e, message: message || e.message }),
    withTimeout: (promise) => Promise.resolve(promise),
    PROVIDERS: [],
    openMicrophone: async () => ({ stream: { getTracks: () => [] }, fellBack: false }),
  };
  class FakeAudioContext {
    constructor(options) { this.sampleRate = 16000; lastAudioContextOptions = options || null; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }
  sandbox.AudioContext = FakeAudioContext;
  sandbox.createPcmCapture = () => ({ start: async () => {} });
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // offscreen.html 先加载 audio/convert.js；流式启动要建状态化重采样器。
  vm.runInContext(fs.readFileSync(path.join(root, 'audio/convert.js'), 'utf8'), sandbox, { filename: 'audio/convert.js' });
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

  await t('concurrent starts: only one microphone is acquired and one start succeeds', async () => {
    const { sandbox, listeners } = makeSandbox();
    let resolveMic;
    let acquisitions = 0;
    sandbox.openMicrophone = () => {
      acquisitions += 1;
      return new Promise((resolve) => {
        resolveMic = () => resolve({ stream: { getTracks: () => [] }, fellBack: false });
      });
    };
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: () => ({
        ready: Promise.resolve(),
        sendAudio() {},
        stop: async () => {},
        close() {},
      }),
    });

    const first = dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    });
    const second = dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    resolveMic();
    const [firstResult, secondResult] = await Promise.all([withTimeout(first), withTimeout(second)]);
    const results = [firstResult, secondResult];

    assert.strictEqual(acquisitions, 1, 'concurrent starts must acquire exactly one microphone');
    assert.strictEqual(results.filter((r) => r?.ok).length, 1, 'exactly one start must succeed');
    assert.strictEqual(
      results.find((r) => !r?.ok)?.error?.code,
      'ALREADY_RECORDING',
      'the losing start must fail with ALREADY_RECORDING',
    );
  });

  await t('STREAM_STOP during microphone startup cancels before AudioContext/capture', async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    lastAudioContextOptions = null;
    let resolveMic;
    let captureStarts = 0;
    sandbox.openMicrophone = () => new Promise((resolve) => {
      resolveMic = () => resolve({ stream: { getTracks: () => [] }, fellBack: false });
    });
    sandbox.createPcmCapture = () => {
      captureStarts += 1;
      return { start: async () => {} };
    };
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: () => ({
        ready: Promise.resolve(),
        sendAudio() {},
        stop: async () => {},
        close() {},
      }),
    });

    const started = dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const stopped = dispatch(listeners, 'asr:stream-stop', {});
    resolveMic();

    const [startResult, stopResult] = await Promise.all([withTimeout(started), withTimeout(stopped)]);
    assert.strictEqual(startResult?.ok, false, 'start must be cancelled');
    assert.strictEqual(startResult?.error?.code, 'STREAM_CANCELLED');
    assert.ok(stopResult?.ok, 'stop must acknowledge the cancellation');
    assert.strictEqual(captureStarts, 0, 'capture must never start');
    assert.strictEqual(lastAudioContextOptions, null, 'AudioContext must not be created');
    assert.ok(
      !sent.some((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'active'),
      'cancelled start must not broadcast active',
    );
    const state = await withTimeout(dispatch(listeners, 'asr:stream-state', {}));
    assert.strictEqual(state?.data?.streaming, false);
  });

  await t('STREAM_STOP during task-started wait closes the pending WebSocket', async () => {
    const { sandbox, listeners } = makeSandbox();
    let resolveReady;
    let closed = false;
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: () => ({
        ready: new Promise((resolve) => { resolveReady = resolve; }),
        sendAudio() {},
        stop: async () => {},
        close() { closed = true; },
      }),
    });

    const started = dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(typeof resolveReady, 'function', 'provider must be waiting on ready');
    const stopped = dispatch(listeners, 'asr:stream-stop', {});
    resolveReady();

    const [startResult, stopResult] = await Promise.all([withTimeout(started), withTimeout(stopped)]);
    assert.strictEqual(startResult?.ok, false);
    assert.strictEqual(startResult?.error?.code, 'STREAM_CANCELLED');
    assert.ok(stopResult?.ok);
    assert.strictEqual(closed, true, 'pending WebSocket must be closed during cancellation');
    const state = await withTimeout(dispatch(listeners, 'asr:stream-state', {}));
    assert.strictEqual(state?.data?.streaming, false);
  });

  await t('backpressure is surfaced to the UI and dropped frames reach finalize diagnostics', async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    let onFrame = null;
    let dropFrames = true;
    sandbox.createPcmCapture = (opts) => {
      onFrame = opts.onFrame;
      return { start: async () => {} };
    };
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: () => ({
        ready: Promise.resolve(),
        sendAudio() { return dropFrames ? false : true; },
        stop: async () => {},
        close() {},
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    assert.strictEqual(typeof onFrame, 'function', 'capture onFrame was not wired');
    sent.length = 0;
    onFrame(new Float32Array(256));
    const warning = sent.find((m) =>
      m.type === 'asr:stream-update' && m.payload?.kind === 'status' && /behind/i.test(m.payload.text || ''));
    assert.ok(warning, 'backpressure must surface a user-visible status');

    dropFrames = false;
    onFrame(new Float32Array(256));
    const recovered = sent.find((m) =>
      m.type === 'asr:stream-update' && m.payload?.kind === 'status' && /back in sync/i.test(m.payload.text || ''));
    assert.ok(recovered, 'recovering from backpressure must clear the warning');

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');

    const finalized = sent.find((m) => m.type === 'asr:debug' && m.payload?.ev === 'stream-finalized');
    assert.ok(finalized, 'stream-finalized diagnostic missing');
    assert.strictEqual(finalized.payload.droppedFrames, 1,
      'dropped audio frames must be carried into finalize diagnostics');
  });

  await t('stream text updates carry bounded deltas and a final full snapshot', async () => {
    const { sandbox, sent, listeners } = makeSandbox();
    await startSession(sandbox, listeners, { payload: { subtitles: true } });
    const provider = sandbox.PROVIDERS[0];
    sent.length = 0;

    for (let i = 0; i < 1000; i += 1) {
      provider.emitResult({ text: `sentence-${i}`, sentenceEnd: true });
    }
    provider.emitResult({ text: 'current partial', sentenceEnd: false });

    const updates = sent.filter((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'text');
    assert.strictEqual(updates.length, 1001);
    const largest = Math.max(...updates.map((m) => JSON.stringify(m.payload).length));
    assert.ok(largest < 200, `per-update payload must stay bounded (largest ${largest})`);
    assert.strictEqual(updates[0].payload.reset, true,
      'the first update must reset any stale local mirror');
    assert.strictEqual(updates.at(-1).payload.partial, 'current partial');
    assert.strictEqual(updates[1].payload.finalDelta, 'sentence-1');
    assert.strictEqual(updates[1].payload.partial, '');
    assert.strictEqual(updates[1].payload.reset, false);

    const subtitle = sent.filter((m) => m.type === 'asr:subtitle-show').at(-1);
    assert.strictEqual(subtitle.payload.finalDelta, '');
    assert.strictEqual(subtitle.payload.partial, 'current partial');
    assert.strictEqual(subtitle.payload.text, undefined);

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');
    const final = sent.find((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'final-text');
    assert.ok(final, 'final full-text snapshot missing');
    assert.ok(final.payload.text.startsWith('sentence-0 sentence-1'));
    assert.ok(final.payload.text.endsWith('sentence-999 current partial'));
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

  await t('model fallback decides the AudioContext rate before it is created (#115)', async () => {
    const { sandbox, listeners } = makeSandbox();
    await startSession(sandbox, listeners, {
      sampleRateFor: (model) => (model === 'fallback-model' ? 8000 : 16000),
    });
    assert.ok(lastAudioContextOptions, 'AudioContext must be constructed');
    assert.strictEqual(lastAudioContextOptions.sampleRate, 8000,
      'context must be built for the fallback model, not the rejected one');
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
    await startSession(sandbox, listeners, { payload: { subtitles: true } });
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
    await startSession(sandbox, listeners, { payload: { subtitles: false } });
    // 让会话产生已确认文本（provider onResult 驱动）。
    const provider = sandbox.PROVIDERS[0];
    provider.emitResult?.({ text: 'hello', sentenceEnd: true });
    provider.emitResult?.({ text: 'partial', sentenceEnd: false });
    sent.length = 0;
    const resp = await setSubtitles(listeners, true);
    assert.ok(resp?.ok);
    const show = sent.find((m) => m.type === 'asr:subtitle-show');
    assert.ok(show, '开启字幕必须立即镜像当前文本，否则开关滞后到下一句话');
    assert.strictEqual(show.payload.done, false);
    assert.strictEqual(show.payload.tabId, 42);
    assert.strictEqual(show.payload.text, 'hello');
    assert.strictEqual(show.payload.partial, 'partial');
    assert.strictEqual(show.payload.reset, true);
  });

  // ---- #60：STREAM_UPDATE 的 ended 广播 ----
  await t('endSession: broadcasts STREAM_UPDATE ended so the popup resets (#60)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners, { payload: { subtitles: false } });
    sent.length = 0;
    const resp = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(resp?.ok, 'STREAM_STOP got no response');
    const ended = sent.find((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'ended');
    assert.ok(ended, '会话收尾必须广播 kind:"ended"，popup 的按钮复位分支依赖它');
    assert.strictEqual(ended.target, 'ui');
  });

  await t('debug events use the unified schema (ev/at/src/streamSeq)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners);
    await new Promise((r) => setTimeout(r, 50));
    const evts = sent.filter((m) => m.type === 'asr:debug');
    assert.ok(evts.length > 0, 'no debug events emitted');
    for (const m of evts) {
      const p = m.payload;
      assert.ok(typeof p.ev === 'string' && p.ev, `ev missing on ${JSON.stringify(p)}`);
      assert.ok(typeof p.at === 'number' && p.at > 0, `at missing on ${p.ev}`);
      assert.strictEqual(p.src, 'offscreen', `src must be offscreen on ${p.ev}`);
    }
    // 会话期事件必须带 streamSeq：新旧会话交错时据此分拣（#72）。
    const active = evts.find((m) => m.payload.ev === 'streaming-active-offscreen');
    assert.ok(active, 'streaming-active-offscreen not emitted');
    assert.strictEqual(typeof active.payload.streamSeq, 'number', 'streamSeq missing');
  });

  await t('stopStreaming: STREAM_STOP response leaves before STREAM_ENDED (#72)', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners);
    sent.length = 0;
    // Chrome 取第一个 sendResponse；STREAM_ENDED 不应阻断响应通道。
    const resp = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(resp?.ok, 'STREAM_STOP must respond before background can close the document');
    const ended = sent.find((m) => m.type === 'asr:stream-ended');
    assert.ok(ended, 'STREAM_ENDED must be sent (fire-and-forget) during stop');
    assert.strictEqual(typeof ended.payload.streamGeneration, 'number', 'STREAM_ENDED must carry a stream-scoped generation for background stale filtering (#72)');
  });

  await t('STREAM_ENDED echoes the generation supplied by background', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    await startSession(sandbox, listeners, { payload: { streamGeneration: 7 } });
    sent.length = 0;
    const resp = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(resp?.ok, 'STREAM_STOP got no response');
    const ended = sent.find((m) => m.type === 'asr:stream-ended');
    assert.strictEqual(ended?.payload?.streamGeneration, 7);
  });

  await t('stopStreaming: awaits provider.stop() so final results reach history', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    let stopCalls = 0;
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: (opts) => ({
        ready: Promise.resolve(),
        sendAudio() {},
        async stop() {
          stopCalls += 1;
          // A provider may emit the last sentence while finish-task is settling.
          opts.onResult({ text: 'final words', sentenceEnd: true });
        },
        close() {},
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');
    assert.strictEqual(stopCalls, 1, 'provider.stop() must be awaited during normal teardown');
    const history = sent.find((m) => m.type === 'asr:history-add');
    assert.match(history?.payload?.text || '', /final words/);
  });

  await t('failed history write is surfaced as history-error and a status', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    sandbox.chrome.runtime.sendMessage = (msg) => {
      sent.push(msg);
      if (msg?.type === 'asr:history-add') {
        return Promise.resolve({
          ok: false,
          error: { code: 'STORAGE_ERROR', message: 'disk full' },
        });
      }
      return Promise.resolve();
    };
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: (opts) => ({
        ready: Promise.resolve(),
        sendAudio() {},
        async stop() {
          opts.onResult({ text: 'final words', sentenceEnd: true });
        },
        close() {},
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;
    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream must still stop cleanly');
    assert.strictEqual(stopped.data?.historyError, 'disk full',
      'history failure must travel with the stop response');

    const errorEvent = sent.find((m) => m.type === 'asr:debug' && m.payload?.ev === 'history-error');
    assert.ok(errorEvent, 'history-error diagnostic missing');
    assert.match(errorEvent.payload.message || '', /disk full/);
    const status = sent.find((m) =>
      m.type === 'asr:stream-update' && m.payload?.kind === 'status' && /history/i.test(m.payload.text || ''));
    assert.ok(status, 'history failure must be visible in the streaming status');
  });

  await t('graceful task-finished onEnd does not surface a network error', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    let callbacks;
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: (opts) => {
        callbacks = opts;
        return {
          ready: Promise.resolve(),
          sendAudio() {},
          async stop() {
            opts.onResult({ text: 'complete final', sentenceEnd: true });
            opts.onComplete?.();
            opts.onEnd?.('complete');
          },
          close() {},
        };
      },
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');
    assert.ok(callbacks, 'provider callbacks were not captured');
    assert.ok(
      !sent.some((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'error-status'),
      'graceful task-finished must not be reported as a network error',
    );
    const history = sent.find((m) => m.type === 'asr:history-add');
    assert.match(history?.payload?.text || '', /complete final/);
  });

  await t('local provider close during stop does not surface a network error', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: (opts) => ({
        ready: Promise.resolve(),
        sendAudio() {},
        async stop() {
          opts.onEnd?.('closed');
        },
        close() {},
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');
    assert.ok(
      !sent.some((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'error-status'),
      'local close() must not be reported as a server/network failure',
    );
  });

  await t('provider error during stop is carried in the stop response', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    sandbox.PROVIDERS.push({
      id: 'qwen',
      supportsStreaming: true,
      defaultStreamModel: 'model',
      sampleRateFor: () => 16000,
      isStreamModel: () => true,
      createStreamSession: (opts) => ({
        ready: Promise.resolve(),
        sendAudio() {},
        async stop() {
          opts.onError(new Error('server died'));
          opts.onEnd?.('error');
        },
        close() {},
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;

    const stopped = await withTimeout(dispatch(listeners, 'asr:stream-stop', {}));
    assert.ok(stopped?.ok, 'stream did not stop');
    assert.strictEqual(stopped.data?.streamError, 'server died',
      'stop response must carry the provider failure');
    assert.ok(
      sent.some((m) => m.type === 'asr:stream-update' && m.payload?.kind === 'error-status'),
      'provider failure must still be broadcast immediately',
    );
  });

  await t('microphone track ending tears down the stream with a visible error', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    let onEnded;
    let stopCalls = 0;
    let closeCalls = 0;
    let captureStops = 0;
    const track = {
      addEventListener(type, listener) {
        if (type === 'ended') onEnded = listener;
      },
      removeEventListener() {},
      stop() {},
    };
    sandbox.openMicrophone = async () => ({
      stream: { getTracks: () => [track] }, fellBack: false,
    });
    sandbox.createPcmCapture = () => ({
      start: async () => {}, stop() { captureStops += 1; },
    });
    sandbox.PROVIDERS.push({
      id: 'qwen', supportsStreaming: true, defaultStreamModel: 'model',
      sampleRateFor: () => 16000, isStreamModel: () => true,
      createStreamSession: () => ({
        ready: Promise.resolve(), sendAudio() {},
        async stop() { stopCalls += 1; }, close() { closeCalls += 1; },
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.ok(started?.ok, 'stream did not start');
    sent.length = 0;
    onEnded();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const state = await withTimeout(dispatch(listeners, 'asr:stream-state', {}));
    assert.strictEqual(state?.data?.streaming, false);
    assert.strictEqual(stopCalls, 1);
    assert.strictEqual(closeCalls, 1);
    assert.ok(captureStops >= 1, 'capture must stop after microphone loss');
    assert.ok(sent.some((m) => m.type === 'asr:stream-ended'
      && m.payload?.reason === 'remote'), 'background must release the stream lease');
    assert.ok(sent.some((m) => m.type === 'asr:stream-update'
      && m.payload?.kind === 'error-status' && /microphone/i.test(m.payload.message || '')),
    'microphone loss must be visible to the user');
  });

  await t('track ending during capture startup rolls back the stream', async () => {
    const { sandbox, sent, listeners } = makeCoexistenceSandbox();
    let closeCalls = 0;
    const track = {
      readyState: 'live',
      addEventListener() {}, removeEventListener() {}, stop() {},
    };
    sandbox.openMicrophone = async () => ({
      stream: { getTracks: () => [track] }, fellBack: false,
    });
    sandbox.createPcmCapture = () => ({
      async start() { track.readyState = 'ended'; }, stop() {},
    });
    sandbox.PROVIDERS.push({
      id: 'qwen', supportsStreaming: true, defaultStreamModel: 'model',
      sampleRateFor: () => 16000, isStreamModel: () => true,
      createStreamSession: () => ({
        ready: Promise.resolve(), sendAudio() {}, async stop() {},
        close() { closeCalls += 1; },
      }),
    });

    const started = await withTimeout(dispatch(listeners, 'asr:stream-start', {
      providerId: 'qwen', apiKey: 'sk-x', model: 'model', audioInput: '',
    }));
    assert.strictEqual(started?.ok, false);
    assert.match(started?.error?.message || '', /microphone disconnected/i);
    const state = await withTimeout(dispatch(listeners, 'asr:stream-state', {}));
    assert.strictEqual(state?.data?.streaming, false);
    assert.strictEqual(closeCalls, 1);
    assert.ok(!sent.some((m) => m.type === 'asr:stream-update'
      && m.payload?.kind === 'active'), 'failed startup must not publish active state');
  });

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

run().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
