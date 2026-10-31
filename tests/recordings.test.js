// RecordingStore — OPFS-backed tab recording storage.
//
// The tab-recording path must never carry audio bytes through runtime messages.
// These tests pin the small cross-context contract used by offscreen and popup:
// save a Blob in OPFS, pass { file, mime, size }, then read/remove it by that ref.
const path = require('node:path');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');
require(path.join(root, 'store/recordings.js'));

let pass = 0;
let fail = 0;
const tests = [];
const t = (name, fn) => tests.push({ name, fn });

function notFound(message) {
  const error = new Error(message);
  error.name = 'NotFoundError';
  return error;
}

function makeFakeOpfs() {
  const files = new Map();
  const dir = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) throw notFound(`missing ${name}`);
      return {
        async createWritable() {
          let pending = null;
          return {
            async write(blob) {
              pending = blob;
            },
            async close() {
              files.set(name, pending);
            },
            async abort() {},
          };
        },
        async getFile() {
          const file = files.get(name);
          if (!file) throw notFound(`missing ${name}`);
          return file;
        },
      };
    },
    async *keys() {
      yield* files.keys();
    },
    async removeEntry(name) {
      if (!files.delete(name)) throw notFound(`missing ${name}`);
    },
  };
  const rootHandle = {
    async getDirectoryHandle(name, { create = false } = {}) {
      if (name !== 'asr-recordings') throw notFound(`missing directory ${name}`);
      return dir;
    },
  };
  return { files, rootHandle };
}

function withOpfs(fake, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => fake.rootHandle } },
  });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
      else delete globalThis.navigator;
    });
}

t('save returns only a portable ref and preserves the Blob bytes', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    const source = new Blob(['recording-bytes'], { type: 'audio/webm' });
    const ref = await globalThis.RecordingStore.save(source);

    assert.strictEqual(globalThis.RecordingStore.isRef(ref), true);
    assert.strictEqual(ref.mime, 'audio/webm');
    assert.strictEqual(ref.size, source.size);
    assert.strictEqual(typeof ref.file, 'string');
    assert.strictEqual(fake.files.has(ref.file), true);

    const restored = await globalThis.RecordingStore.read(ref);
    assert.strictEqual(restored.size, source.size);
    assert.strictEqual(await restored.text(), 'recording-bytes');
  });
});

t('remove deletes the OPFS file and repeated removal is idempotent', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    const ref = await globalThis.RecordingStore.save(new Blob(['x'], { type: 'audio/mp4' }));
    assert.strictEqual(await globalThis.RecordingStore.remove(ref), true);
    assert.strictEqual(fake.files.has(ref.file), false);
    assert.strictEqual(await globalThis.RecordingStore.remove(ref), false);
  });
});

t('invalid refs are rejected before touching OPFS', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    assert.strictEqual(globalThis.RecordingStore.isRef(null), false);
    assert.strictEqual(globalThis.RecordingStore.isRef({ file: '../escape' }), false);
    assert.strictEqual(globalThis.RecordingStore.isRef({ file: 'tab-x.audio', mime: 'audio/webm' }), false);
    await assert.rejects(
      globalThis.RecordingStore.read({ file: '../escape', mime: 'audio/webm', size: 1 }),
      /Invalid recording reference/,
    );
  });
});

t('save creates distinct refs so an older Save click stays valid', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    const one = await globalThis.RecordingStore.save(new Blob(['one'], { type: 'audio/webm' }));
    const two = await globalThis.RecordingStore.save(new Blob(['two'], { type: 'audio/webm' }));
    assert.notStrictEqual(one.file, two.file);
    assert.strictEqual(fake.files.size, 2);
  });
});

t('list reports only recording files in the OPFS directory', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    fake.files.set('tab-a.audio', { size: 1, lastModified: 0 });
    fake.files.set('tab-b.audio', { size: 1, lastModified: 0 });
    fake.files.set('notes.txt', { size: 1, lastModified: 0 });
    const names = await globalThis.RecordingStore.list();
    assert.deepStrictEqual(names.sort(), ['tab-a.audio', 'tab-b.audio']);
  });
  console.log('PASS | list reports only recording files');
});

t('sweep removes only old unreferenced recordings', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    const old = Date.now() - 60 * 60 * 1000;
    fake.files.set('tab-keep.audio', { size: 1, lastModified: old });
    fake.files.set('tab-orphan.audio', { size: 1, lastModified: old });
    fake.files.set('tab-fresh.audio', { size: 1, lastModified: Date.now() });
    fake.files.set('notes.txt', { size: 1, lastModified: old });
    const removed = await globalThis.RecordingStore.sweep([{ file: 'tab-keep.audio', mime: 'audio/webm', size: 1 }]);
    assert.strictEqual(removed, 1, 'only the old orphan is removed');
    assert.ok(fake.files.has('tab-keep.audio'), 'referenced recording is kept');
    assert.ok(fake.files.has('tab-fresh.audio'), 'a just-written file survives the in-flight window');
    assert.ok(fake.files.has('notes.txt'), 'non-recording files are never touched');
  });
  console.log('PASS | sweep removes only old unreferenced recordings');
});

t('sweep keeps recordings whose age cannot be determined', async () => {
  const fake = makeFakeOpfs();
  await withOpfs(fake, async () => {
    fake.files.set('tab-unknown.audio', { size: 1 });
    const removed = await globalThis.RecordingStore.sweep([]);
    assert.strictEqual(removed, 0, 'unknown age must fail closed');
    assert.ok(fake.files.has('tab-unknown.audio'), 'file without lastModified is kept');
  });
  console.log('PASS | sweep keeps recordings with unknown age');
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      pass++;
      console.log(`PASS | ${name}`);
    } catch (error) {
      fail++;
      console.log(`FAIL | ${name} | ${error.message}`);
    }
  }
  console.log(`\n${fail === 0 ? 'ALL PASS' : `${fail} FAIL`} (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
})();
