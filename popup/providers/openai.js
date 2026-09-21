/**
 * OpenAI Whisper provider (audio/transcriptions API).
 *
 * Docs: https://platform.openai.com/docs/api-reference/audio/createTranscription
 * Endpoint: https://api.openai.com/v1/audio/transcriptions
 */
class OpenAIProvider extends BaseProvider {
  static id = 'openai';
  static name = 'OpenAI Whisper';
  static defaultModel = 'whisper-1';
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

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    const json = await response.json();
    if (!response.ok) {
      throw new Error(json.error?.message || `HTTP ${response.status}`);
    }

    const text = json.text;
    if (!text) throw new Error('Empty transcription result');
    return text;
  }
}

window.OpenAIProvider = OpenAIProvider;
