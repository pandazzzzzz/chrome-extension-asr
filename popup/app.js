/**
 * Popup app — generic ASR example framework.
 *
 * The app itself is provider-agnostic. It records audio and delegates
 * transcription to the active provider selected by the user.
 *
 * To add a new provider, see popup/providers/index.js.
 */

// State
let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let audioBlob = null;
let isRecording = false;

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
  els.transcribeBtn = document.getElementById('transcribeBtn');
  els.resultText = document.getElementById('result');
  els.copyBtn = document.getElementById('copyBtn');
  els.fillBtn = document.getElementById('fillBtn');
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
  els.transcribeBtn.addEventListener('click', handleTranscribe);
  els.copyBtn.addEventListener('click', handleCopy);
  els.fillBtn.addEventListener('click', handleFillIntoPage);
}

// ---------- Recording ----------

async function toggleRecording() {
  if (!isRecording) {
    await startRecording();
  } else {
    stopRecording();
  }
}

async function startRecording() {
  try {
    audioBlob = null;
    els.transcribeBtn.disabled = true;
    els.fillBtn.disabled = true;
    chunks = [];
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMimeType(els.audioTypeSelect.value);
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || els.audioTypeSelect.value;
      audioBlob = new Blob(chunks, { type });
      els.transcribeBtn.disabled = audioBlob.size === 0;
      releaseMic();
      showStatus('Recording complete. Click "Transcribe".', 'success');
    };

    mediaRecorder.start();
    isRecording = true;
    els.recordBtn.textContent = 'Stop Recording';
    showStatus('Recording... speak now.', 'success');
  } catch (error) {
    showStatus(`Cannot start recording: ${error.message}`, 'error');
    releaseMic();
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  isRecording = false;
  els.recordBtn.textContent = 'Start Recording';
}

function releaseMic() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  mediaStream = null;
}

// ---------- Transcription ----------

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
    // 转录经 background 代理：密钥在 service worker 内解密，popup 不传递明文
    const text = await globalThis.MessageClient.send(globalThis.MESSAGES.TRANSCRIBE, {
      audioBlob,
      provider: provider.id,
      model,
      endpoint: endpoint || undefined,
    });
    els.resultText.value = text;
    els.fillBtn.disabled = false;
    showStatus('Transcription complete.', 'success');
  } catch (error) {
    showStatus(`Transcription failed: ${error.message}`, 'error');
  } finally {
    els.transcribeBtn.disabled = false;
    els.transcribeBtn.textContent = 'Transcribe';
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

function pickMimeType(preferredType) {
  const candidates = [preferredType, 'audio/webm', 'audio/mp4', 'audio/wav'];
  for (const type of candidates) {
    if (type && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}
