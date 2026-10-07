/**
 * MessageClient — chrome.runtime.sendMessage 的 Promise 封装。
 *
 * 用法:
 *   await MessageClient.send(MESSAGES.FILL_TEXT, { text });
 *   await MessageClient.sendOffscreen(MESSAGES.TAB_RECORD_START, { streamId });
 *
 * 自动:
 *   - 生成 requestId
 *   - 解包响应 { ok, data, error }
 *   - 失败时 reject 一个带 code 的 Error
 *   - 可选指定 target（background 缺省 / offscreen 定向）
 *   - 默认超时：接收上下文被杀（SW 回收 / offscreen 关闭）时 lastError 可能
 *     迟迟不来，await 会挂住整个 UI。超时后 reject 带 TIMEOUT code。
 *     （超时不取消底层消息，调用方 catch 里照常做 UI 恢复。）
 *
 * 注意：runtime.sendMessage 会广播给 background 和 offscreen，两者各自
 * 按 target 过滤；发给 offscreen 的消息 background 会忽略，反之亦然。
 */
globalThis.MessageClient = (() => {
  let counter = 0;

  function nextId() {
    counter += 1;
    return `${Date.now().toString(36)}-${counter}`;
  }

  const DEFAULT_TIMEOUT_MS = 10000;

  /**
   * 发送消息并等待响应。
   * @param {string} type    MESSAGES 中定义的动作
   * @param {object} payload 动作参数
   * @param {string} [target] TARGETS 中的目标（缺省 background）
   * @param {number} [timeoutMs] 响应超时（缺省 10s；等待录音停止等慢操作可放宽）
   * @returns {Promise<any>} 成功时 resolve data
   */
  function send(type, payload = {}, target = globalThis.TARGETS.BACKGROUND, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const message = { type, payload, requestId: nextId(), target };
    const p = new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response'));
          return;
        }
        if (response.ok) {
          resolve(response.data);
        } else {
          const err = new Error(response.error?.message || 'Unknown error');
          err.code = response.error?.code;
          reject(err);
        }
      });
    });
    return globalThis.withTimeout(p, timeoutMs, `sendMessage ${type}`);
  }

  /** 发消息给 offscreen document。 */
  function sendOffscreen(type, payload = {}) {
    return send(type, payload, globalThis.TARGETS.OFFSCREEN);
  }

  return { send, sendOffscreen };
})();
