/**
 * Qwen ASR provider (DashScope) — 真流式（WebSocket run-task 协议）。
 *
 * Docs: https://help.aliyun.com/zh/dashscope/
 * 流式 endpoint: wss://dashscope.aliyuncs.com/api-ws/v1/inference
 *
 * 批量 transcribe() 已随旧伪流式删除；本 provider 只提供真 WebSocket 流式
 * （run-task 协议，详见 createStreamSession 注释）。
 */
class QwenProvider extends BaseProvider {
  static id = 'qwen';
  static name = 'Qwen (DashScope)';
  static defaultModel = 'fun-asr-realtime'; // 流式默认模型
  static hasEndpoint = true;
  static supportsStreaming = true;
  // 真流式只支持 Qwen-Audio-3.x-ASR-Flash-Streaming 与 Fun-ASR-Realtime 系列；
  // 批量模型（qwen3-asr-flash 等）发给 run-task 会被服务端 task-failed。
  static defaultStreamModel = 'fun-asr-realtime';

  /** 实时流式 ASR 的默认 WebSocket endpoint（通用地域）。 */
  static getDefaultStreamEndpoint() {
    return 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  }

  /**
   * 实时流式 ASR（WebSocket，run-task 协议）。
   *
   * 协议依据官方「客户端事件 / 服务端事件」文档与 paraformer-realtime-js demo：
   *   1. onopen → 发 run-task（task_group=audio / task=asr / function=recognition）
   *   2. task-started → ready resolve，之后才可发音频
   *   3. 音频帧以二进制 Int16Array 发送（16kHz / 16-bit / 单声道小端 PCM）
   *   4. result-generated → payload.output.sentence.text；sentence_end=true 为完整句；
   *      heartbeat=true 的心跳包跳过
   *   5. finish-task → task-finished；失败时服务端发 task-failed（header.error_message），
   *      连接被服务端关闭
   *
   * 参数取舍：
   *   - 不传 language_hints：服务端默认自动识别语种（Fun-ASR 系列最多只认 1 个值，
   *     硬编码 ['zh'] 会把英文等强制当中文）
   *   - heartbeat=true：持续静音时保活连接（否则超时断开）；心跳包由上面第 4 步过滤
   *   - 不传 disfluency_removal_enabled（不在官方参数表中）
   *
   * 鉴权：浏览器 WebSocket 无法自定义 header，apiKey 走 URL query 参数。
   * 安全边界：本方法在 popup/sidepanel 调用，apiKey 进入页面 JS —— MV3 service
   * worker 无法持长连接，这是浏览器扩展的固有取舍（密钥仍只来自本地加密存储）。
   *
   * @param {Object} opts 见 BaseProvider.createStreamSession 约定
   * @returns {{ ready: Promise<void>, sendAudio, stop, close }}
   *   ready：task-started 后 resolve；启动失败/超时（10s）reject —— 调用方应先 await
   *   再开始采音，避免丢掉 task-started 之前的音频。
   *   终止回调：onResult（逐句）、onError（失败）、onComplete（finish-task 确认）、
   *   onEnd（会话被服务端/网络终止，调用方应 teardown 并复位 UI）。
   *   调试回调：onEvent（可选）—— 协议各节点打点 { ev, ...detail }，供诊断页观测；
   *   未提供则零开销，且 detail 永不含 apiKey / 完整 wsUrl。
   */
  static createStreamSession({ apiKey, model, endpoint, onResult, onError, onComplete, onEnd, onEvent }) {
    if (!apiKey) throw globalThis.createError(globalThis.Errors.NO_API_KEY);

    // 协议事件打点（可选回调，未提供则无操作）。绝不携带 apiKey / 完整 wsUrl。
    function track(ev, detail) {
      if (onEvent) {
        try { onEvent({ ev, ...detail }); } catch { /* 打点失败不影响协议 */ }
      }
    }

    const streamModel = model || this.defaultStreamModel;
    if (!this.isStreamModel(streamModel)) {
      throw globalThis.createError(
        globalThis.Errors.UNKNOWN,
        `"${streamModel}" is a batch model; realtime requires fun-asr-realtime or qwen-audio-3.x-asr-flash-streaming`,
      );
    }

    const base = endpoint || this.getDefaultStreamEndpoint();
    // 只接受 ws(s):// 的 WebSocket URL。endpoint 字段占位符是 https://...，批量时代的配置
    // 可能留了 https REST URL（如 https://dashscope.aliyuncs.com/api/v1/...）—— 直接喂给
    // new WebSocket('https://…') 会抛 SyntaxError，且每次 Live Stream 都起不来。这里提前报错。
    if (!/^wss?:\/\//i.test(base)) {
      throw globalThis.createError(
        globalThis.Errors.UNKNOWN,
        `"${base}" is not a WebSocket URL; streaming requires wss:// (e.g. ${this.getDefaultStreamEndpoint()})`,
      );
    }
    const sep = base.includes('?') ? '&' : '?';
    const wsUrl = `${base}${sep}api_key=${encodeURIComponent(apiKey)}`;

    const socket = new WebSocket(wsUrl);
    const taskId = this._generateUUID();

    let started = false;
    let readySettled = false;
    let finishedSettled = false;
    let resolveReady;
    let rejectReady;
    let resolveFinished;

    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {}); // 防调用方未 await 时产生 unhandled rejection
    const finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });

    const readyTimer = setTimeout(() => {
      track('ready-timeout', { model: streamModel });
      fail(new Error('Timed out waiting for task-started (check model / API key)'));
    }, 10000);

    function markStarted() {
      if (readySettled) return;
      readySettled = true;
      started = true;
      clearTimeout(readyTimer);
      resolveReady();
      track('task-started', { model: streamModel, taskId });
    }

    // 终态：失败/服务端关闭/任务结束 —— 解锁 ready 与 finished，失败时上报，且只触发一次 onEnd。
    // onEnd 通知调用方（app）「会话已被服务端或网络终止」，由其统一走 teardown —— 否则 UI
    // 会一直停在 streaming 态：isStreaming=true、麦克风继续采、sendAudio 静默空转、按钮卡在 Stop。
    function fail(error) {
      if (finishedSettled) return;
      finishedSettled = true;
      clearTimeout(readyTimer);
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      resolveFinished();
      track('session-end', { started, message: error ? error.message : null });
      if (error) onError?.(error);
      onEnd?.();
    }

    socket.onopen = () => {
      track('ws-open', { taskId });
      socket.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: streamModel,
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            heartbeat: true, // 静音保活，防长时间无语音导致服务端超时断连
          },
          input: {},
        },
      }));
      track('run-task-sent', { model: streamModel });
    };

    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // 非 JSON 帧（如二进制回包）忽略
      }

      const header = message?.header || {};
      switch (header.event) {
        case 'task-started':
          markStarted();
          break;
        case 'task-finished':
          // 任务正常结束（无论之前是否启动成功）
          if (!readySettled) {
            readySettled = true;
            rejectReady(new Error('Task finished before it started'));
          }
          finishedSettled = true;
          clearTimeout(readyTimer);
          resolveFinished();
          track('task-finished', { taskId });
          onComplete?.();
          onEnd?.();
          socket.close();
          break;
        case 'task-failed':
          // 服务端失败并会关闭连接：上报错误并解锁等待
          track('task-failed', {
            message: header.error_message || header.error_code || 'Realtime task failed',
          });
          fail(globalThis.createError(
            globalThis.Errors.API_ERROR,
            header.error_message || header.error_code || 'Realtime task failed',
          ));
          break;
        case 'result-generated': {
          const sentence = message?.payload?.output?.sentence;
          if (!sentence || sentence.heartbeat) {
            // 心跳包（sentence_id=0）跳过 —— 但也计数，便于判断静音保活是否在跑
            if (sentence?.heartbeat) track('heartbeat', {});
            return;
          }
          const text = (sentence.text || '').trim();
          if (!text) return;
          track('result', {
            sentenceEnd: !!sentence.sentence_end,
            sentenceId: sentence.sentence_id,
            len: text.length,
          });
          onResult?.({
            text,
            sentenceEnd: !!sentence.sentence_end,
            sentenceId: sentence.sentence_id,
          });
          break;
        }
        default:
          break;
      }
    };

    socket.onerror = () => {
      // 具体原因由 onclose 兜底（浏览器不暴露 WS 错误细节）
      track('ws-error', { finishedSettled });
      if (!finishedSettled) fail(new Error('WebSocket connection error'));
    };

    socket.onclose = (event) => {
      // 网络断/服务端主动关闭：未正常结束也按终态处理，避免 stop() 永久挂起
      if (!finishedSettled) {
        const reason = event?.reason || '';
        track('ws-close', { wasClean: !!event?.wasClean, code: event?.code, reason, started });
        fail(started ? null : new Error('WebSocket closed before task started'));
      }
    };

    return {
      ready,
      sendAudio(int16Data) {
        // task-started 前丢弃（调用方应 await ready 后再采音）；非 Int16 拒发
        if (!started || socket.readyState !== WebSocket.OPEN) return;
        if (!(int16Data instanceof Int16Array)) return;
        socket.send(int16Data);
      },
      async stop() {
        if (finishedSettled) return;
        if (started && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }));
        } else {
          // 尚未启动（如启动失败）：关连接，onclose 会解锁 finished
          socket.close();
        }
        // 等服务端 task-finished 确认；但加超时兜底——服务端不回、连接又不关（弱网/代理卡住）
        // 时不能永久挂起，否则调用方 stopStreaming 卡住、teardown 不跑、麦克风常驻。
        track('stop-sent', { started, socketState: socket.readyState });
        // finished 先到时要清掉超时定时器，避免 timer 残留挂住 5s（已定态后仍触发 resolve，无意义）
        let timer = null;
        const winner = await Promise.race([
          finished.then(() => {
            if (timer) clearTimeout(timer);
            return 'finished';
          }),
          new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5000); }),
        ]);
        track('stop-done', { winner });
      },
      close() {
        track('ws-close-requested', { finishedSettled });
        socket.close();
      },
    };
  }

  static _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

globalThis.QwenProvider = QwenProvider;
