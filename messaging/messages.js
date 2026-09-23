/**
 * Messages — 跨上下文消息契约定义。
 *
 * 约定所有消息统一形如:
 *   { type: 'asr:transcribe', payload: { ... }, requestId: '...' }
 *
 * - type:      'asr:' 命名空间 + 动作名，避免与其他代码冲突
 * - payload:   动作专属参数
 * - requestId: 由发送方生成的唯一 ID，用于关联请求/响应
 *
 * 响应统一形如:
 *   { ok: true,  data: ... }          成功
 *   { ok: false, error: { code, message } }  失败
 *
 * 当前定义的动作：
 *   asr:transcribe       popup/content → background
 *                        payload: { audioBlob, provider, model, endpoint }
 *                        data:    string (转录文本)
 *
 *   asr:fill-text        popup → background → content
 *                        payload: { text }
 *                        background 转发到当前活动 tab 的 content script，
 *                        content 把 text 注入当前聚焦的 input/textarea。
 *
 *   asr:transcribe-and-fill  content → background（经 background 代理转录，
 *                             完成后由 content 自行注入；此动作当前仍返回文本，
 *                             注入由 content 侧完成）
 *                             payload 同 transcribe
 */
globalThis.MESSAGES = Object.freeze({
  TRANSCRIBE: 'asr:transcribe',
  TRANSCRIBE_AND_FILL: 'asr:transcribe-and-fill',
  FILL_TEXT: 'asr:fill-text',
});
