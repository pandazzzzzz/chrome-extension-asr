/**
 * HistoryStore — 转录历史（IndexedDB），供 options 页展示与回填。
 *
 * 设计：
 *   - 单独数据库 asr-history，对象 store records，按 createdAt 降序查询
 *   - 文本可能很长，单独存取；provider/model 存作检索字段
 *   - 上限 maxEntries（超出按最旧丢弃），避免无限增长
 *
 * 失败策略：IndexedDB 打开失败时返回空结果并打日志，不阻塞主流程
 * （历史是增强功能，不应影响转录本身）。
 */
globalThis.HistoryStore = (() => {
  const DB_NAME = 'asr-history';
  const STORE = 'records';
  const maxEntries = 50;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null; // 允许下次重试
      throw err;
    });
    return dbPromise;
  }

  /** 追加一条记录；超出上限时丢弃最旧的。 */
  async function add({ text, provider = '', model = '' }) {
    if (!text) return;
    try {
      const db = await openDb();
      const record = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text,
        provider,
        model,
        createdAt: Date.now(),
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).add(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      await trim(db);
    } catch (e) {
      console.warn('HistoryStore.add failed:', e);
    }
  }

  /** 读取历史（createdAt 降序，最多 limit 条）。 */
  async function list(limit = maxEntries) {
    try {
      const db = await openDb();
      const items = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const index = tx.objectStore(STORE).index('createdAt');
        const req = index.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
    } catch (e) {
      console.warn('HistoryStore.list failed:', e);
      return [];
    }
  }

  /** 清空历史。 */
  async function clear() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('HistoryStore.clear failed:', e);
    }
  }

  /** 超出上限时删除最旧记录。 */
  async function trim(db) {
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    if (all.length <= maxEntries) return;

    // getAllKeys 升序 → 最旧的在前
    const excess = all.slice(0, all.length - maxEntries);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const key of excess) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { add, list, clear };
})();
