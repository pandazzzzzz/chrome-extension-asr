/**
 * Stream lifecycle helpers shared by the popup and side panel.
 *
 * Pure state predicates live here so the pagehide close path can be tested
 * without a DOM or a live WebSocket.
 */
globalThis.StreamLifecycle = Object.freeze({
  /**
   * Decide whether unloading the page should deliver the current stream result.
   *
   * A busy start that has not finished capture setup must not finalize: the
   * result textarea may still contain the previous session, and writing it
   * again would create a duplicate history entry.
   */
  shouldFinalizeOnPageHide({
    streaming = false,
    busy = false,
    everStarted = false,
    closing = false,
  } = {}) {
    if (closing) return false;
    return !!streaming || (!!busy && !!everStarted);
  },
});
