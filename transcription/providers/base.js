/**
 * BaseProvider — ASR provider 基类（流式版）。
 *
 * 流式转录（realtime WebSocket）所需的最小接口：
 *   - 能力元数据：supportsStreaming / isStreamModel / streamModels / defaultStreamModel
 *   - createStreamSession()：建立 WebSocket 流式会话
 *
 * 批量 transcribe() 已随旧伪流式删除；如需批量转录，将来在重建时补回。
 *
 * 每个 provider 声明（static）：
 *   - id, name
 *   - hasEndpoint:   是否需要 endpoint URL
 *   - supportsStreaming: 是否支持真 WebSocket 流式
 *   - streamModels:  可用 run-task 的模型白名单（默认空 = 一个都不接受）
 *   - defaultStreamModel: 流式默认模型名
 */
class BaseProvider {
  static id = 'base';
  static name = 'Base';
  static hasEndpoint = false;
  /**
   * provider 支持的地域。每个地域给出对应的真流式 endpoint（无 prefix 的相对 URL，
   * resolveEndpoint(region) 会按 URL/相对路径规则解析）。
   *
   * 地域与 API Key 强绑定（官方「API Key 必须与地域匹配」），故把地域选项放在 provider
   * 层级而非仅在 UI 层配置 —— 切换 provider 自动给出匹配的默认 endpoint。
   *
   * 至少必须含 `custom`：用户手工填 endpoint URL 的兜底入口（业务空间专属域名、第三方
   * 代理等场景）。`custom` 的 endpoint 留空，由 UI 文本框收集。
   */
  static regions = [
    { id: 'custom', label: 'Custom', endpoint: '' },
  ];


  /**
   * 真流式默认模型（supportsStreaming 的 provider 覆写；流式与批量模型常不同）。
   * 基类为空串 —— 未声明默认模型的 provider 视为不支持流式。
   */
  static defaultStreamModel = '';

  /**
   * run-task 可用模型白名单。基类为空数组：不显式声明的 provider 一个模型都不接受。
   *
   * 不能用 /realtime|streaming/ 之类的名字正则代替白名单：百炼有多套 WebSocket 协议，
   * 模型名里都带 "realtime" 但接入路径不同 —— `qwen3-asr-flash-realtime` /
   * `qwen-audio-3.x-realtime-*` / `*-omni-*-realtime` / `*-livetranslate-*` 走会话制的
   * `/api-ws/v1/realtime`（模型名在 URL query，用 session.update / input_audio_buffer.*），
   * 而本 provider 走任务制的 `/api-ws/v1/inference`（模型名在 run-task.payload.model）。
   * 名字正则会把这些模型放行 → run-task 发到错误的路径 → 服务端 task-failed。
   *
   * 匹配规则：与白名单项完全相等，或以 `<项>-` 开头（覆盖带日期/规格后缀的快照版本）。
   */
  static streamModels = [];

  /**
   * Resolve endpoint for a given region id. Falls back to the first region
   * (then to `getDefaultStreamEndpoint()` for legacy callers) if the id is
   * unknown. `custom` returns `''` — the caller is expected to read the
   * user-supplied URL from storage.
   * @param {string} regionId
   * @returns {string}
   */
  static endpointFor(regionId) {
    if (regionId) {
      const r = (this.regions || []).find((x) => x.id === regionId);
      if (r) return r.endpoint;
    }
    const fallback = (this.regions || [])[0];
    if (fallback && fallback.endpoint) return fallback.endpoint;
    return this.getDefaultStreamEndpoint ? this.getDefaultStreamEndpoint() : '';
  }

  /**
   * 判断一个模型名是否可用于本 provider 的真流式（run-task / /api-ws/v1/inference）。
   * @param {string} model
   * @returns {boolean}
   */
  static isStreamModel(model) {
    if (!model) return false;
    return this.streamModels.some((m) => model === m || model.startsWith(`${m}-`));
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

}

globalThis.BaseProvider = BaseProvider;
