/**
 * MessageClient — chrome.runtime.sendMessage 的 Promise 封装。
 *
 * 用法:
 *   const text = await MessageClient.send(MESSAGES.TRANSCRIBE, { audioBlob, ... });
 *
 * 自动:
 *   - 生成 requestId
 *   - 解包响应 { ok, data, error }
 *   - 失败时 reject 一个带 code 的 Error
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
   * @returns {Promise<any>} 成功时 resolve data
   */
  function send(type, payload = {}) {
    const message = { type, payload, requestId: nextId() };
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        // chrome.runtime.lastError 在接收方未返回/通道关闭时设置
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background'));
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

  return { send };
})();
