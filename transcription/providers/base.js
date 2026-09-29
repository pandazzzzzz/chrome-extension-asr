/**
 * BaseProvider — ASR provider 基类（流式版）。
 *
 * 流式转录（realtime WebSocket）所需的最小接口：
 *   - 能力元数据：supportsStreaming / isStreamModel / defaultStreamModel
 *   - createStreamSession()：建立 WebSocket 流式会话
 *
 * 批量 transcribe() 已随旧伪流式删除；如需批量转录，将来在重建时补回。
 *
 * 每个 provider 声明（static）：
 *   - id, name, defaultModel
 *   - hasEndpoint:   是否需要 endpoint URL
 *   - supportsStreaming: 是否支持真 WebSocket 流式
 *   - defaultStreamModel: 流式默认模型名
 */
class BaseProvider {
  static id = 'base';
  static name = 'Base';
  static defaultModel = '';
  static hasEndpoint = false;
  static supportsStreaming = false;

  /** 真流式默认模型（supportsStreaming 的 provider 覆写；流式与批量模型常不同）。 */
  static defaultStreamModel = '';

  /**
   * 判断一个模型名是否可用于真流式（run-task）。
   * 流式与批量模型不同：批量模型发给 run-task 会 task-failed。
   * @param {string} model
   * @returns {boolean}
   */
  static isStreamModel(model) {
    if (!model) return false;
    return /realtime|streaming/i.test(model);
  }

  /**
   * Create a streaming session (真 WebSocket 流式).
   *
   * 仅当 supportsStreaming === true 时由 provider 实现；默认抛错。
   *
   * @param {Object} opts
   * @param {string} opts.apiKey
   * @param {string} [opts.model]      流式模型名（如 fun-asr-realtime）
   * @param {string} [opts.endpoint]   自定义 WebSocket URL
   * @param {(r:{text:string, sentenceEnd:boolean})=>void} opts.onResult  实时回调（sentenceEnd=true 表示完整句）
   * @param {(e:Error)=>void} opts.onError    流式错误回调
   * @param {()=>void} opts.onComplete        finish-task 确认回调
   * @returns {{ ready:Promise<void>, sendAudio:(Int16Array)=>void, stop:()=>Promise<void>, close:()=>void }}
   */
  static createStreamSession() {
    throw new Error('Streaming not supported by this provider');
  }

  /**
   * Helper — 统一 POST：包 fetch + 网络错误/HTTP 状态码归一化为带 code 的 Error。
   * 激活 errors.js 中的 NETWORK / API_ERROR 码。
   * （流式 provider 目前未用，预留给将来 provider 配置/鉴权端点。）
   *
   * @param {string} url
   * @param {Object} init
   * @param {Object} init.headers
   * @param {*} init.body
   * @param {(json:Object)=>string} [extractError]
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
          if (json && typeof json === 'object') {
            message = extractError?.(json) || json.error?.message || message;
          }
        } catch {
          message = text.slice(0, 200) || message;
        }
      }
      throw globalThis.createError(globalThis.Errors.API_ERROR, message);
    }

    const json = JSON.parse(text);
    if (json && typeof json === 'object') return json;
    throw globalThis.createError(
      globalThis.Errors.API_ERROR,
      `Invalid JSON response (HTTP ${response.status})`,
    );
  }
}

globalThis.BaseProvider = BaseProvider;
