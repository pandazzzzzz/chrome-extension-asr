/**
 * ConfigStore — 配置读写，全部存于 chrome.storage.local（不随 Google 账户
 * 云同步）。其中 apiKey 字段经 WebCrypto AES-GCM 加密后存储（见 crypto.js），
 * 其余偏好明文。
 *
 * 迁移：早期版本把配置存于 storage.sync 的 `asrConfig` 键（apiKey 明文）。
 * load() 首次调用时迁移到 local、对明文 apiKey 加密、并清除云端旧键。
 */
window.ConfigStore = (() => {
  const CONFIG_KEY = 'asrConfig'; // 本地配置键
  const LEGACY_SYNC_KEY = 'asrConfig'; // 旧版 storage.sync 同名键（需迁移清除）

  // 从旧版 storage.sync 迁移：明文 apiKey 加密后搬到 local，清除云端旧键
  async function migrateLegacy() {
    const { [LEGACY_SYNC_KEY]: legacy } = await chrome.storage.sync.get(LEGACY_SYNC_KEY);
    if (!legacy) return;
    if (legacy.apiKey) {
      legacy.apiKey = await window.CryptoStore.encrypt(legacy.apiKey);
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
        result.apiKey = await window.CryptoStore.decrypt(result.apiKey);
      } catch {
        result.apiKey = ''; // 解密失败置空，避免把密文当明文用
      }
    }
    return result;
  }

  /**
   * 保存配置；apiKey 加密后存储，其余偏好明文。
   * @param {{provider?:string, endpoint?:string, model?:string, audioType?:string, apiKey?:string}} config
   */
  async function save(config) {
    const { apiKey = '', ...prefs } = config;
    const encKey = apiKey ? await window.CryptoStore.encrypt(apiKey) : '';
    await chrome.storage.local.set({ [CONFIG_KEY]: { ...prefs, apiKey: encKey } });
  }

  return { load, save };
})();
