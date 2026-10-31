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
 * 有状态的线性插值重采样器（跨帧保留相位）。
 *
 * 流式音频被切成固定帧逐帧送入：若每帧都独立 round(len/ratio)，小数相位每帧
 * 被丢弃，误差会持续累积（48k→16k、1280 样本/帧时约 469ms/分钟）。这里把
 * 输出位置放在全局时间轴上，帧边界只影响本次能算到哪，不重置相位。
 *
 * @param {number} inputRate
 * @param {number} outputRate
 * @returns {{ process(input: Float32Array): Float32Array, reset(): void }}
 */
globalThis.createResampler = function createResampler(inputRate, outputRate) {
  if (!(inputRate > 0) || !(outputRate > 0)) {
    throw new Error('createResampler requires positive sample rates');
  }
  const identity = inputRate === outputRate;
  const ratio = inputRate / outputRate;
  let nextOut = 0;   // 下一条输出样本在全局输出时间轴上的序号
  let consumed = 0;  // 当前块 input[0] 在全局输入时间轴上的序号
  let carry = 0;     // 上一块的最后一个输入样本（插值左端点）

  function sampleAt(index, input) {
    if (index < consumed) return index === consumed - 1 ? carry : undefined;
    return input[index - consumed];
  }

  return {
    process(input) {
      if (!input || input.length === 0) return new Float32Array(0);
      if (identity) {
        carry = input[input.length - 1];
        consumed += input.length;
        return input;
      }
      const out = [];
      for (;;) {
        const pos = nextOut * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        if (idx - consumed >= input.length) break;
        const a = sampleAt(idx, input);
        const b = sampleAt(idx + 1, input);
        if (a === undefined || b === undefined) break; // 等下一帧补齐插值右端点
        out.push(a + (b - a) * frac);
        nextOut += 1;
      }
      carry = input[input.length - 1];
      consumed += input.length;
      return Float32Array.from(out);
    },
    reset() {
      nextOut = 0;
      consumed = 0;
      carry = 0;
    },
  };
};

/**
 * 单次线性插值重采样（无跨调用状态；供一次性转换/测试使用）。
 * 流式路径请用 createResampler()，否则每帧独立的 round 会累积漂移。
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
