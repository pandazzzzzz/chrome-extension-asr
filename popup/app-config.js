/**
 * Popup/side-panel configuration load, render, persist, and cross-page sync.
 */

// ---------- Config ----------

function getDefaultConfig() {
  const firstProvider = globalThis.PROVIDERS?.[0];
  return {
    provider: firstProvider?.id || '',
    apiKey: '',
    region: '', // '' = 未显式选择（applyConfigToUI 再决定落到首个地域还是 custom）
    endpoint: '', // 仅 region === 'custom' 时使用
    model: '',
    audioType: 'audio/webm',
    subtitles: false,
    audioInput: '', // '' = 跟随系统默认设备
  };
}

async function loadConfig() {
  const base = getDefaultConfig();
  const stored = await globalThis.ConfigStore.load();
  return { ...base, ...stored };
}

function applyConfigToUI(config) {
  // Provider 下拉框只认注册表里的 id；旧的批量 provider id（openai/deepgram 等）已被删，
  // 若保存值没有对应 <option>，浏览器会把 select 归成 '' 导致空白下拉。回退到第一个 provider。
  const fallbackProvider = getDefaultConfig().provider;
  const savedProvider = config.provider;
  const hasOption = (globalThis.PROVIDERS || []).some((p) => p.id === savedProvider);
  const stale = !!savedProvider && !hasOption;
  els.providerSelect.value = (hasOption && savedProvider) ? savedProvider : fallbackProvider;
  if (stale) debugEvt('stale-provider-fallback', { saved: savedProvider, fallback: fallbackProvider });
  els.apiKeyInput.value = config.apiKey || '';
  // region：老配置没有该字段。若存了显式 endpoint（可能是 wss URL，也可能是批量时代
  // 残留的 https REST URL），一律归为 custom 保留原值 —— 不猜地域、不静默改写用户数据。
  // 两者都空时才落到 provider 首个地域。决策规则在 shared/config-ui.js（与 options 页共用）。
  if (els.regionSelect) {
    const resolved = globalThis.ConfigUI.resolveRegionSelection(
      getCurrentProvider()?.regions,
      config.region,
      config.endpoint,
    );
    els.regionSelect.value = resolved.value;
    if (resolved.legacyCustom) debugEvt('legacy-endpoint-kept', { endpoint: config.endpoint });
  }
  els.endpointInput.value = config.endpoint || '';
  setEndpointRowVisible(!els.regionSelect || els.regionSelect.value === 'custom');
  // 模型下拉回填：provider 变了要重建选项，再把保存的模型映射成「预置项 / Custom+手填」。
  // 空配置 → modelSelectionFor 落到 provider.defaultStreamModel（与切 provider 的默认一致）。
  const curProvider = getCurrentProvider();
  const sel = globalThis.ConfigUI.resolveModelSelection(curProvider, config.model);
  populateModelOptions(curProvider, sel);

  // 字幕开关：恢复上次选择并同步按钮文案/状态（无 #subtitleBtn 的入口页跳过）
  subtitlesEnabled = !!config.subtitles;
  if (els.subtitleBtn) {
    els.subtitleBtn.textContent = subtitlesEnabled ? 'Subtitles on' : 'Subtitles';
    els.subtitleBtn.classList.toggle('active', subtitlesEnabled);
  }
  // 音频输入设备：仅当该入口页有下拉框时回填；设备已不在列表时由
  // syncAudioInputOptions 在下次枚举时回退到默认。
  selectedAudioInput = config.audioInput || '';
  if (els.audioInputSelect) els.audioInputSelect.value = selectedAudioInput;

  // 音频格式：此前 persistConfig 会存 audioType、gatherElements 也取了控件，但
  // applyConfigToUI 从不回填它 → 重开 popup/sidepanel 后 UI 恒显示 HTML 默认 webm，
  // 与 storage 里的实际值不符（issue #19 的 Expected 明确要求 audioType 保留）。
  if (els.audioTypeSelect) els.audioTypeSelect.value = config.audioType || 'audio/webm';
  // 模型为空时已在上面 modelSelectionFor 里落到 provider.defaultStreamModel，无需再补。
}

async function persistConfig() {
  const config = {
    provider: els.providerSelect.value,
    apiKey: els.apiKeyInput.value.trim(),
    region: els.regionSelect ? els.regionSelect.value : '',
    endpoint: els.endpointInput.value.trim(),
    model: resolveModel(), // 下拉选中 Custom 时取手填框的值，不能读下拉本身（那是空哨兵）
    audioType: els.audioTypeSelect.value,
    subtitles: subtitlesEnabled,
    audioInput: selectedAudioInput,
  };
  try {
    await globalThis.ConfigStore.save(config);
    // 只把本次提交的字段记为落盘基线。等待 save 期间用户可能又改了别的
    // 字段；若改用 snapshotCurrentConfig()，这些尚未保存的新编辑会被误认成
    // 已落盘，紧随其后的 storage.onChanged 就能把它们覆盖掉。
    lastSavedConfigSnapshot = JSON.stringify(config);
    debugEvt('config-saved', {
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint, // 原值（诊断页可直接看出是不是 https 批量残留）
      audioType: config.audioType,
      subtitles: config.subtitles,
      audioInput: config.audioInput || 'default',
      hasKey: !!config.apiKey,
    });
  } catch (error) {
    debugEvt('config-save-error', { message: error?.message || String(error) });
    showStatus(`Cannot save settings: ${error.message}`, 'error');
    return false;
  }
  return true;
}

// 跨入口页同步：popup/sidepanel 与 options 可同屏共存（side panel 不随焦点销毁），
// 两边只在 DOMContentLoaded 各 load 一次，此后互不感知。persistConfig 是全量 8 字段
// 提交，会把本页 UI 里的**旧** apiKey/model 写回 storage，静默回滚 options 刚保存的
// 值（ConfigStore.merge 只保护未提交字段，保护不了已提交但过期的值）。监听 onChanged
// 把外部修改刷回 UI 才能堵住这个窗口。自己的写入回声会重新读取同一份已保存
// 配置，因此不必猜测事件来源；无条件交给未保存编辑守卫处理，才能避免把紧随
// 其后的外部保存误当成回声吞掉。
function snapshotCurrentConfig() {
  return JSON.stringify({
    provider: els.providerSelect.value,
    apiKey: els.apiKeyInput.value.trim(),
    region: els.regionSelect ? els.regionSelect.value : '',
    endpoint: els.endpointInput.value.trim(),
    model: resolveModel(),
    audioType: els.audioTypeSelect.value,
    subtitles: subtitlesEnabled,
    audioInput: selectedAudioInput,
  });
}

// 本页 UI 是否有尚未落盘的编辑：与上次成功保存的快照不一致即视为有。
// 初始加载完成后由 applyConfigToUI 路径建立基线快照（见 loadConfig 完成处）。
function hasUnsavedConfigEdits() {
  return lastSavedConfigSnapshot !== snapshotCurrentConfig();
}

globalThis.chrome?.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.asrConfig) return;
  // 同步必须走 load() 解密：newValue 是原始存储对象，apiKey 是 AES-GCM 密文，
  // 直接套进 UI 会把密文写进输入框，本页下一次保存再把它加密一次就永久损坏
  // 密钥（#59）。
  (async () => {
    // 本页存在未保存编辑（当前 UI 与上次落盘快照不一致）时不得整体重渲染：
    // applyConfigToUI 会覆写正在输入的 custom model / API key 等字段并隐藏
    // Custom 行（issue #54 手测：11 秒内三次把用户输入清成 model:""）。有未保存
    // 编辑的页本来就不该被外部状态覆盖；等本页把编辑保存后，后续外部变更再同步。
    if (lastSavedConfigSnapshot !== null && hasUnsavedConfigEdits()) {
      debugEvt('config-external-deferred', {});
      return;
    }
    const stored = changes.asrConfig.newValue || {};
    debugEvt('config-external-change', {
      keys: Object.keys(stored).filter((k) => k !== 'apiKey').join(','),
      hasKey: !!stored.apiKey,
    });
    try {
      const decrypted = await globalThis.ConfigStore.load();
      // load() 期间用户仍可能开始编辑。进入函数时的检查已经过期，必须在
      // 应用前按当前 UI 再判定一次（issue #66）。
      if (hasUnsavedConfigEdits()) {
        debugEvt('config-external-deferred', { phase: 'post-load' });
        return;
      }
      applyConfigToUI({ ...getDefaultConfig(), ...decrypted });
      lastSavedConfigSnapshot = snapshotCurrentConfig();
    } catch (error) {
      debugEvt('config-external-load-error', { message: error?.message || String(error) });
    }
  })();
});
