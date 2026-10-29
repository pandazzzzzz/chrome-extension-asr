/**
 * Popup/side-panel bootstrap. Feature scripts load first and share the classic
 * script global lexical environment.
 */

document.addEventListener('DOMContentLoaded', async () => {
  gatherElements();
  try {
    populateProviderSelect();
    // 必须先把 region <option> 建出来，applyConfigToUI 才能把保存的地域选回去
    // （空 <select> 上赋 value 会静默失败 → 保存的地域丢失）。
    onProviderChange();

    const config = await loadConfig();
    applyConfigToUI(config);
    lastSavedConfigSnapshot = snapshotCurrentConfig(); // 初始基线：此后任何 UI 偏离都是未保存编辑

    bindEvents();
    void refreshAudioInputs(); // 先填"已授权/未授权"的设备列表；授权后由录音/流式路径再刷新
    void syncTabRecordingState(); // 录音活在 offscreen 里，popup 重开必须与真实状态对齐
    void syncStreamingState(); // 流式会话同样活在 offscreen：对账按钮态并回填结果文本
    // 诊断页需要知道 popup 已就绪（配置阶段的失败会在这里看到迹象）
    debugEvt('popup-ready', {
      provider: els.providerSelect.value,
      model: resolveModel(), // Custom 态下下拉是空哨兵，必须取 resolveModel 才拿到真实模型名
      hasKey: !!els.apiKeyInput.value.trim(),
      hasEndpoint: !!els.endpointInput.value.trim(),
      providers: (globalThis.PROVIDERS || []).map((p) => p.id),
      audioInput: selectedAudioInput || 'default',
    });
  } catch (error) {
    console.error('Popup initialization failed:', error);
    debugEvt('popup-init-error', { message: error?.message || String(error) });
    if (els.statusDiv) showStatus(`Cannot load settings: ${error.message}`, 'error');
  }
});

debugEvt('app-loaded', { hasBridge: typeof globalThis.emitDebug === 'function' });
