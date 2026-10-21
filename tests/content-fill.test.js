// Content fill-text 回归测试 —— 纯 Node，用最小 DOM 桩驱动 content/content.js。
//
// 锁定两个"假成功"场景：
//   1. `input[type=number/date/...]` 的 value setter 会静默丢弃文本，不能返回 ok；
//   2. contenteditable 里 execCommand('insertText') 返回 false 时不能报成功。
//
// 运行：npm test（或 node tests/content-fill.test.js）
const path = require('node:path');
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

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAIL') + ` (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
