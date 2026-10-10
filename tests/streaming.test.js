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
  assert.ok(Array.isArray(Q.streamModels) && Q.streamModels.length > 0);
  assert.strictEqual(typeof Q.getDefaultStreamEndpoint(), 'string');
  assert.ok(Q.getDefaultStreamEndpoint().startsWith('wss://'));
  assert.ok(Q.getDefaultStreamEndpoint().endsWith('/api-ws/v1/inference'));
});
t('Qwen.isStreamModel: 只放行 run-task 白名单（含快照后缀）', () => {
  assert.strictEqual(Q.isStreamModel('fun-asr-realtime'), true);
  assert.strictEqual(Q.isStreamModel('fun-asr-realtime-2026-02-28'), true); // 快照版本靠前缀匹配
  assert.strictEqual(Q.isStreamModel('qwen-audio-3.1-asr-flash-streaming'), true);
  assert.strictEqual(Q.isStreamModel(''), false);
  assert.strictEqual(Q.isStreamModel('fun-asr'), false); // 非实时模型
  assert.strictEqual(Q.isStreamModel('qwen3-asr-flash'), false); // 批量模型必须被拒
});
t('Qwen.isStreamModel: 拒绝名字带 realtime 但走 /api-ws/v1/realtime 的会话制模型', () => {
  // 这些模型名同样含 "realtime"，旧的名字正则会误放行 → run-task 发错路径 → task-failed
  for (const m of [
    'qwen3-asr-flash-realtime',
    'qwen-audio-3.1-realtime-plus',
    'qwen3.8-omni-flash-realtime',
    'qwen3.5-livetranslate-flash-realtime',
  ]) {
    assert.strictEqual(Q.isStreamModel(m), false, m + ' 不应被 run-task 接受');
  }
});
t('BaseProvider.isStreamModel: 基类白名单为空 → 一律拒绝', () => {
  const b = globalThis.BaseProvider;
  assert.deepStrictEqual(b.streamModels, []);
  assert.strictEqual(b.isStreamModel('fun-asr-realtime'), false);
  assert.strictEqual(b.isStreamModel(''), false);
});
t('Qwen.createStreamSession: 缺 apiKey 抛 NO_API_KEY', () => {
  assert.throws(() => Q.createStreamSession({ apiKey: '', onResult() {} }),
    (e) => e.code === 'NO_API_KEY');
});
t('Qwen.createStreamSession: 非 run-task 模型被拒绝', () => {
  assert.throws(() => Q.createStreamSession({ apiKey: 'k', model: 'qwen3-asr-flash', onResult() {} }),
    (e) => e.code === 'UNKNOWN');
  assert.throws(() => Q.createStreamSession({ apiKey: 'k', model: 'qwen3-asr-flash-realtime', onResult() {} }),
    (e) => e.code === 'UNKNOWN');
});
t('Qwen.createStreamSession: 非 wss:// endpoint 提前报错（不喂给 new WebSocket）', () => {
  assert.throws(() => Q.createStreamSession({
    apiKey: 'k', model: 'fun-asr-realtime', endpoint: 'https://dashscope.aliyuncs.com/api/v1', onResult() {},
  }), (e) => e.code === 'UNKNOWN' && /not a WebSocket URL/.test(e.message));
});
t('Qwen.regions: 每个地域有 id/label，custom 兜底且 endpoint 为空', () => {
  const regions = Q.regions;
  assert.ok(Array.isArray(regions) && regions.length >= 2);
  for (const r of regions) {
    assert.strictEqual(typeof r.id, 'string');
    assert.ok(r.id, 'region 缺 id');
    assert.strictEqual(typeof r.label, 'string');
    assert.ok(r.label, 'region 缺 label');
    assert.strictEqual(typeof r.endpoint, 'string');
  }
  const custom = regions.find((r) => r.id === 'custom');
  assert.ok(custom, '必须提供 custom 地域');
  assert.strictEqual(custom.endpoint, '', 'custom 的 endpoint 必须为空（由 UI 文本框收集）');
  // 非 custom 的地域必须是可用的 wss URL —— 否则会把用户导向错误地址
  for (const r of regions.filter((x) => x.id !== 'custom')) {
    assert.ok(/^wss:\/\//.test(r.endpoint), `${r.id} 的 endpoint 必须是 wss://：${r.endpoint}`);
  }
});
t('Qwen.endpointFor: 按地域解析，custom 返回空串，未知回退首个地域', () => {
  assert.strictEqual(Q.endpointFor('cn-beijing'), 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  assert.strictEqual(Q.endpointFor('ap-southeast-1'), 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference');
  assert.strictEqual(Q.endpointFor('custom'), '');
  // 未知/空值 → 首个地域（不能返回 undefined，否则 createStreamSession 会拿到坏 URL）
  assert.strictEqual(Q.endpointFor('nope'), Q.regions[0].endpoint);
  assert.strictEqual(Q.endpointFor(''), Q.regions[0].endpoint);
  assert.strictEqual(Q.endpointFor(undefined), Q.regions[0].endpoint);
});
t('BaseProvider.endpointFor: 无 regions 的基类回退 getDefaultStreamEndpoint', () => {
  const b = globalThis.BaseProvider;
  assert.deepStrictEqual(b.regions.map((r) => r.id), ['custom']);
  assert.strictEqual(b.endpointFor('anything'), '');
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
    assert.ok(p.defaultStreamModel, p.id + ' 缺默认流式模型');
    assert.ok(Array.isArray(p.streamModels) && p.streamModels.length > 0, p.id + ' 缺 run-task 白名单');
    assert.ok(p.isStreamModel(p.defaultStreamModel), p.id + ' 默认模型必须在自己的白名单内');
    assert.ok(Array.isArray(p.regions) && p.regions.length > 0, p.id + ' 缺 regions');
    assert.ok(p.regions.some((r) => r.id === 'custom'), p.id + ' 必须提供 custom 地域兜底');
  });
  assert.ok(list.includes(Q), '注册表应含 QwenProvider');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
process.exit(fail ? 1 : 0);
