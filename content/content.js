// Content script — 页面内听写注入。
//
// 职责：接收 background 转发的 asr:fill-text 消息，把转录文本注入当前
// 聚焦的输入元素（input / textarea / contenteditable）。
//
// 消息常量 MESSAGES 由 manifest 在 content.js 之前注入 messaging/messages.js。

// 找到当前聚焦的可输入元素
function getActiveField() {
  const el = document.activeElement;
  if (!el) return null;

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    // 排除不可输入文本的 input 类型
    if (['button', 'checkbox', 'radio', 'file', 'hidden', 'image', 'submit', 'reset', 'range', 'color'].includes(type)) {
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
  if (field.kind === 'value') {
    const el = field.el;
    // 用原生 setter 触发框架事件
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  if (field.kind === 'contenteditable') {
    field.el.focus();
    document.execCommand('insertText', false, text);
    return true;
  }

  return false;
}

// 监听来自 background 的注入消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.type === globalThis.MESSAGES.FILL_TEXT) {
    const text = request.payload?.text || '';
    const field = getActiveField();
    if (!field) {
      sendResponse({ ok: false, error: { code: 'NO_FIELD', message: 'No focused input field' } });
      return true;
    }
    const done = fillField(field, text);
    sendResponse({ ok: done, data: done });
    return true;
  }
  return false;
});

console.log('Content script loaded (ASR fill-text)');
