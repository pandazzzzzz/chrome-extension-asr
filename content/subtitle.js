/**
 * Subtitle overlay — 页面内浮动字幕（content script）。
 *
 * 职责：接收 background 转发的 asr:subtitle-show / asr:subtitle-hide 消息，
 * 在当前页面上渲染一个可拖动的半透明字幕浮层。popup/sidepanel 开启 Subtitles
 * 后，流式 partial/final 文本实时镜像到活动标签页；popup 关闭时页面与 popup
 * 之间没有任何中间层（消息只在发送瞬间转发，见 background 的 forwardToActiveTab）。
 *
 * 隔离：宿主为 closed Shadow DOM 的 <div>。页面 CSS / 页面脚本既改不到浮层，
 * 浮层样式也不会泄漏进页面（issue #7 的 HTML 注入教训 —— 文本只走 textContent）。
 *
 * 常驻性：content script 随页面常驻，但**浮层不常驻** —— hide 即拆掉宿主节点，
 * show 时惰性重建；跨导航/刷新自然消失（content script 世界随文档销毁），
 * popup 换活动 tab 后旧 tab 的浮层随之过期，也属预期（切换窗口演讲不现实）。
 *
 * 自动淡出：show({ done:true })（流式会话结束）后 2s 无新消息自动隐藏。
 * 拖动后位置随会话保持（内存变量，不落盘 —— 刷新即回默认，属预期）。
 *
 * 消息常量 MESSAGES / TARGETS 由 manifest 在本脚本之前注入 messaging/messages.js。
 */
(function () {
  'use strict';

  var HOST_ID = 'asr-subtitle-host';
  var TEXT_TIMEOUT_MS = 2000; // done=true 后无新文本的自动隐藏延时

  // 浮层状态（host/shadow 闭包内，本模块外不可达）
  var state = {
    host: null,
    text: null,   // 字幕文本节点
    hideTimer: null,
  };

  /** 惰性创建浮层：closed Shadow DOM + 全内联样式（一次性注入 <style>）。 */
  function attach() {
    if (state.host) return;

    var host = document.createElement('div');
    host.id = HOST_ID;
    // 拖动状态挂 host 数据属性，避免闭包外的全局变量
    host.dataset.dragging = 'false';
    var shadow = host.attachShadow({ mode: 'closed' });

    var style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '.overlay {',
      '  position: fixed; left: 24px; bottom: 48px; z-index: 2147483647;',
      '  max-width: 70vw; min-width: 120px; padding: 10px 16px;',
      '  background: rgba(8, 15, 26, 0.82); color: #fff;',
      '  font: 16px/1.5 "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;',
      '  border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,0.35);',
      '  cursor: move; user-select: none; -webkit-user-select: none;',
      '  white-space: pre-wrap; word-break: break-word;',
      '}',
    ].join('\n');
    shadow.appendChild(style);

    var overlay = document.createElement('div');
    overlay.className = 'overlay';
    var text = document.createTextNode('');
    overlay.appendChild(text);
    shadow.appendChild(overlay);

    // 拖动：pointer 事件比 mouse 事件覆盖触摸笔/触摸屏；setPointerCapture 保证
    // 指针移出元素后仍能持续收到 move。只改 left/top，不碰页面布局。
    overlay.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      host.dataset.dragging = 'true';
      overlay.setPointerCapture(e.pointerId);
      var startX = e.clientX;
      var startY = e.clientY;
      // 初始样式用的是 left/bottom，fixed 元素的 offsetTop 不可靠 —— 以当前视口
      // 矩形为基准，拖动开始时把位置固定成 left/top（覆盖 bottom）。
      var rect = overlay.getBoundingClientRect();
      var originLeft = rect.left;
      var originTop = rect.top;

      function onMove(ev) {
        if (host.dataset.dragging !== 'true') return;
        var nx = originLeft + (ev.clientX - startX);
        var ny = originTop + (ev.clientY - startY);
        // 限制在视口内（留 8px 余量，别把字幕拖没了找不回）
        var maxX = window.innerWidth - overlay.offsetWidth - 8;
        var maxY = window.innerHeight - overlay.offsetHeight - 8;
        overlay.style.left = Math.max(8, Math.min(nx, maxX)) + 'px';
        overlay.style.top = Math.max(8, Math.min(ny, maxY)) + 'px';
        overlay.style.bottom = 'auto';
      }
      function onUp(ev) {
        host.dataset.dragging = 'false';
        overlay.releasePointerCapture(ev.pointerId);
        overlay.removeEventListener('pointermove', onMove);
        overlay.removeEventListener('pointerup', onUp);
        overlay.removeEventListener('pointercancel', onUp);
      }
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
      overlay.addEventListener('pointercancel', onUp);
    });

    document.documentElement.appendChild(host);
    state.host = host;
    state.text = text;
  }

  /** 拆掉浮层（hide 消息 / 自动淡出 / 页面卸载）。幂等。 */
  function detach() {
    if (!state.host) return;
    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    state.host.remove();
    state.host = null;
    state.text = null;
  }

  /**
   * 显示/更新字幕文本。
   * @param {{text:string, done?:boolean}} payload  done=true：会话已结束，
   *        2s 内无新 show 消息则自动隐藏（给用户读完最后一句的时间）。
   */
  function show(payload) {
    var text = payload?.text || '';
    if (!text) return { ok: false, error: globalThis.Errors.NO_TEXT };

    if (state.hideTimer) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    attach();
    state.text.nodeValue = text; // textNode.nodeValue —— 无 HTML 注入面
    if (payload?.done) {
      state.hideTimer = setTimeout(function () {
        state.hideTimer = null;
        detach();
      }, TEXT_TIMEOUT_MS);
    }
    return { ok: true, data: true };
  }

  /** 隐藏浮层（popup 关闭 Subtitles 开关 / 显式 hide）。幂等。 */
  function hide() {
    detach();
    return { ok: true, data: true };
  }

  // 只处理发给 content 的 subtitle 消息（与 content/content.js 的过滤方式一致，
  // 避免与其它上下文重复响应）。fill-text 仍由 content.js 处理，互不干扰。
  chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    if (request?.target !== globalThis.TARGETS.CONTENT) return false;
    if (request.type === globalThis.MESSAGES.SUBTITLE_SHOW) {
      sendResponse(show(request.payload));
      return true;
    }
    if (request.type === globalThis.MESSAGES.SUBTITLE_HIDE) {
      sendResponse(hide());
      return true;
    }
    return false;
  });
})();
