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
let isStreaming = false;      // 真流式转录中（麦克风 PCM → WebSocket）
let isStreamingBusy = false;  // start/stop 进行中（含异步 setup/teardown），防重入

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
  sessionId: 0,      // 每次 startStreaming 自增，用于跨会话 onEnd 竞态防护
};
let streamSessionSeq = 0; // streamSession.sessionId 的自增源

const STREAM = {
  frameSize: 1024,
};

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
  populateProviderSelect();

  const config = await loadConfig();
  applyConfigToUI(config);
  onProviderChange(); // 按选中 provider 更新 endpoint 可见性 + 默认值

  bindEvents();
  // 诊断页需要知道 popup 已就绪（配置阶段的失败会在这里看到迹象）
  debugEvt('popup-ready', {
    provider: els.providerSelect.value,
    model: els.modelInput.value,
    hasKey: !!els.apiKeyInput.value.trim(),
    hasEndpoint: !!els.endpointInput.value.trim(),
    providers: (globalThis.PROVIDERS || []).map((p) => p.id),
  });
});

// ---------- UI setup ----------

function gatherElements() {
  els.providerSelect = document.getElementById('provider');
  els.apiKeyInput = document.getElementById('apiKey');
  els.endpointInput = document.getElementById('endpoint');
  els.endpointRow = document.getElementById('endpointRow');
  els.modelInput = document.getElementById('model');
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
  els.statusDiv = document.getElementById('status');

  syncResultButtons();
  els.resultText.addEventListener('input', syncResultButtons);
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

function getCurrentProvider() {
  const id = els.providerSelect.value;
  return globalThis.PROVIDERS?.find((p) => p.id === id) || null;
}

function onProviderChange() {
  const provider = getCurrentProvider();
  if (!provider) return;

  // Model 输入框为空时填入 provider 默认流式模型
  if (!els.modelInput.value.trim()) {
    els.modelInput.value = provider.defaultModel || provider.defaultStreamModel || '';
  }

  // 支持流式的 provider：提示可选流式模型（批量与流式模型常不同）
  if (provider.supportsStreaming) {
    els.modelInput.placeholder = 'e.g. fun-asr-realtime';
    els.modelInput.title = 'Live Stream 使用此模型；批量模型发给 run-task 会被服务端 task-failed';
  } else {
    els.modelInput.removeAttribute('placeholder');
    els.modelInput.removeAttribute('title');
  }

  // endpoint 字段显隐（provider.hasEndpoint 决定）
  if (provider.hasEndpoint && els.endpointRow) {
    els.endpointRow.style.display = '';
  } else if (els.endpointRow) {
    els.endpointRow.style.display = 'none';
  }
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
  els.providerSelect.addEventListener('change', async () => {
    onProviderChange();
    await persistConfig();
  });
  els.apiKeyInput.addEventListener('change', persistConfig);
  els.endpointInput.addEventListener('change', persistConfig);
  els.modelInput.addEventListener('change', persistConfig);
  els.audioTypeSelect.addEventListener('change', persistConfig);

  els.recordBtn.addEventListener('click', toggleRecording);
  els.tabRecordBtn.addEventListener('click', toggleTabRecording);
  els.saveBtn.addEventListener('click', handleSaveAudio);
  els.streamBtn.addEventListener('click', toggleStreaming);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
  // 这两个按钮只在部分入口页存在（popup: options+panel；sidepanel: options）
  els.optionsBtn?.addEventListener('click', handleOpenOptions);
  els.panelBtn?.addEventListener('click', handleOpenPanel);
}

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
  let stream = null;
  try {
    audioBlob = null;

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();

    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    disableOtherRecordButtons(els.recordBtn);
    showStatus('Recording... speak now.', 'success');
    debugEvt('record-started', { mimeType: els.audioTypeSelect.value });
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
  }
}

async function stopRecording() {
  if (!recorder) return;
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
    enableAllRecordButtons();
  }
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
    showStatus(`Tab record failed: ${error.message}`, 'error');
    enableAllRecordButtons();
  }
}

async function stopTabRecording() {
  isTabRecording = false;
  els.tabRecordBtn.textContent = 'Record Tab';
  try {
    // offscreen 返回 { b64, mime }（JSON 消息通道无法传 Blob），这里还原
    audioBlob = globalThis.decodeAudio(await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_STOP, {}));
    debugEvt('tab-record-stopped', { size: audioBlob ? audioBlob.size : 0, mime: audioBlob ? audioBlob.type : '' });
    showStatus('Tab recording complete.', 'success');
  } catch (error) {
    debugEvt('tab-record-error', { where: 'stop', message: error?.message || String(error) });
    showStatus(`Tab record stop failed: ${error.message}`, 'error');
  } finally {
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
  a.download = `recording-${timestampForFile()}.${extensionForMime(audioBlob.type)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); // 下载触发后再回收
  debugEvt('audio-saved', { size: audioBlob.size, mime: audioBlob.type });
  showStatus(`Saved recording (${Math.max(1, Math.round(audioBlob.size / 1024))} KB).`, 'success');
}

/** 文件名时间戳：2026-09-28T19-30-00（冒号在 Windows 文件名非法）。 */
function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
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
// 原理：麦克风 → PCM 帧（AudioWorklet，createPcmCapture）→ 重采样 16kHz →
// Int16 → WebSocket（百炼 run-task）→ 服务端逐句返回 partial/final → 字幕式回显。
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

  // 尽早禁用，把重入窗口压到最小
  els.streamBtn.disabled = true;
  debugEvt('start-begin', { provider: provider.id });

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    debugEvt('mic-acquired', { tracks: stream.getAudioTracks().length });
    // 真流式服务端只收 16kHz PCM。直接把 AudioContext 建在 16kHz（官方 demo 同法），
    // 浏览器在源节点处做原生重采样 —— 避免逐帧软件重采样的相位不连续与时序漂移。
    // 旧浏览器不支持 sampleRate 选项时回退默认采样率，onStreamFrame 里再软件重采样。
    let context;
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      context = new AudioContext();
    }
    await context.resume(); // 用户手势内解锁

    // 跨会话竞态防护：streamSession 是原地复用的单例，旧会话的延迟 onclose/onEnd
    // 可能在新会话启动期间触发。每次 startStreaming 自增 sessionId，onEnd 闭包持有
    // 本次 mySessionId，若 streamSession.sessionId 已被新会话覆盖则判定为残留并忽略。
    const mySessionId = ++streamSessionSeq;

    streamSession.stream = stream;
    streamSession.context = context;
    streamSession.providerId = provider.id;
    streamSession.apiKey = apiKey;
    streamSession.finalText = '';
    streamSession.partialText = '';
    streamSession.model = els.modelInput.value.trim() || provider.defaultStreamModel || provider.defaultModel;
    streamSession.endpoint = els.endpointInput.value.trim() || undefined;
    streamSession.sessionId = mySessionId; // 置于 createStreamSession 之前：onEnd 在其后才可能触发
    streamSession.endedEarly = false; // 启动期 onEnd 竞态防护（见 createStreamSession 处注释）

    // 批量模型（如 qwen3-asr-flash）不能用于 run-task —— 用流式默认模型兜底
    if (!provider.isStreamModel(streamSession.model)) {
      debugEvt('model-fallback', { requested: streamSession.model, using: provider.defaultStreamModel });
      streamSession.model = provider.defaultStreamModel || 'fun-asr-realtime';
      showStatus(`Using realtime model ${streamSession.model} (batch model not valid for streaming).`, 'success');
    }

    // 先建会话：必须等 task-started（await ready）才开始采音，
    // 否则 task-started 之前的音频帧被 sendAudio 丢弃 → 丢开头首句
    debugEvt('ws-connecting', {
      model: streamSession.model,
      endpointConfigured: !!streamSession.endpoint,
      ctxSampleRate: context.sampleRate,
    });
    const wsSession = provider.createStreamSession({
      apiKey: streamSession.apiKey,
      model: streamSession.model,
      endpoint: streamSession.endpoint,
      onResult: onStreamResult,
      onError: (e) => {
        debugEvt('ws-error', { message: e?.message || String(e) });
        showStatus(`Stream error: ${e.message}`, 'error');
      },
      onComplete: () => debugEvt('ws-complete', {}),
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
    startPcmStats(context.sampleRate, 16000);

    // 竞态检查（必须在 isStreaming 置位前的最后一步）：从 createStreamSession 到这里的
    // 每个 await（ready / capture.start）期间 onEnd 都可能触发。它发生在 isStreaming 仍为
    // false 时只会记 endedEarly 标记，这里统一中止，避免在已结束的会话上把 UI 卡进 streaming 态。
    if (streamSession.endedEarly) {
      debugEvt('ws-ended-before-active', { model: streamSession.model });
      throw new Error('Stream connection closed before recording started');
    }

    els.resultText.value = '';
    syncResultButtons(); // 清空后同步禁用 Copy/Fill

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
  flushPartial();
  showStatus('Streaming stopped.', 'success');
  debugEvt('stream-stopped', { provider: streamSession.providerId, model: streamSession.model });

  // 流式结束：把最终合并文本作为一条历史记录
  const finalText = els.resultText.value.trim();
  if (finalText) {
    saveToHistory(finalText, streamSession.providerId, streamSession.model);
    debugEvt('history-saved', { len: finalText.length });
  }
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

// 每收到一帧 PCM：重采样到 16kHz → 转 Int16 → 发 WebSocket（服务端负责分段）
function onStreamFrame(frame) {
  const session = streamSession;
  if (!session.wsSession || !session.context) return;
  const sampleRate = session.context.sampleRate;
  const resampled = globalThis.resampleFloat32(frame, sampleRate, 16000);
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

function renderStreamText() {
  const parts = [streamSession.finalText, streamSession.partialText]
    .filter(Boolean)
    .join(' ');
  els.resultText.value = parts.trim();
  syncResultButtons(); // 程序化赋值不触发 input，须显式同步按钮
}

// 停止时把未定稿的进行中句子并入定稿（服务端最后一句可能没有 sentence_end 标记）
function flushPartial() {
  if (streamSession.partialText) {
    streamSession.finalText = (streamSession.finalText + ' ' + streamSession.partialText).trim();
    streamSession.partialText = '';
    renderStreamText();
  }
}

// ---------- Navigation (optional buttons) ----------

function handleOpenOptions() {
  chrome.runtime.openOptionsPage();
}

// chrome.sidePanel.open 需要用户手势；popup 内点击即满足
async function handleOpenPanel() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close(); // 侧栏已打开，收起 popup
    }
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

// 写入转录历史（失败不影响主流程；HistoryStore 自身也会吞掉存储错误）
function saveToHistory(text, provider, model) {
  if (!text || !globalThis.HistoryStore) return;
  globalThis.HistoryStore.add({ text, provider, model });
}
// （history-saved 打点在 stopStreaming 内部 —— saveToHistory 被多处复用，日志留在调用点）

function getDefaultConfig() {
  const firstProvider = globalThis.PROVIDERS?.[0];
  return {
    provider: firstProvider?.id || '',
    apiKey: '',
    endpoint: '',
    model: '',
    audioType: 'audio/webm',
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
  els.endpointInput.value = config.endpoint || '';
  els.modelInput.value = config.model || '';
  els.audioTypeSelect.value = config.audioType || 'audio/webm';

  // If model is empty, fill with provider default
  if (!els.modelInput.value) {
    const provider = getCurrentProvider();
    if (provider) els.modelInput.value = provider.defaultModel || provider.defaultStreamModel || '';
  }
}

async function persistConfig() {
  const config = {
    provider: els.providerSelect.value,
    apiKey: els.apiKeyInput.value.trim(),
    endpoint: els.endpointInput.value.trim(),
    model: els.modelInput.value.trim(),
    audioType: els.audioTypeSelect.value,
  };
  await globalThis.ConfigStore.save(config);
  debugEvt('config-saved', {
    provider: config.provider,
    model: config.model,
    endpoint: config.endpoint, // 原值（诊断页可直接看出是不是 https 批量残留）
    audioType: config.audioType,
    hasKey: !!config.apiKey,
  });
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
