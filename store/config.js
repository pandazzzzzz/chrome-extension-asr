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

  // 从旧版 storage.sync 迁移：明文 apiKey 加密后搬到 local，清除云端旧键
  async function migrateLegacy() {
    const { [LEGACY_SYNC_KEY]: legacy } = await chrome.storage.sync.get(LEGACY_SYNC_KEY);
    if (!legacy) return;
    if (legacy.apiKey) {
      legacy.apiKey = await globalThis.CryptoStore.encrypt(legacy.apiKey);
    }
    await chrome.storage.local.set({ [CONFIG_KEY]: legacy });
    await chrome.storage.sync.remove(LEGACY_SYNC_KEY);
  }

  /** 读取配置；apiKey 解密为明文返回；缺失字段为 undefined，由调用方补默认值。 */
  async function load() {
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
    const { apiKey = '', ...prefs } = config;
    const encKey = apiKey ? await globalThis.CryptoStore.encrypt(apiKey) : '';
    const { [CONFIG_KEY]: existing = {} } = await chrome.storage.local.get(CONFIG_KEY);
    await chrome.storage.local.set({ [CONFIG_KEY]: { ...existing, ...prefs, apiKey: encKey } });
  }

  return { load, save };
})();
