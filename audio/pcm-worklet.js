/**
 * AudioWorklet processor — 从媒体流采集固定长度的 PCM 帧，postMessage 给主线程。
 *
 * 由 audio/pcm-capture.js 经 audioContext.audioWorklet.addModule() 注册。
 * 此文件运行在 AudioWorklet 作用域（禁止当普通 <script> 引入）。
 *
 * processorOptions: { frameSize: number }  输出帧长（默认 1024 采样）
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = (options && options.processorOptions && options.processorOptions.frameSize) || 1024;
    this.buffer = new Float32Array(this.frameSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const n = Math.min(channel.length - i, this.frameSize - this.offset);
        this.buffer.set(channel.subarray(i, i + n), this.offset);
        this.offset += n;
        i += n;
        if (this.offset === this.frameSize) {
          // slice() 拷贝出帧，避免 buffer 复用造成数据竞争
          this.port.postMessage(this.buffer.slice(0));
          this.offset = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
