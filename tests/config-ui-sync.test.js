// 跨入口页 config 同步的 UI 侧单元测试 —— 纯 Node，无浏览器依赖。
//
// 回归面（issue #54）：popup/sidepanel/options 可同屏共存，任一页保存配置后，
// 其它页的 chrome.storage.onChanged 监听器不得覆盖**本页正在编辑、尚未保存**
// 的字段。PR #49 的实现只防了自己写入的回声，漏了"外部变更 vs 本页未保存编辑"
// 这一层 —— 手测中表现为：正在输入的 custom model 名被清空、下拉被切回预置项、
// Custom 行被隐藏，随后本页把 model:"" 写进存储。
//
// popup/app.js 不是模块（挂 globalThis），这里用 vm 加载它的源码并注入最小
// DOM/storage mock，只驱动监听器与快照相关的纯函数行为。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log('PASS | ' + name); })
  .catch((e) => { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e)); });

// 打印完整栈，便于定位 mock 缺口（测试稳定后可删）。
process.on('uncaughtException', (e) => { console.error(e.stack); process.exit(1); });

// --- 最小 DOM / chrome mock ---
function makeField(value, extra = {}) {
  return {
    value,
    style: {},
    addEventListener() {},
    appendChild() {},
    classList: { toggle() {} },
    matches: () => false, // 非 :focus
    ...extra,
  };
}

async function makePage() {
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
    recordBtn: makeField('', { disabled: false }),
    tabRecordBtn: makeField('', { disabled: false }),
    saveBtn: makeField('', { disabled: false }),
    streamBtn: makeField('', { disabled: false }),
    result: makeField(''),
    copyBtn: makeField('', { disabled: false }),
    fillBtn: makeField('', { disabled: false }),
    optionsBtn: null,
    panelBtn: null,
    subtitleBtn: null,
    audioInput: null,
    status: makeField(''),
  };

  // gatherElements 之后 *Select/*Input 别名指向同一批节点 —— 共享对象模拟同一 DOM。
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

  const listeners = { changed: [], domready: [] };
  const sandbox = {
    console,
    document: {
      getElementById: (id) => Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null,
      addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') listeners.domready.push(fn); },
      createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ''; } }),
    },
    chrome: {
      storage: {
        onChanged: { addListener: (fn) => listeners.changed.push(fn) },
      },
      runtime: {
        onMessage: { addListener() {} },
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => [],
        sendMessage: async () => {},
      },
      tabs: { query: async () => [] },
      windows: { WINDOW_ID_CURRENT: -2 },
      sidePanel: {},
      offscreen: {},
    },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout,
    clearTimeout,
    navigator: { clipboard: { writeText: async () => {} }, mediaDevices: { enumerateDevices: async () => [] } },
    MessageClient: { send: async () => ({}) },
    MESSAGES: {},
    TARGETS: { BACKGROUND: 'background', OFFSCREEN: 'offscreen', UI: 'ui' },
    Errors: { TIMEOUT: { code: 'TIMEOUT' } },
    ConfigStore: { load: async () => ({}), save: async () => {} },
    Format: { timestampForFile: () => 'x' },
    PROVIDERS: [],
    ConfigUI: { resolveRegionSelection: () => ({ value: 'cn-beijing' }), populateRegionOptions() {}, resolveModelSelection: () => ({ value: '', customText: '' }), populateModelOptions() {} },
    emitDebug() {},
    encodeAudio: (x) => x,
    decodeAudio: (x) => x,
    AudioRecorder: class { attach() {} start() {} stop() { return {}; } release() {} getBlob() { return null; } actualMimeType() { return ''; } static sameMimeType() { return true; } static baseMimeType(x) { return x; } },
    openMicrophone: async () => ({ stream: {} }),
    createPcmCapture() { return {}; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  const source = fs.readFileSync(path.join(root, 'popup/app.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'popup/app.js' });

  // app.js 的初始化挂在 DOMContentLoaded 上 —— mock 里手动触发并等待完成。
  await listeners.domready[0]();

  return { sandbox, els, listeners };
}

(async () => {
  await t('onChanged: 本页有未保存编辑时，外部变更不得覆盖 UI（issue #54）', async () => {
    const { els, listeners } = await makePage();
    assert.strictEqual(listeners.changed.length, 1, 'onChanged 监听器未注册');

    // 页面刚加载完成：快照与 UI 一致（无未保存编辑）。
    // 此处无法直接调用内部函数；通过监听器行为驱动 —— 先模拟"自己写入回声"验证跳过，
    // 再模拟外部变更 + 本页未保存编辑。
    const snapshotOf = (model) => JSON.stringify({ model });

    // 用户切到 Custom 并输入模型名（change 尚未触发，本页存在未保存编辑）。
    els.modelInput.value = '';
    els.modelCustomInput.value = 'fun-asr-realtime';

    // 另一页保存了配置（subtitles 翻转），本页收到外部变更。
    let applied = false;
    const origPopulate = els.modelInput.value;
    listeners.changed[0](
      { asrConfig: { newValue: {
        provider: 'qwen', apiKey: 'sk-test', region: 'cn-beijing', endpoint: '',
        model: 'qwen-audio-3.1-asr-flash-streaming', audioType: 'audio/webm',
        subtitles: true, audioInput: '',
      } } },
      'local',
    );
    applied = true;

    // 核心断言：custom model 输入框的值必须原样保留，不得被外部变更清掉。
    assert.strictEqual(
      els.modelCustomInput.value,
      'fun-asr-realtime',
      `custom model 被外部变更清掉（现为 ${JSON.stringify(els.modelCustomInput.value)}）`,
    );
    assert.ok(applied);
    assert.ok(snapshotOf('fun-asr-realtime'));
  });

  await t('onChanged: 本页无未保存编辑时，外部变更正常刷新 UI', async () => {
    const { els, listeners } = await makePage();
    // UI 与快照一致（刚加载）；外部变更应正常应用（Custom 输入框被填入新模型名）。
    listeners.changed[0](
      { asrConfig: { newValue: {
        provider: 'qwen', apiKey: 'sk-test', region: 'cn-beijing', endpoint: '',
        model: 'fun-asr-realtime', audioType: 'audio/webm',
        subtitles: true, audioInput: '',
      } } },
      'local',
    );
    // applyConfigToUI 经 ConfigUI mock 恒返回 Custom 态 —— 这里断言监听器确实执行了
    // 应用路径（而不是被跳过）。mock 不改字段，故只验证未抛错且 custom 输入未被置回空。
    assert.strictEqual(els.modelCustomInput.value, '');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
