const ENDPOINTS = {
  cn: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  intl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
};

const DEFAULT_CONFIG = {
  apiKey: '',
  region: 'cn',
  model: 'qwen3-asr-flash',
  audioType: 'audio/webm'
};

let mediaRecorder = null;
let mediaStream = null;
let chunks = [];
let audioBlob = null;
let isRecording = false;

document.addEventListener('DOMContentLoaded', async () => {
  const apiKeyInput = document.getElementById('apiKey');
  const regionSelect = document.getElementById('region');
  const audioTypeSelect = document.getElementById('audioType');
  const modelInput = document.getElementById('model');
  const recordBtn = document.getElementById('recordBtn');
  const transcribeBtn = document.getElementById('transcribeBtn');
  const resultText = document.getElementById('result');
  const copyBtn = document.getElementById('copyBtn');
  const statusDiv = document.getElementById('status');

  const config = await loadConfig();
  apiKeyInput.value = config.apiKey;
  regionSelect.value = config.region;
  audioTypeSelect.value = config.audioType;
  modelInput.value = config.model;

  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = type;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => {
      statusDiv.className = '';
    }, 3500);
  }

  async function persistConfig() {
    const next = {
      apiKey: apiKeyInput.value.trim(),
      region: regionSelect.value,
      model: modelInput.value.trim(),
      audioType: audioTypeSelect.value
    };
    await chrome.storage.sync.set({ asrConfig: next });
  }

  apiKeyInput.addEventListener('change', persistConfig);
  regionSelect.addEventListener('change', persistConfig);
  audioTypeSelect.addEventListener('change', persistConfig);
  modelInput.addEventListener('change', persistConfig);

  recordBtn.addEventListener('click', async () => {
    if (!isRecording) {
      try {
        audioBlob = null;
        transcribeBtn.disabled = true;
        chunks = [];
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = pickMimeType(audioTypeSelect.value);
        mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : {});

        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        };
        mediaRecorder.onstop = () => {
          const type = mediaRecorder.mimeType || audioTypeSelect.value;
          audioBlob = new Blob(chunks, { type });
          transcribeBtn.disabled = audioBlob.size === 0;
          releaseMic();
          showStatus('录音完成，可点击“转写”。', 'success');
        };

        mediaRecorder.start();
        isRecording = true;
        recordBtn.textContent = '停止录音';
        showStatus('正在录音，请讲话...', 'success');
      } catch (error) {
        showStatus(`无法开始录音: ${error.message}`, 'error');
        releaseMic();
      }
      return;
    }

    mediaRecorder.stop();
    isRecording = false;
    recordBtn.textContent = '开始录音';
  });

  transcribeBtn.addEventListener('click', async () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim();

    if (!apiKey) {
      showStatus('请先填写 DashScope API Key。', 'error');
      return;
    }
    if (!model) {
      showStatus('请先填写模型名。', 'error');
      return;
    }
    if (!audioBlob) {
      showStatus('请先录音。', 'error');
      return;
    }

    transcribeBtn.disabled = true;
    transcribeBtn.textContent = '转写中...';
    resultText.value = '';

    try {
      const dataUrl = await blobToDataUrl(audioBlob);
      const endpoint = ENDPOINTS[regionSelect.value];
      const format = getAudioFormat(audioBlob.type || audioTypeSelect.value);
      const payload = {
        model,
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Please transcribe the speech to text.' },
              { type: 'input_audio', input_audio: { data: dataUrl, format } }
            ]
          }
        ]
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error?.message || `HTTP ${response.status}`);
      }

      const text = extractText(json);
      if (!text) {
        throw new Error('接口返回为空，请检查音频和模型。');
      }
      resultText.value = text;
      showStatus('转写成功。', 'success');
    } catch (error) {
      showStatus(`转写失败: ${error.message}`, 'error');
    } finally {
      transcribeBtn.disabled = false;
      transcribeBtn.textContent = '转写';
    }
  });

  copyBtn.addEventListener('click', async () => {
    const text = resultText.value.trim();
    if (!text) {
      showStatus('没有可复制的文本。', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showStatus('已复制到剪贴板。', 'success');
    } catch (error) {
      showStatus(`复制失败: ${error.message}`, 'error');
    }
  });

  function releaseMic() {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
    }
    mediaStream = null;
  }
});

async function loadConfig() {
  const { asrConfig } = await chrome.storage.sync.get(['asrConfig']);
  return { ...DEFAULT_CONFIG, ...(asrConfig || {}) };
}

function pickMimeType(preferredType) {
  const candidates = [preferredType, 'audio/webm', 'audio/mp4', 'audio/wav'];
  for (const type of candidates) {
    if (type && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('音频编码失败'));
    reader.readAsDataURL(blob);
  });
}

function getAudioFormat(mimeType) {
  const clean = (mimeType || 'audio/webm').split(';')[0].trim();
  if (clean.endsWith('/wav')) {
    return 'wav';
  }
  if (clean.endsWith('/mp4')) {
    return 'mp4';
  }
  return 'webm';
}

function extractText(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (!content) {
    return '';
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || item.transcript || '')
      .join('\n')
      .trim();
  }
  if (typeof content === 'object' && content.text) {
    return String(content.text).trim();
  }
  return '';
}
