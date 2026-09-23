/**
 * BaseProvider — base class for all ASR providers.
 *
 * Each provider must implement:
 *   - id:            string                unique identifier
 *   - name:          string                display name
 *   - defaultModel:  string                default model name
 *   - hasEndpoint:   boolean               whether an endpoint URL is required
 *   - transcribe({ audioBlob, apiKey, model, endpoint }): Promise<string>
 */
class BaseProvider {
  static id = 'base';
  static name = 'Base';
  static defaultModel = '';
  static hasEndpoint = false;

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
}

globalThis.BaseProvider = BaseProvider;
