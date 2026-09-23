// Background service worker — 消息路由 + API 代理 + offscreen 协调。
//
// 职责：
//   - 接收 popup/content 发来的 asr:* 消息（按 target 过滤，只处理发给 background 的）
//   - asr:transcribe：从本地存储读取配置（含解密 apiKey），委托 Transcriber 转录
//   - asr:tab-record-*：创建/复用 offscreen document，经 tabCapture 取 streamId
//   - asr:fill-text：转发给当前活动 tab 的 content script
//
// 安全边界（如实说明）：
//   转录 API 调用收敛到本 service worker，popup/content 发转录请求时不再
//   传递 apiKey。popup 为编辑配置仍会读取/回填密钥（UX 需求）；content
//   脚本不读取密钥。

// MV3 service worker 为经典脚本，用 importScripts 同步加载依赖。
// 顺序：共享错误 → provider → 调度层 → 存储 → 消息契约
importScripts(
  '../shared/errors.js',
  '../transcription/providers/base.js',
  '../transcription/providers/qwen.js',
  '../transcription/providers/openai.js',
  '../transcription/providers/deepgram.js',
  '../transcription/providers/index.js',
  '../transcription/transcriber.js',
  '../store/crypto.js',
  '../store/config.js',
  '../messaging/messages.js',
);

console.log('Background service worker started');

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// 插件安装/更新时的初始化
chrome.runtime.onInstalled.addListener((details) => {
  console.log('Extension installed:', details.reason);
  if (details.reason === 'install') {
    // 首次安装：清理早期模板遗留的 storage.sync 演示数据
    chrome.storage.sync.get(['data'], (result) => {
      if (result.data !== undefined) chrome.storage.sync.remove(['data']);
    });
  }
});

// 处理 asr:transcribe —— 读配置 + 委托 Transcriber 调度（校验/调用/归一均在调度层）
async function handleTranscribe(payload) {
  const { audioBlob, provider: providerId, model, endpoint } = payload || {};

  const config = await globalThis.ConfigStore.load();

  try {
    const text = await globalThis.Transcriber.transcribe({
      audioBlob,
      providerId: providerId || config.provider,
      apiKey: config.apiKey || '',
      model: model || config.model,
      endpoint: endpoint || config.endpoint,
    });
    return { ok: true, data: text };
  } catch (error) {
    return { ok: false, error: globalThis.normalizeError(error) };
  }
}

// 转发 asr:fill-text 到当前活动 tab 的 content script
async function handleFillText(payload) {
  const { text } = payload || {};
  if (!text) return { ok: false, error: globalThis.Errors.EMPTY_RESULT };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: { code: 'NO_TAB', message: 'No active tab' } };
  }

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: globalThis.MESSAGES.FILL_TEXT,
      payload: { text },
      target: globalThis.TARGETS.CONTENT,
    });
    return { ok: true, data: true };
  } catch (error) {
    // content script 未注入（如 chrome:// 页面）时 sendMessage 会失败
    return { ok: false, error: { code: 'NO_CONTENT', message: 'Cannot fill text on this page' } };
  }
}

// ---------- Offscreen 协调（标签页录音） ----------
// offscreen 单例创建，避免并发重复 createDocument
let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab audio via chrome.tabCapture for transcription',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

// 开始录标签页：取 streamId → 通知 offscreen 开始
async function handleTabRecordStart(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: { code: 'NO_TAB', message: 'No active tab' } };
  }

  // getMediaStreamId 需要用户手势（点击扩展图标）授予的 activeTab
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    return {
      ok: false,
      error: { code: 'TAB_CAPTURE', message: error.message || 'Cannot capture tab (activeTab?)' },
    };
  }

  await ensureOffscreenDocument();
  return sendToOffscreen(globalThis.MESSAGES.TAB_RECORD_START, { streamId });
}

// 停止录标签页：offscreen 返回录制 Blob
async function handleTabRecordStop() {
  return sendToOffscreen(globalThis.MESSAGES.TAB_RECORD_STOP, {});
}

// 给 offscreen 发消息并按 { ok, data, error } 归一化
function sendToOffscreen(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type, payload, target: globalThis.TARGETS.OFFSCREEN, requestId: Date.now().toString(36) },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: { code: 'NO_OFFSCREEN', message: chrome.runtime.lastError.message },
          });
          return;
        }
        if (!response) {
          resolve({ ok: false, error: { code: 'NO_RESPONSE', message: 'No response from offscreen' } });
          return;
        }
        resolve(response);
      },
    );
  });
}

// 统一消息入口
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload, target } = request || {};

  // target 过滤：runtime.sendMessage 是广播，offscreen/content 收到的
  // background 消息也在这里触发，非 background 的直接忽略
  if (target !== undefined && target !== globalThis.TARGETS.BACKGROUND) return false;

  (async () => {
    try {
      switch (type) {
        case globalThis.MESSAGES.TRANSCRIBE:
          return await handleTranscribe(payload);
        case globalThis.MESSAGES.FILL_TEXT:
          return await handleFillText(payload);
        case globalThis.MESSAGES.TAB_RECORD_START:
          return await handleTabRecordStart(payload);
        case globalThis.MESSAGES.TAB_RECORD_STOP:
          return await handleTabRecordStop();
        default:
          return { ok: false, error: globalThis.Errors.UNKNOWN_ACTION };
      }
    } catch (error) {
      console.error('Background handler error:', error);
      return { ok: false, error: globalThis.normalizeError(error) };
    }
  })().then(sendResponse);

  return true; // 保持消息通道开启以异步响应
});
