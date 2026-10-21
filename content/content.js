// Content script — 页面内听写注入。
//
// 职责：接收 background 转发的 asr:fill-text 消息，把转录文本注入当前
// 聚焦的输入元素（input / textarea / contenteditable）。
//
// 消息常量 MESSAGES / TARGETS 与错误码 Errors 由 manifest 在 content.js 之前
// 注入 messaging/messages.js 与 shared/errors.js。

// 找到当前聚焦的可输入元素
function getActiveField() {
  // activeElement 只返回 light DOM 的焦点元素；焦点落在 open shadow root 内时
  // 需要逐层下钻，否则会误报 "No focused input field"。
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return null;

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    // 排除不可输入文本的 input 类型
    // number/date/time/email/url/tel/search/password 等类型的 value setter 会
    // 静默清洗/拒绝任意文本（例如 number 收到 "hello" 会变成 ''），不能当成
    // 可注入字段 —— 否则用户看到 "Filled" 但页面什么都没变。
    // 注意：email/url/number/date 等类型虽然"能输入文本"，但浏览器会按自身规则
    // 清洗/拒绝，注入任意转录文本仍可能静默丢字；只放行真正自由文本的类型。
    const textTypes = new Set(['text', 'search', 'password']);
    if (!textTypes.has(type)) {
      return null;
    }
    return { kind: 'value', el };
  }

  if (el.isContentEditable) {
    return { kind: 'contenteditable', el };
  }

  return null;
}

// 把文本注入目标元素（触发 input/change 事件，兼容 React/Vue 受控组件）
function fillField(field, text) {
  try {
    if (field.kind === 'value') {
      const el = field.el;
      // 用原生 setter 触发框架事件
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      // readonly / maxlength / 页面自定义 setter 仍可能静默改写或丢弃文本。
      if (el.value !== text) return false;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    if (field.kind === 'contenteditable') {
      field.el.focus();
      // execCommand 在页面禁用编辑、选区不可用等情况下会返回 false；必须把它
      // 透传给调用方，不能无条件报成功。
      return document.execCommand('insertText', false, text) === true;
    }
  } catch {
    return false;
  }

  return false;
}

// 监听来自 background 的注入消息（仅处理发给 content 的，避免与其它上下文重复响应）
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (
    request?.target !== globalThis.TARGETS.CONTENT ||
    request.type !== globalThis.MESSAGES.FILL_TEXT
  ) {
    return false;
  }

  const text = request.payload?.text || '';
  const field = getActiveField();
  if (!field) {
    sendResponse({ ok: false, error: globalThis.Errors.NO_FIELD });
    return true;
  }
  const done = fillField(field, text);
  sendResponse(done
    ? { ok: true, data: true }
    : { ok: false, error: globalThis.Errors.NO_FIELD });
  return true;
});

console.log('Content script loaded (ASR fill-text)');
