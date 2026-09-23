/**
 * Provider registry — list of all available ASR providers.
 *
 * To add a new provider:
 *   1. Create a file in this folder extending BaseProvider.
 *   2. Import the script in popup.html (before app.js) and/or via
 *      importScripts in background.js.
 *   3. Add it to the PROVIDERS array below.
 *
 * Capability metadata on each provider (isLocal / supportsStreaming /
 * hasEndpoint / defaultModel) drives dispatch in transcriber.js and UI.
 */
const PROVIDERS = [
  globalThis.QwenProvider,
  globalThis.OpenAIProvider,
  globalThis.DeepgramProvider,
].filter(Boolean); // tolerate a provider script not yet loaded

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));

/**
 * Find a provider by id.
 * @param {string} id
 * @returns {object|null}
 */
globalThis.getProviderById = function getProviderById(id) {
  return PROVIDER_MAP.get(id) || null;
};

globalThis.PROVIDERS = PROVIDERS;
