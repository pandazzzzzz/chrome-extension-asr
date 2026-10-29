/**
 * Shared popup/side-panel form wiring and three-way recording mutex.
 */

// ---------- UI setup ----------

function gatherElements() {
  els.providerSelect = document.getElementById('provider');
  els.apiKeyInput = document.getElementById('apiKey');
  els.endpointInput = document.getElementById('endpoint');
  els.endpointRow = document.getElementById('endpointRow');
  els.regionSelect = document.getElementById('region'); // 可选：无 #region 的入口页跳过
  els.modelInput = document.getElementById('model'); // 下拉：选项来自 provider.modelOptions
  els.modelCustomInput = document.getElementById('modelCustom'); // 仅下拉选中 Custom 时可见
  els.modelCustomRow = document.getElementById('modelCustomRow');
  els.audioTypeSelect = document.getElementById('audioType');
  els.recordBtn = document.getElementById('recordBtn');
  els.tabRecordBtn = document.getElementById('tabRecordBtn');
  els.saveBtn = document.getElementById('saveBtn');
  els.testModelBtn = document.getElementById('testModelBtn');
  els.streamBtn = document.getElementById('streamBtn');
  els.resultText = document.getElementById('result');
  els.copyBtn = document.getElementById('copyBtn');
  els.fillBtn = document.getElementById('fillBtn');
  els.optionsBtn = document.getElementById('optionsBtn'); // 可选：sidepanel/options 有
  els.panelBtn = document.getElementById('panelBtn'); // 可选：popup 有
  els.subtitleBtn = document.getElementById('subtitleBtn'); // 可选：popup/sidepanel 有
  els.audioInputSelect = document.getElementById('audioInput'); // 可选：支持设备枚举的入口页有
  els.statusDiv = document.getElementById('status');

  syncResultButtons();
  els.resultText.addEventListener('input', syncResultButtons);

  // 设备热插拔（插入/拔出麦克风、系统切换默认设备）→ 重新枚举并保留当前选择
  if (els.audioInputSelect && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { void refreshAudioInputs(); });
  }
}

// 把注册表里的 provider 填进下拉框（<select id="provider">）
function populateProviderSelect() {
  const providers = globalThis.PROVIDERS || [];
  providers.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    els.providerSelect.appendChild(option);
  });
}

// ---------- 音频输入设备 ----------

// 用设备列表重建下拉框。首项固定为"跟随系统默认"（value=''），其余按枚举顺序。
// 保留当前选择：设备仍在列表里就选中它，已消失则回退默认并纠正状态变量
// （否则 selectedAudioInput 指向不存在的设备，下次录音会走 OverconstrainedError 分支）。
function syncAudioInputOptions(devices) {
  if (!els.audioInputSelect) return;

  const select = els.audioInputSelect;
  select.textContent = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'System default';
  select.appendChild(defaultOption);

  devices.forEach((device) => {
    const option = document.createElement('option');
    // 'default' 哨兵与 '' 语义重复（都表示跟随默认），统一折叠到 '' 选项
    option.value = device.isDefault ? '' : device.deviceId;
    option.textContent = device.label;
    if (!option.value) return; // 与默认项重复，跳过
    select.appendChild(option);
  });

  const stillPresent = Array.from(select.options).some((o) => o.value === selectedAudioInput);
  if (!stillPresent) {
    selectedAudioInput = '';
    debugEvt('audio-input-fallback', { reason: 'selected-device-gone' });
  }
  select.value = selectedAudioInput;
}

// 设备下拉框的可见性：不支持枚举的入口页（无元素）或枚举不到设备（旧浏览器/
// 无麦克风）时整行隐藏，避免留一个点不动的空下拉框。
function toggleAudioInputRow(visible) {
  const row = els.audioInputSelect?.closest('.field') || els.audioInputSelect;
  if (row) row.style.display = visible ? '' : 'none';
}

// 重新枚举并刷新下拉框。未授权时 Chrome 会返回设备条目但 label 为空（已由
// listAudioInputs 用序号兜底），故此处只关心"有没有 audioinput"。
async function refreshAudioInputs() {
  if (!els.audioInputSelect || !globalThis.isAudioInputSelectionSupported?.()) {
    toggleAudioInputRow(false);
    return;
  }
  let devices;
  try {
    devices = await globalThis.listAudioInputs();
  } catch (error) {
    debugEvt('audio-input-error', { message: error?.message || String(error) });
    toggleAudioInputRow(false);
    return;
  }
  toggleAudioInputRow(devices.length > 0);
  syncAudioInputOptions(devices);
}

// 按选择打开麦克风（含失效回退），统一处理用户可见提示与打点。
async function acquireMicrophone() {
  const { stream, fellBack } = await globalThis.openMicrophone(selectedAudioInput);
  if (fellBack) {
    selectedAudioInput = '';
    if (els.audioInputSelect) els.audioInputSelect.value = '';
    showStatus('Selected microphone is unavailable — using system default.', 'error');
    debugEvt('audio-input-fallback', { reason: 'device-unavailable' });
  }
  return stream;
}

function getCurrentProvider() {
  const id = els.providerSelect.value;
  return globalThis.PROVIDERS?.find((p) => p.id === id) || null;
}

function onProviderChange() {
  const provider = getCurrentProvider();
  if (!provider) return;

  // 模型下拉：选项来自当前 provider 的 modelOptions（形状同 Region 下拉）。
  // 切 provider 时若旧选中项在新预置里仍存在则保持，否则落到首项；Custom 态下
  // 手填框的文本原样保留（那是用户的模型名，不能因为换了 provider 就丢）。
  populateModelOptions(provider);

  // Region 下拉框：选项来自当前 provider 的 regions；无 #region 的入口页跳过。
  // 切换 provider 时重建选项并把 region 归到该 provider 的首个地域（地域与 API Key 强绑定）。
  if (els.regionSelect) {
    const prev = els.regionSelect.value;
    // 决策规则在 shared/config-ui.js（与 options 页共用同一实现）。
    const resolved = globalThis.ConfigUI.resolveRegionSelection(provider.regions, prev, '');
    globalThis.ConfigUI.populateRegionOptions(els.regionSelect, provider.regions, resolved.value);
    // 非 custom 时 endpoint 由 region 决定，文本框隐藏；custom 才显示给用户手填
    setEndpointRowVisible(!provider.hasEndpoint || resolved.value === 'custom');
  } else if (els.endpointRow) {
    setEndpointRowVisible(provider.hasEndpoint);
  }
}

/** endpoint 文本框显隐（自定义地域才需要手填）。 */
function setEndpointRowVisible(visible) {
  if (els.endpointRow) els.endpointRow.style.display = visible ? '' : 'none';
}

/** model 名称文本框显隐（模型下拉选中 Custom 才需要手填）。 */
function setModelCustomRowVisible(visible) {
  if (els.modelCustomRow) els.modelCustomRow.style.display = visible ? '' : 'none';
}

/**
 * 本次流式实际使用的模型名：下拉选中预置项就取该项，选中 Custom 就取手填值。
 *
 * 所有读「当前模型」的地方都必须走这里 —— 直接读 `els.modelInput.value` 会在
 * Custom 状态下拿到空串（哨兵值），把用户的模型名丢掉。
 */
function resolveModel() {
  const selected = els.modelInput ? els.modelInput.value : '';
  if (selected) return selected.trim();
  return els.modelCustomInput ? els.modelCustomInput.value.trim() : '';
}

/**
 * 用当前 provider 的 `modelOptions` 重建模型下拉。
 *
 * 形状与 Region 下拉一致（选项来自 provider 元数据，末项 Custom 配一个文本框）。
 * **无 `#model` 下拉或 provider 无预置选项时**退化为纯 Custom 态（文本框常显），
 * 这样没声明 modelOptions 的 provider 仍能手填任意白名单模型。
 *
 * @param {object|null} provider
 * @param {{value?: string, customText?: string}} [keep] 需要保持的选中态（见 modelSelectionFor）
 */
function populateModelOptions(provider, keep) {
  if (!els.modelInput) return;
  const prev = els.modelInput.value;
  // 选项重建在 shared/config-ui.js（与 options 页共用同一实现）。
  globalThis.ConfigUI.populateModelOptions(els.modelInput, provider);
  const list = provider?.modelOptions || [];
  if (keep) {
    els.modelInput.value = keep.value;
    if (els.modelCustomInput && keep.customText != null) els.modelCustomInput.value = keep.customText;
  } else if (list.some((o) => o.model === prev)) {
    els.modelInput.value = prev; // 切 provider 时尽量保持原选中项（同名模型跨 provider 有效）
  }
  // 下拉为空值 = Custom 哨兵（或退化态）→ 显示手填框
  setModelCustomRowVisible(!els.modelInput.value);
  els.modelInput.title = provider?.supportsStreaming
    ? `Live Stream 只接受本 provider 的 run-task 模型（白名单：${(provider.streamModels || []).join(', ')}）；不在下拉里的模型选 Custom 手填`
    : '';
}

/**
 * 本次流式实际使用的 endpoint：custom 地域取用户填的 URL，其余取地域对应的公共域名。
 * custom 且用户没填 → 返回空串；调用方（startStreaming）据此**硬拦**，不再回落默认
 * 端点（回落会把 Custom 静默变成北京，跨地域 Key 必然握手 401）。非 custom 地域经
 * endpointFor 必得真实 wss URL。空串只应来自 custom 留空这一种情况。
 */
function resolveEndpoint(provider) {
  if (!provider) return '';
  const region = els.regionSelect ? els.regionSelect.value : '';
  if (region === 'custom') return els.endpointInput.value.trim();
  return provider.endpointFor ? provider.endpointFor(region) : '';
}

// Result 为空时禁用 Copy / Fill（handleCopy / handleFillIntoPage 自己也会拦，
// 这里把"点也没用"直接说清楚）。
// 注意：程序化赋值 result.value = text 不会触发 input 事件 —— 流式回调写完
// result 必须显式调用本函数，否则按钮会一直是 disabled。
function syncResultButtons() {
  const disabled = !els.resultText.value.trim();
  els.copyBtn.disabled = disabled;
  els.fillBtn.disabled = disabled;
}

function bindEvents() {
  els.providerSelect.addEventListener('change', () => {
    onProviderChange();
    void persistConfig();
  });
  els.apiKeyInput.addEventListener('change', persistConfig);
  els.endpointInput.addEventListener('change', persistConfig);
  // 地域切换：custom 才显示 endpoint 文本框，并持久化选择
  els.regionSelect?.addEventListener('change', () => {
    setEndpointRowVisible(els.regionSelect.value === 'custom');
    void persistConfig();
  });
  els.modelInput.addEventListener('change', () => {
    // 选中 Custom（空值哨兵）才显示手填框；切回预置项则隐藏（手填值保留在框里）
    setModelCustomRowVisible(!els.modelInput.value);
    void persistConfig();
  });
  els.modelCustomInput?.addEventListener('change', persistConfig);
  els.audioTypeSelect.addEventListener('change', persistConfig);
  // 设备选择同样持久化（#audioInput 只在支持枚举的入口页存在）
  els.audioInputSelect?.addEventListener('change', () => {
    selectedAudioInput = els.audioInputSelect.value;
    debugEvt('audio-input-changed', { deviceId: selectedAudioInput || 'default' });
    void persistConfig();
  });

  els.recordBtn.addEventListener('click', toggleRecording);
  els.tabRecordBtn.addEventListener('click', toggleTabRecording);
  els.saveBtn.addEventListener('click', handleSaveAudio);
  els.testModelBtn?.addEventListener('click', testModel);
  els.streamBtn.addEventListener('click', toggleStreaming);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
  // 这三个按钮只在部分入口页存在（popup: options+panel+subtitles；sidepanel: options+subtitles）
  els.optionsBtn?.addEventListener('click', handleOpenOptions);
  els.panelBtn?.addEventListener('click', handleOpenPanel);
  els.subtitleBtn?.addEventListener('click', toggleSubtitles);
}

async function testModel() {
  if (els.testModelBtn.disabled) return;
  const provider = getCurrentProvider();
  if (!provider?.testConnection) {
    showStatus('This provider does not support model testing.', 'error');
    return;
  }
  els.testModelBtn.disabled = true;
  els.testModelBtn.textContent = 'Testing…';
  showStatus('Testing endpoint, API key, and model…', 'info');
  try {
    const result = await provider.testConnection({
      apiKey: els.apiKeyInput.value.trim(),
      model: resolveModel() || provider.defaultStreamModel,
      endpoint: resolveEndpoint(provider),
    });
    showStatus(result.ok
      ? `Model test passed: ${result.model}.`
      : `Model test failed: ${result.error}`, result.ok ? 'success' : 'error');
  } catch (error) {
    showStatus(`Model test failed: ${error.message}`, 'error');
  } finally {
    els.testModelBtn.disabled = false;
    els.testModelBtn.textContent = 'Test model';
  }
}

// 会话宿主在 offscreen（#43 迁移）：popup 关闭不再断流，pagehide 无需任何收尾。
// 历史写入与字幕收尾都在 offscreen 的会话结束路径完成；本页重开时按 STREAM_STATE
// 对账并接收 STREAM_UPDATE 广播，与 tab 录音的 UI 镜像模式一致。

// 三路录音互斥：开启任一路时禁用其它两路按钮（active 路保留自身）
function disableOtherRecordButtons(active) {
  els.recordBtn.disabled = els.recordBtn !== active;
  els.tabRecordBtn.disabled = els.tabRecordBtn !== active;
  els.streamBtn.disabled = els.streamBtn !== active;
}

// 停止后恢复三路按钮
function enableAllRecordButtons() {
  // 状态感知：ended 广播可能先于 stop 响应到达，无条件全开会在毫秒窗口内
  // 放行其它两路，随后迟到的 stop finally 再次全开，冲掉正在录音那路的互斥
  // 状态（#71）。任一路忙/活跃时保持三路互斥，只复位真正全空闲的状态。
  const recording = isRecording || isRecordingBusy;
  const tabRecording = isTabRecording || isTabRecordingBusy;
  const streaming = isStreaming || isStreamingBusy;
  const activeCount = [recording, tabRecording, streaming].filter(Boolean).length;
  if (activeCount > 0) {
    if (recording) disableOtherRecordButtons(els.recordBtn);
    else if (tabRecording) disableOtherRecordButtons(els.tabRecordBtn);
    else disableOtherRecordButtons(els.streamBtn);
    return;
  }
  els.recordBtn.disabled = false;
  els.tabRecordBtn.disabled = false;
  els.streamBtn.disabled = false;
}
