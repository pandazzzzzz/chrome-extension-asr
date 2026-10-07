# Chrome Extension — Realtime ASR

A Manifest V3 Chrome extension for real-time speech-to-text. Record from the
microphone or a tab, or stream live — transcription appears as you speak over a
WebSocket (Qwen/DashScope run-task protocol). Copy the result or inject it
directly into any page input field.

No build step: load the directory unpacked and it runs.

## Features

- **Microphone recording** — record from the popup (webm / mp4 / wav)
- **Tab audio recording** — capture tab audio (meetings, videos) via `chrome.tabCapture` + an offscreen document
- **Live Stream** — realtime transcription over a WebSocket; partial and final sentences appear as you speak
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

Other entry points: **Side panel** keeps the panel open for long sessions;
**Options** opens settings, history and storage status (also reachable from
`chrome://extensions` → Details → Extension options).

## Permissions

- `storage` — persist configuration in `chrome.storage.local`; API keys are encrypted at rest
- `activeTab` — query the active tab for "Fill into page" and for tab audio capture
- `tabCapture` — capture tab audio (pairs with an offscreen document)
- `sidePanel` — open the persistent side panel
- `offscreen` — create the offscreen document that hosts tab capture (MV3 service workers have no DOM)
- Host permissions: `https://dashscope.aliyuncs.com/*` and `https://dashscope-intl.aliyuncs.com/*` — the Qwen/DashScope realtime endpoint. The WebSocket origin is covered by the `https://` pattern; `wss://` is not a valid Chrome match pattern.

## Project Structure

```
.
├── manifest.json             # Extension configuration (MV3)
├── popup/                    # Popup UI (recording + config)
│   ├── popup.html
│   ├── popup.css
│   └── app.js                # Main UI logic
├── sidepanel/                # Side panel UI (persistent; reuses popup/app.js + popup.css)
│   └── sidepanel.html
├── options/                  # Options page (settings + history + storage status)
│   ├── options.html
│   └── options.js
├── background/
│   └── background.js         # Service worker — message router + offscreen coordinator
├── offscreen/                # Offscreen document (tab audio capture, MV3 requirement)
│   ├── offscreen.html
│   └── offscreen.js
├── audio/
│   ├── recorder.js           # MediaRecorder wrapper (shared: popup mic + offscreen tab)
│   ├── convert.js            # PCM helpers: floatToInt16, resampleFloat32
│   ├── pcm-capture.js        # PCM frame capture (AudioWorklet, ScriptProcessor fallback)
│   └── pcm-worklet.js        # AudioWorklet processor for PCM capture
├── transcription/            # Streaming transcription layer (realtime WebSocket)
│   └── providers/
│       ├── base.js           # Base provider: streaming interface + capability metadata
│       ├── qwen.js           # Qwen (DashScope) — run-task WebSocket streaming
│       └── index.js          # Provider registry (PROVIDERS array)
├── content/                  # Content scripts (page dictation injection)
│   ├── content.js
│   └── content.css
├── store/                    # Storage layer
│   ├── config.js             # Config read/write (all in storage.local)
│   ├── crypto.js             # WebCrypto AES-GCM encryption for API keys
│   └── history.js            # Transcription history (IndexedDB, max 50 entries)
├── messaging/                # Cross-context message contract
│   ├── messages.js           # Action type constants
│   └── client.js             # sendMessage Promise wrapper
├── shared/
│   ├── errors.js             # Unified error codes
│   └── timeout.js            # withTimeout guard for promises that never settle
├── debug/
│   └── bridge.js             # Diagnostic telemetry bridge (active only on the local debug page)
├── scripts/
│   ├── pack.js               # Build `extension.zip` (PowerShell ZipFile + node:zlib fallback)
│   └── check-manifest.js     # Validate manifest.json and every path it references
├── icons/                    # Extension icons
├── docs/
│   ├── ARCHITECTURE.md       # Full architecture design doc
│   └── manual-verification.md # Step-by-step E2E checklist (Live Stream + recording shell)
├── tests/
│   ├── p1-smoke-test.html    # Browser-runnable smoke tests (open directly in Chrome)
│   ├── p1-smoke-test.js      # Test cases (external: inline scripts are blocked by the extension CSP)
│   ├── streaming.test.js     # Node unit tests (npm test): PCM helpers + provider contract
│   ├── stream-debug.html     # Streaming diagnostics page
│   └── serve-debug.js        # Static server for the diagnostics page (127.0.0.1 + [::1])
├── samples/                  # Committed test samples (audio, media)
└── temp/                     # Local-only temp files (not tracked by git)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design, and
[docs/manual-verification.md](docs/manual-verification.md) for the manual end-to-end checklist.

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
