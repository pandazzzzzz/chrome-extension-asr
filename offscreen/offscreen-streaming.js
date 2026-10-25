// Offscreen document — Live Stream 会话宿主。
//
// 为什么在这里：MV3 的 popup/sidepanel 随焦点/关闭销毁，而麦克风 PCM 采集与
// WebSocket 必须活到用户主动停止；service worker 没有 DOM/AudioContext。
// offscreen 文档由 background 创建并协调（与标签页录音共享同一份单例文档），
// 因此流式会话可以跨越 popup 的整个生命周期。
//
// 协议（见 messaging/messages.js）：
//   background → offscreen  STREAM_START  { apiKey, providerId, model, endpoint,
//                                           subtitles, targetTabId, audioInput }
//                           STREAM_STOP   {}
//                           STREAM_SET_SUBTITLES { subtitles }
//   offscreen → background  STREAM_ENDED  { reason }         会话已自行收尾（远端终止）
//   offscreen → 扩展页      STREAM_UPDATE  { kind, ... }      target:'ui' 单向广播
//
// 文本真相源在本模块（finalText/partialText）：popup 只是镜像。provider 契约
// （createStreamSession / createPcmCapture / openMicrophone）与 popup 时代完全一致。
(() => {
  const MESSAGES = globalThis.MESSAGES;
  const TARGETS = globalThis.TARGETS;
  const Errors = globalThis.Errors;

  // 与 popup 时代的 STREAM.frameSize 一致（16kHz = 16ms/帧，调优常量，勿改）。
  const FRAME_SIZE = 256;

  let session = null; // 会话真身：null = 空闲
  let streamSeq = 0;  // 每次自增，跨会话竞态防护（延迟回调归属判断）

  function broadcastUpdate(kind, extra) {
    chrome.runtime.sendMessage({
      type: MESSAGES.STREAM_UPDATE,
      payload: { kind, ...extra },
      target: TARGETS.UI,
    }).catch(() => {});
  }

  // 诊断事件：与 popup 时代同格式，target:'debug' 由 background 中转诊断页。
  function debugEvt(ev, data) {
    chrome.runtime.sendMessage({
      type: MESSAGES.DEBUG_EVT,
      payload: { ev, ...data },
      target: TARGETS.DEBUG,
    }).catch(() => {});
  }

  // 把最终文本写历史 + 收字幕浮层。历史写入已迁到常驻上下文（本模块），
  // popup 关闭不再丢历史 —— 这正是迁移要修的问题。
  async function finalizeSession(reason) {
    if (!session || session.finalSaved) return;
    session.finalSaved = true;
    // 服务端最后一句可能没有 sentence_end 标记，收尾前并入
    if (session.partialText) {
      session.finalText = `${session.finalText} ${session.partialText}`.trim();
      session.partialText = '';
    }
    const finalText = session.finalText.trim();
    debugEvt(reason === 'remote' ? 'stream-pagehide-like-end' : 'stream-finalized', {
      len: finalText.length,
      reason,
    });
    if (finalText) {
      broadcastUpdate('final-text', { text: finalText });
      try {
        await chrome.runtime.sendMessage({
          type: MESSAGES.HISTORY_ADD,
          payload: { text: finalText, provider: session.providerId, model: session.model },
          target: TARGETS.BACKGROUND,
        });
      } catch (e) {
        debugEvt('history-error', { message: e?.message || String(e) });
      }
      if (session.subtitles) {
        // done=true 让浮层自动淡出；失败只打点（chrome:// 页等本就无浮层）
        chrome.runtime.sendMessage({
          type: MESSAGES.SUBTITLE_SHOW,
          payload: { text: finalText, done: true, tabId: session.targetTabId },
          target: TARGETS.BACKGROUND,
        }).catch(() => {});
      }
    }
  }

  async function teardownSession() {
    if (!session) return;
    const s = session;
    session = null;
    stopPcmStats();
    try {
      s.capture?.stop();
    } catch {
      /* ignore */
    }
    try {
      s.wsSession?.close();
    } catch {
      /* ignore */
    }
    s.stream?.getTracks().forEach((t) => t.stop());
    if (s.context) await s.context.close().catch(() => {});
  }

  // 每收到一帧 PCM：重采样到目标采样率 → Int16 → WebSocket（服务端负责分段）
  function onStreamFrame(frame) {
    const s = session;
    if (!s || !s.wsSession || !s.context || !s.targetSampleRate) return;
    const resampled = globalThis.resampleFloat32(frame, s.context.sampleRate, s.targetSampleRate);
    const int16 = globalThis.floatToInt16(resampled);
    s.wsSession.sendAudio(int16);
  }

  function onStreamResult({ text, sentenceEnd }) {
    const s = session;
    if (!s) return;
    if (sentenceEnd) {
      s.finalText = `${s.finalText} ${text}`.trim();
      s.partialText = '';
    } else {
      s.partialText = text;
    }
    const parts = [s.finalText, s.partialText].filter(Boolean).join(' ');
    broadcastUpdate('text', { text: parts.trim() });
    if (s.subtitles && parts.trim()) {
      chrome.runtime.sendMessage({
        type: MESSAGES.SUBTITLE_SHOW,
        payload: { text: parts.trim(), done: false, tabId: s.targetTabId },
        target: TARGETS.BACKGROUND,
      }).catch(() => {});
    }
  }

  // 服务端/网络终止：offscreen 自行收尾（popup 可能已经不在了，等它救场只会丢历史）
  function handleRemoteEnd() {
    if (!session) return;
    session.endedRemotely = true;
    broadcastUpdate('error-status', { message: 'Stream ended by the server or network.' });
    void endSession('remote');
  }

  // 唯一收尾路径：finalize → teardown → 通知 background 清状态（它决定是否回收文档）
  async function endSession(reason) {
    if (!session) return;
    const endedRemotely = reason === 'remote' || session.endedRemotely;
    await finalizeSession(reason);
    await teardownSession();
    debugEvt('stream-stopped-offscreen', { reason: endedRemotely ? 'remote' : 'user' });
    try {
      await chrome.runtime.sendMessage({
        type: MESSAGES.STREAM_ENDED,
        payload: { reason: endedRemotely ? 'remote' : 'user' },
        target: TARGETS.BACKGROUND,
      });
    } catch {
      /* SW 挂起重启窗口：状态标记有 isStreamActive 的文档对账兜底 */
    }
  }

  async function startStreaming(payload) {
    if (session) return { ok: false, error: Errors.ALREADY_RECORDING };

    const provider = (globalThis.PROVIDERS || []).find((p) => p.id === payload?.providerId);
    if (!provider?.supportsStreaming) {
      return { ok: false, error: globalThis.createError(Errors.API_ERROR, 'Provider does not support streaming') };
    }
    const apiKey = payload?.apiKey || '';
    if (!apiKey) return { ok: false, error: globalThis.createError(Errors.API_ERROR, 'API key required') };

    let stream;
    try {
      stream = await globalThis.openMicrophone(payload.audioInput || '');
    } catch (e) {
      return { ok: false, error: globalThis.createError(Errors.RECORD_ERROR, e.message || '') };
    }
    const fellBack = stream.fellBack === true;
    const micStream = stream.stream;
    if (fellBack) broadcastUpdate('status', { text: 'Selected microphone is unavailable — using system default.', type: 'error' });

    const myStreamSeq = ++streamSeq;
    const s = {
      streamSeq: myStreamSeq,
      stream: micStream,
      context: null,
      capture: null,
      wsSession: null,
      providerId: provider.id,
      apiKey,
      model: payload.model || provider.defaultStreamModel || '',
      endpoint: payload.endpoint || undefined,
      subtitles: !!payload.subtitles,
      targetTabId: payload.targetTabId ?? null,
      finalText: '',
      partialText: '',
      targetSampleRate: 0,
      endedRemotely: false,
      finalSaved: false,
      micFallback: fellBack,
    };
    session = s;

    try {
      const targetSampleRate = provider.sampleRateFor(s.model);
      s.targetSampleRate = targetSampleRate;

      // 直接把 AudioContext 建在目标采样率（同 popup 时代），浏览器做原生重采样
      let context;
      try {
        context = new AudioContext({ sampleRate: targetSampleRate });
      } catch {
        context = new AudioContext();
      }
      s.context = context;
      await context.resume();

      // 模型回落必须发生在 sampleRateFor 之后取值覆盖 —— 与 popup 时代同序
      if (!provider.isStreamModel(s.model) && provider.defaultStreamModel) {
        debugEvt('model-fallback', { requested: s.model, using: provider.defaultStreamModel });
        s.model = provider.defaultStreamModel;
        s.targetSampleRate = provider.sampleRateFor(s.model);
      }

      const wsSession = provider.createStreamSession({
        apiKey: s.apiKey,
        model: s.model,
        endpoint: s.endpoint,
        onResult: (r) => {
          if (!session || session.streamSeq !== myStreamSeq) return;
          onStreamResult(r);
        },
        onError: (e) => {
          if (!session || session.streamSeq !== myStreamSeq) return;
          debugEvt('ws-error', { message: e?.message || String(e) });
          broadcastUpdate('error-status', { message: `Stream error: ${e.message}` });
        },
        onComplete: () => {
          if (!session || session.streamSeq !== myStreamSeq) return;
          debugEvt('ws-complete', {});
        },
        // 服务端/网络终止：offscreen 在常驻上下文里，必须自己收尾（不能等 popup）
        onEnd: () => {
          debugEvt('ws-end-received', {});
          if (!session || session.streamSeq !== myStreamSeq) {
            debugEvt('ws-end-stale', {});
            return;
          }
          handleRemoteEnd();
        },
        onEvent: (e) => debugEvt(e.ev, e),
      });
      try {
        await wsSession.ready;
      } catch (e) {
        debugEvt('ws-ready-fail', { message: e?.message || String(e) });
        wsSession.close();
        throw e;
      }
      s.wsSession = wsSession;

      s.capture = globalThis.createPcmCapture({
        stream: micStream,
        context,
        frameSize: FRAME_SIZE,
        onFrame: onStreamFrame,
      });
      await s.capture.start();
      startPcmStats(context.sampleRate, s.targetSampleRate);
      debugEvt('streaming-active-offscreen', { model: s.model });
      broadcastUpdate('status', { text: 'Streaming: speak, results will appear as you go.', type: 'success' });
      broadcastUpdate('active', {
        providerId: s.providerId,
        model: s.model,
        micFallback: fellBack,
      });
      return {
        ok: true,
        data: {
          streaming: true,
          model: s.model,
          micFallback: fellBack,
        },
      };
    } catch (e) {
      // 启动失败：状态已挂上（session !== null），统一收尾保持不变式
      debugEvt('start-error-offscreen', { message: e?.message || String(e) });
      broadcastUpdate('error-status', { message: `Cannot start streaming: ${e.message}` });
      await endSession('user');
      return { ok: false, error: globalThis.createError(Errors.OFFSCREEN_ERROR, e.message || '') };
    }
  }

  async function stopStreaming() {
    if (!session) return { ok: false, error: Errors.NOT_RECORDING };
    await endSession('user');
    return { ok: true, data: { streaming: false } };
  }

  function setSubtitles(subtitles) {
    if (session) session.subtitles = !!subtitles;
    return { ok: true, data: { subtitles: !!subtitles } };
  }

  function getState() {
    if (!session) return { ok: true, data: { streaming: false } };
    const parts = [session.finalText, session.partialText].filter(Boolean).join(' ');
    return {
      ok: true,
      data: {
        streaming: true,
        providerId: session.providerId,
        model: session.model,
        targetTabId: session.targetTabId,
        micFallback: session.micFallback || false,
        text: parts.trim(),
      },
    };
  }

  // PCM 统计（与 popup 时代同形，1s 周期打点，诊断页观察丢帧）
  let pcmStats = { frames: 0, bytes: 0, lastRate: 0, lastTarget: 0 };
  let pcmTimer = null;
  function startPcmStats(sampleRate, targetRate) {
    pcmStats = { frames: 0, bytes: 0, lastRate: sampleRate, lastTarget: targetRate };
    if (pcmTimer) clearInterval(pcmTimer);
    pcmTimer = setInterval(() => {
      debugEvt('pcm-stats', {
        ctxRate: pcmStats.lastRate,
        target: pcmStats.lastTarget,
        framesPerSec: pcmStats.frames,
        bytesPerSec: pcmStats.bytes,
      });
      pcmStats.frames = 0;
      pcmStats.bytes = 0;
    }, 1000);
  }
  function stopPcmStats() {
    if (!pcmTimer) return;
    clearInterval(pcmTimer);
    pcmTimer = null;
    debugEvt('pcm-stats-final', {
      ctxRate: pcmStats.lastRate,
      target: pcmStats.lastTarget,
      framesPerSec: pcmStats.frames,
      bytesPerSec: pcmStats.bytes,
    });
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.target !== TARGETS.OFFSCREEN) return false;
    // 只认领流式家族（契约前缀，覆盖未来新增动作）。同一文档还有 offscreen.js
    // 的监听器（先注册）：Chrome 只取第一个实际回包的监听器，任何一侧替对方
    // 家族抢答（哪怕是 UNKNOWN_ACTION）都会把真实结果挤掉 —— #58 正来源于此。
    if (typeof request.type !== 'string' || !request.type.startsWith('asr:stream-')) return false;
    (async () => {
      switch (request.type) {
        case MESSAGES.STREAM_START:
          return await startStreaming(request.payload || {});
        case MESSAGES.STREAM_STOP:
          return await stopStreaming();
        case MESSAGES.STREAM_SET_SUBTITLES:
          return setSubtitles(request.payload?.subtitles);
        case MESSAGES.STREAM_STATE:
          return getState();
        default:
          return { ok: false, error: globalThis.createError(Errors.UNKNOWN_ACTION, 'Unknown message type') };
      }
    })()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: globalThis.createError(Errors.OFFSCREEN_ERROR, e.message || '') }));
    return true;
  });
})();
