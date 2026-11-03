'use strict';

/**
 * Installed in the real offscreen document before Live Stream starts.
 * The provider and PCM capture remain untouched; only the network edge is fake.
 */
function installMockWebSocket(options = {}) {
  if (globalThis.__asrE2EMock) return globalThis.__asrE2EMock;

  const partialText = String(options.partialText || 'mock partial');
  const finalText = String(options.finalText || 'mock final transcript');
  const state = {
    audioBytes: 0,
    audioFrames: 0,
    closed: 0,
    contexts: [],
    finishTasks: 0,
    finalSent: false,
    runTasks: [],
    sockets: 0,
    urls: [],
  };
  globalThis.__asrE2EMock = state;

  const RealAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = class MockAudioContext extends RealAudioContext {
    constructor(contextOptions) {
      super(contextOptions);
      state.contexts.push(this.sampleRate);
    }
  };

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = String(url);
      this.readyState = MockWebSocket.CONNECTING;
      state.sockets += 1;
      state.urls.push(this.url.replace(/api_key=[^&]*/i, 'api_key=<redacted>'));
      setTimeout(() => {
        if (this.readyState !== MockWebSocket.CONNECTING) return;
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.({});
      }, 0);
    }

    send(data) {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        const header = message?.header || {};
        if (header.action === 'run-task') {
          state.runTasks.push(message.payload || {});
          setTimeout(() => this.#emit({
            header: { event: 'task-started', task_id: header.task_id },
            payload: {},
          }), 0);
          setTimeout(() => this.#emit({
            header: { event: 'result-generated', task_id: header.task_id },
            payload: { output: { sentence: { text: partialText, sentence_end: false } } },
          }), 120);
          setTimeout(() => {
            state.finalSent = true;
            this.#emit({
              header: { event: 'result-generated', task_id: header.task_id },
              payload: { output: { sentence: { text: finalText, sentence_end: true } } },
            });
          }, 260);
          return;
        }
        if (header.action === 'finish-task') {
          state.finishTasks += 1;
          setTimeout(() => this.#emit({
            header: { event: 'task-finished', task_id: header.task_id },
            payload: {},
          }), 0);
        }
        return;
      }

      state.audioFrames += 1;
      state.audioBytes += Number(data?.byteLength) || 0;
    }

    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      state.closed += 1;
      setTimeout(() => {
        this.onclose?.({ wasClean: true, code: 1000, reason: '' });
      }, 0);
    }

    #emit(message) {
      if (this.readyState !== MockWebSocket.OPEN) return;
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  globalThis.WebSocket = MockWebSocket;
  return state;
}

module.exports = { installMockWebSocket };
