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
  frameSize = 1024,
}) {
  let source = null;
  let node = null;
  let silentGain = null;
  let mode = null;

  async function start() {
    if (node) return;
    source = context.createMediaStreamSource(stream);
    silentGain = context.createGain();
    silentGain.gain.value = 0;

    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await context.audioWorklet.addModule(chrome.runtime.getURL('audio/pcm-worklet.js'));
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

    // 回退：ScriptProcessorNode（废弃但可用；帧在 onaudioprocess 内切分）
    const sp = context.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < input.length; i += frameSize) {
        const end = Math.min(i + frameSize, input.length);
        if (end > i) onFrame(new Float32Array(input.slice(i, end)));
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
  }

  return { start, stop, mode: () => mode };
};
