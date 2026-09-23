/**
 * Qwen ASR provider (DashScope, OpenAI-compatible API).
 *
 * Docs: https://help.aliyun.com/zh/dashscope/
 * Endpoints:
 *   cn   — https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
 *   intl — https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
 */
class QwenProvider extends BaseProvider {
  static id = 'qwen';
  static name = 'Qwen (DashScope)';
  static defaultModel = 'qwen3-asr-flash';
  static hasEndpoint = true;

  static getDefaultEndpoint() {
    return 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  }

  static async transcribe({ audioBlob, apiKey, model, endpoint }) {
    if (!apiKey) throw new Error('API key is required');
    if (!model) throw new Error('Model name is required');
    if (!endpoint) endpoint = this.getDefaultEndpoint();

    const dataUrl = await this.blobToDataUrl(audioBlob);
    const format = this.getAudioFormat(audioBlob.type);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        modalities: ['text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Please transcribe the speech to text.' },
              { type: 'input_audio', input_audio: { data: dataUrl, format } },
            ],
          },
        ],
      }),
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error?.message || `HTTP ${response.status}`);
    }

    const text = this._extractText(json);
    if (!text) throw new Error('Empty transcription result');
    return text;
  }

  static _extractText(json) {
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((item) => item.text || item.transcript || '')
        .join('\n')
        .trim();
    }
    if (typeof content === 'object' && content.text) return String(content.text).trim();
    return '';
  }
}

globalThis.QwenProvider = QwenProvider;
