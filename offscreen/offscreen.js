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

  async function startRecording(streamId) {
    if (recorder) return { ok: false, error: Errors.ALREADY_RECORDING };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
    });

    // 关键：捕获标签页音频后原音频会静音，必须回放给用户
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    recorder = new AudioRecorder();
    recorder.attach(stream);
    recorder.start();

    return { ok: true, data: { recording: true } };
  }

  async function stopRecording() {
    if (!recorder) return { ok: false, error: Errors.NOT_RECORDING };

    try {
      const blob = await recorder.stop();
      recorder.release();
      recorder = null;
      if (audioContext) {
        await audioContext.close().catch(() => {});
        audioContext = null;
      }
      return { ok: true, data: blob };
    } catch (e) {
      return { ok: false, error: globalThis.createError(Errors.RECORD_ERROR, e.message || '') };
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
