/**
 * Transcriber — 统一转录调度层。
 *
 * 职责：
 *   - 根据 providerId 找到 provider（getProviderById）
 *   - 校验入参（audioBlob / provider / apiKey）—— 抛带 code 的 Error
 *   - 调用 provider.transcribe
 *   - 结果归一（空结果抛 EMPTY_RESULT）
 *
 * 不负责：消息格式、密钥读取、配置管理（由调用方 background 处理）。
 * 错误约定：抛出带 code 的 Error，调用方用 normalizeError 归一化为响应。
 *
 * 能力感知：本地 provider（isLocal=true）跳过 apiKey 校验，见 P2b。
 */
globalThis.Transcriber = (() => {
  /**
   * @param {object} opts
   * @param {Blob}   opts.audioBlob
   * @param {string} opts.providerId  provider id（显式传入优先于配置默认）
   * @param {string} [opts.apiKey]     云端 provider 需要；本地 provider 可省
   * @param {string} [opts.model]
   * @param {string} [opts.endpoint]
   * @returns {Promise<string>} 转录文本
   * @throws {Error & {code:string}} 带 code 的错误，调用方用 normalizeError 归一化
   */
  async function transcribe({ audioBlob, providerId, apiKey, model, endpoint }) {
    if (!audioBlob) throw globalThis.createError(globalThis.Errors.NO_AUDIO);

    const provider = globalThis.getProviderById(providerId);
    if (!provider) throw globalThis.createError(globalThis.Errors.NO_PROVIDER);

    // 本地 provider 不需要 apiKey（音频不出设备，无云端凭证）
    if (!provider.isLocal && !apiKey) {
      throw globalThis.createError(globalThis.Errors.NO_API_KEY);
    }

    const text = await provider.transcribe({
      audioBlob,
      apiKey,
      model: model || provider.defaultModel,
      endpoint: endpoint || undefined,
    });

    if (!text) throw globalThis.createError(globalThis.Errors.EMPTY_RESULT);
    return text;
  }

  return { transcribe };
})();
