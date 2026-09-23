/**
 * Errors — 统一错误码与错误构造辅助。
 *
 * 跨上下文返回错误时统一用 code，避免把各 provider 的原始错误直接透出。
 */
globalThis.Errors = Object.freeze({
  // 配置类
  NO_PROVIDER: { code: 'NO_PROVIDER', message: 'No provider selected' },
  NO_API_KEY: { code: 'NO_API_KEY', message: 'API key is required' },
  NO_AUDIO: { code: 'NO_AUDIO', message: 'No audio data' },

  // 网络 / API 类
  NETWORK: { code: 'NETWORK', message: 'Network request failed' },
  API_ERROR: { code: 'API_ERROR', message: 'Provider API error' },
  EMPTY_RESULT: { code: 'EMPTY_RESULT', message: 'Empty transcription result' },

  // 消息 / 协议类
  UNKNOWN_ACTION: { code: 'UNKNOWN_ACTION', message: 'Unknown message type' },
  NO_RESPONSE: { code: 'NO_RESPONSE', message: 'No response' },

  // 未知
  UNKNOWN: { code: 'UNKNOWN', message: 'Unknown error' },
});

/**
 * 把任意异常归一化为 { code, message }。
 * 保留 provider 原始错误信息（message），code 缺省为 API_ERROR。
 */
globalThis.normalizeError = function normalizeError(error, fallback = globalThis.Errors.API_ERROR) {
  const code = error?.code;
  // 仅认可 Errors 中真实定义的错误码（Object.hasOwn 避免原型属性名误查）
  if (code && Object.hasOwn(globalThis.Errors, code) && globalThis.Errors[code].code === code) {
    return { code, message: error.message };
  }
  return { code: fallback.code, message: error?.message || fallback.message };
};

/**
 * 由 Errors 定义构造带 code 的 Error 实例。
 * @param {{code:string,message:string}} def   Errors 中的某项
 * @param {string} [message]                   覆盖默认 message（保留原始错误详情）
 * @returns {Error & {code:string}}
 */
globalThis.createError = function createError(def, message) {
  const e = new Error(message || def.message);
  e.code = def.code;
  return e;
};
