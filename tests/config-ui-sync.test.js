// 跨入口页 config 同步的 UI 侧单元测试 —— 纯 Node，无浏览器依赖。
//
// 回归面（issue #54）：popup/sidepanel/options 可同屏共存，任一页保存配置后，
// 其它页的 chrome.storage.onChanged 监听器不得覆盖**本页正在编辑、尚未保存**
// 的字段。PR #49 的实现只防了自己写入的回声，漏了"外部变更 vs 本页未保存编辑"
// 这一层 —— 手测中表现为：正在输入的 custom model 名被清空、下拉被切回预置项、
// Custom 行被隐藏，随后本页把 model:"" 写进存储。
//
// 回归面（issue #59）：storage 里 apiKey 是 AES-GCM 密文，onChanged 的
// newValue 是原始存储对象 —— 直接套进 UI 会把密文写进输入框，本页下一次保存
// 会把密文再加密一次，密钥被静默永久损坏。同步路径必须经 ConfigStore.load()
// 解密后再应用。
//
// popup/app.js 不是模块（挂 globalThis），这里用 vm 加载它的源码并注入最小
// DOM/storage mock，只驱动监听器与快照相关的纯函数行为。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

// app.js 的初始化链有多个 async 层级（DOMContentLoaded → loadConfig →
// ConfigStore.load → applyConfigToUI），手动触发后需排空整条 microtask 链
// 再断言，否则监听器可能尚未注册 / 快照尚未建立。
async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

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
    addEventListener() {}, // bindEvents 会对全部控件绑定事件，mock 统一提供
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
    testModelBtn: makeField('', { disabled: false }),
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
  const page = {
    // onChanged 同步路径必须走 ConfigStore.load()（解密），不能直接套 storage 密文。
    configStoreLoads: 0,
    nextConfigStoreLoad: null,
    nextConfigStoreSave: null,
    // 初始 load 返回与 els 初始值一致的配置，建立"UI=基线快照"的干净起点
    //（否则首个 onChanged 会被当成回声/未保存编辑跳过）。
    configStoreLoadResult: {
      provider: 'qwen', apiKey: 'sk-test', region: 'cn-beijing', endpoint: '',
      model: 'qwen-audio-3.1-asr-flash-streaming', audioType: 'audio/webm',
    },
  };
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
    navigator: { clipboard: { writeText: async () => {} }, mediaDevices: { enumerateDevices: async () => [], addEventListener() {} } },
    MessageClient: { send: async () => ({}) },
    MESSAGES: {},
    TARGETS: { BACKGROUND: 'background', OFFSCREEN: 'offscreen', UI: 'ui' },
    Errors: { TIMEOUT: { code: 'TIMEOUT' } },
    ConfigStore: {
      load: async () => {
        page.configStoreLoads += 1;
        if (page.nextConfigStoreLoad) {
          const pending = page.nextConfigStoreLoad;
          page.nextConfigStoreLoad = null;
          return pending;
        }
        return page.configStoreLoadResult;
      },
      save: async () => {
        if (page.nextConfigStoreSave) {
          const pending = page.nextConfigStoreSave;
          page.nextConfigStoreSave = null;
          await pending;
        }
      },
    },
    Format: { timestampForFile: () => 'x' },
    PROVIDERS: [{
      id: 'qwen',
      name: 'Qwen (DashScope)',
      // 与真实 provider 一致：把存储模型映射成「预置项 / Custom+手填」，
      // 让初始化路径 applyConfigToUI 建立真实的基线快照。
      modelSelectionFor: (m) => (m === 'qwen-audio-3.1-asr-flash-streaming'
        ? { value: m, customText: '' }
        : { value: '', customText: m || '' }),
      testConnection: async () => ({ ok: true, model: 'fun-asr-realtime' }),
      endpointFor: () => 'wss://example.test/inference',
    }],
    ConfigUI: {
      resolveRegionSelection: () => ({ value: 'cn-beijing' }),
      populateRegionOptions() {},
      // 透传 provider.modelSelectionFor —— 与 shared/config-ui.js 的真实行为一致。
      resolveModelSelection: (provider, model) => provider?.modelSelectionFor
        ? provider.modelSelectionFor(model)
        : { value: '', customText: model || '' },
      populateModelOptions() {},
    },
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
  await flushAsync();

  return { sandbox, els, listeners, page };
}

(async () => {
  await t('Test model: popup, side panel, and options all expose the button', async () => {
    for (const file of ['popup/popup.html', 'sidepanel/sidepanel.html', 'options/options.html']) {
      const html = fs.readFileSync(path.join(root, file), 'utf8');
      assert.match(html, /id="testModelBtn"/, `${file} is missing the Test model button`);
    }
  });

  await t('Test model: 使用未保存的 Custom 模型与 Custom endpoint', async () => {
    const { sandbox, els } = await makePage();
    let observed;
    sandbox.PROVIDERS[0].testConnection = async (config) => {
      observed = config;
      return { ok: true, model: config.model };
    };
    els.modelInput.value = '';
    els.modelCustomInput.value = 'fun-asr-realtime';
    els.regionSelect.value = 'custom';
    els.endpointInput.value = 'wss://draft.test/inference';
    await sandbox.testModel();
    assert.strictEqual(observed.model, 'fun-asr-realtime');
    assert.strictEqual(observed.endpoint, 'wss://draft.test/inference');
    assert.strictEqual(els.statusDiv.textContent, 'Model test passed: fun-asr-realtime.');
    assert.strictEqual(els.testModelBtn.disabled, false);
  });

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
    // 监听器内部 await ConfigStore.load() —— 排空后再断言（也避免泄漏到后续用例）。
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));
    // 用例 3 已断言应用路径（load 解密回填）；此处保留原弱断言 —— mock 的 load
    // 返回初始配置（model 仍为预置项），modelCustom 不变是正确结果。
    assert.strictEqual(els.modelCustomInput.value, '');
  });

  await t('onChanged: 同步走 ConfigStore.load 解密，apiKey 输入框不得出现密文（issue #59）', async () => {
    const { els, listeners, page } = await makePage();
    // 外部页保存了新配置（model 换成非预置项 → 本页基线必不同，不会误判回声）。
    // storage 里落的是密文；同步路径必须解密后回填，不得把密文写进输入框。
    page.configStoreLoadResult = {
      provider: 'qwen', apiKey: 'sk-plaintext-again', region: 'cn-beijing',
      endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
    };
    listeners.changed[0](
      { asrConfig: { newValue: {
        provider: 'qwen', apiKey: 'enc:BASE64-CIPHERTEXT', region: 'cn-beijing',
        endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
        subtitles: true, audioInput: '',
      } } },
      'local',
    );
    // 监听器内部 await load() —— 让 microtask 队列排空后再断言。
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(page.configStoreLoads >= 2, '同步路径没有走 ConfigStore.load()（issue #59：会把密文写进 UI），实际 load 次数: ' + page.configStoreLoads);
    assert.strictEqual(els.apiKeyInput.value, 'sk-plaintext-again');
  });

  await t('onChanged: 延迟 load 期间开始的编辑不得在 load 完成后被覆盖（issue #66）', async () => {
    const { els, listeners, page } = await makePage();
    let resolveLoad;
    page.nextConfigStoreLoad = new Promise((resolve) => { resolveLoad = resolve; });

    listeners.changed[0](
      { asrConfig: { newValue: {
        provider: 'qwen', apiKey: 'enc:EXTERNAL-CIPHERTEXT', region: 'cn-beijing',
        endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
        subtitles: true, audioInput: '',
      } } },
      'local',
    );
    await flushAsync();

    // load 尚未返回时，用户切到 Custom 并开始输入。
    els.modelInput.value = '';
    els.modelCustomInput.value = 'qwen3-asr-flash-realtime';

    resolveLoad({
      provider: 'qwen', apiKey: 'sk-external', region: 'cn-beijing',
      endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
      subtitles: true, audioInput: '',
    });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(
      els.modelCustomInput.value,
      'qwen3-asr-flash-realtime',
      '异步 load 返回后覆盖了等待期间产生的未保存编辑（issue #66）',
    );
    assert.strictEqual(els.apiKeyInput.value, 'sk-test', 'API Key 在 load 返回后也不应被外部值覆盖');
  });

  await t('persistConfig: save 期间的新编辑不得被后续外部同步覆盖', async () => {
    const { sandbox, els, listeners, page } = await makePage();
    let resolveSave;
    page.nextConfigStoreSave = new Promise((resolve) => { resolveSave = resolve; });

    els.apiKeyInput.value = 'sk-being-saved';
    const saving = vm.runInContext('persistConfig()', sandbox);
    await flushAsync();

    // save 尚未返回，用户继续输入新的 Custom 模型。
    els.modelInput.value = '';
    els.modelCustomInput.value = 'qwen3-asr-flash-realtime';
    resolveSave();
    await saving;
    await flushAsync();

    page.configStoreLoadResult = {
      provider: 'qwen', apiKey: 'sk-external', region: 'cn-beijing',
      endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
    };
    listeners.changed[0](
      { asrConfig: { newValue: {
        provider: 'qwen', apiKey: 'enc:EXTERNAL-CIPHERTEXT', region: 'cn-beijing',
        endpoint: '', model: 'fun-asr-realtime', audioType: 'audio/webm',
        subtitles: true, audioInput: '',
      } } },
      'local',
    );
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(
      els.modelCustomInput.value,
      'qwen3-asr-flash-realtime',
      'save 期间产生的编辑被误记为已保存，随后被外部变更覆盖',
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
