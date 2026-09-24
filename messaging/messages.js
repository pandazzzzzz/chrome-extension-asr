/**
 * Messages — 跨上下文消息契约定义。
 *
 * 消息统一形如:
 *   { type: 'asr:transcribe', payload: { ... }, requestId: '...', target?: 'background' | 'offscreen' }
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
 * 当前定义的动作：
 *   asr:transcribe       popup → background
 *                        payload: { audio: { b64, mime }, provider, model, endpoint }
 *                        data:    string (转录文本)
 *
 *   asr:fill-text        popup → background → content
 *                        payload: { text }
 *                        data:    true（content 已注入；失败时 ok:false + NO_FIELD 等）
 *
 *   asr:tab-record-start popup → background → offscreen
 *                        payload: { streamId }（background 取得的 tabCapture streamId）
 *                        data:    true
 *
 *   asr:tab-record-stop  popup → background → offscreen
 *                        payload: {}
 *                        data:    { b64, mime }（录制音频，见下方音频编码说明）
 *
 * 音频为什么编码传输：runtime 消息通道是 JSON 序列化（不是 structured clone），
 * Blob / ArrayBuffer / Uint8Array 都会丢失（Blob 变成 {}），所以音频统一走
 * encodeAudio → { b64, mime }（base64 字符串可无损穿过消息通道），接收端用
 * decodeAudio 还原成 Blob。请求与响应两个方向都要编码。
 */
globalThis.MESSAGES = Object.freeze({
  TRANSCRIBE: 'asr:transcribe',
  FILL_TEXT: 'asr:fill-text',
  TAB_RECORD_START: 'asr:tab-record-start',
  TAB_RECORD_STOP: 'asr:tab-record-stop',
});

/** 消息路由目标（缺省为 background）。 */
globalThis.TARGETS = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  CONTENT: 'content',
});

/**
 * Blob → 消息可传的 { b64, mime }（见文件头「音频为什么编码传输」）。
 * 分块转 base64，避免大音频一次 String.fromCharCode 栈溢出。
 * @param {Blob} blob
 * @returns {Promise<{b64: string, mime: string}>}
 */
globalThis.encodeAudio = async function encodeAudio(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { b64: btoa(binary), mime: blob.type || 'audio/webm' };
};

/**
 * encodeAudio 的逆操作。
 * @param {{b64: string, mime?: string}} enc
 * @returns {Blob|null} 形状不合法时返回 null（调用方按 NO_AUDIO 处理）
 */
globalThis.decodeAudio = function decodeAudio(enc) {
  if (!enc || typeof enc.b64 !== 'string') return null;
  try {
    const binary = atob(enc.b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: enc.mime || 'audio/webm' });
  } catch {
    return null;
  }
};
