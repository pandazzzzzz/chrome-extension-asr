// Background service worker — 消息路由 + offscreen 协调。
//
// 职责：
//   - 接收 popup/content 发来的 asr:* 消息（按 target 过滤，只处理发给 background 的）
//   - asr:tab-record-*：创建/复用 offscreen document，经 tabCapture 取 streamId
//   - asr:fill-text：转发给当前活动 tab 的 content script

// MV3 service worker 为经典脚本，用 importScripts 同步加载依赖。
// 顺序：共享错误 → 消息契约（配置/加密由 popup 侧读取，此处不涉密钥）
importScripts(
  '../shared/errors.js',
  '../messaging/messages.js',
);

console.log('Background service worker started');

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// 诊断页订阅者集合：诊断页 content 桥（debug/bridge.js）在装载时发 DEBUG_SUBSCRIBE
// 登记本 tab id，这里只向订阅 tab 转发遥测 —— 替代原来"每次事件查全部 tab 广播"的
// O(全部 tab) 开销。集合存内存，service worker 挂起重启会清空；桥在 focus/pageshow
// 时重发订阅自愈。
const debugSubscribers = new Set();

function forwardDebugToTabs(payload) {
  for (const tabId of debugSubscribers) {
    chrome.tabs.sendMessage(
      tabId,
      { type: globalThis.MESSAGES.DEBUG_EVT, payload, target: globalThis.TARGETS.DEBUG },
      () => {
        // 桥仍会回 sendResponse({ok:true})；若桥已不在（导航走/关闭），无人响应 →
        // lastError 置位，从集合移除自愈。
        if (chrome.runtime.lastError) debugSubscribers.delete(tabId);
      },
    );
  }
}

// tab 关闭立即清理，不必等下一次转发时的 lastError 兜底。
chrome.tabs.onRemoved.addListener((tabId) => {
  debugSubscribers.delete(tabId);
});

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

// 转发 asr:fill-text 到当前活动 tab 的 content script
async function handleFillText(payload) {
  const { text } = payload || {};
  if (!text) return { ok: false, error: globalThis.Errors.NO_TEXT };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: globalThis.Errors.NO_TAB };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: globalThis.MESSAGES.FILL_TEXT,
      payload: { text },
      target: globalThis.TARGETS.CONTENT,
    });
    // content 的响应必须原样转发：content 判定无聚焦字段时回 { ok:false, NO_FIELD }，
    // 丢掉它会让 popup 永远显示"填充成功"。message 未定义时（异常路径）按失败处理。
    if (response && response.ok) return { ok: true, data: response.data };
    return {
      ok: false,
      error: response?.error
        ? globalThis.normalizeError(response.error)
        : globalThis.Errors.NO_CONTENT,
    };
  } catch (error) {
    // content script 未注入（如 chrome:// 页面）时 sendMessage 会失败
    return { ok: false, error: globalThis.Errors.NO_CONTENT };
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
    justification: 'Recording tab audio for transcription',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

// 开始录标签页：取 streamId → 通知 offscreen 开始
async function handleTabRecordStart(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    return { ok: false, error: globalThis.Errors.NO_TAB };
  }

  // getMediaStreamId 需要用户手势（点击扩展图标）授予的 activeTab
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    return {
      ok: false,
      error: globalThis.createError(globalThis.Errors.TAB_CAPTURE, error.message || ''),
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
            error: globalThis.createError(
              globalThis.Errors.NO_OFFSCREEN,
              chrome.runtime.lastError.message,
            ),
          });
          return;
        }
        if (!response) {
          resolve({ ok: false, error: globalThis.Errors.NO_RESPONSE });
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

  // 诊断页订阅/退订：content 桥（debug/bridge.js）在诊断页装载时登记本 tab id，
  // 离开/关闭时退订。订阅集合存内存，worker 重启会清空 —— 桥在 focus/pageshow 时重发自愈。
  if (type === globalThis.MESSAGES.DEBUG_SUBSCRIBE && sender?.tab?.id != null) {
    debugSubscribers.add(sender.tab.id);
    return false;
  }
  if (type === globalThis.MESSAGES.DEBUG_UNSUBSCRIBE && sender?.tab?.id != null) {
    debugSubscribers.delete(sender.tab.id);
    return false;
  }

  // 诊断遥测转发（target:'debug'）：
  // chrome.runtime.sendMessage 只广播给扩展上下文（background / 扩展页），
  // **到不了 content script** —— content 只能由 chrome.tabs.sendMessage 送达。
  // 所以这里由 background 中转一跳给各 tab 的 content 桥（debug/bridge.js）。
  if (type === globalThis.MESSAGES.DEBUG_EVT && target === globalThis.TARGETS.DEBUG) {
    forwardDebugToTabs(payload);
    return false; // fire-and-forget，不占响应通道
  }

  // target 过滤：runtime.sendMessage 是广播，offscreen/content 收到的
  // background 消息也在这里触发，非 background 的直接忽略
  if (target !== undefined && target !== globalThis.TARGETS.BACKGROUND) return false;

  (async () => {
    try {
      switch (type) {
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
