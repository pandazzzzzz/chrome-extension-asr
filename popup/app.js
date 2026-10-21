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
let isStreaming = false;      // 真流式转录中（麦克风 PCM → WebSocket）
let isStreamingBusy = false;  // start/stop 进行中（含异步 setup/teardown），防重入
let closingPage = false;      // pagehide 收尾已接管，避免与 stopStreaming 重复写历史

// 流式会话（Live Stream 模式）
const streamSession = {
  context: null,
  capture: null,
  stream: null,
  wsSession: null,   // 真 WebSocket 流式会话（supportsStreaming provider）
  finalText: '',     // 已定稿的完整句文本
  partialText: '',   // 当前进行中的句子
  providerId: '',
  model: '',
  endpoint: '',
  apiKey: '',
  // 本次会话的 PCM 目标采样率（Hz），来自 provider.sampleRateFor(最终模型)。
  // run-task 向服务端声明的就是这个值，故 onStreamFrame 必须重采样到同一个速率，
  // 否则声明与实际不符。onStreamFrame 拿不到 provider，只能经 streamSession 传递。
  targetSampleRate: 0,
  sessionId: 0,      // 每次 startStreaming 自增，用于跨会话 onEnd 竞态防护
  targetTabId: null, // 本次字幕绑定的 tab（点击 Live Stream 时捕获，切 tab 后不跟随）
  everStarted: false, // 本次启动是否真正走到采集开始（区分启动中与停止中）
  finalSaved: false, // 最终文本已交给 background（pagehide 与正常 stop 只能写一次）
};
let streamSessionSeq = 0; // streamSession.sessionId 的自增源

const STREAM = {
  // PCM 帧长（采样数）。16kHz 下每帧累积 16ms —— 这是**首字延迟里唯一由插件
  // 决定的固定项**：采集必须攒满一帧才会 sendAudio，服务端也要等音频才出结果。
  // 实测（stub WS，本地 RTT≈0，6s 会话；「点击 → 首帧送达」含固定启动 ~50ms）：
  //   frameSize=1024 (64ms): 累积 64ms · 合计 123ms · 92 帧 · 间隔 p50 60ms max 71ms
  //   frameSize= 512 (32ms): 累积 36ms · 合计  ~95ms · 186 帧 · 间隔 p50 30ms max 41ms
  //   frameSize= 256 (16ms): 累积 31ms · 合计  82ms · 372 帧 · 间隔 p50 19ms max 21ms
  // 三档字节总量一致（~190KB/6s），且 256 的节奏反而**更稳**（max 71 → 21ms）。
  // 取 256：端到端 −41ms、抖动 −70%。代价（消息数 ×4）已实测：6s 内主线程任务时间
  // 只从 0.2ms 涨到 0.3ms（`temp/perf/cpu.js`）。再往下（128）收益已不明显而消息数
  // 再翻倍，故不取。
  //
  // ⚠️ 本值是**采样数**，所以上面「16ms」只在 16kHz 下成立。采样率现随模型走
  // （provider.sampleRateFor），8k 电话模型下每帧累积 32ms —— 仍在电话语音的常规
  // 帧长范围（20–40ms），且基准数据只对 256 有效，故**不**为 8k 单独调优（改成
  // `Math.round(rate * 0.016)` 可让各速率都维持 ~16ms，但消息数翻倍且无基准背书）。
  frameSize: 256,
};

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
// bridge.js 未加载时静默跳过；绝不携带 apiKey（endpoint 也只传"是否设置"的布尔）。
function debugEvt(phase, detail) {
  if (typeof globalThis.emitDebug !== 'function') return;
  globalThis.emitDebug({ phase, at: Date.now(), detail: detail || {} });
}

// PCM 帧统计：每帧一条日志会把诊断页刷爆，这里 1s 聚合一次
const pcmStats = { frames: 0, bytes: 0, srcRate: 0, wsRate: 0 };
let pcmTimer = null;

function flushPcmStats() {
  if (!pcmStats.frames) return;
  debugEvt('pcm-stats', { ...pcmStats });
  pcmStats.frames = 0;
  pcmStats.bytes = 0;
}
function startPcmStats(srcRate, wsRate) {
  pcmStats.srcRate = srcRate;
  pcmStats.wsRate = wsRate;
  pcmTimer = setInterval(flushPcmStats, 1000);
}
function stopPcmStats() {
  clearInterval(pcmTimer);
  pcmTimer = null;
  flushPcmStats();
}

// partial 中间结果高频刷新：节流到 ~4 条/秒，final（sentenceEnd）立即记
let lastPartialLogAt = 0;
function logStreamResult(text, sentenceEnd, sentenceId) {
  if (sentenceEnd) {
    debugEvt('final', { sentenceId, len: text.length });
    return;
  }
  const now = Date.now();
  if (now - lastPartialLogAt < 400) return;
  lastPartialLogAt = now;
  debugEvt('partial', { sentenceId, len: text.length });
}

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

    bindEvents();
    void refreshAudioInputs(); // 先填"已授权/未授权"的设备列表；授权后由录音/流式路径再刷新
    void syncTabRecordingState(); // 录音活在 offscreen 里，popup 重开必须与真实状态对齐
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
    const regions = provider.regions || [];
    const prev = els.regionSelect.value;
    els.regionSelect.innerHTML = '';
    for (const r of regions) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.label;
      els.regionSelect.appendChild(opt);
    }
    const known = regions.some((r) => r.id === prev);
    els.regionSelect.value = known ? prev : (regions[0]?.id || 'custom');
    // 非 custom 时 endpoint 由 region 决定，文本框隐藏；custom 才显示给用户手填
    setEndpointRowVisible(!provider.hasEndpoint || els.regionSelect.value === 'custom');
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
  const options = provider?.modelOptions || [];
  // 没有预置选项也保留一个 Custom 项，让下拉不至于空白（值走文本框）
  const list = options.length ? options : [{ model: '', label: 'Custom…' }];
  const prev = els.modelInput.value;
  els.modelInput.innerHTML = '';
  for (const o of list) {
    const opt = document.createElement('option');
    opt.value = o.model;
    opt.textContent = o.label || o.model || 'Custom…';
    els.modelInput.appendChild(opt);
  }
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
  els.streamBtn.addEventListener('click', toggleStreaming);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
  // 这三个按钮只在部分入口页存在（popup: options+panel+subtitles；sidepanel: options+subtitles）
  els.optionsBtn?.addEventListener('click', handleOpenOptions);
  els.panelBtn?.addEventListener('click', handleOpenPanel);
  els.subtitleBtn?.addEventListener('click', toggleSubtitles);
}

// popup 可能在流式过程中被关闭（点页面、切窗口、Esc）。DOM 卸载时 WebSocket /
// AudioContext / 麦克风会随页面销毁，但 IndexedDB 写入与字幕收尾必须在此之前
// 交给常驻上下文：background 写历史，字幕消息带 done=true。这里不 await（pagehide
// 不保证等待异步工作），消息一旦发出由 background 继续完成。
globalThis.addEventListener('pagehide', () => {
  // stopStreaming 会在等待 finish-task 前先把 isStreaming 置 false；若这时关闭
  // popup，只检查 isStreaming 会丢掉最后的 partial。但启动阶段同样 busy，此时
  // 结果区可能还是上一轮文本，不能收尾（否则会重复写历史）。
  const shouldFinalize = globalThis.StreamLifecycle.shouldFinalizeOnPageHide({
    streaming: isStreaming,
    busy: isStreamingBusy,
    everStarted: streamSession.everStarted,
    closing: closingPage,
  });
  if (!shouldFinalize) return;
  closingPage = true;
  void finalizeStreamingText(false, 'pagehide');
});

// 三路录音互斥：开启任一路时禁用其它两路按钮（active 路保留自身）
function disableOtherRecordButtons(active) {
  els.recordBtn.disabled = els.recordBtn !== active;
  els.tabRecordBtn.disabled = els.tabRecordBtn !== active;
  els.streamBtn.disabled = els.streamBtn !== active;
}

// 停止后恢复三路按钮
function enableAllRecordButtons() {
  els.recordBtn.disabled = false;
  els.tabRecordBtn.disabled = false;
  els.streamBtn.disabled = false;
}

// ---------- Recording (microphone) ----------

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

    // 按 #audioInput 选择打开麦克风；授权成功后设备名才可见 → 刷新下拉框
    stream = await acquireMicrophone();
    void refreshAudioInputs();
    debugEvt('mic-open', { deviceId: selectedAudioInput || 'default' });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();
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
    isRecording = false;
    els.recordBtn.textContent = 'Start Recording';
    enableAllRecordButtons();
  } finally {
    isRecordingBusy = false;
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
    showStatus(`Recording failed: ${error.message}`, 'error');
    // 失败路径同样要停轨 + 释放，否则音轨常驻、下次 start 又 new 一个实例
    recorder.release();
    recorder = null;
  } finally {
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
      enableAllRecordButtons();
    }
  } finally {
    isTabRecordingBusy = false;
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
    enableAllRecordButtons();
  } catch (error) {
    debugEvt('tab-record-error', { where: 'stop', message: error?.message || String(error) });
    // 停止失败（超时/offscreen 失联）时录音**可能还在跑** —— 乐观复位成空闲会再次
    // 制造"停不掉的录音"。与 start 同样处理：以 background 为准重新对齐。
    if (await syncTabRecordingState()) {
      if (!isTabRecording) showStatus(`Tab record stop failed: ${error.message}`, 'error');
    } else {
      showStatus(`Tab record stop failed: ${error.message}`, 'error');
      enableAllRecordButtons();
    }
  } finally {
    isTabRecordingBusy = false;
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
  // 防重入：setup 期间（getUserMedia + await ready + capture.start）按钮尚未禁用，
  // 双击会开两条流两个 WebSocket 抢共享 streamSession。
  if (isStreamingBusy || isStreaming) {
    debugEvt('start-blocked', { isStreamingBusy, isStreaming });
    return;
  }
  isStreamingBusy = true;
  closingPage = false;
  streamSession.everStarted = false;

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

  // Custom 地域必须手填 endpoint：留空时 resolveEndpoint 返回 ''，而 provider 会把
  // 空串当成"未指定"回落到公共北京端点 —— 用户明明选了 Custom 却被静默拨到别的地域
  // （地域与 API Key 强绑定，必然握手 401，且报错信息完全指不到这里）。故在**开麦之前**
  // 拦下：早退路径不能留下音轨（见 docs/manual-verification.md 的历史 bug #4）。
  // 只算一次，下面直接复用，避免守卫与实际连接读到不同的值。
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

  // 字幕绑定"点击 Live Stream 时"的活动 tab。必须在开麦前取：权限弹窗期间
  // 用户可能切 tab，开麦后再查会把字幕绑到错误的页面。查询失败不阻塞主流程。
  streamSession.targetTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    streamSession.targetTabId = tab?.id ?? null;
  } catch {
    streamSession.targetTabId = null;
  }

  try {
    const stream = await acquireMicrophone();
    debugEvt('mic-acquired', {
      tracks: stream.getAudioTracks().length,
      deviceId: selectedAudioInput || 'default',
    });
    void refreshAudioInputs(); // 授权后设备名才可见

    // 跨会话竞态防护：streamSession 是原地复用的单例，旧会话的延迟 onclose/onEnd
    // 可能在新会话启动期间触发。每次 startStreaming 自增 sessionId，onEnd 闭包持有
    // 本次 mySessionId，若 streamSession.sessionId 已被新会话覆盖则判定为残留并忽略。
    const mySessionId = ++streamSessionSeq;

    streamSession.stream = stream;
    // context 与 targetSampleRate 必须显式重置：AudioContext 要等模型定下来才能建
    // （采样率随模型走），在此之前 onStreamFrame 的 !session.context 守卫必须看到
    // null，而不是上一会话的残值。
    streamSession.context = null;
    streamSession.targetSampleRate = 0;
    streamSession.providerId = provider.id;
    streamSession.apiKey = apiKey;
    streamSession.finalText = '';
    streamSession.partialText = '';
    streamSession.model = resolveModel() || provider.defaultStreamModel;
    // endpoint 由地域决定（custom 才取手填值）；已在上面的守卫里算过一次，直接复用。
    // Custom 留空已被拦下，故这里的 '' 只可能来自无 #region 的入口页 —— 那种情况
    // 交给 provider 的默认端点兜底（undefined 才回落，'' 会被 provider 判为错误）。
    streamSession.endpoint = endpoint || undefined;
    streamSession.sessionId = mySessionId; // 置于 createStreamSession 之前：onEnd 在其后才可能触发
    streamSession.endedEarly = false; // 启动期 onEnd 竞态防护（见 createStreamSession 处注释）
    streamSession.finalSaved = false;
    // 非 run-task 模型（批量模型、或走 /api-ws/v1/realtime 的会话制模型）不能用于本链路 ——
    // 回落 provider 默认流式模型。仅在确有默认值时回落，否则交给 createStreamSession 抛错。
    // requestedModel 要在改写前留住：回落后的提示要说"你填的 X 不行，改用 Y"。
    const requestedModel = streamSession.model;
    if (!provider.isStreamModel(streamSession.model)) {
      debugEvt('model-fallback', { requested: streamSession.model, using: provider.defaultStreamModel });
      if (provider.defaultStreamModel) {
        streamSession.model = provider.defaultStreamModel;
        showStatus(
          `Using ${streamSession.model} — "${requestedModel}" is not a run-task model.`,
          'success',
        );
      }
    }

    // 采样率随模型走（8k 电话模型只接受 8000 Hz）。必须在模型回落**之后**取值，
    // 否则回落到默认模型后仍按用户填的 8k 模型建 8kHz 图，声明与实际不符。
    // provider 内部用同一个 sampleRateFor(最终模型串) 填 run-task 的 sample_rate，
    // 两侧同入同出，构造上不会漂移。
    const targetSampleRate = provider.sampleRateFor(streamSession.model);
    streamSession.targetSampleRate = targetSampleRate;

    // 直接把 AudioContext 建在目标采样率（官方 demo 同法），浏览器在源节点处做原生
    // 重采样 —— 避免逐帧软件重采样的相位不连续与时序漂移。旧浏览器不支持 sampleRate
    // 选项时回退默认采样率，onStreamFrame 里再软件重采样到 targetSampleRate。
    let context;
    try {
      context = new AudioContext({ sampleRate: targetSampleRate });
    } catch {
      context = new AudioContext();
    }
    // 先挂上再 resume：resume 抛错时 teardownStreaming 才拿得到这个 context 并关掉它。
    // 反过来的顺序会让 context 只存在于局部变量里 → AudioContext 泄漏。
    streamSession.context = context;
    await context.resume(); // 用户手势内解锁

    // 先建会话：必须等 task-started（await ready）才开始采音，
    // 否则 task-started 之前的音频帧被 sendAudio 丢弃 → 丢开头首句
    debugEvt('ws-connecting', {
      model: streamSession.model,
      endpointConfigured: !!streamSession.endpoint,
      ctxSampleRate: context.sampleRate,
      targetSampleRate,
    });
    const wsSession = provider.createStreamSession({
      apiKey: streamSession.apiKey,
      model: streamSession.model,
      endpoint: streamSession.endpoint,
      // 跨会话竞态防护与 onEnd 同理：旧会话的延迟回调（理论上 socket.close 后不会再
      // 触发，但保持对称）不应再写新会话的 streamSession 状态或误触 UI。
      onResult: (r) => {
        if (streamSession.sessionId !== mySessionId) return;
        onStreamResult(r);
      },
      onError: (e) => {
        if (streamSession.sessionId !== mySessionId) return;
        debugEvt('ws-error', { message: e?.message || String(e) });
        showStatus(`Stream error: ${e.message}`, 'error');
      },
      onComplete: () => {
        if (streamSession.sessionId !== mySessionId) return;
        debugEvt('ws-complete', {});
      },
      // 服务端/网络主动终止（task-finished / task-failed / onclose）：统一走 stopStreaming
      // 的 teardown + 历史落盘，避免 UI 卡死 streaming 态。stopStreaming 内部有重入护栏。
      //
      // 竞态防护：连接可能在 await wsSession.ready 期间（isStreaming 仍为 false）就结束。
      // 此时 stopStreaming() 会被跳过（护栏只看 isStreaming），启动流程会继续在死连接上开采集。
      // 所以 onEnd 提前触发时记 endedEarly 标记，startStreaming 在 ready 之后检查并中止启动。
      onEnd: () => {
        debugEvt('ws-end-received', {});
        // 跨会话竞态防护：sessionId 已被新会话覆盖 → 本回调是旧会话的延迟 onclose 残留，
        // 不应再写 endedEarly（会误杀新会话的启动检查）或触发 stopStreaming。
        if (streamSession.sessionId !== mySessionId) {
          debugEvt('ws-end-stale', {});
          return;
        }
        if (isStreaming) stopStreaming();
        else streamSession.endedEarly = true;
      },
      onEvent: (e) => debugEvt(e.ev, e),
    });
    try {
      await wsSession.ready; // 启动失败/超时会 throw，由外层 catch 兜底
    } catch (e) {
      debugEvt('ws-ready-fail', { message: e?.message || String(e) });
      wsSession.close(); // 关掉未就绪的连接，避免泄漏
      throw e;
    }
    streamSession.wsSession = wsSession;
    debugEvt('ws-ready', { model: streamSession.model });

    // 竞态早检：await wsSession.ready 期间若 onEnd 已触发（endedEarly=true），先中止，
    // 避免在已死会话上创建 PCM 采集（AudioWorklet 模块加载 + 音频图接线）。
    // 下方 capture.start() 之后的二次检查覆盖该 await 窗口本身。
    if (streamSession.endedEarly) {
      debugEvt('ws-ended-before-capture', { model: streamSession.model });
      throw new Error('Stream connection closed before recording started');
    }

    streamSession.capture = globalThis.createPcmCapture({
      stream,
      context,
      frameSize: STREAM.frameSize,
      onFrame: onStreamFrame,
    });
    await streamSession.capture.start();
    debugEvt('capture-started', {
      mode: streamSession.capture.mode?.() || 'unknown',
      frameSize: STREAM.frameSize,
      ctxSampleRate: context.sampleRate,
    });
    startPcmStats(context.sampleRate, targetSampleRate);

    // 竞态检查（必须在 isStreaming 置位前的最后一步）：从 createStreamSession 到这里的
    // 每个 await（ready / capture.start）期间 onEnd 都可能触发。它发生在 isStreaming 仍为
    // false 时只会记 endedEarly 标记，这里统一中止，避免在已结束的会话上把 UI 卡进 streaming 态。
    if (streamSession.endedEarly) {
      debugEvt('ws-ended-before-active', { model: streamSession.model });
      throw new Error('Stream connection closed before recording started');
    }

    els.resultText.value = '';
    syncResultButtons(); // 清空后同步禁用 Copy/Fill

    streamSession.everStarted = true;
    isStreaming = true;
    els.streamBtn.textContent = 'Stop Stream';
    disableOtherRecordButtons(els.streamBtn);
    showStatus('Streaming: speak, results will appear as you go.', 'success');
    debugEvt('streaming-active', { model: streamSession.model });
  } catch (error) {
    debugEvt('start-error', { message: error?.message || String(error) });
    showStatus(`Cannot start streaming: ${error.message}`, 'error');
    stopPcmStats(); // capture.start 之后若任一步抛错，清掉 1s 定时器，避免泄漏
    await teardownStreaming();
    enableAllRecordButtons();
  } finally {
    // 成功路径里 disableOtherRecordButtons 已把 streamBtn 置回 enabled；失败路径 enableAll 亦然。
    // 这里兜底复位 busy 标记（不重复动 disabled，避免覆盖 disableOther/enableAll 的互斥语义）。
    isStreamingBusy = false;
    if (!isStreaming) els.streamBtn.disabled = false;
  }
}

async function stopStreaming() {
  // 防重入：stop 期间（await stop + teardown）按钮/状态已切，但服务端 onEnd 可能与本函数
  // 同时触发（用户点 Stop 恰好服务端也结束）—— 用 busy 护栏避免 teardown 跑两遍。
  if (isStreamingBusy) {
    debugEvt('stop-blocked', {});
    return;
  }
  isStreamingBusy = true;
  isStreaming = false;
  closingPage = false;
  els.streamBtn.disabled = true;
  debugEvt('stop-begin', {});

  try {
    // 等待服务端 finish-task 确认，尾音/最后一句由 flushPartial 落定。
    // stop() 内部有 5s 超时，不会永久挂起。
    try {
      await streamSession.wsSession?.stop();
    } catch (e) {
      /* 忽略 stop 阶段错误，仍继续清理 */
      debugEvt('stop-ws-error', { message: e?.message || String(e) });
    }

    await teardownStreaming();
  } finally {
    stopPcmStats();
    els.streamBtn.textContent = 'Live Stream';
    enableAllRecordButtons();
    isStreamingBusy = false;
  }

  // 把最后的进行中句子并入定稿
  showStatus('Streaming stopped.', 'success');
  debugEvt('stream-stopped', { provider: streamSession.providerId, model: streamSession.model });

  // 流式结束：最终文本 —— 一条历史记录 + 字幕镜像（done=true 让浮层自动淡出）。
  // flushPartial(false) 避免先发一条 done=false、随后 done=true 造成消息竞态。
  await finalizeStreamingText(true);
}

// 最终文本只交付一次：正常 Stop 与 popup 关闭（pagehide）可能同时发生。
// `finalSaved` 在第一个 await 之前同步置位，二者不会各写一条历史。
async function finalizeStreamingText(awaitDelivery, trigger = 'stop') {
  if (streamSession.finalSaved) return;
  streamSession.finalSaved = true;
  flushPartial(false);
  const finalText = els.resultText?.value.trim() || '';
  const phase = trigger === 'pagehide' ? 'stream-pagehide' : 'stream-finalized';
  debugEvt(phase, { len: finalText.length, awaitDelivery });
  if (!finalText) return;

  const tabId = streamSession.targetTabId;
  const tasks = [];
  if (subtitlesEnabled) tasks.push(pushSubtitle(finalText, true, tabId));
  tasks.push(saveToHistory(finalText, streamSession.providerId, streamSession.model));
  if (awaitDelivery) await Promise.all(tasks);
  else void Promise.all(tasks);
}

async function teardownStreaming() {
  debugEvt('teardown', {
    hasCapture: !!streamSession.capture,
    hasWs: !!streamSession.wsSession,
    hasStream: !!streamSession.stream,
    hasContext: !!streamSession.context,
  });
  try {
    streamSession.capture?.stop();
  } catch {
    /* ignore */
  }
  streamSession.capture = null;

  streamSession.wsSession?.close();
  streamSession.wsSession = null;

  if (streamSession.stream) {
    streamSession.stream.getTracks().forEach((t) => t.stop());
    streamSession.stream = null;
  }
  if (streamSession.context) {
    await streamSession.context.close().catch(() => {});
    streamSession.context = null;
  }
}

// 每收到一帧 PCM：重采样到本会话的目标采样率 → 转 Int16 → 发 WebSocket（服务端负责分段）
function onStreamFrame(frame) {
  const session = streamSession;
  // targetSampleRate 是 run-task 里向服务端声明的速率，必须与实际发出的 PCM 一致
  if (!session.wsSession || !session.context || !session.targetSampleRate) return;
  const resampled = globalThis.resampleFloat32(frame, session.context.sampleRate, session.targetSampleRate);
  const int16 = globalThis.floatToInt16(resampled);
  session.wsSession.sendAudio(int16);
  pcmStats.frames += 1;
  pcmStats.bytes += int16.byteLength;
}

// 服务端逐帧返回句子：sentence_end=false 是进行中的中间结果（实时覆盖），
// sentence_end=true 表示完整句（追加进定稿文本）。
function onStreamResult({ text, sentenceEnd, sentenceId }) {
  if (sentenceEnd) {
    // 完整句：并入定稿，清空进行中
    streamSession.finalText = (streamSession.finalText + ' ' + text).trim();
    streamSession.partialText = '';
  } else {
    // 中间结果：覆盖当前进行中的句子
    streamSession.partialText = text;
  }
  logStreamResult(text, sentenceEnd, sentenceId);
  renderStreamText();
}

function renderStreamText(mirror = true) {
  const parts = [streamSession.finalText, streamSession.partialText]
    .filter(Boolean)
    .join(' ');
  els.resultText.value = parts.trim();
  syncResultButtons(); // 程序化赋值不触发 input，须显式同步按钮
  // 字幕镜像：partial/final 每次刷新都同步到起始页浮层（done=false，不自动淡出）
  if (mirror && subtitlesEnabled && parts.trim()) {
    void pushSubtitle(parts.trim(), false);
  }
}

// 停止时把未定稿的进行中句子并入定稿（服务端最后一句可能没有 sentence_end 标记）
function flushPartial(mirror = true) {
  if (streamSession.partialText) {
    streamSession.finalText = (streamSession.finalText + ' ' + streamSession.partialText).trim();
    streamSession.partialText = '';
    renderStreamText(mirror);
  }
}
// ---------- Subtitle mirror（浮动字幕） ----------

// 开关按钮回调：切换字幕开关并立即同步远端浮层（关闭时让当前活动页隐藏浮层）。
// popup 关闭（DOM 销毁）后 UI 开关随之消失，无需（也无法）再同步。
async function toggleSubtitles() {
  subtitlesEnabled = !subtitlesEnabled;
  els.subtitleBtn.textContent = subtitlesEnabled ? 'Subtitles on' : 'Subtitles';
  els.subtitleBtn.classList.toggle('active', subtitlesEnabled);
  await persistConfig(); // 配置写失败会自行显示状态，浮层仍按用户点击立即切换
  if (subtitlesEnabled && els.resultText.value.trim()) {
    // 已有结果时立即镜像到当前活动页（不沿用上一次会话的 tab）
    await pushSubtitle(els.resultText.value.trim(), true, null);
  } else if (!subtitlesEnabled) {
    await hideSubtitle(null);
  }
}

// 把文本推给字幕浮层（缺省用本次会话的起始 tab）。失败只打点 —— 字幕是旁路
// 输出（chrome:// 页、无 content script 的页面都会失败），不该打断流式主流程。
async function pushSubtitle(text, done = false, tabId = streamSession.targetTabId) {
  if (!subtitlesEnabled || !text) return;
  try {
    await globalThis.MessageClient.send(globalThis.MESSAGES.SUBTITLE_SHOW, {
      text,
      done,
      tabId,
    });
  } catch (error) {
    debugEvt('subtitle-error', { code: error?.code || '', message: error?.message || String(error) });
  }
}

async function hideSubtitle(tabId = streamSession.targetTabId) {
  try {
    await globalThis.MessageClient.send(globalThis.MESSAGES.SUBTITLE_HIDE, {
      tabId,
    });
  } catch {
    /* 浮层本就不存在（页面刷新走）时的 hide 失败无关紧要 */
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

// 写入转录历史。交给常驻的 background，而不是在 popup 里直接开 IndexedDB：
// popup 可能在历史事务完成前被关闭，导致最终文本丢失。失败不影响主流程，但必须
// 打点而不是假装成功。
async function saveToHistory(text, provider, model) {
  if (!text) return false;
  try {
    await globalThis.MessageClient.send(
      globalThis.MESSAGES.HISTORY_ADD,
      { text, provider, model },
      globalThis.TARGETS.BACKGROUND,
      15000,
    );
    debugEvt('history-saved', { len: text.length });
    return true;
  } catch (error) {
    debugEvt('history-error', { message: error?.message || String(error) });
    return false;
  }
}

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
  // 两者都空时才落到 provider 首个地域。
  const regionIds = (getCurrentProvider()?.regions || []).map((r) => r.id);
  const hasRegion = !!config.region && regionIds.includes(config.region);
  const legacyCustom = !config.region && !!config.endpoint;
  if (els.regionSelect) {
    els.regionSelect.value = hasRegion ? config.region : (legacyCustom ? 'custom' : regionIds[0] || 'custom');
    if (legacyCustom) debugEvt('legacy-endpoint-kept', { endpoint: config.endpoint });
  }
  els.endpointInput.value = config.endpoint || '';
  setEndpointRowVisible(!els.regionSelect || els.regionSelect.value === 'custom');
  // 模型下拉回填：provider 变了要重建选项，再把保存的模型映射成「预置项 / Custom+手填」。
  // 空配置 → modelSelectionFor 落到 provider.defaultStreamModel（与切 provider 的默认一致）。
  const curProvider = getCurrentProvider();
  const sel = curProvider?.modelSelectionFor
    ? curProvider.modelSelectionFor(config.model)
    : { value: '', customText: config.model || '' };
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

// ---------- Helpers ----------

function showStatus(message, type) {
  els.statusDiv.textContent = message;
  els.statusDiv.className = type;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    els.statusDiv.className = '';
  }, 3500);
}
