/**
 * OpenAI provider (audio/transcriptions API).
 *
 * Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 * Endpoint: https://api.openai.com/v1/audio/transcriptions
 *
 * 模型说明（2026 起）：
 *   - 默认 `gpt-4o-mini-transcribe`：成本/速度均衡的新一代转录模型
 *   - 可选 `gpt-4o-transcribe`（更高质量）、`gpt-4o-transcribe-diarize`（说话人标注）
 *   - `whisper-1` 仍可用（开源 Whisper V2 驱动），但不再是推荐项
 *   - 新模型仅支持 `response_format=json`（默认即是），不支持 `prompt` 参数
 */
class OpenAIProvider extends BaseProvider {
  static id = 'openai';
  static name = 'OpenAI Transcription';
  static defaultModel = 'gpt-4o-mini-transcribe';
  static hasEndpoint = true;

  static getDefaultEndpoint() {
    return 'https://api.openai.com/v1/audio/transcriptions';
  }

  static async transcribe({ audioBlob, apiKey, model, endpoint }) {
    if (!apiKey) throw new Error('API key is required');
    if (!model) throw new Error('Model name is required');
    if (!endpoint) endpoint = this.getDefaultEndpoint();

    const format = this.getAudioFormat(audioBlob.type);
    const filename = `audio.${format}`;
    const formData = new FormData();
    formData.append('file', audioBlob, filename);
    formData.append('model', model);

    const json = await this.post(endpoint, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    const text = json.text;
    if (!text) throw new Error('Empty transcription result');
    return text;
  }
}

globalThis.OpenAIProvider = OpenAIProvider;
