/**
 * Popup app — recording shell.
 *
 * 当前只负责音频采集：麦克风录音与标签页录音（经 background → offscreen）。
 * 配置（provider / apiKey / endpoint / model）持久化到本地，apiKey 加密存储，
 * 为后续接入真 WebSocket 流式转录预留。转录逻辑尚未接入。
 */

// State
let recorder = null;          // AudioRecorder 实例（麦克风）
let audioBlob = null;         // 录音结果
let isRecording = false;      // 麦克风录音中
let isTabRecording = false;   // 标签页录音中（经 background → offscreen）

// DOM references
const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  gatherElements();

  const config = await loadConfig();
  applyConfigToUI(config);

  bindEvents();
});

// ---------- UI setup ----------

function gatherElements() {
  els.providerInput = document.getElementById('provider');
  els.apiKeyInput = document.getElementById('apiKey');
  els.endpointInput = document.getElementById('endpoint');
  els.modelInput = document.getElementById('model');
  els.audioTypeSelect = document.getElementById('audioType');
  els.recordBtn = document.getElementById('recordBtn');
  els.tabRecordBtn = document.getElementById('tabRecordBtn');
  els.resultText = document.getElementById('result');
  els.copyBtn = document.getElementById('copyBtn');
  els.fillBtn = document.getElementById('fillBtn');
  els.optionsBtn = document.getElementById('optionsBtn'); // 可选：sidepanel/options 有
  els.panelBtn = document.getElementById('panelBtn'); // 可选：popup 有
  els.statusDiv = document.getElementById('status');
}

function bindEvents() {
  els.providerInput.addEventListener('change', persistConfig);
  els.apiKeyInput.addEventListener('change', persistConfig);
  els.endpointInput.addEventListener('change', persistConfig);
  els.modelInput.addEventListener('change', persistConfig);
  els.audioTypeSelect.addEventListener('change', persistConfig);

  els.recordBtn.addEventListener('click', toggleRecording);
  els.tabRecordBtn.addEventListener('click', toggleTabRecording);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
  // 这两个按钮只在部分入口页存在（popup: options+panel；sidepanel: options）
  els.optionsBtn?.addEventListener('click', handleOpenOptions);
  els.panelBtn?.addEventListener('click', handleOpenPanel);
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
  try {
    audioBlob = null;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new AudioRecorder({ mimeType: els.audioTypeSelect.value });
    recorder.attach(stream);
    recorder.start();

    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    els.tabRecordBtn.disabled = true; // 互斥：同一时刻只能录一路
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
  isRecording = false;
  try {
    audioBlob = await recorder.stop();
    recorder.release();
    recorder = null;
    showStatus('Recording complete.', 'success');
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

    // background 取 tabCapture streamId → 创建 offscreen → offscreen 开始录
    await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_START, {});

    isTabRecording = true;
    els.tabRecordBtn.textContent = 'Stop Tab Rec';
    els.recordBtn.disabled = true; // 互斥：同一时刻只能录一路
    showStatus('Recording tab audio... play something in the tab.', 'success');
  } catch (error) {
    showStatus(`Tab record failed: ${error.message}`, 'error');
  }
}

async function stopTabRecording() {
  isTabRecording = false;
  els.tabRecordBtn.textContent = 'Record Tab';
  els.recordBtn.disabled = false;
  try {
    // offscreen 返回 { b64, mime }（JSON 消息通道无法传 Blob），这里还原
    audioBlob = globalThis.decodeAudio(await globalThis.MessageClient.send(globalThis.MESSAGES.TAB_RECORD_STOP, {}));
    showStatus('Tab recording complete.', 'success');
  } catch (error) {
    showStatus(`Tab record stop failed: ${error.message}`, 'error');
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

function getDefaultConfig() {
  return {
    provider: '',
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
  els.providerInput.value = config.provider || '';
  els.apiKeyInput.value = config.apiKey || '';
  els.endpointInput.value = config.endpoint || '';
  els.modelInput.value = config.model || '';
  els.audioTypeSelect.value = config.audioType || 'audio/webm';
}

async function persistConfig() {
  const config = {
    provider: els.providerInput.value.trim(),
    apiKey: els.apiKeyInput.value.trim(),
    endpoint: els.endpointInput.value.trim(),
    model: els.modelInput.value.trim(),
    audioType: els.audioTypeSelect.value,
  };
  await globalThis.ConfigStore.save(config);
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
