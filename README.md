# Chrome Extension — Realtime ASR

A Manifest V3 Chrome extension for real-time speech-to-text. Record from the
microphone or a tab, or stream live — transcription appears as you speak over a
WebSocket (Qwen/DashScope run-task protocol). Copy the result or inject it
directly into any page input field.

No build step: load the directory unpacked and it runs.

## Features

- **Microphone recording** — record from the popup (webm / mp4 / wav)
- **Microphone selection** — pick which input device to use; the choice is persisted and falls back to the system default if the device disappears
- **Tab audio recording** — capture tab audio (meetings, videos) via `chrome.tabCapture` + an offscreen document
- **Live Stream** — realtime transcription over a WebSocket; partial and final sentences appear as you speak
- **Floating subtitles** — mirror the live transcript into a draggable overlay on the active page (toggle with **Subtitles**)
- **Save audio** — download the last mic or tab recording
- **Result actions** — copy to clipboard, or fill the focused input on the active page
- **Config** — provider / API key / endpoint / model / audio format, persisted locally
- **Encrypted storage** — API keys are encrypted (AES-GCM via WebCrypto) in `chrome.storage.local`; no cloud sync
- **Transcription history** — every streaming session is recorded in IndexedDB
- **Side panel + options page** — a persistent panel for long sessions, plus settings, history and storage status

## Quick Start

1. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** — select this directory.
2. Click the extension icon in the toolbar.
3. Select the provider (Qwen/DashScope) and enter your API key. It is stored encrypted, locally.
4. **Record**: click **Start Recording**, speak, then **Stop Recording** — or click **Record Tab** to capture the active tab's audio. **Save audio** downloads the result.
5. **Transcribe live**: click **Live Stream**, speak, and watch text appear. Use **Copy text** or **Fill into page** to use it.
6. **Floating subtitles**: click **Subtitles** to mirror the live transcript into a draggable overlay on the active page (useful when presenting from a window you are not looking at). The toggle is remembered; the overlay hides when streaming ends if no new text arrives.
7. **Pick a microphone**: the **Microphone** dropdown lists your input devices (names appear after the first permission grant) and applies to both recording and Live Stream. The choice is remembered.

Other entry points: **Side panel** keeps the panel open for long sessions;
**Options** opens settings, history and storage status (also reachable from
`chrome://extensions` → Details → Extension options).

## Permissions

- `storage` — persist configuration in `chrome.storage.local`; API keys are encrypted at rest
- `activeTab` — query the active tab for "Fill into page" and for tab audio capture
- `tabCapture` — capture tab audio (pairs with an offscreen document)
- `sidePanel` — open the persistent side panel
- `offscreen` — create the offscreen document that hosts tab capture (MV3 service workers have no DOM)
- Host permissions: `https://dashscope.aliyuncs.com/*` and `https://dashscope-intl.aliyuncs.com/*`. Note that these cover **HTTP** requests only: the streaming path uses `new WebSocket(...)` from the popup/side-panel page, and extension pages are **not** subject to `host_permissions` for WebSocket connections (verified: a `wss://` connection to an undeclared host still reaches the server). `wss://` is not a valid Chrome match pattern. The extension currently makes no `fetch()` calls, so these entries are effectively unused — kept as documentation of the endpoint hosts.

## Tests

`npm test` runs the Node unit tests (`tests/streaming.test.js`): the PCM helpers
(`floatToInt16`, `resampleFloat32`) and the streaming provider contract. No
browser or network needed.

For the browser smoke tests, open `tests/p1-smoke-test.html` in Chrome. It loads
the real modules and checks crypto, config, messaging and error helpers; the
cases live in `tests/p1-smoke-test.js` (external, so the page also runs under
the extension CSP).

For streaming diagnostics, run `node tests/serve-debug.js` and open
`http://localhost:18923/tests/stream-debug.html`. Pass a port to override the
default: `node tests/serve-debug.js 19150`.

## License

MIT
