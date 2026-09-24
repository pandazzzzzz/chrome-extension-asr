/**
 * BaseProvider — base class for all ASR providers.
 *
 * Each provider must declare (static):
 *   - id:                string    unique identifier
 *   - name:              string    display name
 *   - defaultModel:      string    default model name
 *   - hasEndpoint:       boolean   whether an endpoint URL is required
 *   - isLocal:           boolean   local inference (no API key, no upload) [default false]
 *   - supportsStreaming: boolean  whether provider supports streaming chunks [default false]
 *
 * Each provider must implement:
 *   - transcribe({ audioBlob, apiKey, model, endpoint }): Promise<string>
 *
 * Capability metadata (isLocal / supportsStreaming) drives dispatch in
 * transcriber.js and UI affordances; defaults keep existing providers valid.
 */
class BaseProvider {
  static id = 'base';
  static name = 'Base';
  static defaultModel = '';
  static hasEndpoint = false;
  static isLocal = false;
  static supportsStreaming = false;

  /**
   * @param {Blob} audioBlob
   * @param {Object} options
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {string} [options.endpoint]
   * @returns {Promise<string>} transcribed text
   */
  static async transcribe({ audioBlob, apiKey, model, endpoint }) {
    throw new Error('transcribe() must be implemented by the provider');
  }

  /**
   * Helper — convert a Blob to a base64 data URL.
   * 用 Blob.arrayBuffer()（window 与 service worker 均支持），避免依赖 FileReader。
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  static async blobToDataUrl(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
  }

  /**
   * Helper — extract short audio format string from a mime type.
   * @param {string} mimeType
   * @returns {string} e.g. "wav", "mp3", "webm"
   */
  static getAudioFormat(mimeType) {
    const clean = (mimeType || 'audio/webm').split(';')[0].trim();
    if (clean.endsWith('/wav')) return 'wav';
    if (clean.endsWith('/mp3')) return 'mp3';
    if (clean.endsWith('/mp4')) return 'mp4';
    if (clean.endsWith('/ogg')) return 'ogg';
    if (clean.endsWith('/flac')) return 'flac';
    return 'webm';
  }

  /**
   * Helper — 统一 POST：包 fetch + 网络错误/HTTP 状态码归一化为带 code 的 Error。
   * 激活 errors.js 中的 NETWORK / API_ERROR 码（否则 normalizeError 会降级为 UNKNOWN）。
   *
   * @param {string} url
   * @param {Object} init          fetch init（method 固定 POST）
   * @param {Object} init.headers
   * @param {*} init.body
   * @param {(json:Object)=>string} [extractError]  从非 OK 响应体提取错误消息
   * @returns {Promise<Object>} 解析后的 JSON
   * @throws {Error & {code:string}} NETWORK / API_ERROR
   */
  static async post(url, { headers, body, extractError } = {}) {
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body });
    } catch (e) {
      throw globalThis.createError(
        globalThis.Errors.NETWORK,
        e?.message || 'Network request failed',
      );
    }

    // 先读 body 文本，再按是否 OK 分流：避免非 JSON 错误体（如 5xx HTML）二次抛错
    let text = '';
    try {
      text = await response.text();
    } catch {
      /* 读取失败仍按状态码报错 */
    }

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      if (text) {
        try {
          const json = JSON.parse(text);
          message = extractError?.(json) || json.error?.message || message;
        } catch {
          message = text.slice(0, 200) || message;
        }
      }
      throw globalThis.createError(globalThis.Errors.API_ERROR, message);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw globalThis.createError(
        globalThis.Errors.API_ERROR,
        `Invalid JSON response (HTTP ${response.status})`,
      );
    }
  }
}

globalThis.BaseProvider = BaseProvider;
