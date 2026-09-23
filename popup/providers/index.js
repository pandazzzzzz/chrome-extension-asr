/**
 * Provider registry — list of all available ASR providers.
 * To add a new provider:
 *   1. Create a file in this folder extending BaseProvider.
 *   2. Import the script in popup.html (before app.js).
 *   3. Add it to the PROVIDERS array below.
 */
const PROVIDERS = [
  globalThis.QwenProvider,
  globalThis.OpenAIProvider,
  globalThis.DeepgramProvider,
];

globalThis.PROVIDERS = PROVIDERS;
