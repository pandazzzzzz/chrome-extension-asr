/**
 * Audio conversion helpers — 流式转录所需的 PCM 工具。
 *
 * 供真流式 ASR（百炼 WebSocket）把 AudioWorklet 采样的 Float32 PCM 转成
 * 服务端要求的 16-bit 整型 PCM，并按需重采样到 16kHz。
 * 纯计算，无 DOM / WebAudio 依赖。
 */

/**
 * Float32（-1..1）→ Int16（-32768..32767），带 clamp。
 * @param {Float32Array} samples
 * @returns {Int16Array}
 */
globalThis.floatToInt16 = function floatToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
};

/**
 * 线性插值重采样 Float32 PCM（如 48kHz → 16kHz）。
 * 对语音识别足够；不引入外部 resampler library（保持无构建约束）。
 * @param {Float32Array} input
 * @param {number} inputRate
 * @param {number} outputRate
 * @returns {Float32Array}
 */
globalThis.resampleFloat32 = function resampleFloat32(input, inputRate, outputRate) {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] || 0;
    const b = input[idx + 1] !== undefined ? input[idx + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
};
