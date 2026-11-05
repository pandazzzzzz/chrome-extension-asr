/**
 * 共享格式化助手（跨上下文：popup / sidepanel / options 均加载）。
 *
 * 挂载在 globalThis 上，与 shared/errors.js、shared/timeout.js 一致 ——
 * 不用 ES module，因为扩展页与 service worker 都靠 <script src> / importScripts
 * 按顺序加载普通脚本（见 AGENTS.md「Global scripts」）。
 */
globalThis.Format = (() => {
  const CREDENTIAL_HOST_LABEL = /^(?:sk|pk|api[_-]?key|access[_-]?token|token|secret|credential)[-_]/i;

  /**
   * 文件名安全的时间戳：`2026-09-28T19-30-00`。
   * 冒号在 Windows 文件名中非法，故整体替换掉 `:` 与 `.`。
   * @param {Date} [date] 缺省为当前时间
   * @returns {string}
   */
  function timestampForFile(date = new Date()) {
    return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  /**
   * 遥测用的 endpoint 摘要：保留 scheme/host 和白名单内的已知协议路径
   * （分诊时用来判断是不是 `https://` 残留或地址拼错），其余路径整体脱敏；
   * 同时去掉 userinfo / query / fragment —— 用户可能把 Key 直接拼进自定义
   * URL 的任意位置，`hasKey` 布尔挡不住这种泄漏。
   * @param {string} value
   * @returns {string} 空串保持空；无法解析时返回 `<unparseable>`
   */
  function endpointForTelemetry(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      const hostname = url.hostname
        .split('.')
        .map((label) => (CREDENTIAL_HOST_LABEL.test(label) ? '<redacted>' : label))
        .join('.');
      const host = hostname + (url.port ? `:${url.port}` : '');
      const safePaths = new Set(['', '/', '/api-ws/v1/inference', '/api-ws/v1/realtime']);
      const path = safePaths.has(url.pathname) ? url.pathname : '/<redacted-path>';
      return `${url.protocol}//${host}${path}`;
    } catch {
      return '<unparseable>';
    }
  }

  return { timestampForFile, endpointForTelemetry };
})();
