/**
 * Popup app — generic ASR example framework.
 *
 * The app itself is provider-agnostic. It records audio and delegates
 * transcription to the active provider selected by the user.
 *
 * To add a new provider, see transcription/providers/index.js.
 */

// State
let recorder = null;          // AudioRecorder 实例（麦克风）
let audioBlob = null;         // 录音结果
let isRecording = false;      // 麦克风录音中
let isTabRecording = false;   // 标签页录音中（经 background → offscreen）
let isStreaming = false;      // 实时流式转录中（麦克风 PCM + VAD 分段）

// 流式会话（Live Stream 模式）
const streamSession = {
  context: null,
  capture: null,
  vad: null,
  stream: null,
  segmentChunks: [], // 当前语音段累积的 PCM 帧
  segmentSamples: 0,
  pending: 0, // 未完成的转录请求数
  sawSpeech: false, // 当前段是否已检测到语音（未检测到的段丢弃）
  providerId: '',
  model: '',
  endpoint: '',
};

const STREAM = {
  sampleRate: 48000, // 实际以 audioContext.sampleRate 为准
  frameSize: 1024,
  maxSegmentMs: 30000, // 单段超过此时长强制切分，避免请求过大
  minSegmentMs: 400, // 低于此时长的片段视为噪声，不提交转录
};

// DOM references
const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  gatherElements();
  populateProviderSelect();

  const config = await loadConfig();
  applyConfigToUI(config);
  onProviderChange(); // update endpoint visibility based on selected provider

  bindEvents();
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
  els.streamBtn = document.getElementById('streamBtn');
  els.transcribeBtn = document.getElementById('transcribeBtn');
  els.resultText = document.getElementById('result');
  els.copyBtn = document.getElementById('copyBtn');
  els.fillBtn = document.getElementById('fillBtn');
  els.optionsBtn = document.getElementById('optionsBtn'); // 可选：sidepanel/options 有
  els.panelBtn = document.getElementById('panelBtn'); // 可选：popup 有
  els.statusDiv = document.getElementById('status');
}

function populateProviderSelect() {
  globalThis.PROVIDERS.forEach((provider) => {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    els.providerSelect.appendChild(option);
  });
}

function onProviderChange() {
  const provider = getCurrentProvider();
  if (!provider) return;

  // Update model input to the provider's default (only if empty)
  if (!els.modelInput.value.trim()) {
    els.modelInput.value = provider.defaultModel;
  }

  // Toggle endpoint field visibility
  if (provider.hasEndpoint) {
    els.endpointRow.style.display = '';
    if (!els.endpointInput.value.trim() && typeof provider.getDefaultEndpoint === 'function') {
      els.endpointInput.value = provider.getDefaultEndpoint();
    }
  } else {
    els.endpointRow.style.display = 'none';
  }
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
  els.streamBtn.addEventListener('click', toggleStreaming);
  els.transcribeBtn.addEventListener('click', handleTranscribe);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
  // 这两个按钮只在部分入口页存在（popup: options+panel；sidepanel: options）
  els.optionsBtn?.addEventListener('click', handleOpenOptions);
  els.panelBtn?.addEventListener('click', handleOpenPanel);
}

// ---------- Recording ----------

// ---------- Recording (microphone) ----------

async function toggleRecording() {
  if (!isRecording) {
    await startRecording();
  } else {
    await stopRecording();
  }
}

async function startRecording() {
  try {
    audioBlob = null;
    els.transcribeBtn.disabled = true;
    els.fillBtn.disabled = true;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();

    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    els.tabRecordBtn.disabled = true; // 互斥：同一时刻只能录一路
    els.streamBtn.disabled = true;
    showStatus('Recording... speak now.', 'success');
  } catch (error) {
    showStatus(`Cannot start recording: ${error.message}`, 'error');
    recorder?.release();
    recorder = null;
  }
}

async function stopRecording() {
  if (!recorder) return;
  els.recordBtn.textContent = 'Start Recording';
  els.tabRecordBtn.disabled = false;
  els.streamBtn.disabled = false;
  isRecording = false;
  try {
    audioBlob = await recorder.stop();
    recorder.release();
    recorder = null;
    els.transcribeBtn.disabled = !audioBlob || audioBlob.size === 0;
    showStatus('Recording complete. Click "Transcribe".', 'success');
  } catch (error) {
    showStatus(`Recording failed: ${error.message}`, 'error');
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
    els.transcribeBtn.disabled = true;
    els.fillBtn.disabled = true;

    // background 取 tabCapture streamId → 创建 offscreen → offscreen 开始录
    await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_START, {});

    isTabRecording = true;
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    els.recordBtn.disabled = true; // 互斥：同一时刻只能录一路
    els.streamBtn.disabled = true;
    showStatus('Recording tab audio... play something in the tab.', 'success');
  } catch (error) {
    showStatus(`Tab record failed: ${error.message}`, 'error');
  }
}

async function stopTabRecording() {
  isTabRecording = false;
  els.tabRecordBtn.textContent = 'Record Tab';
  els.recordBtn.disabled = false;
  els.tabRecordBtn.disabled = false;
  els.streamBtn.disabled = false;
  try {
    // offscreen 返回 { b64, mime }（JSON 消息通道无法传 Blob），这里还原
    audioBlob = globalThis.decodeAudio(await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_STOP, {}));
    els.transcribeBtn.disabled = !audioBlob || audioBlob.size === 0;
    showStatus('Tab recording complete. Click "Transcribe".', 'success');
  } catch (error) {
    showStatus(`Tab record stop failed: ${error.message}`, 'error');
  }
}

// ---------- Streaming transcription (mic + VAD segments) ----------
//
// 原理：麦克风 → PCM 帧（AudioWorklet）→ VAD 状态机判定语音起止 →
// 语音段用 WAV 合成后经 background 转录 → 文本按段顺序拼接增量回显。
// 这是「增量式」流式（每段一次批量调用），非 WebSocket 真流式（见 supportsStreaming 预留）。

let streamSeq = 0;          // 段序号，保证回显顺序
const streamTexts = new Map(); // seq -> text（未完成时为 undefined）

async function toggleStreaming() {
  if (!isStreaming) {
    await startStreaming();
  } else {
    await stopStreaming();
  }
}

async function startStreaming() {
  const provider = getCurrentProvider();
  if (!provider) {
    showStatus('No provider selected.', 'error');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext();
    await context.resume(); // 用户手势内解锁

    streamSession.stream = stream;
    streamSession.context = context;
    streamSession.vad = globalThis.createVoiceActivityDetector({
      sampleRate: context.sampleRate,
    });
    streamSession.providerId = provider.id;
    streamSession.model = els.modelInput.value.trim();
    streamSession.endpoint = els.endpointInput.value.trim() || undefined;

    streamSession.capture = globalThis.createPcmCapture({
      stream,
      context,
      frameSize: STREAM.frameSize,
      onFrame: onStreamFrame,
    });
    await streamSession.capture.start();

    streamSeq = 0;
    streamTexts.clear();
    streamSession.segmentChunks = [];
    streamSession.segmentSamples = 0;
    streamSession.pending = 0;
    streamSession.sawSpeech = false;
    els.resultText.value = '';

    isStreaming = true;
    els.streamBtn.textContent = 'Stop Stream';
    els.recordBtn.disabled = true; // 互斥：同一时刻只录一路
    els.tabRecordBtn.disabled = true;
    els.transcribeBtn.disabled = true; // 流式模式下禁用整段转录
    els.fillBtn.disabled = true;
    els.audioTypeSelect.disabled = true; // 流式固定输出 WAV
    showStatus('Streaming: speak, results will appear as you go.', 'success');
  } catch (error) {
    showStatus(`Cannot start streaming: ${error.message}`, 'error');
    await teardownStreaming();
  }
}

async function stopStreaming() {
  isStreaming = false;

  // 先截断当前段再关流，保证尾音不丢
  submitStreamSegment();

  const pending = streamSession.pending;
  await teardownStreaming();

  els.streamBtn.textContent = 'Live Stream';
  els.recordBtn.disabled = false;
  els.tabRecordBtn.disabled = false;
  els.transcribeBtn.disabled = false;
  els.audioTypeSelect.disabled = false;

  if (pending > 0) {
    showStatus(`${pending} segment(s) still transcribing...`, 'success');
  } else {
    showStatus('Streaming stopped.', 'success');
  }
  // 流式结束：把最终合并文本作为一条历史记录（含仍在途段落）
  const finalText = els.resultText.value.trim();
  if (finalText) {
    saveToHistory(finalText, streamSession.providerId, streamSession.model);
  }
}

async function teardownStreaming() {
  try {
    streamSession.capture?.stop();
  } catch {
    /* ignore */
  }
  streamSession.capture = null;
  streamSession.vad = null;

  if (streamSession.stream) {
    streamSession.stream.getTracks().forEach((t) => t.stop());
    streamSession.stream = null;
  }
  if (streamSession.context) {
    await streamSession.context.close().catch(() => {});
    streamSession.context = null;
  }
}

// 每收到一帧 PCM：喂给 VAD，累积当前段，处理切段事件
function onStreamFrame(frame) {
  const vad = streamSession.vad;
  if (!vad) return;

  const result = vad.feed(frame);
  streamSession.segmentChunks.push(frame);
  streamSession.segmentSamples += frame.length;

  for (const event of result.events) {
    if (event.type === 'speech-start') {
      streamSession.sawSpeech = true;
    } else if (event.type === 'speech-end') {
      submitStreamSegment();
    }
  }

  // 防御：单段过长强制切分（避免请求过大 / 无语音时无上限堆积）
  const maxSamples = (STREAM.maxSegmentMs / 1000) * streamSession.context.sampleRate;
  if (streamSession.segmentSamples >= maxSamples) {
    submitStreamSegment();
  }
}

// 把当前累积段合成 WAV 并提交转录（仅当段内有语音）
function submitStreamSegment() {
  if (!streamSession.segmentChunks.length) return;

  const pcm = globalThis.concatFloat32(streamSession.segmentChunks);
  const sawSpeech = streamSession.sawSpeech;
  streamSession.segmentChunks = [];
  streamSession.segmentSamples = 0;
  streamSession.sawSpeech = false;

  const sampleRate = streamSession.context.sampleRate;
  const durationMs = (pcm.length / sampleRate) * 1000;
  if (!sawSpeech || durationMs < STREAM.minSegmentMs) return; // 纯静音/噪声丢弃

  const blob = globalThis.floatToWavBlob(pcm, sampleRate);
  const seq = ++streamSeq;
  streamTexts.set(seq, undefined); // 占位，保持段顺序

  streamSession.pending += 1;
  // 音频必须编码成 { b64, mime } 才能穿过 JSON 消息通道（Blob 会变成 {}）
  globalThis.encodeAudio(blob)
    .then((audio) =>
      globalThis.MessageClient.send(globalThis.MESSAGES.TRANSCRIBE, {
        audio,
        provider: streamSession.providerId,
        model: streamSession.model,
        endpoint: streamSession.endpoint,
      }),
    )
    .then((text) => {
      streamTexts.set(seq, text);
      renderStreamResult();
    })
    .catch((error) => {
      streamTexts.set(seq, `\n[${error.message}]\n`);
      renderStreamResult();
    })
    .finally(() => {
      streamSession.pending = Math.max(0, streamSession.pending - 1);
      if (streamSession.pending > 0) {
        showStatus(`Transcribing... (${streamSession.pending} segment(s) in flight)`, 'success');
      }
    });
}

// 按段序号拼接回显（未完成的段显示占位）
function renderStreamResult() {
  const parts = [];
  for (let seq = 1; seq <= streamSeq; seq++) {
    const value = streamTexts.get(seq);
    if (value === undefined) parts.push('…'); // 在途
    else parts.push(value);
  }
  els.resultText.value = parts.join(' ').trim();
  if (parts.some((p) => p && p !== '…')) els.fillBtn.disabled = false;
}

async function handleTranscribe() {
  const provider = getCurrentProvider();
  const model = els.modelInput.value.trim();
  const endpoint = els.endpointInput.value.trim();

  if (!provider) {
    showStatus('No provider selected.', 'error');
    return;
  }
  if (!audioBlob) {
    showStatus('Please record something first.', 'error');
    return;
  }

  els.transcribeBtn.disabled = true;
  els.transcribeBtn.textContent = 'Transcribing...';
  els.resultText.value = '';

  try {
    // 转录经 background 代理：密钥在 service worker 内解密，popup 不传递明文。
    // 音频编码传输（JSON 消息通道无法传 Blob）
    const text = await globalThis.MessageClient.send(globalThis.MESSAGES.TRANSCRIBE, {
      audio: await globalThis.encodeAudio(audioBlob),
      provider: provider.id,
      model,
      endpoint: endpoint || undefined,
    });
    els.resultText.value = text;
    els.fillBtn.disabled = false;
    showStatus('Transcription complete.', 'success');
    saveToHistory(text, provider.id, els.modelInput.value.trim());
  } catch (error) {
    showStatus(`Transcription failed: ${error.message}`, 'error');
  } finally {
    els.transcribeBtn.disabled = false;
    els.transcribeBtn.textContent = 'Transcribe';
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
    showStatus('Filled into page input.', 'success');
  } catch (error) {
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
    showStatus('Copied to clipboard.', 'success');
  } catch (error) {
    showStatus(`Copy failed: ${error.message}`, 'error');
  }
}

// ---------- Config ----------

// 写入转录历史（失败不影响主流程；HistoryStore 自身也会吞掉存储错误）
function saveToHistory(text, provider, model) {
  if (!text || !globalThis.HistoryStore) return;
  globalThis.HistoryStore.add({ text, provider, model });
}

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
  els.providerSelect.value = config.provider || '';
  els.apiKeyInput.value = config.apiKey || '';
  els.endpointInput.value = config.endpoint || '';
  els.modelInput.value = config.model || '';
  els.audioTypeSelect.value = config.audioType || 'audio/webm';

  // If model is empty, fill with provider default
  if (!els.modelInput.value) {
    const provider = getCurrentProvider();
    if (provider) els.modelInput.value = provider.defaultModel;
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
}

function getCurrentProvider() {
  const id = els.providerSelect.value;
  return globalThis.PROVIDERS?.find((p) => p.id === id) || null;
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
