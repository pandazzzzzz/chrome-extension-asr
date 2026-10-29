/**
 * Messages — 跨上下文消息契约定义。
 *
 * 消息统一形如:
 *   { type: 'asr:fill-text', payload: { ... }, requestId: '...', target?: 'background' | 'offscreen' }
 *
 * - type:      'asr:' 命名空间 + 动作名
 * - payload:   动作专属参数
 * - requestId: 发送方生成的唯一 ID，用于关联请求/响应
 * - target:    收件人上下文。runtime.sendMessage 是广播的，background 与
 *              offscreen 会同时收到同一条消息，故必须用 target 过滤，缺省
 *              视为发给 background。
 *
 * 响应统一形如:
 *   { ok: true,  data: ... }                    成功
 *   { ok: false, error: { code, message } }     失败
 *
 *   asr:subtitle-show    offscreen 会话 → background → content
 *                        payload: { text, done, tabId? }（done=true 表示会话已结束，
 *                        浮层再亮 2s 后自动淡出）
 *                        data:    true
 *
 *   asr:subtitle-hide    offscreen 会话 → background → content
 *                        payload: { tabId? }
 *                        data:    true
 *
 *   asr:fill-text        popup → background → content
 *                        payload: { text }
 *                        data:    true（content 已注入；失败时 ok:false + NO_FIELD 等）
 *
 *   asr:tab-record-state popup/sidepanel → background
 *                        payload: {}
 *                        data:    { recording: boolean }
 *                        标签页录音的状态活在 background/offscreen 里，popup 只是镜像；
 *                        popup 每次装载都要对齐一次（它随时可能被关闭而丢内存状态）。
 *
 *   asr:history-add      popup/sidepanel → background
 *                        payload: { text, provider, model }
 *                        data:    { saved: true }
 *                        历史写入放在常驻 service worker，popup 关闭时已发出的最终文本
 *                        仍能落库；options 页仍直接读/清/导出同一个 IndexedDB。
 *
 *   asr:debug            popup/sidepanel/offscreen → background → content bridge
 *                        payload: diagnostic event object（不含 API Key / 完整 URL）
 *                        data:    none（fire-and-forget）
 *
 *   asr:debug-subscribe  diagnostic page content bridge → background
 *                        payload: {}
 *                        data:    { ok: true }（订阅心跳）
 *
 *   asr:debug-unsubscribe diagnostic page content bridge → background
 *                         payload: {}
 *                         data:    none（fire-and-forget）
 *
 * 音频不走 runtime 消息通道：runtime 消息是 JSON 序列化，Blob/ArrayBuffer
 * 无法无损传递。标签页录音写入同源 OPFS，消息里只传
 * { file, mime, size } 元数据；popup/sidepanel 保存时再按引用读取。
 */
globalThis.MESSAGES = Object.freeze({
  SUBTITLE_SHOW: 'asr:subtitle-show',
  SUBTITLE_HIDE: 'asr:subtitle-hide',
  FILL_TEXT: 'asr:fill-text',
  TAB_RECORD_START: 'asr:tab-record-start',
  TAB_RECORD_STOP: 'asr:tab-record-stop',
  TAB_RECORD_STATE: 'asr:tab-record-state', // 查询标签页录音是否在进行（popup 装载时对齐）
  MIC_RECORD_PORT: 'asr:mic-record',          // popup/sidepanel → background 长连接租约
  MIC_RECORD_ACQUIRE: 'asr:mic-record-acquire',
  MIC_RECORD_RELEASE: 'asr:mic-record-release',
  STREAM_START: 'asr:stream-start',         // Live Stream 会话（宿主在 offscreen，跨 popup 生命周期）
  STREAM_STOP: 'asr:stream-stop',
  STREAM_STATE: 'asr:stream-state',         // popup 装载时对账（同 tab-record-state 模式）
  STREAM_SET_SUBTITLES: 'asr:stream-set-subtitles', // 会话中途切换字幕镜像
  STREAM_UPDATE: 'asr:stream-update',       // offscreen → 扩展页广播（partial/final/终止），target: 'ui'
  STREAM_ENDED: 'asr:stream-ended',         // offscreen → background：会话已自行收尾（远端终止），请清状态回收文档
  HISTORY_ADD: 'asr:history-add', // 由 background 写入历史，跨 popup 生命周期
  DEBUG_EVT: 'asr:debug',
  DEBUG_SUBSCRIBE: 'asr:debug-subscribe',     // 诊断页 content 桥 → background 登记本 tab
  DEBUG_UNSUBSCRIBE: 'asr:debug-unsubscribe', // 诊断页离开/关闭 → 退订
});

/** 消息路由目标（缺省为 background）。 */
globalThis.TARGETS = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  CONTENT: 'content',
  DEBUG: 'debug', // 调试事件：由 popup/sidepanel 发出，content 桥（debug/bridge.js）接收
                  // 后 window.postMessage 给诊断页（tests/stream-debug.html）。
                  // background / offscreen 的 target 过滤会忽略它，无需处理。
  UI: 'ui',     // offscreen → 扩展页（popup/sidepanel）的单向广播：流式文本更新与会话终止。
                // background / offscreen / content 的 target 过滤都会忽略它；只有
                // popup/app-streaming.js 显式监听 target === TARGETS.UI 的消息。
});

// 诊断遥测只允许来自仓库自带的本地诊断页，且限定默认开发端口。任意
// localhost 服务都能拿到 content script 注入；仅凭 hostname/path 后缀会让
// 另一个本地进程冒充诊断页订阅模型、设备与错误遥测。
globalThis.DEBUG_PAGE = Object.freeze({
  host: 'localhost',
  port: '18923',
  path: '/tests/stream-debug.html',
  hosts: Object.freeze(['localhost', '127.0.0.1', '[::1]']),
});

globalThis.isApprovedDebugPageUrl = function isApprovedDebugPageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && globalThis.DEBUG_PAGE.hosts.includes(url.hostname)
      && url.port === globalThis.DEBUG_PAGE.port
      && url.pathname === globalThis.DEBUG_PAGE.path;
  } catch {
    return false;
  }
};
