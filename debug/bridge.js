/**
 * Debug bridge — 流式调试点到点的转发桥（仅诊断用）。
 *
 * 同一份文件在两类上下文有不同职责（靠 location.protocol 区分）：
 *
 * 1. 扩展页面（popup / sidepanel / options，chrome-extension: 协议）
 *    暴露 globalThis.emitDebug(entry)：把一个调试事件 fire-and-forget 广播为
 *    target:'debug' 的 runtime 消息。故意不用 MessageClient.send —— 那是
 *    request/response 语义，诊断页桥不会回 {ok}，会让每次打点都 reject。
 *
 * 2. content script（普通页面，http/https/file: 协议）
 *    监听 target:'debug' 的 runtime 消息，window.postMessage 转给页面。
 *    仅当 URL 命中诊断页（stream-debug.html 或 ?debug 参数）才装监听，
 *    避免在所有普通页面留一个永无事件的空监听。
 *
 * 参与方：
 *   - background / offscreen 的 target 过滤忽略 target:'debug'（无需改它们）
 *   - content/content.js 的 target 过滤同样忽略（只处理 target:'content'）
 *
 * 诊断页（tests/stream-debug.html）监听 window message，记入事件面板。
 */
(function () {
  'use strict';

  // ---- 扩展页面侧：暴露 emitDebug ----
  if (location.protocol === 'chrome-extension:') {
    globalThis.emitDebug = function emitDebug(entry) {
      // fire-and-forget：没人监听也无所谓，不产生 rejected promise。
      // 注意：runtime.sendMessage 只达扩展上下文，content 桥靠 background 中转。
      try {
        chrome.runtime.sendMessage({
          type: (globalThis.MESSAGES && globalThis.MESSAGES.DEBUG_EVT) || 'asr:debug',
          payload: entry,
          target: (globalThis.TARGETS && globalThis.TARGETS.DEBUG) || 'debug',
          requestId: Date.now().toString(36),
        });
      } catch {
        /* 上下文已销毁等 —— 调试日志丢失无妨 */
      }
    };
    return;
  }

  // ---- content script 侧：runtime 消息 → window 消息 ----
  // 只对本地诊断页装监听（stream-debug.html + localhost），普通页面不装。
  // 关键：不能只用 ?debug 这种宽松匹配做开关 —— 任何网站在 URL 里带 debug 参数
  // 都会装上监听，扩展每次打点（含 config-saved 的 endpoint/model/provider）都会被
  // 转发给该页，等于把配置泄露给攻击者选中的页面。诊断页靠 tests/serve-debug.js
  // 在 localhost 托管，路径名 + 主机名双重限定即可。
  const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isDiagnosticPage = isLocalHost && /stream-debug\.html/.test(location.pathname);
  if (!isDiagnosticPage) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) return;

  chrome.runtime.onMessage.addListener((request) => {
    const wantTarget = (globalThis.TARGETS && globalThis.TARGETS.DEBUG);
    const wantType = (globalThis.MESSAGES && globalThis.MESSAGES.DEBUG_EVT);
    if (request?.target !== wantTarget || request.type !== wantType) return false;
    window.postMessage({ type: 'asr:debug-log', entry: request.payload }, location.origin);
    return false; // 不需响应
  });
})();
