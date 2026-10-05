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
globalThis.CryptoStore = (() => {
  const DB_NAME = 'asr-crypto';
  const STORE = 'keys';
  const KEY_RECORD = 'main';

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // 缓存 DB 句柄：避免每次 idbGet/idbSet 都新建并泄漏一个 IDB 连接。
  // 注意两个自愈点（open 失败 / 连接被外部关闭，如版本变更）都要清空缓存，
  // 否则永久持有坏句柄，后续所有加解密都失败——比连接泄漏更糟。
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      const p = new Promise((resolve, reject) => {
        // v2：旧版 options 页曾直接 open(v1) 却未建 'keys' store，导致库被建到 v1
        // 且缺表；此后 open(v1) 不再触发 onupgradeneeded，加解密永久损坏。升到 v2
        // 强制走一次 upgrade，用 contains 补建缺失的表（已存在的库则无事发生）。
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => {
          const db = req.result;
          // 连接被外部强制关闭时清缓存（身份检查：别误清后来重建的新连接）
          db.onclose = () => { if (dbPromise === p) dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => reject(req.error);
      });
      p.catch(() => { if (dbPromise === p) dbPromise = null; });
      dbPromise = p;
    }
    return dbPromise;
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

  // 双层防竞态：
  //   1) keyPromise single-flight —— 同上下文内并发调用共享一次获取/生成。
  //   2) acquireKey 的 CAS 事务 —— 跨上下文（popup / options / sidepanel 是各自独立
  //      的 JS 模块实例，单靠 1 无法互见）。首装并发时两边各自 generate 也无害：
  //      IDB 对同一 store 的 readwrite 事务串行执行，输的一方在事务内复查会看到
  //      赢家的密钥并直接采用，绝不覆盖——先写 key 加密的数据因此永不丢。
  let keyPromise = null;

  async function acquireKey() {
    const db = await openDb();
    // 快路径：常规情况（密钥早已存在）直接读，不走 readwrite 事务
    const existing = await idbGet(KEY_RECORD);
    if (existing) return existing;

    // 慢路径（首装）：先生成好候选密钥，再开事务做「复查缺才写」。
    // 生成必须发生在事务开启前：subtle.generateKey 跨任务边界，await 它会让
    // 事务自动提交（IDB stale-transaction 陷阱）。
    const fresh = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // extractable: false — 不可导出
      ['encrypt', 'decrypt'],
    );
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let winner;
      const getReq = store.get(KEY_RECORD);
      getReq.onsuccess = () => {
        if (getReq.result) {
          winner = getReq.result; // 他上下文抢先写入：采用赢家，丢弃本地生成
          return;
        }
        winner = fresh;
        store.put(fresh, KEY_RECORD); // 同步入队（仍在事务回调的任务内），事务不过期
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => resolve(winner);
      tx.onabort = () => reject(tx.error);
    });
  }

  // 获取或首次生成非可导出 AES-GCM 密钥
  function getKey() {
    if (!keyPromise) {
      keyPromise = acquireKey();
      // 获取失败时清空，允许下次重试（否则后续调用永久拿到 rejected promise）
      keyPromise.catch(() => { keyPromise = null; });
    }
    return keyPromise;
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

  /** 是否已持有 AES-GCM 密钥（不创建）。供 options 页显示存储状态，避免它
   *  绕过 CryptoStore 直接 indexedDB.open 把库建坏（见 options.js 注释）。 */
  async function hasKey() {
    const existing = await idbGet(KEY_RECORD);
    return !!existing;
  }

  return { encrypt, decrypt, hasKey };
})();
