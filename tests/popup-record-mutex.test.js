// popup 三路录音互斥的按钮状态回归测试（纯 Node，无浏览器依赖）。
//
// 覆盖 #71：offscreen 的 STREAM_UPDATE kind:'ended' 可能先于 STREAM_STOP 响应
// 到达。若 enableAllRecordButtons 无条件全开三路，迟到的 stop finally 会再次
// 全开，把正在录音那路的互斥状态清掉。这里直接驱动 popup 的 UI 广播监听器，
// 断言 busy/active 路径的按钮在 ended 广播后保持禁用。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeField(value = '', extra = {}) {
  return {
    value,
    style: {},
    disabled: false,
    addEventListener() {},
    appendChild() {},
    classList: { toggle() {} },
    ...extra,
  };
}

async function makePopup() {
  const els = {
    provider: makeField('qwen'),
    apiKey: makeField('sk-test'),
    endpoint: makeField(''),
    endpointRow: { style: {} },
    region: makeField('cn-beijing'),
    model: makeField('qwen-audio-3.1-asr-flash-streaming'),
    modelCustom: makeField(''),
    modelCustomRow: { style: {} },
    audioType: makeField('audio/webm'),
    recordBtn: makeField(),
    tabRecordBtn: makeField(),
    saveBtn: makeField(),
    streamBtn: makeField(),
    result: makeField(''),
    copyBtn: makeField(),
    fillBtn: makeField(),
    optionsBtn: null,
    panelBtn: null,
    subtitleBtn: null,
    audioInput: null,
    status: makeField(),
  };
  const aliases = {
    providerSelect: els.provider,
    apiKeyInput: els.apiKey,
    regionSelect: els.region,
    endpointInput: els.endpoint,
    modelInput: els.model,
    modelCustomInput: els.modelCustom,
    audioTypeSelect: els.audioType,
    statusDiv: els.status,
    resultText: els.result,
  };
  Object.assign(els, aliases);

  const listeners = { domready: [], runtime: [] };
  const sandbox = {
    console,
    document: {
      getElementById: (id) => Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null,
      addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') listeners.domready.push(fn); },
      createElement: () => ({ style: {}, click() {}, remove() {} }),
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
        sendMessage: async () => ({}),
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => [],
      },
      storage: { onChanged: { addListener() {} }, local: {}, session: {} },
      tabs: { query: async () => [{ id: 42 }] },
      windows: { WINDOW_ID_CURRENT: -2 },
      sidePanel: {},
      offscreen: {},
    },
    navigator: { mediaDevices: { enumerateDevices: async () => [], addEventListener() {} }, clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    MessageClient: { send: async () => ({ streaming: false }) },
    MESSAGES: {
      STREAM_UPDATE: 'asr:stream-update',
      STREAM_STATE: 'asr:stream-state',
    },
    TARGETS: { BACKGROUND: 'background', UI: 'ui' },
    Errors: { TIMEOUT: { code: 'TIMEOUT' } },
    ConfigStore: { load: async () => ({}), save: async () => {} },
    ConfigUI: {
      resolveRegionSelection: () => ({ value: 'cn-beijing' }),
      populateRegionOptions() {},
      resolveModelSelection: () => ({ value: 'model', customText: '' }),
      populateModelOptions() {},
    },
    Format: { timestampForFile: () => 'x' },
    PROVIDERS: [],
    emitDebug() {},
    AudioRecorder: class {
      attach() {}
      start() {}
      actualMimeType() { return ''; }
      static sameMimeType() { return true; }
      static baseMimeType(x) { return x; }
    },
    openMicrophone: async () => ({ stream: { getTracks: () => [] } }),
    createPcmCapture() { return {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'popup/app.js'), 'utf8'), sandbox, { filename: 'popup/app.js' });
  await listeners.domready[0]();
  await flushAsync();
  return { sandbox, els, listeners };
}

(async () => {
  {
    const { els, listeners } = await makePopup();
    // 模拟 stop 进行中：ended 广播先到，另一路已在录音/忙。
    // applyStreamingState(false) 会走 enableAllRecordButtons —— 必须尊重其它路的状态。
    listeners.runtime[0]({
      target: 'ui',
      type: 'asr:stream-update',
      payload: { kind: 'ended' },
    });
    assert.strictEqual(els.streamBtn.disabled, false, 'stream button should reset after ended');
    assert.strictEqual(els.recordBtn.disabled, false, 'idle mic path should be enabled');
    assert.strictEqual(els.tabRecordBtn.disabled, false, 'idle tab path should be enabled');
  }
  {
    const { sandbox, els, listeners } = await makePopup();
    await vm.runInContext('startRecording()', sandbox);
    await flushAsync();
    assert.strictEqual(els.recordBtn.disabled, false, 'active mic button stays clickable');
    assert.strictEqual(els.tabRecordBtn.disabled, true, 'tab path disabled while mic records');
    assert.strictEqual(els.streamBtn.disabled, true, 'stream path disabled while mic records');
    // ended 广播到达时 isRecording=true；enableAllRecordButtons 不得冲掉互斥。
    listeners.runtime[0]({
      target: 'ui',
      type: 'asr:stream-update',
      payload: { kind: 'ended' },
    });
    assert.strictEqual(els.streamBtn.disabled, true, 'mic path keeps stream path locked (#71)');
    assert.strictEqual(els.tabRecordBtn.disabled, true, 'mic path keeps tab path locked (#71)');
  }
  console.log('PASS | ended broadcast resets only idle paths (#71)');
  {
    const { sandbox, els } = await makePopup();
    // Model the exact stop path: the call resolves while its own busy flag is
    // still set. The shared reset must not treat that just-finished path busy.
    await vm.runInContext('stopTabRecording()', sandbox);
    await flushAsync();
    assert.strictEqual(els.recordBtn.disabled, false, 'mic path re-enables after tab stop');
    assert.strictEqual(els.tabRecordBtn.disabled, false, 'tab path re-enables after tab stop');
    assert.strictEqual(els.streamBtn.disabled, false, 'stream path re-enables after tab stop');
    console.log('PASS | successful tab stop unlocks all paths (#81)');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
