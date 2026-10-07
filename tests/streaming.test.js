// 流式转录层单元测试 —— 纯 Node，无浏览器依赖（audio/convert.js 与
// transcription/providers/* 均为 globalThis 脚本，无 chrome./DOM 引用）。
//
// 覆盖：PCM 数值助手（floatToInt16 / resampleFloat32）与 provider 契约
// （能力元数据、isStreamModel 判定、createStreamSession 前置校验、注册表不变量）。
// 不含 WebSocket 网络链路 —— 那属于真机端到端验证（见 docs/HANDOFF.md §3）。
//
// 运行：npm test（或 node tests/streaming.test.js）
//
// 历史：原为 temp/test-streaming-integration.js（gitignored，2026-10-07 移入 tests/ 并挂 npm test）。
const path = require('node:path');
const assert = require('node:assert');

// 模块以 globalThis 挂载（popup/service worker 共用），Node 下先提供最小契约桩。
// 仅用这些测试实际断言到的错误码 —— 不引真实 errors.js，避免牵入无关依赖。
globalThis.Errors = {
  NO_API_KEY: { code: 'NO_API_KEY', message: 'key' },
  UNKNOWN: { code: 'UNKNOWN', message: 'u' },
  NETWORK: { code: 'NETWORK', message: 'n' },
  API_ERROR: { code: 'API_ERROR', message: 'a' },
};
globalThis.createError = (def, msg) => {
  const e = new Error(msg || def.message);
  e.code = def.code;
  return e;
};

const root = path.resolve(__dirname, '..');
require(path.join(root, 'audio/convert.js'));
require(path.join(root, 'transcription/providers/base.js'));
require(path.join(root, 'transcription/providers/qwen.js'));
require(path.join(root, 'transcription/providers/index.js'));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

// --- floatToInt16 ---
t('floatToInt16: 正负边界 clamp + 中值', () => {
  const out = globalThis.floatToInt16(new Float32Array([0, 1, -1, 0.5, -0.5, 2, -2]));
  assert.deepStrictEqual([...out], [0, 32767, -32768, 16383, -16384, 32767, -32768]);
});
t('floatToInt16: 长度保持一致', () => {
  const inp = new Float32Array(1024).map((_, i) => Math.sin(i / 10));
  assert.strictEqual(globalThis.floatToInt16(inp).length, 1024);
});

// --- resampleFloat32 ---
t('resampleFloat32: 同采样率返回原数组', () => {
  const inp = new Float32Array([0, 1, 2]);
  assert.strictEqual(globalThis.resampleFloat32(inp, 16000, 16000), inp);
});
t('resampleFloat32: 48k -> 16k 长度缩为1/3', () => {
  const out = globalThis.resampleFloat32(new Float32Array(4800), 48000, 16000);
  assert.strictEqual(out.length, 1600);
});
t('resampleFloat32: 恒定值重采样后仍为常数', () => {
  const out = globalThis.resampleFloat32(new Float32Array(1000).fill(0.7), 48000, 16000);
  assert.ok(out.every(v => Math.abs(v - 0.7) < 1e-6));
});
t('resampleFloat32: 16k -> 48k 升采样', () => {
  const out = globalThis.resampleFloat32(new Float32Array(1000), 16000, 48000);
  assert.strictEqual(out.length, 3000);
});

// --- provider 契约 ---
const Q = globalThis.QwenProvider;
t('Qwen: 流式能力元数据正确', () => {
  assert.strictEqual(Q.id, 'qwen');
  assert.strictEqual(Q.supportsStreaming, true);
  assert.strictEqual(Q.defaultStreamModel, 'fun-asr-realtime');
  assert.strictEqual(typeof Q.getDefaultStreamEndpoint(), 'string');
  assert.ok(Q.getDefaultStreamEndpoint().startsWith('wss://'));
});
t('BaseProvider.isStreamModel: 按 realtime|streaming 判定', () => {
  const b = globalThis.BaseProvider;
  assert.strictEqual(b.isStreamModel('fun-asr-realtime'), true);
  assert.strictEqual(b.isStreamModel('qwen-audio-3.x-asr-flash-streaming'), true);
  assert.strictEqual(b.isStreamModel('qwen3-asr-flash'), false); // 批量模型必须被拒
  assert.strictEqual(b.isStreamModel(''), false);
  assert.strictEqual(Q.isStreamModel('qwen3-asr-flash'), false);
});
t('Qwen.createStreamSession: 缺 apiKey 抛 NO_API_KEY', () => {
  assert.throws(() => Q.createStreamSession({ apiKey: '', onResult() {} }),
    (e) => e.code === 'NO_API_KEY');
});
t('Qwen.createStreamSession: 批量模型被拒绝', () => {
  assert.throws(() => Q.createStreamSession({ apiKey: 'k', model: 'qwen3-asr-flash', onResult() {} }),
    (e) => e.code === 'UNKNOWN');
});
t('BaseProvider: 流式基类默认抛错（不实现就用不了）', () => {
  assert.throws(() => globalThis.BaseProvider.createStreamSession({}), /Streaming not supported/);
});
t('注册表: 只含支持流式的 provider，且都实现了 createStreamSession', () => {
  const list = globalThis.PROVIDERS;
  assert.ok(Array.isArray(list) && list.length >= 1);
  list.forEach(p => {
    assert.ok(p.supportsStreaming, p.id + ' 应支持流式');
    assert.strictEqual(typeof p.createStreamSession, 'function', p.id + ' 缺 createStreamSession');
    assert.ok(p.defaultStreamModel || p.defaultModel, p.id + ' 缺默认模型');
  });
  assert.ok(list.includes(Q), '注册表应含 QwenProvider');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
process.exit(fail ? 1 : 0);
