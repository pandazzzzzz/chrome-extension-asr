// HistoryStore 错误传播测试 —— 纯 Node，无浏览器依赖。
//
// 历史是增强功能，但"读失败"与"空历史"必须是两种状态：否则 options 会把
// IndexedDB 故障误报成 "No history yet."，clear() 也会误报成功。本文件用
// 缺失的 indexedDB 触发 openDb 失败，锁定四个入口都 reject。
//
// 运行：npm test（或 node tests/history.test.js）
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
// HistoryStore 只在失败分支打 console.warn；测试故意制造失败，过滤这些预期日志，
// 避免 `npm test` 输出看起来像有错误。
const realWarn = console.warn;
console.warn = () => {};
delete globalThis.indexedDB;
delete require.cache[require.resolve(path.join(root, 'store/history.js'))];
require(path.join(root, 'store/history.js'));

// 真实 IndexedDB 的最小内存桩：用于验证 add() 的“已写入但 trim 失败”边界，
// 以及 trim 按 createdAt 而不是 key 字符串排序。
// 只实现本测试需要的 open / transaction / add / getAllKeys / getAll / delete / count。
function makeFakeIndexedDb({ failTrim = false } = {}) {
  const rows = new Map();
  const store = {
    keyPath: 'id',
    add(record) {
      rows.set(record.id, record);
      return { result: record.id };
    },
    getAllKeys() {
      return makeKeysRequest();
    },
    getAll() {
      const req = {};
      setTimeout(() => {
        req.result = [...rows.values()];
        req.onsuccess?.();
      }, 0);
      return req;
    },
    delete(key) { rows.delete(key); },
    count() { return { result: rows.size }; },
    index() {
      return {
        getAll: () => store.getAll(),
        getAllKeys: () => makeKeysRequest(),
      };
    },
  };
  function makeKeysRequest() {
    const req = {};
    setTimeout(() => {
      if (failTrim) {
        req.error = new Error('trim getAllKeys failed');
        req.onerror?.();
        return;
      }
      // createdAt 索引按 createdAt 升序返回主键，而不是按主键字符串排序。
      req.result = [...rows.values()]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((record) => record.id);
      req.onsuccess?.();
    }, 0);
    return req;
  }
  let txCount = 0;
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => store,
    transaction(name, mode) {
      txCount += 1;
      const thisTx = txCount;
      const tx = {
        objectStore: () => store,
        oncomplete: null,
        onerror: null,
        onabort: null,
      };
      // 同步完成后由 setTimeout 触发，模拟 IndexedDB 的事件循环时序。
      setTimeout(() => {
        if (failTrim && thisTx > 1) {
          tx.error = new Error('trim transaction failed');
          tx.onabort?.();
        } else {
          tx.oncomplete?.();
        }
      }, 0);
      return tx;
    },
  };
  return {
    rows,
    open() {
      const req = {};
      setTimeout(() => {
        req.result = db;
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };
}

let pass = 0, fail = 0;
const t = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => { pass++; console.log('PASS | ' + name); })
  .catch((e) => { fail++; console.log('FAIL | ' + name + ' | ' + e.message); });

(async () => {
  const H = globalThis.HistoryStore;

  await t('add: IndexedDB 打开失败 → reject（不假装保存成功）', async () => {
    await assert.rejects(H.add({ text: 'hello' }), /indexedDB is not defined/);
  });

  await t('list: IndexedDB 打开失败 → reject（不与空历史混淆）', async () => {
    await assert.rejects(H.list(), /indexedDB is not defined/);
  });

  await t('count: IndexedDB 打开失败 → reject（不误报 0 条）', async () => {
    await assert.rejects(H.count(), /indexedDB is not defined/);
  });

  await t('clear: IndexedDB 打开失败 → reject（不误报已清空）', async () => {
    await assert.rejects(H.clear(), /indexedDB is not defined/);
  });

  await t('add: trim 失败时不能把已经写入的记录报成保存失败', async () => {
    // 换一个干净的模块实例，避免前面 openDb 的失败缓存。
    delete require.cache[require.resolve(path.join(root, 'store/history.js'))];
    const fake = makeFakeIndexedDb({ failTrim: true });
    globalThis.indexedDB = fake;
    require(path.join(root, 'store/history.js'));
    const store = globalThis.HistoryStore;
    const realWarn = console.warn;
    let warned = '';
    console.warn = (...args) => { warned += args.join(' '); };
    try {
      await store.add({ text: 'saved-before-trim' });
    } finally {
      console.warn = realWarn;
    }
    assert.match(warned, /trim transaction failed|trim getAllKeys failed/,
      'trim 失败仍应留下诊断日志');
    assert.strictEqual(fake.rows.size, 1, '记录应已写入');
  });

  await t('trim: 按 createdAt 删除最旧记录，而不是按 id 字符串', async () => {
    delete require.cache[require.resolve(path.join(root, 'store/history.js'))];
    const fake = makeFakeIndexedDb();
    globalThis.indexedDB = fake;
    require(path.join(root, 'store/history.js'));
    const store = globalThis.HistoryStore;

    // 模拟 50 条记录已满：主键字符串顺序与 createdAt 顺序不同。createdAt
    // 最大的记录故意配字典序最小的 id（a-newest）；若 trim 用 getAllKeys
    // 升序删除，会误删最新记录，而不是 createdAt 最小的 m-oldest。
    for (let i = 0; i < 50; i++) {
      const id = i === 0
        ? 'm-oldest'
        : (i === 49 ? 'a-newest' : `b-${String(i).padStart(2, '0')}`);
      fake.rows.set(id, {
        id,
        text: `entry-${i}`,
        createdAt: 1000 + i,
      });
    }
    // 写入一条 createdAt 最新的记录；若 trim 按主键删，会先删 a-newest。
    await store.add({ text: 'newest' });
    assert.strictEqual(fake.rows.size, 50, '超出上限后应回到 maxEntries');
    assert.ok([...fake.rows.values()].some((r) => r.text === 'newest'), '新记录必须保留');
    assert.ok(![...fake.rows.values()].some((r) => r.text === 'entry-0'),
      'createdAt 最旧的记录必须被删除，即使它的 id 字典序居中');
    assert.ok([...fake.rows.values()].some((r) => r.text === 'entry-49'),
      'createdAt 最新的既有记录不应被误删');
  });

  console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
  console.warn = realWarn;
  process.exit(fail === 0 ? 0 : 1);
})();
