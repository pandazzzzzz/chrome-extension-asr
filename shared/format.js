/**
 * 共享格式化助手（跨上下文：popup / sidepanel / options 均加载）。
 *
 * 挂载在 globalThis 上，与 shared/errors.js、shared/timeout.js 一致 ——
 * 不用 ES module，因为扩展页与 service worker 都靠 <script src> / importScripts
 * 按顺序加载普通脚本（见 AGENTS.md「Global scripts」）。
 */
globalThis.Format = (() => {
  /**
   * 文件名安全的时间戳：`2026-09-28T19-30-00`。
   * 冒号在 Windows 文件名中非法，故整体替换掉 `:` 与 `.`。
   * @param {Date} [date] 缺省为当前时间
   * @returns {string}
   */
  function timestampForFile(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  return { timestampForFile };
})();
