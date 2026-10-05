// Offscreen document — 标签页音频采集宿主（MV3 约束：service worker 无 DOM，
// MediaRecorder 与 getUserMedia 必须在 document 里）。
//
// 协议：
//   background → offscreen: { type: 'asr:tab-record-start', target:'offscreen',
//                              payload: { streamId } }  streamId 来自
//   chrome.tabCapture.getMediaStreamId()（Chrome 116+ 可在 service worker 调）
//   offscreen 用 streamId 调 getUserMedia({chromeMediaSource:'tab'}) 拿到
//   流，并用 AudioContext 把捕获音频回放给用户（否则标签页会被静音）。
//   background → offscreen: { type: 'asr:tab-record-stop', target:'offscreen' }
//   offscreen 返回录制得到的 Blob。
//
// 依赖 messaging/messages.js、audio/recorder.js（由 offscreen.html 的 <script> 加载）。
(() => {
  const MESSAGES = globalThis.MESSAGES;
  const TARGETS = globalThis.TARGETS;
  const Errors = globalThis.Errors;
  const AudioRecorder = globalThis.AudioRecorder;

  let recorder = null;
  let audioContext = null;

  // 采集拆除的唯一实现（start 回滚与 stop 清理共用，避免两处近重复各自漂移）。
  // 不变式：模块变量必须在 await close **之前**同步置空——否则 await 期间并发进入的
  // startRecording 新建的 audioContext 会被后置的 `audioContext = null` 覆盖而泄漏。
  async function teardownCapture() {
    const ctx = audioContext;
    if (recorder) {
      recorder.release();
      recorder = null;
    }
    audioContext = null;
    if (ctx) await ctx.close().catch(() => {});
  }

  async function startRecording(streamId) {
    if (recorder) return { ok: false, error: Errors.ALREADY_RECORDING };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
      });
    } catch (e) {
      // 发起中失败也要回给结构化错误对象：字符串没有 .code，popup 侧只剩
      // "Unknown error"，且归一化逻辑会把 code 兜成 API_ERROR（语义错位）。
      return { ok: false, error: globalThis.createError(Errors.RECORD_ERROR, e.message || '') };
    }

    // await 后重查守卫：两个 START 并发时可能都带着 recorder===null 通过入口检查，
    // 晚到者会覆盖先装好的 recorder/audioContext（双泄漏 + 前者录音被接管）。
    // 单线程模型保证此处检查与下面的同步装配不可分割，晚到者必然看到已装的 recorder。
    if (recorder) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: Errors.ALREADY_RECORDING };
    }

    // 尽早把 rec 挂上模块变量：之后任何一步抛错，teardownCapture 都能停轨
    //（捕获流会静音标签页，泄漏的流 = 标签页永久静音）。
    const rec = new AudioRecorder();
    rec.attach(stream);
    recorder = rec;
    try {
      // 关键：捕获标签页音频后原音频会静音，必须回放给用户
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(audioContext.destination);
      rec.start();
    } catch (e) {
      // 回滚（如 MediaRecorder 构造/格式不支持、AudioContext 创建失败）：置空状态 +
      // 停轨 + 关 ctx，否则后续 startRecording 命中 if(recorder) 永久 ALREADY_RECORDING。
      await teardownCapture();
      return { ok: false, error: globalThis.createError(Errors.RECORD_ERROR, e.message || '') };
    }

    return { ok: true, data: { recording: true } };
  }

  async function stopRecording() {
    if (!recorder) return { ok: false, error: Errors.NOT_RECORDING };

    // blob 声明放进 try：catch 直接可见，无需 null 哨兵。
    // 关键：清理放进 finally——recorder.stop() 抛错（含其内部超时兜底 reject）时
    // 也必须置空 recorder、关闭 audioContext，否则状态卡死 + 泄漏。
    // encodeAudio 放 try 内：编码若抛错同样走 finally 清理并回结构化错误。
    let blob;
    try {
      blob = await recorder.stop();
      // 消息通道是 JSON，Blob 到 background 会变成 {} —— 必须编码传输
      return { ok: true, data: await globalThis.encodeAudio(blob) };
    } catch (e) {
      return { ok: false, error: globalThis.createError(Errors.RECORD_ERROR, e.message || '') };
    } finally {
      await teardownCapture();
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 只处理发给 offscreen 的消息（target 过滤，避免与 background 重复响应）
    if (request?.target !== TARGETS.OFFSCREEN) return false;

    (async () => {
      try {
        switch (request.type) {
          case MESSAGES.TAB_RECORD_START:
            return await startRecording(request.payload?.streamId);
          case MESSAGES.TAB_RECORD_STOP:
            return await stopRecording();
          default:
            return { ok: false, error: globalThis.createError(Errors.UNKNOWN_ACTION, 'Unknown message type') };
        }
      } catch (e) {
        console.error('Offscreen error:', e);
        return { ok: false, error: globalThis.createError(Errors.OFFSCREEN_ERROR, e.message || '') };
      }
    })().then(sendResponse);

    return true;
  });
})();
