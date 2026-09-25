/**
 * Deepgram provider (listen API).
 *
 * Docs: https://developers.deepgram.com/reference/listen-file
 * Endpoint: https://api.deepgram.com/v1/listen
 *
 * 模型说明（2026 起）：默认 `nova-3`（当前推荐主力模型）。
 * `nova-2` 仍可用但已被取代；响应形状（results.channels[].alternatives[].transcript）
 * 两代一致，换模型无需改解析。
 */
class DeepgramProvider extends BaseProvider {
  static id = 'deepgram';
  static name = 'Deepgram';
  static defaultModel = 'nova-3';
  static hasEndpoint = true;

  static getDefaultEndpoint() {
    return 'https://api.deepgram.com/v1/listen';
  }

  static async transcribe({ audioBlob, apiKey, model, endpoint }) {
    if (!apiKey) throw new Error('API key is required');
    if (!endpoint) endpoint = this.getDefaultEndpoint();

    const url = new URL(endpoint);
    if (model) {
      url.searchParams.set('model', model);
    }

    const json = await this.post(url.toString(), {
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': audioBlob.type || 'audio/webm',
      },
      body: audioBlob,
      extractError: (json) => json.err_msg || json.message,
    });

    const text = json?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (!text) throw new Error('Empty transcription result');
    return text;
  }
}

globalThis.DeepgramProvider = DeepgramProvider;
