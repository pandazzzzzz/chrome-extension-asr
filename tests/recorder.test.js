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

t('sameMimeType: codec 参数差异不算格式回退', () => {
  const R = globalThis.AudioRecorder;
  assert.strictEqual(R.sameMimeType('audio/webm', 'audio/webm;codecs=opus'), true);
  assert.strictEqual(R.sameMimeType('audio/webm;codecs=vp9', 'audio/webm;codecs=opus'), true);
  assert.strictEqual(R.sameMimeType('audio/wav', 'audio/webm;codecs=opus'), false);
  assert.strictEqual(R.sameMimeType('', ''), false);
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
