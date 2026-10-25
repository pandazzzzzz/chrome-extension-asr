/**
 * PCM capture — 从 MediaStream 采集固定长度 Float32 PCM 帧。
 *
 * 首选 AudioWorklet（pcm-worklet.js，不阻塞主线程）；不可用时回退
 * ScriptProcessorNode（已废弃但浏览器兼容面最广）。
 *
 * 节点接到 0 增益 GainNode → destination，确保音频图被拉取（process()
 * 才会被调用），同时不产生任何声音输出。
 *
 * 用法:
 *   const capture = createPcmCapture({ stream, context, onFrame: (frame) => {...} });
 *   await capture.start();
 *   ... capture.stop();
 *
 * 注意：context 由调用方创建（须在用户手势内创建/解锁），本模块只连线。
 */
globalThis.createPcmCapture = function createPcmCapture({
  stream,
  context,
  onFrame,
  // 与 popup/app.js 的 STREAM.frameSize 保持一致（16kHz = 16ms/帧）。
  // 该值经实测选取：帧越长首帧延迟越大（1024 → 64ms 累积），帧越短消息数越多。
  // 改动时请两处同步 —— 调用方总是显式传参，这个默认值只为独立调用/测试兜底。
  frameSize = 256,
}) {
  let source = null;
  let node = null;
  let silentGain = null;
  let mode = null;
  let fallbackOffset = 0;
  const fallbackBuffer = new Float32Array(frameSize);

  async function start() {
    if (node) return;
    source = context.createMediaStreamSource(stream);
    silentGain = context.createGain();
    silentGain.gain.value = 0;

    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        // 本模块只在扩展上下文运行（offscreen 文档），worklet URL 恒可经 runtime 解析。
        // 不要写 import.meta.url 兜底：经典脚本里那是 SyntaxError，只是从未被求值。
        await context.audioWorklet.addModule(globalThis.chrome.runtime.getURL('audio/pcm-worklet.js'));
        const worklet = new AudioWorkletNode(context, 'pcm-capture-processor', {
          processorOptions: { frameSize },
        });
        worklet.port.onmessage = (e) => {
          onFrame(e.data instanceof Float32Array ? e.data : new Float32Array(e.data));
        };
        source.connect(worklet);
        worklet.connect(silentGain);
        silentGain.connect(context.destination);
        node = worklet;
        mode = 'worklet';
        return;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
      }
    }

    fallbackOffset = 0;

    // 回退：ScriptProcessorNode（废弃但可用）。4096 样本的缓冲区通常不是
    // frameSize 的整数倍，必须像 AudioWorklet 一样把余数留到下一次回调，
    // 否则会发出短帧，且每次回调边界都会丢失固定采样对齐。
    const sp = context.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      let i = 0;
      while (i < input.length) {
        const n = Math.min(input.length - i, frameSize - fallbackOffset);
        fallbackBuffer.set(input.subarray(i, i + n), fallbackOffset);
        fallbackOffset += n;
        i += n;
        if (fallbackOffset === frameSize) {
          onFrame(fallbackBuffer.slice());
          fallbackOffset = 0;
        }
      }
    };
    source.connect(sp);
    sp.connect(silentGain);
    silentGain.connect(context.destination);
    node = sp;
    mode = 'scriptprocessor';
  }

  function stop() {
    try {
      if (node) node.disconnect();
      if (source) source.disconnect();
      if (silentGain) silentGain.disconnect();
    } catch {
      /* ignore */
    }
    node = null;
    source = null;
    silentGain = null;
    mode = null;
    fallbackOffset = 0;
  }

  return { start, stop, mode: () => mode };
};
