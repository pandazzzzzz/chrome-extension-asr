/**
 * MessageClient — chrome.runtime.sendMessage 的 Promise 封装。
 *
 * 用法:
 *   const text = await MessageClient.send(MESSAGES.TRANSCRIBE, {
 *     audio: await encodeAudio(blob), // JSON 通道传不了 Blob，先编码
 *     provider, model, endpoint,
 *   });
 *   await MessageClient.sendOffscreen(MESSAGES.TAB_RECORD_START, { streamId });
 *
 * 自动:
 *   - 生成 requestId
 *   - 解包响应 { ok, data, error }
 *   - 失败时 reject 一个带 code 的 Error
 *   - 可选指定 target（background 缺省 / offscreen 定向）
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

  /**
   * 发送消息并等待响应。
   * @param {string} type    MESSAGES 中定义的动作
   * @param {object} payload 动作参数
   * @param {string} [target] TARGETS 中的目标（缺省 background）
   * @returns {Promise<any>} 成功时 resolve data
   */
  function send(type, payload = {}, target = globalThis.TARGETS.BACKGROUND) {
    const message = { type, payload, requestId: nextId(), target };
    return new Promise((resolve, reject) => {
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
  }

  /** 发消息给 offscreen document。 */
  function sendOffscreen(type, payload = {}) {
    return send(type, payload, globalThis.TARGETS.OFFSCREEN);
  }

  return { send, sendOffscreen };
})();
