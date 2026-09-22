/**
 * CryptoStore — WebCrypto AES-GCM 对称加密辅助。
 *
 * 设计：
 *   - 密钥：首次运行自动生成 AES-GCM 256 密钥（extractable: false），
 *     存于 IndexedDB。不可导出，脚本无法通过 crypto.subtle.exportKey 取走。
 *   - 密文：iv(12B) || ciphertext 拼接后 base64 存储。
 *   - 密钥(IDB) 与密文(storage.local) 分离存放，抬高直接读取明文的门槛。
 *
 * 防护边界（如实说明）：
 *   同扩展上下文的代码仍可调用 decrypt() 拿到明文——WebCrypto 在扩展内
 *   无法抵御有代码执行能力的攻击，只是把"读 storage 拿明文"抬高到
 *   "读 IDB 密钥 + 调用解密 API"。真正的纵深防御依赖 background 代理
 *   (P1) 把密钥限制在 service worker 上下文。
 */
window.CryptoStore = (() => {
  const DB_NAME = 'asr-crypto';
  const STORE = 'keys';
  const KEY_RECORD = 'main';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // 获取或首次生成非可导出 AES-GCM 密钥
  async function getKey() {
    const existing = await idbGet(KEY_RECORD);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // extractable: false — 不可导出
      ['encrypt', 'decrypt'],
    );
    await idbSet(KEY_RECORD, key);
    return key;
  }

  function toB64(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function fromB64(str) {
    const s = atob(str);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  /** 加密明文字符串，返回 base64(iv + ciphertext)；空串原样返回。 */
  async function encrypt(plaintext) {
    if (!plaintext) return '';
    const key = await getKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = enc.encode(plaintext);
    const cipher = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data),
    );
    const packed = new Uint8Array(iv.length + cipher.length);
    packed.set(iv, 0);
    packed.set(cipher, iv.length);
    return toB64(packed);
  }

  /** 解密 base64(iv + ciphertext) 为明文；空串原样返回。 */
  async function decrypt(packedB64) {
    if (!packedB64) return '';
    const key = await getKey();
    const packed = fromB64(packedB64);
    const iv = packed.slice(0, 12);
    const cipher = packed.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return dec.decode(plain);
  }

  return { encrypt, decrypt };
})();
