/**
 * withTimeout — 给任意 Promise 加超时兜底的共享辅助。
 *
 * 背景：项目里多处异步操作可能永不 settle（MediaRecorder onstop 不触发、
 * 消息通道对端被杀导致回调不来……）。逐个手写 setTimeout/清理容易漏,
 * 统一到这里。
 *
 * 用法:
 *   await withTimeout(somePromise, 5000, 'MediaRecorder.stop');
 *   // 超时 reject Error('Timeout: MediaRecorder.stop did not settle within 5000ms')
 *   // 且 err.code === 'TIMEOUT'（供 normalizeError / UI 分支识别）
 *
 * 语义说明：超时只让调用方拿到 rejection，**不会**取消底层操作
 * （Promise 本身不可取消）。调用方若需要清理（停轨/关 ctx/release），
 * 应在自己的 catch/finally 里做——popup 与 offscreen 的 stop 路径已是这个形状。
 */
globalThis.withTimeout = function withTimeout(promise, ms, label = '') {
  let timer = null;
  // finally 在 promise 先 settle（成功或失败）时清掉计时器，避免误报超时。
  const settled = promise.finally(() => {
    if (timer) { clearTimeout(timer); timer = null; }
  });
  return Promise.race([
    settled,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Timeout: ${label || 'operation'} did not settle within ${ms}ms`);
        err.code = globalThis.Errors && globalThis.Errors.TIMEOUT
          ? globalThis.Errors.TIMEOUT.code
          : 'TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]);
};
