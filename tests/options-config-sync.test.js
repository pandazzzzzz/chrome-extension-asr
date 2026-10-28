// options 页跨入口配置同步回归 —— 纯 Node，无浏览器依赖。
//
// 回归面（issue #69）：options 与 popup/sidepanel 共用 storage.local，
// 外部页保存后本页必须刷新；本页有未保存编辑时不得被覆盖，且异步
// ConfigStore.load() 返回后仍要按最新 UI 重新判定（issue #66 的同类竞态）。
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

async function flushAsync() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

let pass = 0;
let fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log('PASS | ' + name); })
  .catch((e) => {
    fail++;
    console.log('FAIL | ' + name + ' | ' + (e && e.stack ? e.stack.split('\n').slice(0, 7).join('\n') : e));
  });

function makeField(value = '') {
  const listeners = {};
  let textContent = '';
  return {
    value,
    className: '',
    style: {},
    listeners,
    children: [],
    get textContent() { return textContent; },
    set textContent(text) {
      textContent = String(text);
      this.children = [];
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    appendChild(child) { this.children.push(child); },
    append() {},
    click() {},
    remove() {},
    set href(v) { this._href = v; },
    get href() { return this._href || ''; },
  };
}

function makeSandbox() {
  const els = {
    provider: makeField('qwen'),
    apiKey: makeField('sk-test'),
    endpoint: makeField(''),
    endpointRow: { style: {} },
    region: makeField('cn-beijing'),
    audioType: makeField('audio/webm'),
    model: makeField('qwen-audio-3.1-asr-flash-streaming'),
    modelCustom: makeField(''),
    modelCustomRow: { style: {} },
    saveBtn: makeField(),
    testModelBtn: makeField(),
    clearHistoryBtn: makeField(),
    exportHistoryBtn: makeField(),
    refreshHistoryBtn: makeField(),
    historyList: makeField(),
    status: makeField(),
    keyStatus: makeField(),
    cryptoKeyStatus: makeField(),
    historyCount: makeField(),
  };
  const listeners = { changed: [], domready: [] };
  const page = {
    configStoreLoads: 0,
    nextConfigStoreLoad: null,
    nextConfigStoreSave: null,
    configStoreLoadResult: {
      provider: 'qwen',
      apiKey: 'sk-test',
      region: 'cn-beijing',
      endpoint: '',
      model: 'qwen-audio-3.1-asr-flash-streaming',
      audioType: 'audio/webm',
    },
    savedConfigs: [],
  };
  const provider = {
    id: 'qwen',
    name: 'Qwen (DashScope)',
    modelOptions: [{ model: 'qwen-audio-3.1-asr-flash-streaming' }],
    regions: [{ value: 'cn-beijing' }, { value: 'custom' }],
    modelSelectionFor(model) {
      return model === 'qwen-audio-3.1-asr-flash-streaming'
        ? { value: model, customText: '' }
        : { value: '', customText: model || '' };
    },
    testConnection: async () => ({ ok: true, model: 'draft-model' }),
    endpointFor: () => 'wss://example.test/inference',
  };
  const sandbox = {
    console,
    document: {
      getElementById: (id) => Object.prototype.hasOwnProperty.call(els, id) ? els[id] : null,
      addEventListener(type, fn) { if (type === 'DOMContentLoaded') listeners.domready.push(fn); },
      createElement() {
        return makeField();
      },
      body: { appendChild() {} },
    },
    chrome: {
      storage: {
        onChanged: { addListener: (fn) => listeners.changed.push(fn) },
      },
    },
    setTimeout,
    clearTimeout,
    Blob: globalThis.Blob,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    PROVIDERS: [provider],
    ConfigUI: {
      resolveRegionSelection(regions, savedRegion, savedEndpoint) {
        const has = (regions || []).some((r) => r.value === savedRegion);
        if (has) return { value: savedRegion };
        if (savedEndpoint) return { value: 'custom' };
        return { value: regions?.[0]?.value || '' };
      },
      populateRegionOptions(el, regions, value) {
        el.value = value || regions?.[0]?.value || '';
      },
      populateModelOptions(el, p) {
        el.value = p?.modelOptions?.[0]?.model || '';
      },
      resolveModelSelection(p, model) {
        return p?.modelSelectionFor
          ? p.modelSelectionFor(model)
          : { value: '', customText: model || '' };
      },
    },
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
      save: async (config) => {
        page.savedConfigs.push(config);
        if (page.nextConfigStoreSave) {
          const pending = page.nextConfigStoreSave;
          page.nextConfigStoreSave = null;
          await pending;
        }
      },
    },
    HistoryStore: {
      list: async () => [],
      count: async () => 0,
      clear: async () => {},
    },
    CryptoStore: { hasKey: async () => true },
    Format: { timestampForFile: () => 'x' },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(root, 'options/options.js'), 'utf8'),
    sandbox,
    { filename: 'options/options.js' },
  );
  return { sandbox, els, listeners, page };
}

async function initPage() {
  const state = makeSandbox();
  await state.listeners.domready[0]();
  await flushAsync();
  return state;
}

function changeEvent(config) {
  return {
    asrConfig: {
      newValue: {
        ...config,
        apiKey: 'enc:BASE64-CIPHERTEXT',
      },
    },
  };
}

(async () => {
  await t('Test model: tests draft settings and reports provider errors', async () => {
    const { sandbox, els } = await initPage();
    let observed;
    sandbox.PROVIDERS[0].testConnection = async (config) => {
      observed = config;
      return { ok: true, model: config.model };
    };
    els.model.value = '';
    els.modelCustom.value = 'draft-model';
    await sandbox.testModel();
    assert.strictEqual(observed.model, 'draft-model');
    assert.strictEqual(els.status.textContent, 'Model test passed: draft-model.');
    assert.strictEqual(els.testModelBtn.disabled, false);
  });

  await t('onChanged: external config is applied through decrypted ConfigStore.load', async () => {
    const { els, listeners, page } = await initPage();
    page.configStoreLoadResult = {
      provider: 'qwen',
      apiKey: 'sk-plaintext',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    };

    listeners.changed[0](changeEvent({
      provider: 'qwen',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    }), 'local');
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(page.configStoreLoads >= 2, 'sync path must call ConfigStore.load()');
    assert.strictEqual(els.apiKey.value, 'sk-plaintext');
    assert.strictEqual(els.modelCustom.value, 'fun-asr-realtime');
    assert.strictEqual(els.model.value, '');
    assert.strictEqual(els.audioType.value, 'audio/ogg');
    assert.strictEqual(els.provider.children.length, 1, 'provider options must not be appended twice');
    assert.strictEqual(els.provider.children[0].value, 'qwen');
  });

  await t('onChanged: external config does not overwrite unsaved options edits', async () => {
    const { els, listeners, page } = await initPage();
    page.configStoreLoadResult = {
      provider: 'qwen',
      apiKey: 'sk-external',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    };

    els.apiKey.value = 'sk-user-editing';
    els.model.value = '';
    els.modelCustom.value = 'qwen3-asr-flash-realtime';
    listeners.changed[0](changeEvent({
      provider: 'qwen',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    }), 'local');
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(els.apiKey.value, 'sk-user-editing');
    assert.strictEqual(els.modelCustom.value, 'qwen3-asr-flash-realtime');
  });

  await t('onChanged: edit started while ConfigStore.load is pending is preserved', async () => {
    const { els, listeners, page } = await initPage();
    let resolveLoad;
    page.nextConfigStoreLoad = new Promise((resolve) => { resolveLoad = resolve; });

    listeners.changed[0](changeEvent({
      provider: 'qwen',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    }), 'local');
    await flushAsync();

    els.model.value = '';
    els.modelCustom.value = 'qwen3-asr-flash-realtime';
    resolveLoad({
      provider: 'qwen',
      apiKey: 'sk-external',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    });
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(els.modelCustom.value, 'qwen3-asr-flash-realtime');
    assert.strictEqual(els.apiKey.value, 'sk-test');
  });

  await t('onChanged: an external save after own save is still applied', async () => {
    const { els, listeners, page } = await initPage();
    els.apiKey.value = 'sk-saved-here';
    await els.saveBtn.listeners.click();
    const loadsAfterSave = page.configStoreLoads;
    assert.strictEqual(page.savedConfigs.length, 1);

    page.configStoreLoadResult = {
      provider: 'qwen',
      apiKey: 'sk-different-external',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    };
    listeners.changed[0](changeEvent({
      provider: 'qwen',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    }), 'local');
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(page.configStoreLoads > loadsAfterSave, 'external change must reload decrypted config');
    assert.strictEqual(els.apiKey.value, 'sk-different-external');
  });

  await t('onChanged: provider select is cleared and rebuilt for the new provider', async () => {
    const { sandbox, els, listeners, page } = await initPage();
    sandbox.PROVIDERS.push({
      id: 'other',
      name: 'Other Provider',
      modelOptions: [{ model: 'other-stream-model' }],
      regions: [{ value: 'custom' }],
      modelSelectionFor: (model) => ({ value: model || 'other-stream-model', customText: '' }),
    });
    page.configStoreLoadResult = {
      provider: 'other',
      apiKey: 'sk-other',
      region: 'custom',
      endpoint: 'wss://example.test/inference',
      model: 'other-stream-model',
      audioType: 'audio/webm',
    };
    listeners.changed[0](changeEvent({
      provider: 'other',
      region: 'custom',
      endpoint: 'wss://example.test/inference',
      model: 'other-stream-model',
      audioType: 'audio/webm',
    }), 'local');
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(els.provider.value, 'other');
    assert.deepStrictEqual(els.provider.children.map((o) => o.value), ['qwen', 'other']);
  });

  await t('save: edits made while the save is pending are not treated as saved', async () => {
    const { sandbox, els, listeners, page } = await initPage();
    let resolveSave;
    page.nextConfigStoreSave = new Promise((resolve) => { resolveSave = resolve; });

    els.apiKey.value = 'sk-being-saved';
    const saving = vm.runInContext('save()', sandbox);
    await flushAsync();

    els.model.value = '';
    els.modelCustom.value = 'qwen3-asr-flash-realtime';
    resolveSave();
    await saving;
    await flushAsync();

    page.configStoreLoadResult = {
      provider: 'qwen',
      apiKey: 'sk-external',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    };
    listeners.changed[0](changeEvent({
      provider: 'qwen',
      region: 'cn-beijing',
      endpoint: '',
      model: 'fun-asr-realtime',
      audioType: 'audio/ogg',
    }), 'local');
    await flushAsync();
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(
      els.modelCustom.value,
      'qwen3-asr-flash-realtime',
      'edits made while save was pending must remain protected from external sync',
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
