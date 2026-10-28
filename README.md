# Chrome Extension — Realtime ASR

A Manifest V3 Chrome extension for real-time speech-to-text. Record from the
microphone or a tab, or stream live — transcription appears as you speak over a
WebSocket (Qwen/DashScope run-task protocol). Copy the result or inject it
directly into any page input field.

No build step: load the directory unpacked and it runs.

## Features

- **Microphone recording** — record from the popup (webm / mp4, with wav when the browser's MediaRecorder supports it)
- **Microphone selection** — pick which input device to use; the choice is persisted and falls back to the system default if the device disappears
- **Tab audio recording** — capture tab audio (meetings, videos) via `chrome.tabCapture` + an offscreen document
- **Live Stream** — realtime transcription over a WebSocket; partial and final sentences appear as you speak
- **Model connection test** — validate the current endpoint, API key and model with a task handshake, without recording or sending audio
- **Floating subtitles** — mirror the live transcript into a draggable overlay on the page where streaming started (toggle with **Subtitles**; switching tabs does not move the overlay)
- **Save audio** — download the last mic or tab recording
- **Result actions** — copy to clipboard, or fill the focused input on the active page
- **Config** — provider / API key / region / endpoint / model / audio format, persisted locally. **Region** picks the endpoint (Beijing / Singapore / Custom); the endpoint field only appears for Custom, so the URL and the API key's region can't silently drift apart.
- **Encrypted storage** — API keys are encrypted (AES-GCM via WebCrypto) in `chrome.storage.local`; no cloud sync
- **Transcription history** — every streaming session is recorded in IndexedDB, and the options page can **export it as JSON** (a timestamped download; no `downloads` permission needed)
- **Side panel + options page** — a persistent panel for long sessions, plus settings, history and storage status
- **Dark mode** — the popup, side panel and options page follow the OS/browser colour scheme automatically (`prefers-color-scheme`); no toggle to configure
- **Keyboard shortcuts** — `Ctrl+Shift+Y` opens the popup, `Ctrl+Shift+U` the side panel (`Cmd+Shift+…` on macOS). `Open the options page` ships **without** a default key — assign one at `chrome://extensions/shortcuts`

## Quick Start

1. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked** — select this directory.
2. Click the extension icon in the toolbar.
3. Select the provider (Qwen/DashScope) and enter your API key. It is stored encrypted, locally.
   Click **Test model** to check unsaved settings before starting a stream.
4. **Record**: click **Start Recording**, speak, then **Stop Recording** — or click **Record Tab** to capture the active tab's audio. **Save audio** downloads the result.
5. **Transcribe live**: click **Live Stream**, speak, and watch text appear. Use **Copy text** or **Fill into page** to use it.
6. **Floating subtitles**: click **Subtitles** to mirror the live transcript into a draggable overlay on the page where streaming started (useful when presenting from a window you are not looking at). The toggle is remembered; the overlay hides when streaming ends if no new text arrives.
7. **Pick a microphone**: the **Microphone** dropdown lists your input devices (names appear after the first permission grant) and applies to both recording and Live Stream. The choice is remembered.

Other entry points: **Side panel** keeps the panel open for long sessions;
**Options** opens settings, history and storage status (also reachable from
`chrome://extensions` → Details → Extension options).
**Shortcuts** can be rebound (or given a key, for the options command) at
`chrome://extensions/shortcuts`.

## Permissions

- `storage` — persist configuration in `chrome.storage.local`; API keys are encrypted at rest
- `tabCapture` — capture tab audio (pairs with an offscreen document)
- `sidePanel` — open the persistent side panel
- `offscreen` — create the offscreen document that hosts tab capture (MV3 service workers have no DOM)
- Host permissions: none. Live Stream opens its WebSocket from the offscreen document
  (`offscreen/offscreen-streaming.js`), so recording survives popup/side-panel closure.
  Extension pages are **not** subject to `host_permissions` for WebSocket connections;
  only `wss://` endpoints are accepted. `wss://` is not a valid Chrome match pattern, and
  the extension makes no `fetch()` calls.

## Tests

`npm test` runs the Node unit tests: `tests/streaming.test.js` (PCM helpers,
provider contract, model metadata, active-close handling and post-handshake
network errors), `tests/devices.test.js` (microphone permission errors map to
actionable Chrome settings guidance), `tests/config.test.js` (merge semantics, apiKey boundaries,
one-shot migration and write serialization), `tests/config-ui-sync.test.js`
(popup/side-panel cross-page edit guards), `tests/options-config-sync.test.js`
(options-page sync and unsaved-edit guards), `tests/offscreen-messaging.test.js`
(stream lifecycle and message-family routing), `tests/popup-record-mutex.test.js`
(recording UI mutex and mic lease), `tests/background-lifecycle.test.js` and
`tests/background-arbitration.test.js` (stream generations and three-way audio
ownership), `tests/history.test.js` (IndexedDB
errors are not reported as empty/success, trim failures do not hide a
successful write, and trimming follows createdAt), `tests/content-fill.test.js`
(fill-text cannot report false success; open Shadow DOM is supported),
`tests/recorder.test.js`
(MediaRecorder format fallback), `tests/pcm-capture.test.js` (the ScriptProcessor
fallback carries partial frames across callbacks),
`tests/pack.test.js` (the packaged zip keeps every manifest-referenced path and
no dev-only/agent artifacts), `tests/debug-redact.test.js` (diagnostic logs
redact query/JSON/Bearer credentials), and `tests/serve-debug.test.js` (the
diagnostics server serves only its exact page assets, blocks
path traversal, rejects a non-loopback `Host` header, and exits cleanly when
its port is taken).
No browser or network needed.

## WebSocket authentication note

Browsers cannot set an `Authorization` header on a WebSocket handshake. The Qwen
provider therefore uses the service's observed `?api_key=...` query fallback,
even though the public protocol documentation describes a Bearer header. Only
`wss://` endpoints are accepted. Treat URLs, browser diagnostics, and any proxy
logs as credential-bearing when debugging Live Stream, and use a dedicated,
least-privilege API key for this extension. If the provider removes query-string
authentication, run a loopback-only TLS proxy that adds the documented
`Authorization: Bearer ...` header, then point the **Custom** region endpoint at
that proxy. Do not log the incoming query string, and trust the proxy certificate
only for local development.

For the browser smoke tests, open `tests/p1-smoke-test.html` in Chrome. It loads
the real modules and checks crypto, config, messaging and error helpers; the
cases live in `tests/p1-smoke-test.js` (external, so the page also runs under
the extension CSP). `tests/smoke-run.js` also checks that the diagnostic page
can load a selected local audio file in a real Chrome media element.

For streaming diagnostics, run `node tests/serve-debug.js` and open
`http://localhost:18923/tests/stream-debug.html`. Telemetry requires this exact
approved loopback origin/port, and the content bridge is injected only into
that exact port/path and subscribes only from the top frame; the static server
can listen on another port for manual page testing, but the bridge intentionally
will not inject or subscribe there. The
server binds to loopback only,
serves only the diagnostic page and its redaction helper (so `.env.local`,
`.git/`, `docs/`, `temp/`, local manual plans, exported logs, and local media
are never reachable over HTTP), and rejects any non-loopback `Host` header.

## License

MIT
