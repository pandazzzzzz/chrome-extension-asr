// PCM capture fallback tests - pure Node, with minimal Web Audio stubs.
//
// The AudioWorklet path is covered by the browser; this pins the ScriptProcessor
// fallback that older Chrome versions use. ScriptProcessor delivers 4096-sample
// buffers, so a frame boundary can fall inside a buffer. The fallback must carry
// the remainder into the next callback instead of emitting a short frame.
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'audio/pcm-capture.js'));

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log('PASS | ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL | ' + name + ' | ' + e.message);
  }
};

function makeContext() {
  const created = { script: null };
  const context = {
    destination: {},
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createScriptProcessor: () => {
      const node = {
        onaudioprocess: null,
        connect() {},
        disconnect() {},
      };
      created.script = node;
      return node;
    },
  };
  return { context, created };
}

function emit(node, samples) {
  node.onaudioprocess({
    inputBuffer: {
      getChannelData: () => new Float32Array(samples),
    },
  });
}

(async () => {
  await t('fallback: 4096 样本缓冲区中的余数跨回调拼接成完整帧', async () => {
    const { context, created } = makeContext();
    const frames = [];
    const capture = globalThis.createPcmCapture({
      stream: {},
      context,
      frameSize: 1000,
      onFrame: (frame) => frames.push([...frame]),
    });
    await capture.start();
    assert.strictEqual(capture.mode(), 'scriptprocessor');

    emit(created.script, Array.from({ length: 4096 }, (_, i) => i));
    assert.strictEqual(frames.length, 4, '4096 = 4 full frames + 96 remainder');
    assert.deepStrictEqual(frames.map((f) => f.length), [1000, 1000, 1000, 1000]);

    emit(created.script, Array.from({ length: 4096 }, (_, i) => 5000 + i));
    assert.strictEqual(frames.length, 8, 'the 96-sample remainder must complete the next frame');
    assert.strictEqual(frames[4].length, 1000);
    assert.deepStrictEqual(frames[4].slice(0, 96), Array.from({ length: 96 }, (_, i) => 4096 - 96 + i));
    assert.strictEqual(frames[4][96], 5000);
    capture.stop();
  });

  await t('fallback: 未满一帧的尾音不单独发送', async () => {
    const { context, created } = makeContext();
    const frames = [];
    const capture = globalThis.createPcmCapture({
      stream: {},
      context,
      frameSize: 256,
      onFrame: (frame) => frames.push(frame.length),
    });
    await capture.start();

    emit(created.script, new Array(100).fill(0));
    assert.deepStrictEqual(frames, [], '100 samples cannot form a 256-sample frame');

    emit(created.script, new Array(200).fill(0));
    assert.deepStrictEqual(frames, [256], 'the first 256 samples form one frame');
    capture.stop();
  });

  await t('stop: 丢弃尚未成帧的余数，避免下一次 start 串音', async () => {
    const { context, created } = makeContext();
    const frames = [];
    const capture = globalThis.createPcmCapture({
      stream: {},
      context,
      frameSize: 256,
      onFrame: (frame) => frames.push(frame.length),
    });
    await capture.start();
    emit(created.script, new Array(200).fill(0));
    capture.stop();
    assert.deepStrictEqual(frames, []);

    await capture.start();
    emit(created.script, new Array(200).fill(0));
    assert.deepStrictEqual(frames, [], 'a restarted capture must not inherit the old remainder');
    capture.stop();
  });

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
