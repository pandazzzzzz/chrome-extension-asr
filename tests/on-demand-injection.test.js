// On-demand content injection regression tests (pure Node, no browser).
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

function makeSandbox() {
  const tabsSent = [];
  const scripts = [];
  const styles = [];
  const listeners = [];
  let available = false;
  const sandbox = {
    console,
    Date,
    URL,
    setTimeout,
    clearTimeout,
    importScripts: (...files) => {
      for (const file of files) {
        const resolved = path.resolve(root, 'background', file);
        vm.runInContext(fs.readFileSync(resolved, 'utf8'), sandbox, { filename: file });
      }
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => listeners.push(fn) },
        onConnect: { addListener() {} },
        onInstalled: { addListener() {} },
        sendMessage: async () => ({ ok: true }),
        getURL: (p) => 'chrome-extension://test/' + p,
        getContexts: async () => [],
      },
      storage: {
        session: { async get() { return {}; }, async set() {} },
        sync: { async get() { return {}; }, async remove() {} },
      },
      tabs: {
        query: async () => [{ id: 7 }],
        onRemoved: { addListener() {} },
        sendMessage: async (tabId, message) => {
          tabsSent.push({ tabId, message });
          if (!available) throw new Error('Could not establish connection. Receiving end does not exist.');
          return { ok: true, data: true };
        },
      },
      scripting: {
        executeScript: async (details) => {
          scripts.push(details);
          available = true;
          return [];
        },
        insertCSS: async (details) => { styles.push(details); },
      },
      commands: { onCommand: { addListener() {} } },
      sidePanel: { open: async () => {} },
      windows: { WINDOW_ID_CURRENT: -2 },
      offscreen: {},
      tabCapture: {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(root, 'background/background.js'), 'utf8'),
    sandbox,
    { filename: 'background/background.js' },
  );
  return { sandbox, tabsSent, scripts, styles, listeners };
}

async function dispatch(page, type, payload = {}) {
  const results = await Promise.all(page.listeners.map((fn) => new Promise((resolve) => {
    fn({ type, payload, target: 'background' }, {}, resolve);
  })));
  return results.find((result) => result !== undefined);
}

async function test(name, fn) {
  await fn();
  console.log('PASS | ' + name);
}

(async () => {
  await test('fill injects its content bundle once and retries the message', async () => {
    const page = makeSandbox();
    const response = await dispatch(page, 'asr:fill-text', { text: 'hello' });
    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(Array.from(page.scripts[0].files), [
      'messaging/messages.js',
      'shared/errors.js',
      'content/content.js',
    ]);
    assert.strictEqual(page.scripts[0].target.tabId, 7);
    assert.deepStrictEqual(Array.from(page.styles[0].files), ['content/content.css']);
    assert.strictEqual(page.tabsSent.length, 2);
  });

  await test('an installed fill listener is not injected again', async () => {
    const page = makeSandbox();
    await dispatch(page, 'asr:fill-text', { text: 'first' });
    await dispatch(page, 'asr:fill-text', { text: 'second' });
    assert.strictEqual(page.scripts.length, 1);
    assert.strictEqual(page.styles.length, 1);
    assert.strictEqual(page.tabsSent.length, 3);
  });

  await test('subtitle show injects only its own bundle on demand', async () => {
    const page = makeSandbox();
    const response = await dispatch(page, 'asr:subtitle-show', { text: 'caption', tabId: 7 });
    assert.strictEqual(response.ok, true);
    assert.deepStrictEqual(Array.from(page.scripts[0].files), [
      'messaging/messages.js',
      'shared/errors.js',
      'content/subtitle.js',
    ]);
    assert.strictEqual(page.styles.length, 0);
    assert.strictEqual(page.tabsSent.length, 2);
  });

  await test('subtitle hide never injects into an otherwise untouched page', async () => {
    const page = makeSandbox();
    const response = await dispatch(page, 'asr:subtitle-hide', { tabId: 7 });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'NO_CONTENT');
    assert.strictEqual(page.scripts.length, 0);
    assert.strictEqual(page.tabsSent.length, 1);
  });

  await test('restricted pages retain the existing no-content failure', async () => {
    const page = makeSandbox();
    page.sandbox.chrome.scripting.executeScript = async () => {
      throw new Error('Cannot access a chrome:// URL');
    };
    const response = await dispatch(page, 'asr:fill-text', { text: 'hello' });
    assert.strictEqual(response.ok, false);
    assert.strictEqual(response.error.code, 'NO_CONTENT');
    assert.strictEqual(page.tabsSent.length, 1);
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
