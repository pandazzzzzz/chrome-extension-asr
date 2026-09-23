// Background service worker — 消息路由 + API 代理。
//
// 职责：
//   - 接收 popup/content 发来的 asr:transcribe 消息
//   - 从本地存储读取配置（含解密 apiKey），找到对应 provider
//   - 代为调用 provider API，返回转录文本
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
    });
    return { ok: true, data: true };
  } catch (error) {
    // content script 未注入（如 chrome:// 页面）时 sendMessage 会失败
    return { ok: false, error: { code: 'NO_CONTENT', message: 'Cannot fill text on this page' } };
  }
}

// 统一消息入口
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload } = request || {};

  (async () => {
    try {
      switch (type) {
        case globalThis.MESSAGES.TRANSCRIBE:
          return await handleTranscribe(payload);
        case globalThis.MESSAGES.FILL_TEXT:
          return await handleFillText(payload);
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
