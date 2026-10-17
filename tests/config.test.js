// ConfigStore 单元测试 —— 纯 Node，无浏览器依赖。
//
// 覆盖 issue #19 的回归面：`save()` 的 **merge 语义**（未传字段保持原值，不再被整对象
// 替换抹掉）与 apiKey 的加密/清除边界。`store/config.js` 只用到
// `chrome.storage.{local,sync}` 与 `globalThis.CryptoStore`，本文件用最小内存 mock 驱动，
// **不联网、不落盘**。
//
// 运行：npm test（或 node tests/config.test.js）
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const t = (name, fn) => {
  // 每个用例独立一份 mock，避免跨用例污染。
  freshMocks();
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('PASS | ' + name); })
    .catch((e) => { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); });
};

// --- 最小 chrome.storage + CryptoStore mock ---
let localStore, syncStore, encryptCalls;
function freshMocks() {
  localStore = {};
  syncStore = {};
  encryptCalls = 0;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => (key in localStore ? { [key]: localStore[key] } : {}),
        set: async (obj) => { Object.assign(localStore, obj); },
      },
      sync: {
        get: async (key) => (key in syncStore ? { [key]: syncStore[key] } : {}),
        remove: async (key) => { delete syncStore[key]; },
      },
    },
  };
  // 可逆的假加密：真实 CryptoStore 走 WebCrypto/IndexedDB（AES-GCM），密文不含明文。
  // 这里用 base64 模拟同一性质 —— 落盘值不含明文子串，且能被 decrypt 还原，
  // 使「storage 中不出现明文」的断言真正有效（而非 mock 把明文原样塞回去）。
  globalThis.CryptoStore = {
    encrypt: async (plain) => { encryptCalls++; return 'enc:' + Buffer.from(plain, 'utf8').toString('base64'); },
    decrypt: async (cipher) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString('utf8'),
    hasKey: async () => true,
  };
  // 重新 require config.js，让它绑定当前 mock（require 缓存里是旧模块）。
  delete require.cache[require.resolve(path.join(root, 'store/config.js'))];
  require(path.join(root, 'store/config.js'));
}

(async () => {
  // --- 核心回归：部分保存不得抹掉未传字段（issue #19）---
  await t('save: 部分字段保存 → 未传字段保持原值（不抹掉 audioType/subtitles/audioInput）', async () => {
    const CS = globalThis.ConfigStore;
    // popup 先存全量 8 字段（含非默认的 audioType/subtitles/audioInput）
    await CS.save({
      provider: 'qwen', apiKey: 'sk-1', region: 'cn-beijing', endpoint: '',
      model: 'fun-asr-realtime', audioType: 'audio/wav', subtitles: true, audioInput: 'dev-42',
    });
    // options 页只提交它编辑的字段（模拟 issue #19 的 5 字段写入方）
    await CS.save({ provider: 'qwen', apiKey: 'sk-1', region: 'custom', endpoint: 'wss://x/api-ws/v1/inference', model: 'm2' });
    const cfg = await CS.load();
    // 未提交的三项必须原样保留
    assert.strictEqual(cfg.audioType, 'audio/wav', 'audioType 被抹掉');
    assert.strictEqual(cfg.subtitles, true, 'subtitles 被抹掉');
    assert.strictEqual(cfg.audioInput, 'dev-42', 'audioInput 被抹掉');
    // 提交过的字段按新值
    assert.strictEqual(cfg.region, 'custom');
    assert.strictEqual(cfg.endpoint, 'wss://x/api-ws/v1/inference');
    assert.strictEqual(cfg.model, 'm2');
  });

  await t('save: 提交的字段覆盖旧值（merge 不阻止正常更新）', async () => {
    const CS = globalThis.ConfigStore;
    await CS.save({ provider: 'qwen', apiKey: 'sk-1', model: 'a', audioType: 'audio/webm', subtitles: false });
    await CS.save({ model: 'b' }); // 只改 model
    const cfg = await CS.load();
    assert.strictEqual(cfg.model, 'b');
    assert.strictEqual(cfg.provider, 'qwen'); // 未传保持
    assert.strictEqual(cfg.audioType, 'audio/webm');
  });

  // --- apiKey 边界：加密落盘 / 传空串视为清除 ---
  await t('save: apiKey 加密落盘，storage 中不出现明文；load 解密还原', async () => {
    const CS = globalThis.ConfigStore;
    await CS.save({ apiKey: 'sk-secret', model: 'm' });
    const raw = localStore.asrConfig;
    assert.ok(raw.apiKey.startsWith('enc:'), '落盘未加密: ' + raw.apiKey);
    assert.ok(!JSON.stringify(raw).includes('sk-secret'), '明文泄漏进 storage');
    assert.strictEqual(encryptCalls, 1);
    const cfg = await CS.load();
    assert.strictEqual(cfg.apiKey, 'sk-secret', '解密还原失败');
  });

  await t('save: apiKey 传空串 → 清除已存密钥（显式动作），其余字段不受影响', async () => {
    const CS = globalThis.ConfigStore;
    await CS.save({ apiKey: 'sk-secret', model: 'm', audioType: 'audio/wav' });
    await CS.save({ apiKey: '' }); // 显式清除
    const raw = localStore.asrConfig;
    assert.strictEqual(raw.apiKey, '', '空串未清除密钥');
    assert.strictEqual(encryptCalls, 1, '空串不应触发 encrypt');
    const cfg = await CS.load();
    assert.strictEqual(cfg.model, 'm');
    assert.strictEqual(cfg.audioType, 'audio/wav');
  });

  // --- 空库首存：merge 对不存在的旧对象不报错 ---
  await t('save: 空库首次保存 → merge 旧对象缺失时正常写入', async () => {
    const CS = globalThis.ConfigStore;
    await CS.save({ provider: 'qwen', apiKey: 'sk-1' });
    const cfg = await CS.load();
    assert.strictEqual(cfg.provider, 'qwen');
    assert.strictEqual(cfg.apiKey, 'sk-1');
  });

  // --- 迁移路径不回归：storage.sync 遗留配置仍被搬迁 + 清除云端 ---
  await t('load: storage.sync 遗留配置迁移到 local 并清除云端副本', async () => {
    const CS = globalThis.ConfigStore;
    syncStore.asrConfig = { provider: 'legacy', apiKey: 'sk-legacy', model: 'old' };
    const cfg = await CS.load();
    assert.strictEqual(cfg.apiKey, 'sk-legacy', '迁移后明文 key 应可解密读回');
    assert.strictEqual(syncStore.asrConfig, undefined, '云端副本未清除');
    // 迁移时旧对象被加密落盘 → 后续 save 应基于它 merge，不丢字段
    assert.strictEqual(cfg.model, 'old');
    await CS.save({ model: 'new' });
    const cfg2 = await CS.load();
    assert.strictEqual(cfg2.provider, 'legacy', 'merge 后 provider 丢失');
    assert.strictEqual(cfg2.model, 'new');
  });

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
