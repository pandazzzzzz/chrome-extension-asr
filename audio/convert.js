/**
 * Audio conversion helpers — PCM ⇄ WAV / 分片工具。
 *
 * 供流式转录（VAD 切段）把 Float32 PCM 合成为 provider 可接受的 WAV Blob。
 * 纯计算，无 DOM / WebAudio 依赖，可在 Node 单测。
 */

/**
 * 把 Float32 PCM 合成 16-bit 单声道 WAV。
 *
 * @param {Float32Array} samples 采样值（-1..1）
 * @param {number} sampleRate    采样率（如 48000）
 * @returns {Blob}               WAV Blob（audio/wav）
 */
globalThis.floatToWavBlob = function floatToWavBlob(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples.length * 2;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  // 16-bit little-endian，float(-1..1) → int16
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

/**
 * 拼接多个 Float32Array 为一个。
 * @param {Float32Array[]} chunks
 * @returns {Float32Array}
 */
globalThis.concatFloat32 = function concatFloat32(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};
