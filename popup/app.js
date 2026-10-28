/**
 * Popup app — recording shell + realtime WebSocket streaming transcription.
 *
 * 录音壳：麦克风录音、标签页录音（经 background → offscreen）、Save audio 下载。
 * 真流式：Live Stream 按钮 → PCM 采集（AudioWorklet）→ 百炼 WebSocket run-task
 * 协议 → 字幕式 partial/final 实时回显。
 *
 * 批量转录（Transcribe 按钮 + VAD 分段）已随旧伪流式删除；当前 provider
 * （Qwen）supportsStreaming === true，流式直接走 WebSocket，本地不做 VAD。
 */

// State
let recorder = null;          // AudioRecorder 实例（麦克风）
let audioBlob = null;         // 录音结果（由 Save audio 落盘）
let isRecording = false;      // 麦克风录音中
let isTabRecording = false;   // 标签页录音中（经 background → offscreen）
let isRecordingBusy = false;  // 麦克风 start/stop 进行中（含 await），防重入
let isTabRecordingBusy = false; // 标签页 start/stop 进行中（含 await），防重入
let isStreaming = false;      // 真流式转录中（UI 镜像；真相在 background + offscreen）
let isStreamingBusy = false;  // start/stop 消息往返进行中，防重入
let micLeasePort = null;      // background 发放的麦克风录音所有权（长连接）
let lastSavedConfigSnapshot = null; // 本页 persistConfig 成功后的字段快照（识别 storage 回声；null = 尚未初始化）

// 流式会话的宿主已迁至 offscreen（offscreen-streaming.js），本页只是 UI 镜像：
// 发 start/stop、收 STREAM_UPDATE 广播刷新结果区、装载时按 STREAM_STATE 对账。
// 会话可以跨 popup/sidepanel 生命周期 —— 关闭 UI 不再断流，这正是 #43 的目标。

// ---------- 字幕镜像（浮动字幕，可选按钮 #subtitleBtn） ----------
// Live Stream 的 partial/final 实时镜像到**开始流式时**所在标签页的浮动字幕浮层
// （content/subtitle.js）。转发失败只打点不打断 —— 字幕是旁路输出，主流程
// （结果区回显 / 历史落盘）不能因为它挂掉。popup 关闭后无人发送，浮层随
// 页面刷新自然消失；无 #subtitleBtn 的入口页（options）该按钮功能静默缺失。
let subtitlesEnabled = false;

// ---------- 音频输入设备（可选下拉框 #audioInput） ----------
// deviceId '' = 跟随系统默认。设备名只在首次 getUserMedia 授权成功后才可见，
// 故枚举发生在授权之后（见 refreshAudioInputs / syncAudioInputOptions）。
let selectedAudioInput = '';

// ---------- 调试打点（诊断页 tests/stream-debug.html 经 debug/bridge.js 接收） ----------
// bridge.js 正常先于 app.js 加载（三个入口页的 <script> 顺序都已保证），这里的
// fallback 只兜底“未来某个入口页漏配 script 标签”。绝不携带 apiKey（endpoint 也
// 只传"是否设置"的布尔）。
// schema 与 background/offscreen 对齐：{ ev, at, src, detail }。诊断页兼容旧
// 导出日志里的 phase 字段。
globalThis.emitDebug = typeof globalThis.emitDebug === 'function'
  ? globalThis.emitDebug
  : function (entry) {
    try {
      chrome.runtime.sendMessage({
        type: (globalThis.MESSAGES && globalThis.MESSAGES.DEBUG_EVT) || 'asr:debug',
        payload: entry,
        target: (globalThis.TARGETS && globalThis.TARGETS.DEBUG) || 'debug',
      });
    } catch {
      /* 上下文已销毁 —— 调试日志丢失无妨 */
    }
  };

function debugEvt(phase, detail) {
  if (typeof globalThis.emitDebug !== 'function') return;
  globalThis.emitDebug({ ev: phase, at: Date.now(), src: 'ui', detail: detail || {} });
}

// PCM 帧统计与 partial/final 打点随会话宿主一起迁到了 offscreen（offscreen-streaming.js）。

// DOM references
const els = {};

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

// ---------- Recording (microphone) ----------

// 麦克风录音跨 UI 互斥：真正的 MediaRecorder 仍在当前页面，但开始前必须先向
// background 领取租约。长连接在 popup/sidepanel 关闭时自动断开，不会留下死锁。
function acquireMicRecordingLease() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let port;
    try {
      port = globalThis.chrome.runtime.connect({
        name: globalThis.MESSAGES.MIC_RECORD_PORT,
      });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        try { port.disconnect(); } catch { /* already closed */ }
        reject(error);
      } else {
        micLeasePort = port;
        resolve();
      }
    };

    port.onMessage.addListener((message) => {
      if (settled) return;
      if (message?.ok) {
        finish();
        return;
      }
      const error = new Error(message?.error?.message || 'Another audio recording is already active.');
      error.code = message?.error?.code || globalThis.Errors.ALREADY_RECORDING.code;
      finish(error);
    });

    port.onDisconnect.addListener(() => {
      if (!settled) {
        finish(new Error('Background recording lease connection closed.'));
        return;
      }
      if (micLeasePort !== port) return;
      micLeasePort = null;
      if (isRecording || isRecordingBusy) {
        debugEvt('record-lease-lost', {});
        showStatus('Recording stopped because the background connection was lost.', 'error');
        void stopRecording();
      }
    });

    timer = setTimeout(() => {
      const error = new Error('Timed out acquiring the recording lease.');
      error.code = globalThis.Errors.TIMEOUT?.code || 'TIMEOUT';
      finish(error);
    }, 5000);

    try {
      port.postMessage({ type: globalThis.MESSAGES.MIC_RECORD_ACQUIRE });
    } catch (error) {
      finish(error);
    }
  });
}

function releaseMicRecordingLease() {
  const port = micLeasePort;
  micLeasePort = null;
  if (!port) return;
  try {
    port.postMessage({ type: globalThis.MESSAGES.MIC_RECORD_RELEASE });
  } catch { /* background already gone */ }
  try {
    port.disconnect();
  } catch { /* already closed */ }
}

async function toggleRecording() {
  if (!isRecording) {
    await startRecording();
  } else {
    await stopRecording();
  }
}

async function startRecording() {
  // 防重入：isRecording 要等 await getUserMedia 之后才置位，且按钮在这段窗口内仍可点。
  // 双击会开两条麦克风流，后到者覆盖 recorder → 第一条流无人停轨，麦克风常驻占用。
  // 与 startStreaming 同形的 busy 护栏，覆盖整个 await 窗口。
  if (isRecordingBusy || isRecording) return;
  isRecordingBusy = true;

  let stream = null;
  try {
    audioBlob = null;

    // 先领租约，再打开麦克风：否则两个 UI 可以同时通过本地检查。
    await acquireMicRecordingLease();
    // 按 #audioInput 选择打开麦克风；授权成功后设备名才可见 → 刷新下拉框
    stream = await acquireMicrophone();
    void refreshAudioInputs();
    debugEvt('mic-open', { deviceId: selectedAudioInput || 'default' });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();
    if (!micLeasePort) throw new Error('Recording ownership was lost before capture started.');
    const requestedMime = els.audioTypeSelect.value;
    const actualMime = recorder.actualMimeType();
    const formatChanged = !!requestedMime && !!actualMime
      && !AudioRecorder.sameMimeType(requestedMime, actualMime);
    if (formatChanged) {
      debugEvt('audio-format-fallback', { requested: requestedMime, actual: actualMime });
      showStatus(
        `This browser cannot record ${AudioRecorder.baseMimeType(requestedMime)}; `
        + `using ${AudioRecorder.baseMimeType(actualMime)}.`,
        'error',
      );
    }

    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    disableOtherRecordButtons(els.recordBtn);
    if (!formatChanged) {
      showStatus('Recording... speak now.', 'success');
    }
    debugEvt('record-started', { requestedMime, mimeType: actualMime });
  } catch (error) {
    debugEvt('record-error', { where: 'start', message: error?.message || String(error) });
    showStatus(`Cannot start recording: ${error.message}`, 'error');
    // 两条清理线都要走：recorder 持有 stream 时由 release 停轨；
    // 构造 recorder 就失败时只有裸 stream，需直接停轨（否则麦克风占用红点常驻）
    recorder?.release();
    recorder = null;
    stream?.getTracks().forEach((t) => t.stop());
    releaseMicRecordingLease();
    isRecording = false;
    els.recordBtn.textContent = 'Start Recording';
  } finally {
    isRecordingBusy = false;
    enableAllRecordButtons();
  }
}

async function stopRecording() {
  // 防重入：stop 期间 recorder 尚未置空（onstop 是异步的），第二次点击会重复
  // recorder.stop() → MediaRecorder 抛 InvalidStateError，且 catch 里 recorder
  // 可能已被首轮置空而触发 null.release() 崩溃。busy 护栏关掉整个 await 窗口。
  if (isRecordingBusy || !recorder) return;
  isRecordingBusy = true;

  els.recordBtn.textContent = 'Start Recording';
  isRecording = false;
  try {
    audioBlob = await recorder.stop();
    recorder.release();
    recorder = null;
    debugEvt('record-stopped', { size: audioBlob ? audioBlob.size : 0, mime: audioBlob ? audioBlob.type : '' });
    showStatus('Recording complete.', 'success');
  } catch (error) {
    debugEvt('record-error', { where: 'stop', message: error?.message || String(error) });
    // 超时/异常时已录分片是用户唯一能救回的数据：release({keepChunks}) 停轨但
    // 保留 chunks，getBlob() 仍可拼出部分音频供 Save。
    const partial = recorder.getBlob();
    recorder.release({ keepChunks: true });
    recorder = null;
    if (partial && partial.size > 0) {
      audioBlob = partial;
      showStatus(`Recording failed: ${error.message} — partial audio kept, use Save audio.`, 'error');
    } else {
      showStatus(`Recording failed: ${error.message}`, 'error');
    }
  } finally {
    if (!isRecording) releaseMicRecordingLease();
    isRecordingBusy = false;
    enableAllRecordButtons();
  }
}

// 装载时与 background 对账标签页录音状态。popup 只是 UI 壳：关掉即丢内存变量，
// 而录音仍在 offscreen 里跑。不对账的后果是按钮复位成"可点"，再点只会拿到
// ALREADY_RECORDING，用户再也停不掉这段录音（详见 background 的 TAB_RECORDING_KEY）。
async function syncTabRecordingState() {
  let recording = false;
  try {
    const data = await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_STATE, {});
    recording = !!data?.recording;
  } catch {
    // 查询失败（SW 刚被回收等）：按"空闲"处理（见下），返回值告诉调用方未对齐成功。
    return false;
  }

  // 以 background 为准**双向**对齐：录着就切成 Stop，没录就复位。
  // 只往一个方向改是不够的 —— 失败路径（如"另一路正在录"）恰恰要覆盖掉
  // 乐观置上的 busy 态，把用户引到唯一能停止录音的那个按钮上。
  isTabRecording = recording;
  if (recording) {
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    disableOtherRecordButtons(els.tabRecordBtn);
    showStatus('Recording tab audio... play something in the tab.', 'success');
    debugEvt('tab-record-restored', {});
  } else {
    els.tabRecordBtn.textContent = 'Record Tab';
    enableAllRecordButtons();
  }
  return true;
}

// ---------- Recording (tab audio, via offscreen) ----------

async function toggleTabRecording() {
  if (!isTabRecording) {
    await startTabRecording();
  } else {
    await stopTabRecording();
  }
}

async function startTabRecording() {
  // 防重入：isTabRecording 要等 await MessageClient.send 之后才置位。双击时第二次请求
  // 会命中 background 的 ALREADY_RECORDING 早退并走 catch → enableAllRecordButtons()，
  // 把"正在录音"的互斥状态清掉：按钮显示 Stop Tab Rec 却三路全可点，破坏互斥不变式。
  if (isTabRecordingBusy || isTabRecording) return;
  isTabRecordingBusy = true;

  try {
    audioBlob = null;

    // background 取 tabCapture streamId → 创建 offscreen → offscreen 开始录
    await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_START, {});

    isTabRecording = true;
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    disableOtherRecordButtons(els.tabRecordBtn);
    showStatus('Recording tab audio... play something in the tab.', 'success');
    debugEvt('tab-record-started', {});
  } catch (error) {
    debugEvt('tab-record-error', { where: 'start', message: error?.message || String(error) });
    // 失败时先按真实状态对账，再决定怎么报。这里**不按错误码分支**：同一个"另一路
    // 正在录"会因失败点不同而报不同码（start 早退是 ALREADY_RECORDING，而
    // tabCapture 先失败时是 TAB_CAPTURE "Cannot capture a tab with an active stream"），
    // 枚举码必然漏。对账成功且确实在录 → 不报错，按钮已指向可停止的 Stop。
    if (await syncTabRecordingState()) {
      if (!isTabRecording) showStatus(`Tab record failed: ${error.message}`, 'error');
    } else {
      showStatus(`Tab record failed: ${error.message}`, 'error');
    }
  } finally {
    isTabRecordingBusy = false;
    enableAllRecordButtons();
  }
}

async function stopTabRecording() {
  if (isTabRecordingBusy || !isTabRecording) return;
  isTabRecordingBusy = true;

  isTabRecording = false;
  els.tabRecordBtn.textContent = 'Record Tab';
  try {
    // offscreen 返回 { b64, mime }（JSON 消息通道无法传 Blob），这里还原。
    // 超时放宽到 20s：链路 = background relay + offscreen recorder.stop()（内部
    // 已有 5s 兜底）+ 大 blob 的 base64 编码，默认 10s 对长录音偏紧。
    audioBlob = globalThis.decodeAudio(
      await globalThis.MessageClient.send(
        globalThis.MESSAGES.TAB_RECORD_STOP,
        {},
        globalThis.TARGETS.BACKGROUND,
        20000,
      ),
    );
    debugEvt('tab-record-stopped', { size: audioBlob ? audioBlob.size : 0, mime: audioBlob ? audioBlob.type : '' });
    showStatus('Tab recording complete.', 'success');
  } catch (error) {
    debugEvt('tab-record-error', { where: 'stop', message: error?.message || String(error) });
    // offscreen 失败响应可携带部分已录音频（recorder 超时路径）；对账说已不在录时
    // 才能确定录音确实停了，此时恢复部分音频供 Save，避免用户几分钟音频全丢。
    const partialEnc = error.partialData;
    if (partialEnc?.b64 && (await syncTabRecordingState()) && !isTabRecording) {
      const partialBlob = globalThis.decodeAudio(partialEnc);
      if (!partialBlob) return; // 形状不合法：走下面的常规失败处理
      audioBlob = partialBlob;
      debugEvt('tab-record-partial', { size: audioBlob.size, mime: audioBlob.type });
      showStatus(`Tab record stop failed: ${error.message} — partial audio kept, use Save audio.`, 'error');
    }
    // 停止失败（超时/offscreen 失联）时录音**可能还在跑** —— 乐观复位成空闲会再次
    // 制造"停不掉的录音"。与 start 同样处理：以 background 为准重新对齐。
    if (await syncTabRecordingState()) {
      if (!isTabRecording) showStatus(`Tab record stop failed: ${error.message}`, 'error');
    } else {
      showStatus(`Tab record stop failed: ${error.message}`, 'error');
    }
  } finally {
    isTabRecordingBusy = false;
    enableAllRecordButtons();
  }
}

// ---------- Save recording ----------

// 麦克风与 Tab 录音的结果都落到 audioBlob（批量转录已删，先落盘）
// （createObjectURL + a[download]，无需 downloads 权限）。
function handleSaveAudio() {
  if (!audioBlob || !audioBlob.size) {
    showStatus('No recording yet. Record something first.', 'error');
    return;
  }
  const url = URL.createObjectURL(audioBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${globalThis.Format.timestampForFile()}.${extensionForMime(audioBlob.type)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // 下载触发后再回收
  debugEvt('audio-saved', { size: audioBlob.size, mime: audioBlob.type });
  showStatus(`Saved recording (${Math.max(1, Math.round(audioBlob.size / 1024))} KB).`, 'success');
}

function extensionForMime(mime) {
  const type = (mime || '').split(';')[0].trim();
  if (type === 'audio/webm') return 'webm';
  if (type === 'audio/mp4') return 'm4a';
  if (type === 'audio/wav') return 'wav';
  return 'webm';
}
debugEvt('app-loaded', { hasBridge: typeof globalThis.emitDebug === 'function' });

// ---------- Streaming transcription (realtime WebSocket) ----------
//
// 原理：麦克风 → PCM 帧（AudioWorklet，createPcmCapture）→ 重采样到目标采样率 →
// Int16 → WebSocket（百炼 run-task）→ 服务端逐句返回 partial/final → 字幕式回显。
// 目标采样率随模型走（provider.sampleRateFor：16kHz，8k 电话模型为 8kHz），且必须
// 与 run-task 里声明的 sample_rate 一致，否则服务端按错误速率解析音频。
// 服务端负责分段，本地不做 VAD（VAD 分段批量已随伪流式删除）。

async function toggleStreaming() {
  if (!isStreaming) {
    await startStreaming();
  } else {
    await stopStreaming();
  }
}

async function startStreaming() {
  // busy 覆盖消息往返窗口（background 端 start 要建文档 + 等 task-started）。
  if (isStreamingBusy || isStreaming) {
    debugEvt('start-blocked', { isStreamingBusy, isStreaming });
    return;
  }
  isStreamingBusy = true;

  const provider = getCurrentProvider();
  if (!provider) {
    debugEvt('start-fail', { reason: 'no-provider' });
    showStatus('No provider selected.', 'error');
    isStreamingBusy = false;
    return;
  }
  if (!provider.supportsStreaming) {
    debugEvt('start-fail', { reason: 'no-streaming-support', provider: provider.id });
    showStatus('Provider does not support streaming.', 'error');
    isStreamingBusy = false;
    return;
  }
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey) {
    debugEvt('start-fail', { reason: 'no-api-key' });
    showStatus('API key required for streaming.', 'error');
    isStreamingBusy = false;
    return;
  }

  // Custom 地域必须手填 endpoint：发消息前在 UI 拦下（只有本页知道 region 下拉意图）。
  // 留空会把 Custom 静默变成北京，跨地域 Key 必然握手 401。
  const endpoint = resolveEndpoint(provider);
  if (els.regionSelect?.value === 'custom' && !endpoint) {
    debugEvt('start-fail', { reason: 'no-endpoint', region: 'custom' });
    showStatus('Custom region requires an endpoint URL.', 'error');
    isStreamingBusy = false;
    return;
  }

  // 尽早禁用，把重入窗口压到最小
  els.streamBtn.disabled = true;
  debugEvt('start-begin', { provider: provider.id });

  // 字幕绑定"点击 Live Stream 时"的活动 tab：权限弹窗期间用户可能切 tab，
  // 开麦后再查会把字幕绑到错误的页面。查询失败不阻塞主流程。
  let targetTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    targetTabId = tab?.id ?? null;
  } catch {
    targetTabId = null;
  }

  els.resultText.value = '';
  syncResultButtons(); // 清空后同步禁用 Copy/Fill

  try {
    // 会话宿主在 offscreen：模型回落 / AudioContext / PCM / WebSocket 都在那边发生，
    // 这里只发消息并镜像状态。超时 25s：ready(10s) + getUserMedia + 采集启动 + 余量。
    await globalThis.MessageClient.send(
      globalThis.MESSAGES.STREAM_START,
      {
        providerId: provider.id,
        apiKey,
        model: resolveModel() || provider.defaultStreamModel,
        endpoint: endpoint || '',
        subtitles: subtitlesEnabled,
        targetTabId,
        audioInput: selectedAudioInput,
      },
      globalThis.TARGETS.BACKGROUND,
      25000,
    );
    isStreaming = true;
    els.streamBtn.textContent = 'Stop Stream';
    disableOtherRecordButtons(els.streamBtn);
    // 成功提示由 offscreen 的 STREAM_UPDATE(active) 补发（麦克风回退时替换为错误提示）
  } catch (error) {
    debugEvt('start-error', { message: error?.message || String(error) });
    showStatus('Cannot start streaming: ' + error.message, 'error');
  } finally {
    isStreamingBusy = false;
    if (!isStreaming) enableAllRecordButtons();
    if (!isStreaming) els.streamBtn.disabled = false;
  }
}

async function stopStreaming() {
  // 防重入：stop 消息往返期间 offscreen 的终止广播可能同时到达（服务端恰好也结束）。
  if (isStreamingBusy) {
    debugEvt('stop-blocked', {});
    return;
  }
  isStreamingBusy = true;
  isStreaming = false;
  els.streamBtn.disabled = true;
  debugEvt('stop-begin', {});
  try {
    // 收尾（finish-task、最终文本、历史、字幕 done）都在 offscreen 完成后由
    // STREAM_UPDATE 广播把最终文本回填本页。
    await globalThis.MessageClient.send(
      globalThis.MESSAGES.STREAM_STOP,
      {},
      globalThis.TARGETS.BACKGROUND,
      20000,
    );
    showStatus('Streaming stopped.', 'success');
  } catch (error) {
    // offscreen 停止失败时会话可能仍在跑：以 background 为准重新对账（同 tab 录音模式）
    debugEvt('stop-error', { message: error?.message || String(error) });
    await syncStreamingState();
  } finally {
    els.streamBtn.textContent = isStreaming ? 'Stop Stream' : 'Live Stream';
    if (!isStreaming) enableAllRecordButtons();
    isStreamingBusy = false;
  }
}

// 装载/停止失败后与 background 对账流式状态（同 syncTabRecordingState 模式）：
// background 查 storage.session 标记 + offscreen 文档存在性；活跃时再向 offscreen
// 拿会话详情（当前文本）回填结果区。
async function syncStreamingState() {
  try {
    const data = await globalThis.MessageClient.send(globalThis.MESSAGES.STREAM_STATE, {});
    applyStreamingState(!!data?.streaming);
    if (data?.streaming) {
      // background 只知道"活着"；会话详情（当前文本）要直接问 offscreen
      const detail = await globalThis.MessageClient.send(
        globalThis.MESSAGES.STREAM_STATE,
        {},
        globalThis.TARGETS.OFFSCREEN,
        8000,
      );
      if (detail?.streaming && typeof detail.text === 'string') {
        els.resultText.value = detail.text;
        syncResultButtons();
      }
    }
    return true;
  } catch {
    return false; // 查询失败（SW 刚回收等）：保持本地镜像，返回未对齐
  }
}

// 按 background 真相刷新三路互斥按钮（streamBtn 文案 + 其它两路禁用）
function applyStreamingState(streaming) {
  isStreaming = streaming;
  if (streaming) {
    els.streamBtn.textContent = 'Stop Stream';
    disableOtherRecordButtons(els.streamBtn);
  } else {
    els.streamBtn.textContent = 'Live Stream';
    enableAllRecordButtons();
  }
}

// offscreen → 本页的单向广播（target:'ui'）：文本更新 / 状态提示 / 终止。
// popup 关闭期间发出的广播自然丢失（无人监听），会话不受影响 —— 重开时按
// STREAM_STATE 对账补齐。background/offscreen/content 的 target 过滤都会忽略它。
globalThis.chrome?.runtime?.onMessage?.addListener((request) => {
  if (request?.target !== globalThis.TARGETS.UI || request?.type !== globalThis.MESSAGES.STREAM_UPDATE) return false;
  // 字段约定（与 offscreen-streaming.js 的 broadcastUpdate 对齐）：
  //   status → { text, type }；error-status → { message }；ended → {}
  // 此前这里读 message（offscreen 从不发送该字段），成功提示与麦克风回退
  // 警告全部被静默丢弃（#60）。
  const { kind, text, type, message } = request.payload || {};
  const statusText = typeof text === 'string' ? text : '';
  if ((kind === 'text' || kind === 'final-text') && typeof text === 'string') {
    els.resultText.value = text;
    syncResultButtons();
  } else if (kind === 'status' && statusText) {
    showStatus(statusText, type === 'error' ? 'error' : 'success');
  } else if (kind === 'active') {
    // 启动成功（offscreen 在 task-started + 采集就绪后广播）。STREAM_START 的响应
    // 也能置位 isStreaming，但那时 offscreen 的状态广播可能已先到达（popup 关闭
    // 期间重开对账等场景）——这里只做幂等复位与按钮文案兜底。
    if (!isStreaming) applyStreamingState(true);
  } else if (kind === 'error-status' && message) {
    showStatus(message, 'error');
    if (isStreaming) applyStreamingState(false); // 远端终止：会话已收尾，UI 复位
  } else if (kind === 'ended') {
    debugEvt('stream-ended-broadcast', {});
    applyStreamingState(false);
  }
  return false;
});

// 字幕镜像现由 offscreen 会话驱动（partial/final/done 全在会话侧）；本页开关
// 只负责持久化偏好 + 会话中途热切换（STREAM_SET_SUBTITLES）。会话不活跃时
// 无需通知（下次 start 会带上开关值）。
async function toggleSubtitles() {
  subtitlesEnabled = !subtitlesEnabled;
  els.subtitleBtn.textContent = subtitlesEnabled ? 'Subtitles on' : 'Subtitles';
  els.subtitleBtn.classList.toggle('active', subtitlesEnabled);
  await persistConfig(); // 配置写失败会自行显示状态，浮层仍按用户点击立即切换
  if (isStreaming) {
    try {
      await globalThis.MessageClient.send(
        globalThis.MESSAGES.STREAM_SET_SUBTITLES,
        { subtitles: subtitlesEnabled },
        globalThis.TARGETS.OFFSCREEN,
        5000,
      );
    } catch {
      /* 会话侧很快也会通过对账拿到正确值；失败不阻塞开关 */
    }
  }
}

// ---------- Navigation (optional buttons) ----------

function handleOpenOptions() {
  chrome.runtime.openOptionsPage();
}

// chrome.sidePanel.open 需要用户手势；popup 内点击即满足。手势只在这个同步
// 调用栈里有效 —— 前面不能 await（包括 chrome.tabs.query）。让 Chrome 自己
// 解析 WINDOW_ID_CURRENT，和 background 的快捷键处理保持一致。
async function handleOpenPanel() {
  try {
    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    window.close(); // 侧栏已打开，收起 popup
  } catch (error) {
    showStatus(`Cannot open side panel: ${error.message}`, 'error');
  }
}

// ---------- Fill into page ----------

async function handleFillIntoPage() {
  const text = els.resultText.value.trim();
  if (!text) {
    showStatus('Nothing to fill.', 'error');
    return;
  }
  try {
    await globalThis.MessageClient.send(globalThis.MESSAGES.FILL_TEXT, { text });
    debugEvt('fill-ok', { len: text.length });
    showStatus('Filled into page input.', 'success');
  } catch (error) {
    debugEvt('fill-error', { code: error?.code || '', message: error?.message || String(error) });
    // 超时是"结果未知"而非"确定失败"：填充是不可取消的副作用，慢页面上它可能
    // 已经落地。直接说 failed 会诱导用户重试 → 文本插入两遍，所以分开措辞。
    if (error?.code === globalThis.Errors.TIMEOUT.code) {
      showStatus('Fill timed out — check the page before retrying (it may already be filled).', 'error');
      return;
    }
    showStatus(`Fill failed: ${error.message}`, 'error');
  }
}

// ---------- Copy ----------

async function handleCopy() {
  const text = els.resultText.value.trim();
  if (!text) {
    showStatus('Nothing to copy.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    debugEvt('copy-ok', { len: text.length });
    showStatus('Copied to clipboard.', 'success');
  } catch (error) {
    debugEvt('copy-error', { message: error?.message || String(error) });
    showStatus(`Copy failed: ${error.message}`, 'error');
  }
}

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
  }
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

// ---------- Helpers ----------

function showStatus(message, type) {
  els.statusDiv.textContent = message;
  els.statusDiv.className = type;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    els.statusDiv.className = '';
  }, 3500);
}
