/**
 * Options page — 全局设置、转录历史、本地存储状态。
 *
 * 与 popup 共用同一 ConfigStore（storage.local + 加密），popup 保存后
 * options 刷新即可看到最新值；反之亦然。
 */

const els = {};
let statusTimer = null;
let lastSavedConfigSnapshot = null; // 最近一次已知落盘状态的字段快照

document.addEventListener('DOMContentLoaded', async () => {
  try {
    gatherElements();

    const config = await globalThis.ConfigStore.load();
    applyToUI(config);
    lastSavedConfigSnapshot = snapshotCurrentConfig();

    bindEvents();
    await refreshHistory();
    await refreshStorageStatus();
  } catch (error) {
    console.error('Options initialization failed:', error);
    if (els.status) show(`Cannot load settings: ${error.message}`, 'error');
  }
});

function gatherElements() {
  els.provider = document.getElementById('provider');
  els.apiKey = document.getElementById('apiKey');
  els.endpoint = document.getElementById('endpoint');
  els.endpointRow = document.getElementById('endpointRow');
  els.region = document.getElementById('region');
  els.audioType = document.getElementById('audioType');
  els.model = document.getElementById('model');
  els.modelCustom = document.getElementById('modelCustom');
  els.modelCustomRow = document.getElementById('modelCustomRow');
  els.saveBtn = document.getElementById('saveBtn');
  els.testModelBtn = document.getElementById('testModelBtn');
  els.clearHistoryBtn = document.getElementById('clearHistoryBtn');
  els.exportHistoryBtn = document.getElementById('exportHistoryBtn');
  els.refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
  els.historyList = document.getElementById('historyList');
  els.status = document.getElementById('status');
  els.keyStatus = document.getElementById('keyStatus');
  els.cryptoKeyStatus = document.getElementById('cryptoKeyStatus');
  els.historyCount = document.getElementById('historyCount');
}

function applyToUI(config) {
  // provider 是下拉框，选项来自 providers 注册表；无匹配时回退默认
  const providers = globalThis.PROVIDERS || [];
  // onChanged 同步会多次进入本函数：重建前必须清空，否则 provider 选项
  // 每次外部变更都追加一份（"Qwen (DashScope)" 越积越多，#59）。
  els.provider.textContent = '';
  providers.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    els.provider.appendChild(option);
  });
  const first = providers[0]?.id || '';
  // 旧版批量 provider（openai/deepgram 等）已从注册表删除：保存值没有对应 <option>
  // 时 select 会归成 '' 导致空白下拉，点 Save 还会把 '' 写回 storage。回退到第一个
  // provider，与 popup/app-config.js applyConfigToUI 的 stale-provider-fallback 保持一致。
  const savedProvider = config.provider;
  const hasOption = providers.some((p) => p.id === savedProvider);
  els.provider.value = (hasOption && savedProvider) ? savedProvider : first;
  els.apiKey.value = config.apiKey || '';
  els.endpoint.value = config.endpoint || '';
  els.audioType.value = config.audioType || 'audio/webm';
  // 模型下拉：选项来自当前 provider 的 modelOptions，再把保存的模型映射成
  // 「预置项 / Custom+手填」。与 popup/app-config.js 的 applyConfigToUI 用同一个
  // modelSelectionFor，保证两页对同一配置渲染一致。
  const modelProvider = providers.find((p) => p.id === els.provider.value) || providers[0];
  populateModels(modelProvider, config.model);

  // Region 下拉：选项来自当前 provider；老配置无 region 时，若存了 endpoint 则归 custom。
  populateRegions(els.provider.value, config.region, config.endpoint);
}

/**
 * 用当前 provider 的 regions 重建 region 下拉并选中 savedRegion。
 * 无 savedRegion 但存了 endpoint（老配置/批量时代残留）时归为 custom，保留原值不猜地域。
 */
function populateRegions(providerId, savedRegion, savedEndpoint) {
  const provider = (globalThis.PROVIDERS || []).find((p) => p.id === providerId);
  // 决策规则与选项重建都在 shared/config-ui.js（与 popup/sidepanel 共用同一实现）。
  const resolved = globalThis.ConfigUI.resolveRegionSelection(provider?.regions, savedRegion, savedEndpoint);
  globalThis.ConfigUI.populateRegionOptions(els.region, provider?.regions, resolved.value);
  setEndpointVisible(els.region.value === 'custom');
}

function setEndpointVisible(visible) {
  if (els.endpointRow) els.endpointRow.style.display = visible ? '' : 'none';
}

function setModelCustomVisible(visible) {
  if (els.modelCustomRow) els.modelCustomRow.style.display = visible ? '' : 'none';
}

/**
 * 用 provider 的 modelOptions 重建模型下拉并选中 savedModel。形状同 populateRegions：
 * 选项来自 provider 元数据，末项 Custom（空值哨兵）配一个手填文本框。
 * 映射规则委托给 provider.modelSelectionFor（与 popup 共用），保证两页一致。
 */
function populateModels(provider, savedModel) {
  // 选项重建与选中态映射都在 shared/config-ui.js（与 popup/sidepanel 共用同一实现）。
  globalThis.ConfigUI.populateModelOptions(els.model, provider);
  const sel = globalThis.ConfigUI.resolveModelSelection(provider, savedModel);
  els.model.value = sel.value;
  if (els.modelCustom) els.modelCustom.value = sel.customText || '';
  setModelCustomVisible(!els.model.value);
}

/** 当前生效的模型名：下拉选中 Custom（空哨兵）时取手填框。 */
function resolveModel() {
  return els.model.value ? els.model.value.trim() : (els.modelCustom?.value.trim() || '');
}

function bindEvents() {
  // 切换 provider → 重建 region 与 model 选项（地域/模型都来自 provider 元数据）
  els.provider.addEventListener('change', () => {
    populateRegions(els.provider.value, '', els.endpoint.value.trim());
    const provider = (globalThis.PROVIDERS || []).find((p) => p.id === els.provider.value);
    populateModels(provider, resolveModel());
  });
  // 只有 custom 地域需要手填 endpoint
  els.region.addEventListener('change', () => {
    setEndpointVisible(els.region.value === 'custom');
  });
  // 模型下拉选中 Custom（空哨兵）才显示手填框
  els.model.addEventListener('change', () => {
    setModelCustomVisible(!els.model.value);
  });
  els.saveBtn.addEventListener('click', save);
  els.testModelBtn.addEventListener('click', testModel);
  els.clearHistoryBtn.addEventListener('click', clearHistory);
  els.exportHistoryBtn.addEventListener('click', exportHistory);
  els.refreshHistoryBtn.addEventListener('click', refreshHistory);
}

async function testModel() {
  if (els.testModelBtn.disabled) return;
  const provider = (globalThis.PROVIDERS || []).find((p) => p.id === els.provider.value);
  if (!provider?.testConnection) {
    show('This provider does not support model testing.', 'error');
    return;
  }
  els.testModelBtn.disabled = true;
  els.testModelBtn.textContent = 'Testing…';
  show('Testing endpoint, API key, and model…', 'info');
  try {
    const endpoint = els.region.value === 'custom'
      ? els.endpoint.value.trim()
      : provider.endpointFor(els.region.value);
    const result = await provider.testConnection({
      apiKey: els.apiKey.value.trim(),
      model: resolveModel() || provider.defaultStreamModel,
      endpoint,
    });
    show(result.ok
      ? `Model test passed: ${result.model}.`
      : `Model test failed: ${result.error}`, result.ok ? 'success' : 'error');
  } catch (error) {
    show(`Model test failed: ${error.message}`, 'error');
  } finally {
    els.testModelBtn.disabled = false;
    els.testModelBtn.textContent = 'Test model';
  }
}

async function save() {
  const region = els.region.value;
  const endpoint = els.endpoint.value.trim();

  // Custom 地域必须有 endpoint：这里不挡的话，region:'custom' + endpoint:'' 会被写进
  // asrConfig，而 popup 的 resolveEndpoint 对空串会回落到 provider 的默认端点（北京）——
  // 用户明明选了 Custom 却被静默拨到别的地域，跨地域的 API Key 必然握手 401，且报错
  // 信息完全指不到这个配置项。Save 是显式动作、有状态条，故在此拒绝。
  //
  // 刻意的不对称：popup 的 persistConfig 是 change 驱动的「草稿保存」，**不**做这个
  // 校验（否则用户还没填完 URL 就丢输入），真正的强制点在 startStreaming 的守卫。
  if (region === 'custom' && !endpoint) {
    show('Custom region requires an endpoint URL.', 'error');
    return;
  }

  try {
    // 只提交本页实际编辑的字段。`subtitles` / `audioInput` 在本页无控件，故不提交 ——
    // ConfigStore.save 是 merge 语义（issue #19），未传字段保持原值，不会被这次保存抹掉。
    // `audioType` 本页有控件（applyToUI 回填过），故读它一并提交，用户在此改的格式能落盘。
    const config = {
      provider: els.provider.value,
      apiKey: els.apiKey.value.trim(),
      region,
      endpoint,
      model: resolveModel(),
      audioType: els.audioType.value,
    };
    await globalThis.ConfigStore.save(config);
    // 只记录本次提交值；若保存期间又产生了新编辑，后续外部变更仍应被
    // hasUnsavedConfigEdits() 拦住，不能被误当成"本页已保存"。
    lastSavedConfigSnapshot = JSON.stringify(config);
    show('Settings saved.', 'success');
    await refreshStorageStatus();
  } catch (e) {
    show(`Save failed: ${e.message}`, 'error');
  }
}

// 跨入口页同步：popup/sidepanel 与本页可同屏共存，两边只在 DOMContentLoaded 各 load
// 一次。popup 的 persistConfig 是全量 8 字段提交，本页保存后若不同步，本页 UI 里
// 持有的旧值会在下一次 popup 保存时被写回 storage（静默回滚本页的修改）。监听
// onChanged 重新套用外部修改；本页有未保存编辑时跳过，避免覆盖用户正在输入
// 的内容。自己的写入回声会重新读取同一份已保存配置，因此无需用计数猜测
// 事件来源；这样也不会吞掉紧接着到达的外部保存。
function snapshotCurrentConfig() {
  return JSON.stringify({
    provider: els.provider.value,
    apiKey: els.apiKey.value.trim(),
    region: els.region.value,
    endpoint: els.endpoint.value.trim(),
    model: resolveModel(),
    audioType: els.audioType.value,
  });
}

globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.asrConfig) return;
  (async () => {
    if (hasUnsavedConfigEdits()) return;
    // 同步必须走 load() 解密：newValue 里 apiKey 是 AES-GCM 密文，直接套 UI
    // 会在下一次 Save 时被再加密一次，密钥永久损坏（#59）。
    try {
      const decrypted = await globalThis.ConfigStore.load();
      // load() 期间用户仍可能开始编辑，应用前必须按最新 UI 再判定一次（#66）。
      if (hasUnsavedConfigEdits()) return;
      // applyToUI 会重建 provider 下拉并级联重建 region/model 选项
      applyToUI(decrypted);
      lastSavedConfigSnapshot = snapshotCurrentConfig();
    } catch (e) {
      show(`Cannot sync settings: ${e.message}`, 'error');
    }
  })();
});

function hasUnsavedConfigEdits() {
  return lastSavedConfigSnapshot !== null
    && lastSavedConfigSnapshot !== snapshotCurrentConfig();
}

async function refreshHistory() {
  let items;
  try {
    items = await globalThis.HistoryStore.list(20);
  } catch (error) {
    els.historyList.textContent = '';
    const failed = document.createElement('div');
    failed.className = 'empty';
    failed.textContent = `Cannot read history: ${error.message}`;
    els.historyList.appendChild(failed);
    show(`Cannot read history: ${error.message}`, 'error');
    return false;
  }
  els.historyList.textContent = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No history yet.';
    els.historyList.appendChild(empty);
    return true;
  }

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'history-item';
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = `${new Date(item.createdAt).toLocaleString()} · ${item.provider || '?'} · ${item.model || '?'}`;
    const text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = item.text;
    div.append(meta, text);
    els.historyList.appendChild(div);
  }
  return true;
}

async function clearHistory() {
  try {
    await globalThis.HistoryStore.clear();
  } catch (error) {
    show(`Clear history failed: ${error.message}`, 'error');
    return;
  }
  if (await refreshHistory()) show('History cleared.', 'success');
}

/**
 * 导出全部历史为 JSON 文件。
 *
 * 用 list() 的默认上限（maxEntries = 50）—— 与页面上看到的一致，不做「导出更多」，
 * 因为 HistoryStore 本来就会把超出上限的旧记录丢弃，库里没有第 51 条。
 * 下载走 createObjectURL + a[download]，与 popup 的 Save audio 同一套做法，
 * 因此**不需要 downloads 权限**。
 */
async function exportHistory() {
  let items;
  try {
    items = await globalThis.HistoryStore.list();
  } catch (e) {
    show(`Export failed: ${e.message}`, 'error');
    return;
  }
  if (!items.length) {
    show('Nothing to export.', 'error');
    return;
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    count: items.length,
    entries: items.map((it) => ({
      createdAt: new Date(it.createdAt).toISOString(),
      provider: it.provider || '',
      model: it.model || '',
      text: it.text,
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `asr-history-${globalThis.Format.timestampForFile()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // 下载触发后再回收
  show(`Exported ${items.length} ${items.length === 1 ? 'entry' : 'entries'}.`, 'success');
}

async function refreshStorageStatus() {
  let config;
  try {
    config = await globalThis.ConfigStore.load();
  } catch (error) {
    els.keyStatus.textContent = 'unavailable';
    els.historyCount.textContent = 'unavailable';
    show(`Cannot read storage status: ${error.message}`, 'error');
    return;
  }
  els.keyStatus.textContent = config.apiKey ? `configured (encrypted at rest)` : 'not set';

  // 密钥存在性检查必须走 CryptoStore.hasKey()——不能直接 indexedDB.open('asr-crypto')：
  // 全新安装时该库不存在，直接 open(v1) 会触发 onupgradeneeded 把库建到 v1 却不建
  // 'keys' object store（这里没处理升级回调），此后 CryptoStore 的 onupgradeneeded
  // 不再触发（库已是 v1），CryptoStore 永远建不出表 → API Key 加解密永久损坏。
  try {
    els.cryptoKeyStatus.textContent = (await globalThis.CryptoStore.hasKey())
      ? 'present (non-extractable)'
      : 'missing';
  } catch {
    els.cryptoKeyStatus.textContent = 'unavailable';
  }

  try {
    const history = await globalThis.HistoryStore.count();
    els.historyCount.textContent = `${history}`;
  } catch {
    els.historyCount.textContent = 'unavailable';
  }
}

function show(message, type) {
  els.status.textContent = message;
  els.status.className = type;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.className = '';
  }, 3500);
}
