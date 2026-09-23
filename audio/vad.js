/**
 * VoiceActivityDetector — 能量阈值语音活动检测（VAD）状态机。
 *
 * 纯逻辑：无 DOM / WebAudio 依赖，输入逐帧 Float32 PCM，输出状态与边界事件，
 * 便于在 Node 中直接单测。
 *
 * 设计要点：
 *   - 阈值滞回：起音用 speechThreshold，静音判定用更低的
 *     silenceThreshold（= speechThreshold * silenceRatio），避免阈值附近抖动
 *   - minSpeechMs 滤掉突发噪声（更短的"语音"不触发）
 *   - minSilenceMs 保证词间自然停顿不会把一句话切断
 *   - sampleRate/帧长用于把帧数换算成毫秒
 *
 * 用法:
 *   const vad = createVoiceActivityDetector({ sampleRate: 48000 });
 *   const { state, events } = vad.feed(pcmChunk); // pcmChunk: Float32Array
 *   events.forEach(e => e.type === 'speech-start' ? ... : ...);
 */
globalThis.createVoiceActivityDetector = function createVoiceActivityDetector({
  sampleRate = 48000,
  speechThreshold = 0.02, // RMS 起音阈值（0..1）
  silenceRatio = 0.6, // 静音阈值 = speechThreshold * silenceRatio
  minSpeechMs = 250, // 语音最短持续，短于它视为噪声
  minSilenceMs = 800, // 静音最短持续，满足后判定语音结束
} = {}) {
  const silenceThreshold = speechThreshold * silenceRatio;
  let state = 'idle'; // 'idle' | 'speaking'
  let speechMs = 0; // idle 态：连续超过起音阈值的时长
  let silenceMs = 0; // speaking 态：连续低于静音阈值的时长
  let elapsedMs = 0; // 自创建/上次 reset 起的累计时长，用于事件时间戳

  /** 计算一帧的 RMS（0..1）。 */
  function rms(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sum += v * v;
    }
    return frame.length ? Math.sqrt(sum / frame.length) : 0;
  }

  /**
   * 送入一帧 PCM。
   * @param {Float32Array} frame 一帧采样（内容值 0..1 量级）
   * @returns {{state:'idle'|'speaking', rms:number, events:Array<{type:string, atMs:number}>}}
   */
  function feed(frame) {
    const level = rms(frame);
    const frameMs = (frame.length / sampleRate) * 1000;
    const events = [];
    elapsedMs += frameMs;

    if (state === 'idle') {
      speechMs = level >= speechThreshold ? speechMs + frameMs : 0;
      if (speechMs >= minSpeechMs) {
        state = 'speaking';
        silenceMs = 0;
        speechMs = 0;
        events.push({ type: 'speech-start', atMs: elapsedMs });
      }
    } else {
      silenceMs = level < silenceThreshold ? silenceMs + frameMs : 0;
      if (silenceMs >= minSilenceMs) {
        state = 'idle';
        silenceMs = 0;
        speechMs = 0;
        events.push({ type: 'speech-end', atMs: elapsedMs });
      }
    }

    return { state, rms: level, events };
  }

  /** 清空状态（新一轮检测前调用）。 */
  function reset() {
    state = 'idle';
    speechMs = 0;
    silenceMs = 0;
    elapsedMs = 0;
  }

  return {
    feed,
    reset,
    getState: () => state,
    thresholds: { speechThreshold, silenceThreshold, minSpeechMs, minSilenceMs },
  };
};
