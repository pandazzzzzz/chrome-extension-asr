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
 *                        payload: { audioBlob, provider, model, endpoint }
 *                        data:    string (转录文本)
 *
 *   asr:fill-text        popup → background → content
 *                        payload: { text }
 *                        data:    true（content 已注入）
 *
 *   asr:tab-record-start popup → background → offscreen
 *                        payload: { streamId }（background 取得的 tabCapture streamId）
 *                        data:    true
 *
 *   asr:tab-record-stop  popup → background → offscreen
 *                        payload: {}
 *                        data:    Blob（录制音频）
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
