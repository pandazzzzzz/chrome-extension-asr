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
  // 默认模型改为 qwen-audio-3.1-asr-flash-streaming（fun-asr-realtime 免费额度已耗尽）。
  // 这里只锁**结构性**约束（默认非空、在白名单内、16 kHz），不锁具体名字 —— 换默认属
  // 产品决策（额度会变），锁死名字会让每次调整都得改测试。
  assert.ok(Q.defaultStreamModel, 'defaultStreamModel 不得为空');
  assert.ok(Q.isStreamModel(Q.defaultStreamModel), '默认模型必须在 streamModels 白名单内');
  assert.strictEqual(Q.sampleRateFor(Q.defaultStreamModel), 16000,
    '默认模型应为 16 kHz（与 AudioContext 默认率一致，走 identity 重采样零开销）');
  assert.ok(Array.isArray(Q.streamModels) && Q.streamModels.length > 0);
  assert.strictEqual(typeof Q.getDefaultStreamEndpoint(), 'string');
  assert.ok(Q.getDefaultStreamEndpoint().startsWith('wss://'));
  assert.ok(Q.getDefaultStreamEndpoint().endsWith('/api-ws/v1/inference'));
  assert.strictEqual(Q.defaultSampleRate, 16000);
});

// --- modelOptions（模型下拉预置项）与 modelSelectionFor（配置 → 下拉选中态）---
t('Qwen.modelOptions: 形状正确 —— 每项有 label，末项是 Custom 哨兵', () => {
  const opts = Q.modelOptions;
  assert.ok(Array.isArray(opts) && opts.length >= 2, '至少要有一个预置项 + Custom');
  for (const o of opts) {
    assert.strictEqual(typeof o.model, 'string');
    assert.ok(typeof o.label === 'string' && o.label.trim(), '每项都要有非空 label（下拉显示用）');
  }
  assert.strictEqual(opts[opts.length - 1].model, '',
    '末项必须是 Custom（model 为空哨兵，与 regions 的 custom 项同构）');
  // 预置项（除 Custom）必须都是真白名单模型 —— 否则下拉里摆一个选了就被回落的模型
  for (const o of opts.slice(0, -1)) {
    assert.ok(Q.isStreamModel(o.model), `modelOptions 里的 "${o.model}" 不在 streamModels 白名单内`);
  }
  // label 不得写额度/价格：免费额度按月重置、会耗尽也会恢复，写进 label 必然过期误导用户
  for (const o of opts) {
    assert.ok(!/免费|额度|价格|剩余|free|quota|pricing/i.test(o.label),
      `label 含额度/价格字样（会过期）：${o.label}`);
  }
  // 默认模型必须能在下拉里直接选中，否则新用户的默认值会以 Custom 态呈现
  assert.ok(opts.some((o) => o.model === Q.defaultStreamModel),
    `defaultStreamModel "${Q.defaultStreamModel}" 不在 modelOptions 里，新用户默认会落到 Custom`);
});

t('modelSelectionFor: 预置项 → 直接选中，customText 为空', () => {
  const preset = Q.modelOptions.find((o) => o.model).model;
  assert.deepStrictEqual(Q.modelSelectionFor(preset), { value: preset, customText: '' });
});

t('modelSelectionFor: 空值 → 落到 defaultStreamModel（不是 Custom 空态）', () => {
  const sel = Q.modelSelectionFor('');
  assert.strictEqual(sel.value, Q.defaultStreamModel, '空配置应选中默认模型');
  assert.strictEqual(sel.customText, '', '默认模型在预置里，不需要手填');
  assert.deepStrictEqual(Q.modelSelectionFor(undefined), sel, 'undefined 同空值');
  assert.deepStrictEqual(Q.modelSelectionFor('   '), sel, '空白串同空值');
});

t('modelSelectionFor: 白名单内但未预置的模型 → Custom + 原文保留（不改写用户数据）', () => {
  // fun-asr-realtime 仍在 streamModels 白名单（Custom 手填照样可用），只是不再预置
  assert.ok(Q.isStreamModel('fun-asr-realtime'), '前置：它确实还在白名单里');
  assert.ok(!Q.modelOptions.some((o) => o.model === 'fun-asr-realtime'), '前置：它不在预置里');
  assert.deepStrictEqual(Q.modelSelectionFor('fun-asr-realtime'),
    { value: '', customText: 'fun-asr-realtime' });
  // 带日期后缀的快照版本同样走 Custom（isStreamModel 前缀匹配放行，下拉不预置）
  assert.deepStrictEqual(Q.modelSelectionFor('fun-asr-flash-8k-realtime-2026-01-28'),
    { value: '', customText: 'fun-asr-flash-8k-realtime-2026-01-28' });
  // 刻意不校验 isStreamModel：非白名单值也原样进文本框，由 startStreaming 的
  // model-fallback 处理，而不是在渲染时静默改写
  assert.deepStrictEqual(Q.modelSelectionFor('qwen3-asr-flash-realtime'),
    { value: '', customText: 'qwen3-asr-flash-realtime' });
});

t('BaseProvider.modelOptions: 基类为空数组，无预置时退化为纯 Custom', () => {
  const B = globalThis.BaseProvider;
  assert.deepStrictEqual(B.modelOptions, [], '基类不应预置任何模型');
  // 空 modelOptions + 空 defaultStreamModel → Custom 态且文本框留空
  assert.deepStrictEqual(B.modelSelectionFor(''), { value: '', customText: '' });
  // 保存过的值仍要原样回填到文本框（不能因为没预置就丢）
  assert.deepStrictEqual(B.modelSelectionFor('some-model'), { value: '', customText: 'some-model' });
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
t('Qwen: task-started 之后的网络错误不得误报为握手失败', () => {
  withFakeSocket((sockets) => {
    let reported = null;
    const session = Q.createStreamSession({
      apiKey: 'k',
      model: 'fun-asr-realtime',
      onResult() {},
      onError: (e) => { reported = e; },
    });
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) });
    sockets[0].onerror();
    assert.ok(reported, 'onError 应被调用');
    assert.ok(!/handshake/i.test(reported.message), '已启动后不应再报握手失败: ' + reported.message);
    session.close();
  });
});
t('Qwen: task-started 之后连接关闭要上报 NETWORK，而不是静默结束', () => {
  withFakeSocket((sockets) => {
    let reported = null;
    let ended = false;
    const session = Q.createStreamSession({
      apiKey: 'k',
      model: 'fun-asr-realtime',
      onResult() {},
      onError: (e) => { reported = e; },
      onEnd: () => { ended = true; },
    });
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) });
    sockets[0].onclose({ wasClean: false, code: 1006, reason: '' });
    assert.ok(reported, 'onError 应被调用');
    assert.strictEqual(reported.code, 'NETWORK');
    assert.ok(ended, 'onEnd 仍应触发以让 UI 清理');
  });
});
t('Qwen: 主动 close() 不得把已启动会话误报成 NETWORK', () => {
  withFakeSocket((sockets) => {
    let reported = null;
    let ended = false;
    const session = Q.createStreamSession({
      apiKey: 'k',
      model: 'fun-asr-realtime',
      onResult() {},
      onError: (e) => { reported = e; },
      onEnd: () => { ended = true; },
    });
    sockets[0].onopen();
    sockets[0].onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) });
    session.close();
    assert.strictEqual(reported, null, '用户主动停止不是网络故障，不应报错');
    assert.ok(ended, '主动关闭仍应触发 onEnd，让 UI 完成清理');
  });
});
t('Qwen: stop() 超时后主动 close() 不得补报 NETWORK', async () => {
  // stop() 在服务端 5s 未确认时会超时返回；随后 teardown 调用 close()。
  // 这个主动关闭若被当成网络断开，会把 UI 的 "Streaming stopped." 覆盖成错误。
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => (ms === 5000
    ? realSetTimeout(fn, 0)
    : realSetTimeout(fn, ms));
  try {
    await new Promise((resolve, reject) => {
      withFakeSocket((sockets) => {
        let reported = null;
        let ended = 0;
        const session = Q.createStreamSession({
          apiKey: 'k',
          model: 'fun-asr-realtime',
          onResult() {},
          onError: (e) => { reported = e; },
          onEnd: () => { ended += 1; },
        });
        sockets[0].onopen();
        sockets[0].onmessage({ data: JSON.stringify({ header: { event: 'task-started' } }) });
        session.stop().then(() => {
          session.close();
          try {
            assert.strictEqual(reported, null, '超时后的主动 close 不应报 NETWORK');
            assert.strictEqual(ended, 1, '主动 close 应只触发一次 onEnd');
            resolve();
          } catch (error) {
            reject(error);
          }
        }, reject);
      });
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
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
    // modelOptions（模型下拉预置项）的不变量：
    assert.ok(Array.isArray(p.modelOptions), p.id + ' 缺 modelOptions');
    for (const o of p.modelOptions) {
      // 非 Custom 项必须是真的白名单模型 —— 否则下拉里摆了个选了就被 model-fallback 换掉的模型
      if (o.model) {
        assert.ok(p.isStreamModel(o.model), `${p.id}: modelOptions 的 "${o.model}" 不在白名单内`);
        assert.ok(p.sampleRateFor(o.model) > 0, `${p.id}: "${o.model}" 解析不到有效采样率`);
      }
      assert.ok(typeof o.label === 'string' && o.label.trim(), `${p.id}: modelOptions 项缺 label`);
    }
    // Custom 哨兵（空 model）最多一个，且必须在末位 —— UI 靠"下拉值为空"判定 Custom 态
    const customs = p.modelOptions.filter((o) => !o.model);
    assert.ok(customs.length <= 1, p.id + ': modelOptions 出现多个空 model（Custom 哨兵）');
    if (customs.length) {
      assert.strictEqual(p.modelOptions[p.modelOptions.length - 1].model, '',
        p.id + ': Custom 项应在末位');
    }
    // 默认模型必须可直接选中，否则新用户打开就看到"Custom + 一个模型名"而非预置项
    assert.ok(p.modelOptions.some((o) => o.model === p.defaultStreamModel),
      `${p.id}: defaultStreamModel "${p.defaultStreamModel}" 不在 modelOptions 里`);
    // modelSelectionFor 是 popup 与 options 共用的映射，两侧必须同构
    assert.strictEqual(typeof p.modelSelectionFor, 'function', p.id + ' 缺 modelSelectionFor');
    assert.deepStrictEqual(p.modelSelectionFor(p.defaultStreamModel),
      { value: p.defaultStreamModel, customText: '' }, p.id + ': 默认模型应直接选中');
  });
  assert.ok(list.includes(Q), '注册表应含 QwenProvider');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed (' + (pass + fail) + ' total)');
process.exit(fail ? 1 : 0);
