// 流式转录层单元测试 —— 纯 Node，无浏览器依赖（audio/convert.js 与
// transcription/providers/* 均为 globalThis 脚本，无 chrome./DOM 引用）。
//
// 覆盖：PCM 数值助手（floatToInt16 / resampleFloat32）与 provider 契约
// （能力元数据、isStreamModel / sampleRateFor 判定、createStreamSession 前置校验、
// run-task 报文的 sample_rate、注册表不变量）。
// **不联网**：WebSocket 用本文件内的假件（withFakeSocket）驱动，只断言发出去的报文；
// 真实网络链路属真机端到端验证（见 docs/HANDOFF.md §3）。
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
  NO_ENDPOINT: { code: 'NO_ENDPOINT', message: 'endpoint' },
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
  assert.strictEqual(Q.defaultSampleRate, 16000);
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
t('Qwen.createStreamSession: endpoint 为空串报 NO_ENDPOINT（不静默回落默认端点）', () => {
  // Custom 地域没填 URL 时 resolveEndpoint 返回 ''。若被 `endpoint || default` 吞掉，
  // 就会静默拨公共北京端点 —— 用户明明选了 Custom，而地域与 API Key 强绑定，必然 401。
  assert.throws(() => Q.createStreamSession({
    apiKey: 'k', model: 'fun-asr-realtime', endpoint: '', onResult() {},
  }), (e) => e.code === 'NO_ENDPOINT');
});
t('Qwen.createStreamSession: 省略 endpoint 回落默认端点（区别于显式空串）', () => {
  // 「未指定」与「显式空串」必须分开：前者回落 getDefaultStreamEndpoint()，后者报错。
  // 注意 Node 22+ 自带原生全局 WebSocket，**不能**用 ReferenceError 当"通过校验"的
  // 探针 —— 那会真的向 dashscope 发起一次连接尝试。改用假件断言 URL。
  // （withFakeSocket 是函数声明，提升到模块顶部，故此处可调用。）
  withFakeSocket((sockets) => {
    const session = Q.createStreamSession({ apiKey: 'k', model: 'fun-asr-realtime', onResult() {} });
    assert.strictEqual(sockets.length, 1);
    assert.ok(
      sockets[0].url.startsWith(Q.getDefaultStreamEndpoint() + '?'),
      '省略 endpoint 应回落到默认端点，实际：' + sockets[0].url.replace(/api_key=[^&]*/, 'api_key=<redacted>'),
    );
    session.close();
  });
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
t('Qwen.sampleRateFor: 8k 电话模型返回 8000，其余继承 defaultSampleRate', () => {
  // 这两个模型**只接受** 8000 Hz，发 16000 会被服务端拒绝
  assert.strictEqual(Q.sampleRateFor('fun-asr-flash-8k-realtime'), 8000);
  assert.strictEqual(Q.sampleRateFor('paraformer-realtime-8k-v2'), 8000);
  // 快照后缀靠前缀匹配命中（与 isStreamModel 同一规则）
  assert.strictEqual(Q.sampleRateFor('fun-asr-flash-8k-realtime-2026-01-28'), 8000);
  // 16k 模型（paraformer-realtime-v2 目录描述为「支持任意采样率」）走默认值
  assert.strictEqual(Q.sampleRateFor('fun-asr-realtime'), 16000);
  assert.strictEqual(Q.sampleRateFor('fun-asr-realtime-2026-02-28'), 16000);
  assert.strictEqual(Q.sampleRateFor('paraformer-realtime-v2'), 16000);
  assert.strictEqual(Q.sampleRateFor('qwen-audio-3.1-asr-flash-streaming'), 16000);
  // 空值不炸，回退默认
  assert.strictEqual(Q.sampleRateFor(''), Q.defaultSampleRate);
  assert.strictEqual(Q.sampleRateFor(undefined), Q.defaultSampleRate);
});
t('BaseProvider.sampleRateFor: 例外表为空 → 一律 defaultSampleRate', () => {
  const b = globalThis.BaseProvider;
  assert.deepStrictEqual(b.sampleRates, {});
  assert.strictEqual(b.defaultSampleRate, 16000);
  assert.strictEqual(b.sampleRateFor('fun-asr-flash-8k-realtime'), 16000);
  assert.strictEqual(b.sampleRateFor('anything'), b.defaultSampleRate);
});

// 假 WebSocket：只记录构造 URL 与 send() 的报文，完全不联网。
// **不能**在构造器里同步触发 onopen —— qwen.js 是先 `new WebSocket(url)`、之后才赋
// `socket.onopen`，同步触发会把事件丢掉。故由用例手动驱动。
// close() 主动触发 onclose，让 createStreamSession 内的 10s readyTimer 被 clearTimeout，
// 不留悬挂定时器。
function withFakeSocket(fn) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() {
      this.readyState = 3; // CLOSED
      this.onclose?.({ wasClean: true, code: 1000, reason: '' });
    }
  }
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  try {
    fn(sockets);
  } finally {
    if (prev === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = prev;
  }
}

t('Qwen run-task 报文: sample_rate 随模型走（8k 发 8000，其余发 16000）', () => {
  // 这是「元数据对」与「真正发出去的报文对」之间的差别：sampleRateFor 只证明查表正确，
  // 本用例证明它确实进了 run-task 的 payload.parameters.sample_rate。
  const cases = [
    ['fun-asr-realtime', 16000],
    ['paraformer-realtime-v2', 16000],
    ['qwen-audio-3.1-asr-flash-streaming', 16000],
    ['paraformer-realtime-8k-v2', 8000],
    ['fun-asr-flash-8k-realtime', 8000],
    ['fun-asr-flash-8k-realtime-2026-01-28', 8000], // 快照后缀同样命中
  ];
  for (const [model, want] of cases) {
    withFakeSocket((sockets) => {
      const session = Q.createStreamSession({ apiKey: 'k', model, onResult() {} });
      assert.strictEqual(sockets.length, 1, model + ' 应恰好建一个 socket');
      sockets[0].onopen(); // 手动驱动握手（见 withFakeSocket 注释）
      const runTask = JSON.parse(sockets[0].sent[0]);
      assert.strictEqual(runTask.header.action, 'run-task', model + ' 首帧应为 run-task');
      assert.strictEqual(runTask.payload.model, model, model + ' 应原样透传');
      assert.strictEqual(
        runTask.payload.parameters.sample_rate, want,
        `${model} 的 sample_rate 应为 ${want}`,
      );
      assert.strictEqual(runTask.payload.parameters.format, 'pcm');
      session.close();
    });
  }
});
t('Qwen run-task 报文: 显式空 endpoint 在建 socket 之前就被拦下', () => {
  // 与上面的探针互补：证明 NO_ENDPOINT 守卫位于 `new WebSocket` 之前，
  // 连 socket 都不会创建（不会有任何连接尝试）。
  withFakeSocket((sockets) => {
    assert.throws(() => Q.createStreamSession({
      apiKey: 'k', model: 'fun-asr-realtime', endpoint: '', onResult() {},
    }), (e) => e.code === 'NO_ENDPOINT');
    assert.strictEqual(sockets.length, 0, '空 endpoint 不应创建任何 socket');
  });
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
    // 采样率元数据：白名单里每个模型都要能解析出可用速率，否则该模型实际不可用
    // （8k 模型发 16000 会被服务端拒 —— 这正是本次修复的缺陷）。
    assert.strictEqual(typeof p.sampleRateFor, 'function', p.id + ' 缺 sampleRateFor');
    assert.ok(Number.isInteger(p.defaultSampleRate) && p.defaultSampleRate > 0,
      p.id + ' defaultSampleRate 必须是正整数');
    assert.ok(Number.isInteger(p.sampleRateFor(p.defaultStreamModel)) && p.sampleRateFor(p.defaultStreamModel) > 0,
      p.id + ' 默认模型的采样率必须为正');
    for (const m of p.streamModels) {
      const rate = p.sampleRateFor(m);
      assert.ok(Number.isInteger(rate) && rate > 0, `${p.id}: ${m} 解析不到有效采样率（${rate}）`);
    }
    // 例外表的每个键本身必须是白名单模型 —— 否则是拼写错或已删模型的死条目，
    // 静默失效（该模型会拿到 defaultSampleRate 而被服务端拒绝）。
    for (const key of Object.keys(p.sampleRates || {})) {
      assert.ok(p.isStreamModel(key), `${p.id}: sampleRates 的键 "${key}" 不在 streamModels 白名单内`);
    }
  });
  assert.ok(list.includes(Q), '注册表应含 QwenProvider');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
process.exit(fail ? 1 : 0);
