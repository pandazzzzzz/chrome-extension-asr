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
  populateProviders();

  const config = await globalThis.ConfigStore.load();
  applyToUI(config);
  toggleEndpoint();

  bindEvents();
  await refreshHistory();
  await refreshStorageStatus();
});

function gatherElements() {
  els.provider = document.getElementById('provider');
  els.apiKey = document.getElementById('apiKey');
  els.endpoint = document.getElementById('endpoint');
  els.endpointRow = document.getElementById('endpointRow');
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

function populateProviders() {
  globalThis.PROVIDERS.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = p.name;
    els.provider.appendChild(option);
  });
}

function applyToUI(config) {
  els.provider.value = config.provider || '';
  els.apiKey.value = config.apiKey || '';
  els.endpoint.value = config.endpoint || '';
  els.audioType.value = config.audioType || 'audio/webm';
  els.model.value = config.model || '';
  if (!els.model.value) {
    const p = globalThis.getProviderById(els.provider.value);
    if (p) els.model.value = p.defaultModel;
  }
}

function toggleEndpoint() {
  const p = globalThis.getProviderById(els.provider.value);
  els.endpointRow.style.display = p && p.hasEndpoint ? '' : 'none';
}

function bindEvents() {
  els.provider.addEventListener('change', () => {
    const p = globalThis.getProviderById(els.provider.value);
    if (p && p.hasEndpoint && !els.endpoint.value.trim() && p.getDefaultEndpoint) {
      els.endpoint.value = p.getDefaultEndpoint();
    }
    if (p && !els.model.value.trim()) els.model.value = p.defaultModel;
    toggleEndpoint();
  });

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

  try {
    const req = indexedDB.open('asr-crypto', 1);
    req.onsuccess = () => {
      const store = req.result.transaction('keys', 'readonly').objectStore('keys');
      const get = store.get('main');
      get.onsuccess = () => {
        els.cryptoKeyStatus.textContent = get.result ? 'present (non-extractable)' : 'missing';
        req.result.close();
      };
      get.onerror = () => {
        els.cryptoKeyStatus.textContent = 'unknown';
        req.result.close();
      };
    };
    req.onerror = () => {
      els.cryptoKeyStatus.textContent = 'unavailable';
    };
  } catch {
    els.cryptoKeyStatus.textContent = 'unavailable';
  }

  const history = await globalThis.HistoryStore.list(1000);
  els.historyCount.textContent = `${history.length}`;
}

function show(message, type) {
  els.status.textContent = message;
  els.status.className = type;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.className = '';
  }, 3500);
}
