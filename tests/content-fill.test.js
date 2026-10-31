// Content fill-text 回归测试 —— 纯 Node，用最小 DOM 桩驱动 content/content.js。
//
// 锁定两个"假成功"场景：
//   1. `input[type=number/date/...]` 的 value setter 会静默丢弃文本，不能返回 ok；
//   2. contenteditable 里 execCommand('insertText') 返回 false 时不能报成功。
//
// 运行：npm test（或 node tests/content-fill.test.js）
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert');

const root = path.resolve(__dirname, '..');

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
  }
}

function makeInput(tagName, type, value = '') {
  const el = {
    tagName,
    value,
    _value: value,
    isContentEditable: false,
    _type: type,
    getAttribute(name) {
      return name === 'type' ? this._type : null;
    },
    dispatchEvent() { return true; },
  };
  return el;
}

function loadContent(activeElement, execCommand = () => false) {
  globalThis.document = {
    activeElement,
    execCommand,
  };
  globalThis.Event = FakeEvent;
  globalThis.HTMLInputElement = { prototype: {} };
  globalThis.HTMLTextAreaElement = { prototype: {} };
  Object.defineProperty(globalThis.HTMLInputElement.prototype, 'value', {
    configurable: true,
    set(value) { this._value = value; },
    get() { return this._value; },
  });
  Object.defineProperty(globalThis.HTMLTextAreaElement.prototype, 'value', {
    configurable: true,
    set(value) { this._value = value; },
    get() { return this._value; },
  });
  // 测试里的 input 是普通对象，不是 HTMLInputElement 实例；让它的原型指向
  // HTMLInputElement.prototype，模拟浏览器里 value setter 通过原型链工作的行为。
  if (activeElement?.tagName === 'INPUT') {
    Object.setPrototypeOf(activeElement, globalThis.HTMLInputElement.prototype);
  }

  let listener = null;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
    },
  };
  globalThis.TARGETS = { CONTENT: 'content' };
  globalThis.MESSAGES = { FILL_TEXT: 'asr:fill-text' };
  globalThis.Errors = {
    NO_FIELD: { code: 'NO_FIELD', message: 'No focused input field' },
    NO_TEXT: { code: 'NO_TEXT', message: 'No text to fill' },
  };

  delete require.cache[require.resolve(path.join(root, 'content/content.js'))];
  delete globalThis.__asrFillTextInstalled; // 每次 loadContent 模拟一个全新的页面全局。
  require(path.join(root, 'content/content.js'));
  assert.strictEqual(typeof listener, 'function', 'content.js 应注册消息监听器');
  return listener;
}

function sendFill(listener, text = 'hello') {
  let response = null;
  listener(
    { target: 'content', type: 'asr:fill-text', payload: { text } },
    {},
    (r) => { response = r; },
  );
  return response;
}

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + e.message); }
};

t('fill: input[type=number/date/email/url] 不得假成功', () => {
  for (const type of ['number', 'date', 'email', 'url']) {
    const el = makeInput('INPUT', type);
    const listener = loadContent(el);
    const res = sendFill(listener);
    assert.strictEqual(res.ok, false, `${type} 不可自由写入文本，必须返回失败`);
    assert.strictEqual(res.error.code, 'NO_FIELD');
  }
});

t('fill: contenteditable 的 execCommand 返回 false 时不得假成功', () => {
  const el = { tagName: 'DIV', isContentEditable: true, focus() {} };
  const listener = loadContent(el);
  const res = sendFill(listener);
  assert.strictEqual(res.ok, false, 'execCommand 失败必须返回失败');
});

t('fill: input value 被页面拒绝（readonly/maxlength）时不得假成功', () => {
  const el = makeInput('INPUT', 'text');
  Object.defineProperty(el, 'value', {
    configurable: true,
    set() { /* 模拟 readonly：写入被静默丢弃 */ },
    get() { return ''; },
  });
  const listener = loadContent(el);
  const res = sendFill(listener);
  assert.strictEqual(res.ok, false, 'value 未改变必须返回失败');
  assert.strictEqual(res.error.code, 'NO_FIELD');
});

t('fill: open shadow root 内的输入框可被识别并写入', () => {
  const el = makeInput('INPUT', 'text');
  // makeInput 自带 value 属性会遮蔽原型 setter；删掉它，模拟真实 input 的
  // value 只由 HTMLInputElement.prototype 提供。
  delete el.value;
  // 先建 prototype 桩，再把 el 挂上去；按真实 DOM 形状把 shadow root 放在
  // document.activeElement 上。
  const host = { tagName: 'DIV', shadowRoot: { activeElement: el } };
  const listener = loadContent(host);
  Object.setPrototypeOf(el, globalThis.HTMLInputElement.prototype);
  const res = sendFill(listener, 'shadow text');
  assert.strictEqual(res.ok, true, 'open shadow root 内的 input 应可写入');
  assert.strictEqual(el.value, 'shadow text');
});

t('fill: contenteditable 成功插入后返回 ok', () => {
  const el = { tagName: 'DIV', isContentEditable: true, focus() {} };
  const listener = loadContent(el, () => true);
  const res = sendFill(listener, 'inserted');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data, true);
});

t('fill: 重复按需注入只注册一个消息监听器', () => {
  const listeners = [];
  const sandbox = {
    console: { log() {} },
    document: { activeElement: null },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } },
    TARGETS: { CONTENT: 'content' },
    MESSAGES: { FILL_TEXT: 'asr:fill-text' },
    Errors: { NO_FIELD: { code: 'NO_FIELD' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');
  vm.runInContext(source, sandbox);
  vm.runInContext(source, sandbox);
  assert.strictEqual(listeners.length, 1);
});

t('subtitles: 重复按需注入只注册一个消息监听器', () => {
  const listeners = [];
  const sandbox = {
    document: {},
    window: {},
    setTimeout,
    clearTimeout,
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } },
    TARGETS: { CONTENT: 'content' },
    MESSAGES: { SUBTITLE_SHOW: 'asr:subtitle-show', SUBTITLE_HIDE: 'asr:subtitle-hide' },
    Errors: {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(root, 'content/subtitle.js'), 'utf8');
  vm.runInContext(source, sandbox);
  vm.runInContext(source, sandbox);
  assert.strictEqual(listeners.length, 1);
});

t('subtitles: a page-removed host is recreated on the next show (#116)', () => {
  const listeners = [];
  function makeEl(tag) {
    const el = {
      tagName: tag,
      style: {},
      dataset: {},
      children: [],
      isConnected: false,
      appendChild(child) {
        this.children.push(child);
        child.isConnected = this.isConnected;
      },
      addEventListener() {},
      setPointerCapture() {},
      releasePointerCapture() {},
      getBoundingClientRect() { return { left: 0, top: 0 }; },
      attachShadow() {
        const shadow = { children: [], appendChild(child) { this.children.push(child); } };
        this.shadow = shadow;
        return shadow;
      },
      remove() { this.isConnected = false; },
    };
    return el;
  }
  const documentElement = makeEl('html');
  documentElement.isConnected = true;
  const sandbox = {
    document: {
      documentElement,
      createElement: makeEl,
      createTextNode: (text) => ({ nodeValue: text }),
    },
    window: { innerWidth: 1024, innerHeight: 768 },
    setTimeout,
    clearTimeout,
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } },
    TARGETS: { CONTENT: 'content' },
    MESSAGES: { SUBTITLE_SHOW: 'asr:subtitle-show', SUBTITLE_HIDE: 'asr:subtitle-hide' },
    Errors: { NO_TEXT: { code: 'NO_TEXT' } },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'content/subtitle.js'), 'utf8'), sandbox);

  const dispatch = (payload) => new Promise((resolve) => {
    listeners[0]({ target: 'content', type: 'asr:subtitle-show', payload }, {}, resolve);
  });
  return dispatch({ text: 'first' }).then(() => {
    const first = documentElement.children[0];
    assert.ok(first, 'host mounted');
    first.remove(); // 页面主动删除宿主
    return dispatch({ text: 'second' });
  }).then(() => {
    const live = documentElement.children.filter((h) => h.isConnected);
    assert.strictEqual(live.length, 1, 'a fresh connected host must be mounted');
    assert.notStrictEqual(live[0], documentElement.children[0], 'detached host must not be reused');
    const overlay = live[0].shadow.children.find((c) => c.className === 'overlay');
    assert.strictEqual(overlay.children[0].nodeValue, 'second', 'text must be written into the new host');
  });
});

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
