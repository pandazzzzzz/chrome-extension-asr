/**
 * ConfigStore — 配置读写，全部存于 chrome.storage.local（不随 Google 账户
 * 云同步）。其中 apiKey 字段经 WebCrypto AES-GCM 加密后存储（见 crypto.js），
 * 其余偏好明文。
 *
 * 迁移：早期版本把配置存于 storage.sync 的 `asrConfig` 键（apiKey 明文）。
 * load() 首次调用时迁移到 local、对明文 apiKey 加密、并清除云端旧键。
 */
globalThis.ConfigStore = (() => {
  const CONFIG_KEY = 'asrConfig'; // 本地配置键
  const LEGACY_SYNC_KEY = 'asrConfig'; // 旧版 storage.sync 同名键（需迁移清除）
  // 同一扩展上下文内的 load/save 串行化：save 是 read-modify-write，两个并发调用若
  // 都先读到同一旧对象，后写者会覆盖先写者的字段；load 的迁移也可能与 save 交错。
  // 跨上下文（popup/options/sidepanel 同时保存）由 navigator.locks 互斥：Web Locks
  // 按同源共享锁空间，扩展页面同属 chrome-extension://<id>，能真正串行化各自页面内
  // 的队列；API 不可用（极老环境/测试桩未提供）时退化为仅内存队列。
  let operationQueue = Promise.resolve();
  const CONFIG_LOCK = 'asr-config-lock';

  function enqueue(task) {
    const run = operationQueue.then(() => {
      const locks = globalThis.navigator?.locks;
      if (!locks?.request) return task();
      return locks.request(CONFIG_LOCK, { mode: 'exclusive' }, task);
    });
    operationQueue = run.catch(() => {}); // 失败不阻塞后续操作
    return run;
  }

  // 从旧版 storage.sync 迁移：明文 apiKey 加密后搬到 local，清除云端旧键
  async function migrateLegacy() {
    const { [LEGACY_SYNC_KEY]: legacy } = await chrome.storage.sync.get(LEGACY_SYNC_KEY);
    if (!legacy) return;
    // 迁移只应发生在 local 尚无配置时。sync 的 remove 可能因离线/配额失败而
    // 留下旧副本；若每次 load 都无脑覆盖 local，用户后来保存的新配置会被旧数据
    // 回滚。local 已有配置即视为已迁移，只清理云端副本。
    const { [CONFIG_KEY]: existing } = await chrome.storage.local.get(CONFIG_KEY);
    if (existing) {
      await chrome.storage.sync.remove(LEGACY_SYNC_KEY);
      return;
    }
    if (legacy.apiKey) {
      legacy.apiKey = await globalThis.CryptoStore.encrypt(legacy.apiKey);
    }
    await chrome.storage.local.set({ [CONFIG_KEY]: legacy });
    await chrome.storage.sync.remove(LEGACY_SYNC_KEY);
  }

  /** 读取配置；apiKey 解密为明文返回；缺失字段为 undefined，由调用方补默认值。 */
  async function load() {
    return enqueue(async () => {
      await migrateLegacy();
      const { [CONFIG_KEY]: config } = await chrome.storage.local.get(CONFIG_KEY);
      if (!config) return {};
      const result = { ...config };
      if (result.apiKey) {
        try {
          result.apiKey = await globalThis.CryptoStore.decrypt(result.apiKey);
        } catch {
          result.apiKey = ''; // 解密失败置空，避免把密文当明文用
        }
      }
      return result;
    });
  }

  /**
   * 保存配置；apiKey 加密后存储，其余偏好明文。
   *
   * **merge 语义（issue #19）**：`chrome.storage.local.set` 对 `asrConfig` 键是整对象
   * 替换，而各写入方提交的字段集并不一致 —— popup/sidepanel 的 `persistConfig` 提交全部
   * 8 个字段，options 的 Save 只提交它自己编辑的那几个。若 save 直接替换，options 的一次
   * 保存就会把 `audioType/subtitles/audioInput` 抹掉（回默认）。故这里先读回已存对象、
   * 把传入字段覆盖其上再写回：**没传的字段保持原值**。apiKey 是例外 —— 传空串视为清除
   * （显式动作），传值则加密覆盖。
   *
   * @param {{provider?:string, region?:string, endpoint?:string, model?:string, audioType?:string, subtitles?:boolean, audioInput?:string, apiKey?:string}} config
   */
  async function save(config) {
    return enqueue(async () => {
      const { apiKey, ...prefs } = config;
      const hasApiKey = Object.hasOwn(config, 'apiKey');
      const encKey = hasApiKey && apiKey ? await globalThis.CryptoStore.encrypt(apiKey) : null;
      const { [CONFIG_KEY]: existing = {} } = await chrome.storage.local.get(CONFIG_KEY);
      const merged = { ...existing, ...prefs };
      if (hasApiKey) merged.apiKey = encKey || '';
      await chrome.storage.local.set({ [CONFIG_KEY]: merged });
    });
  }

  return { load, save };
})();
