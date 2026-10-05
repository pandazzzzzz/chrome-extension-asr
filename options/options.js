/**
 * Options page — 全局设置、转录历史、本地存储状态。
 *
 * 与 popup 共用同一 ConfigStore（storage.local + 加密），popup 保存后
 * options 刷新即可看到最新值；反之亦然。
 */

const els = {};
let statusTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  gatherElements();

  const config = await globalThis.ConfigStore.load();
  applyToUI(config);

  bindEvents();
  await refreshHistory();
  await refreshStorageStatus();
});

function gatherElements() {
  els.provider = document.getElementById('provider');
  els.apiKey = document.getElementById('apiKey');
  els.endpoint = document.getElementById('endpoint');
  els.audioType = document.getElementById('audioType');
  els.model = document.getElementById('model');
  els.saveBtn = document.getElementById('saveBtn');
  els.clearHistoryBtn = document.getElementById('clearHistoryBtn');
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
  providers.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    els.provider.appendChild(option);
  });
  const first = providers[0]?.id || '';
  // 旧版批量 provider（openai/deepgram 等）已从注册表删除：保存值没有对应 <option>
  // 时 select 会归成 '' 导致空白下拉，点 Save 还会把 '' 写回 storage。回退到第一个
  // provider，与 popup/app.js applyConfigToUI 的 stale-provider-fallback 保持一致。
  const savedProvider = config.provider;
  const hasOption = providers.some((p) => p.id === savedProvider);
  els.provider.value = (hasOption && savedProvider) ? savedProvider : first;
  els.apiKey.value = config.apiKey || '';
  els.endpoint.value = config.endpoint || '';
  els.audioType.value = config.audioType || 'audio/webm';
  els.model.value = config.model || '';
}

function bindEvents() {
  els.saveBtn.addEventListener('click', save);
  els.clearHistoryBtn.addEventListener('click', clearHistory);
  els.refreshHistoryBtn.addEventListener('click', refreshHistory);
}

async function save() {
  try {
    await globalThis.ConfigStore.save({
      provider: els.provider.value,
      apiKey: els.apiKey.value.trim(),
      endpoint: els.endpoint.value.trim(),
      model: els.model.value.trim(),
      audioType: els.audioType.value,
    });
    show('Settings saved.', 'success');
    await refreshStorageStatus();
  } catch (e) {
    show(`Save failed: ${e.message}`, 'error');
  }
}

async function refreshHistory() {
  const items = await globalThis.HistoryStore.list(20);
  els.historyList.innerHTML = '';

  if (!items.length) {
    els.historyList.innerHTML = '<div class="empty">No history yet.</div>';
    return;
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
}

async function clearHistory() {
  await globalThis.HistoryStore.clear();
  await refreshHistory();
  show('History cleared.', 'success');
}

async function refreshStorageStatus() {
  const config = await globalThis.ConfigStore.load();
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

  const history = await globalThis.HistoryStore.count();
  els.historyCount.textContent = `${history}`;
}

function show(message, type) {
  els.status.textContent = message;
  els.status.className = type;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.className = '';
  }, 3500);
}
