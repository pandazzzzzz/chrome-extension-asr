// AudioRecorder 格式选择回归测试 —— 纯 Node，用最小 MediaRecorder 桩。
//
// 浏览器并不保证支持 audio/wav（当前 Chrome 实测 isTypeSupported('audio/wav')
// 为 false）。用户选择 wav 时会回退到 webm，但 UI 必须能感知"实际格式与请求
// 不同"，不能继续显示/命名成 wav。本测试锁定 pickMimeType 的确定性回退，
// 以及 AudioRecorder.actualMimeType 对最终 Blob 类型的记录。
//
// 运行：npm test（或 node tests/recorder.test.js）
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'audio/recorder.js'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

function withSupport(supported, fn) {
  const prev = globalThis.MediaRecorder;
  globalThis.MediaRecorder = {
    isTypeSupported: (type) => supported.includes(type),
  };
  try { fn(); } finally {
    if (prev === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = prev;
  }
}

// --- 最小 MediaRecorder + 媒体流桩：驱动 stop()/release() 生命周期 ---
let recorderStubs = [];
function withFakeRecorder({ onstopDelay = 0 } = {}, fn) {
  recorderStubs = [];
  const prevRecorder = globalThis.MediaRecorder;
  const prevBlob = globalThis.Blob;
  globalThis.MediaRecorder = class FakeMediaRecorder {
    static isTypeSupported = () => true;
    constructor() {
      this.mimeType = '';
      recorderStubs.push(this);
    }
    start() {}
    stop() {}
  };
  // Blob 桩只算字节数；size 累加语义与真 Blob 一致。
  globalThis.Blob = class FakeBlob {
    constructor(parts) { this.size = (parts || []).reduce((n, p) => n + (p.size || 0), 0); }
  };
  const timer = onstopDelay === Infinity ? null
    : setTimeout(() => stub.onstop?.(), onstopDelay);
  const stub = recorderStubs[0];
  try { fn(); } finally {
    if (timer) clearTimeout(timer);
    if (prevRecorder === undefined) delete globalThis.MediaRecorder;
    else globalThis.MediaRecorder = prevRecorder;
    if (prevBlob === undefined) delete globalThis.Blob;
    else globalThis.Blob = prevBlob;
  }
}
function makeStream() {
  return { getTracks: () => [{ stop() {} }] };
}
function makeBlobPart(size) {
  return { size };
}

t('pickMimeType: 首选受支持时原样返回', () => {
  withSupport(['audio/mp4', 'audio/webm'], () => {
    assert.strictEqual(globalThis.AudioRecorder.pickMimeType('audio/mp4'), 'audio/mp4');
  });
});

t('pickMimeType: wav 不受支持时回退 webm（顺序确定）', () => {
  withSupport(['audio/webm', 'audio/mp4'], () => {
    assert.strictEqual(globalThis.AudioRecorder.pickMimeType('audio/wav'), 'audio/webm');
  });
});

t('pickMimeType: 全都不支持时返回空串（交给浏览器默认）', () => {
  withSupport([], () => {
    assert.strictEqual(globalThis.AudioRecorder.pickMimeType('audio/wav'), '');
  });
});

t('actualMimeType: 回退后返回实际选中的格式，而不是用户首选', () => {
  withSupport(['audio/webm'], () => {
    const rec = new globalThis.AudioRecorder({ mimeType: 'audio/wav' });
    assert.strictEqual(rec.actualMimeType(), 'audio/webm');
  });
});

t('actualMimeType: MediaRecorder 回报的 codec 参数优先于协商结果', () => {
  withSupport(['audio/webm'], () => {
    const rec = new globalThis.AudioRecorder({ mimeType: 'audio/webm' });
    rec.recorder = { mimeType: 'audio/webm;codecs=opus' };
    assert.strictEqual(rec.actualMimeType(), 'audio/webm;codecs=opus');
  });
});

t('stop: onstop 不触发时超时 reject，已录分片仍可从 getBlob 恢复', () => {
  withFakeRecorder({ onstopDelay: Infinity }, async () => {
    const rec = new globalThis.AudioRecorder({ mimeType: 'audio/webm' });
    rec.attach(makeStream());
    rec.start();
    recorderStubs[0].ondataavailable({ data: makeBlobPart(1024) });
    recorderStubs[0].ondataavailable({ data: makeBlobPart(2048) });

    // withTimeout 内部用全局 setTimeout；短超时等待下加速测试。
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms, 20));
    let timeoutError = null;
    try {
      await rec.stop();
    } catch (err) {
      timeoutError = err;
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(timeoutError, 'stop() 应因 onstop 缺失而超时 reject');
    assert.match(timeoutError.message, /MediaRecorder\.stop/);

    const blob = rec.getBlob();
    assert.strictEqual(blob.size, 3072, '已录分片必须可恢复');
    assert.strictEqual(blob.type, 'audio/webm');
  });
});

t('release: 默认丢弃分片（成功路径语义不变）', () => {
  withFakeRecorder({}, () => {
    const rec = new globalThis.AudioRecorder({ mimeType: 'audio/webm' });
    rec.attach(makeStream());
    rec.start();
    recorderStubs[0].ondataavailable({ data: makeBlobPart(512) });
    rec.release();
    assert.strictEqual(rec.getBlob().size, 0, 'release 后分片应清空');
  });
});

t('release({ keepChunks }): 保留分片且停止音轨（失败恢复路径）', () => {
  withFakeRecorder({}, () => {
    const rec = new globalThis.AudioRecorder({ mimeType: 'audio/webm' });
    rec.attach(makeStream());
    rec.start();
    recorderStubs[0].ondataavailable({ data: makeBlobPart(1024) });
    rec.release({ keepChunks: true });
    assert.strictEqual(rec.getBlob().size, 1024, 'keepChunks 时分片保留');
    assert.strictEqual(rec.recorder, null, 'recorder 已释放');
    assert.strictEqual(rec.stream, null, '音轨已停止');
    assert.strictEqual(rec.isRecording, false);
  });
});

t('sameMimeType: codec 参数差异不算格式回退', () => {
  const R = globalThis.AudioRecorder;
  assert.strictEqual(R.sameMimeType('audio/webm', 'audio/webm;codecs=opus'), true);
  assert.strictEqual(R.sameMimeType('audio/webm;codecs=vp9', 'audio/webm;codecs=opus'), true);
  assert.strictEqual(R.sameMimeType('audio/wav', 'audio/webm;codecs=opus'), false);
  assert.strictEqual(R.sameMimeType('', ''), false);
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
