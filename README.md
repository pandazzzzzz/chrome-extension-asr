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
manifest.json               Extension configuration (MV3)
popup/                      Popup UI: popup.html, popup.css, app.js (shared UI logic)
sidepanel/                  Persistent side panel (reuses popup/app.js + popup.css)
options/                    Options page: settings, history, storage status
background/background.js    Service worker — message routing + offscreen coordination
offscreen/                  Offscreen document hosting tab-audio capture
content/                    Content script — injects text into the focused page input
audio/                      recorder.js (MediaRecorder), convert.js (PCM helpers),
                            pcm-capture.js + pcm-worklet.js (AudioWorklet frame capture)
transcription/providers/    base.js (interface), qwen.js (run-task WebSocket), index.js (registry)
store/                      config.js (storage.local), crypto.js (AES-GCM), history.js (IndexedDB)
messaging/                  messages.js (action + target contract), client.js (sendMessage wrapper)
shared/errors.js            Unified error codes + createError / normalizeError
debug/bridge.js             Diagnostic telemetry bridge (active only on the local debug page)
scripts/pack.js             Build extension.zip (PowerShell ZipFile, node:zlib fallback)
tests/                      Browser-runnable smoke tests and the streaming debug page
icons/ samples/ temp/       Icons, committed test samples, local-only scratch space
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Tests

Open `tests/p1-smoke-test.html` in Chrome. It loads the real modules and checks
crypto, config, messaging and error helpers.

For streaming diagnostics, run `node tests/serve-debug.js` and open
`http://localhost:18923/tests/stream-debug.html`. Pass a port to override the
default: `node tests/serve-debug.js 19150`.

## License

MIT
