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

async function makePopup(options = {}) {
  let micAcquisitions = 0;
  let leaseRequests = 0;
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
      body: { appendChild() {} },
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.runtime.push(fn) },
        sendMessage: async () => ({}),
        connect: () => {
          const messageListeners = [];
          const disconnectListeners = [];
          return {
            onMessage: { addListener: (fn) => messageListeners.push(fn) },
            onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
            postMessage(msg) {
              if (msg?.type !== 'asr:mic-record-acquire') return;
              leaseRequests += 1;
              setTimeout(() => {
                for (const fn of messageListeners) {
                  fn(options.leaseAccepted === false
                    ? { ok: false, error: { code: 'ALREADY_RECORDING', message: 'Already recording' } }
                    : { ok: true, data: { recording: true } });
                }
              }, 0);
            },
            disconnect() {
              for (const fn of disconnectListeners) fn();
            },
          };
        },
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
      TAB_RECORD_STATE: 'asr:tab-record-state',
      TAB_RECORD_STOP: 'asr:tab-record-stop',
      MIC_RECORD_PORT: 'asr:mic-record',
      MIC_RECORD_ACQUIRE: 'asr:mic-record-acquire',
      MIC_RECORD_RELEASE: 'asr:mic-record-release',
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
    RecordingStore: { isRef: () => false, read: async () => null, remove: async () => false },
    PROVIDERS: [],
    emitDebug() {},
    AudioRecorder: class {
      attach() {}
      start() {}
      actualMimeType() { return ''; }
      static sameMimeType() { return true; }
      static baseMimeType(x) { return x; }
    },
    openMicrophone: async () => {
      micAcquisitions += 1;
      return { stream: { getTracks: () => [] } };
    },
    createPcmCapture() { return {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'popup/app.js'), 'utf8'), sandbox, { filename: 'popup/app.js' });
  await listeners.domready[0]();
  await flushAsync();
  return {
    sandbox,
    els,
    listeners,
    get micAcquisitions() { return micAcquisitions; },
    get leaseRequests() { return leaseRequests; },
  };
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
  {
    const denied = await makePopup({ leaseAccepted: false });
    await vm.runInContext('startRecording()', denied.sandbox);
    await flushAsync();
    assert.strictEqual(denied.leaseRequests, 1, 'mic start must request the background recording lease');
    assert.strictEqual(denied.micAcquisitions, 0, 'denied lease must not open a microphone');
    assert.strictEqual(denied.els.recordBtn.disabled, false, 'failed mic start must unlock the mic button');
    assert.strictEqual(denied.els.tabRecordBtn.disabled, false, 'failed mic start must unlock Tab');
    assert.strictEqual(denied.els.streamBtn.disabled, false, 'failed mic start must unlock Stream');

    const granted = await makePopup();
    await vm.runInContext('startRecording()', granted.sandbox);
    await flushAsync();
    assert.strictEqual(granted.leaseRequests, 1, 'mic start must acquire before getUserMedia');
    assert.strictEqual(granted.micAcquisitions, 1, 'granted lease should allow microphone acquisition once');
    console.log('PASS | microphone recording acquires the shared background lease');
  }
  {
    const { sandbox } = await makePopup();
    const ref = { file: 'tab-test.audio', mime: 'audio/webm', size: 4 };
    let reads = 0;
    let removals = 0;
    let clicks = 0;
    sandbox.MessageClient.send = async (type) => {
      if (type === 'asr:tab-record-stop') return ref;
      if (type === 'asr:tab-record-state') return { recording: false };
      return { streaming: false };
    };
    sandbox.RecordingStore = {
      isRef: (value) => value === ref,
      read: async () => { reads += 1; return { size: 4, type: 'audio/webm' }; },
      remove: async () => { removals += 1; return true; },
    };
    sandbox.document.createElement = () => ({ style: {}, click() { clicks += 1; }, remove() {} });

    await vm.runInContext('isTabRecording = true; stopTabRecording()', sandbox);
    await flushAsync();
    const stored = await vm.runInContext('audioRecording', sandbox);
    assert.strictEqual(stored.file, ref.file, 'tab stop must keep the OPFS ref');

    await vm.runInContext('handleSaveAudio()', sandbox);
    await flushAsync();
    assert.strictEqual(reads, 1, 'Save audio must read the OPFS-backed recording');
    assert.strictEqual(clicks, 1, 'Save audio must trigger one download');
    assert.strictEqual(removals, 1, 'Save audio must delete the OPFS file after download');
    assert.strictEqual(await vm.runInContext('audioRecording', sandbox), null);
    console.log('PASS | tab recording saves through OPFS metadata');
  }
  {
    const { sandbox } = await makePopup();
    const ref = { file: 'tab-partial.audio', mime: 'audio/webm', size: 2 };
    sandbox.MessageClient.send = async (type) => {
      if (type === 'asr:tab-record-stop') {
        const error = new Error('stop timed out');
        error.partialData = ref;
        throw error;
      }
      if (type === 'asr:tab-record-state') return { recording: false };
      return { streaming: false };
    };
    sandbox.RecordingStore.isRef = (value) => value === ref;

    await vm.runInContext('isTabRecording = true; stopTabRecording()', sandbox);
    await flushAsync();
    const stored = await vm.runInContext('audioRecording', sandbox);
    assert.strictEqual(stored.file, ref.file, 'partial stop must retain the OPFS ref');
    console.log('PASS | partial tab recording keeps its OPFS reference');
  }
  {
    const { sandbox } = await makePopup();
    const oldRef = { file: 'tab-old.audio', mime: 'audio/webm', size: 4 };
    const newRef = { file: 'tab-new.audio', mime: 'audio/webm', size: 5 };
    let releaseRead;
    let readStarted = false;
    sandbox.RecordingStore = {
      isRef: () => false,
      read: async () => {
        readStarted = true;
        await new Promise((resolve) => { releaseRead = resolve; });
        return { size: 4, type: 'audio/webm' };
      },
      remove: async () => true,
    };
    sandbox.document.createElement = () => ({ style: {}, click() {}, remove() {} });
    await vm.runInContext(`audioRecording = ${JSON.stringify(oldRef)}`, sandbox);
    const saving = vm.runInContext('handleSaveAudio()', sandbox);
    while (!readStarted) await flushAsync();
    await vm.runInContext(`audioRecording = ${JSON.stringify(newRef)}`, sandbox);
    releaseRead();
    await saving;
    const stored = await vm.runInContext('audioRecording', sandbox);
    assert.strictEqual(stored.file, newRef.file, 'a slow Save must not clear a newer recording');
    console.log('PASS | slow tab save preserves a newer OPFS reference');
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
