# Chrome Extension — Realtime ASR

A Manifest V3 Chrome extension for **real-time speech-to-text**. Record from the microphone or a tab, or stream live — transcription appears as you speak via WebSocket (Qwen/DashScope run-task protocol). Copy results or inject them directly into any page input field.

## Features

- **Microphone recording** directly from the popup (webm / mp4 / wav)
- **Tab audio recording** — record tab audio (meetings, videos) via `chrome.tabCapture` + offscreen document
- **Live Stream (realtime transcription)** — speak and see text appear as you go (partial / final subtitles via Qwen WebSocket run-task)
- **Save audio** — download the last recording (mic or tab) to disk
- **Config forms** — Provider / API Key / Endpoint / Model / audio format, persisted locally
- **Encrypted local storage** — API keys stored encrypted (AES-GCM via WebCrypto) in `chrome.storage.local` (no cloud sync)
- **Result area + Copy + Fill into page** — transcriptions show up here; copy to clipboard or inject into the focused input on any page
- **Side panel + options page** — persistent panel (reuses popup logic); options page for settings, history, and storage status
- **Transcription history** — IndexedDB store records every streaming session result

## Project Structure

```
.
├── manifest.json             # Extension configuration (MV3)
├── popup/                    # Popup UI (recording + config)
│   ├── popup.html
│   ├── popup.css
│   └── app.js                # Main UI logic
├── sidepanel/                 # Side panel UI (persistent; reuses popup/app.js + popup.css)
│   └── sidepanel.html
├── options/                   # Options page (settings + history + storage status)
│   ├── options.html
│   └── options.js
├── background/
│   └── background.js         # Service worker — message router + offscreen coordinator
├── offscreen/                # Offscreen document (tab audio capture, MV3 requirement)
│   ├── offscreen.html
│   └── offscreen.js
├── audio/
│   ├── recorder.js         # MediaRecorder wrapper (shared: popup mic + offscreen tab)
│   ├── convert.js          # PCM helpers: floatToInt16, resampleFloat32
│   ├── pcm-capture.js      # PCM frame capture (AudioWorklet, ScriptProcessor fallback)
│   └── pcm-worklet.js      # AudioWorklet processor for PCM capture
├── transcription/          # Streaming transcription layer (realtime WebSocket)
│   └── providers/
│       ├── base.js         # Base provider: streaming interface + capability metadata
│       ├── qwen.js         # Qwen (DashScope) — run-task WebSocket streaming
│       └── index.js        # Provider registry (PROVIDERS array)
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
│   └── errors.js             # Unified error codes
├── scripts/
│   └── pack.js             # Build `extension.zip` (PowerShell ZipFile + node:zlib fallback)
├── icons/                    # Extension icons
├── docs/
│   └── ARCHITECTURE.md       # Full architecture design doc
├── tests/
│   └── p1-smoke-test.html    # Browser-runnable smoke tests (open directly in Chrome)
├── samples/                  # Committed test samples (audio, models)
└── temp/                     # Local-only temp files (not tracked by git)
```

> 架构设计与按功能划分的模块规划见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## Quick Start

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this project directory.
2. Click the extension icon in the toolbar.
3. Select a provider (Qwen/DashScope) and fill in your API Key (stored encrypted / locally).
4. To record: click **Start Recording**, speak, then **Stop Recording** — or click **Record Tab** to capture the active tab's audio (e.g. a meeting or video). Click **Save audio** to download.
5. For realtime transcription: click **Live Stream**, speak, and watch results appear as you go. Use **Copy text** or **Fill into page** to use the result.

Other entry points: the **Side panel** button keeps the panel open for long sessions; **Options** opens the settings/history/storage page (also available via `chrome://extensions` → Details → Extension options).

## Permissions

- `storage` — persist configuration locally (provider, API key, endpoint, model, audio format); API keys are encrypted in `storage.local` (no cloud sync)
- `activeTab` — query the active tab for the "Fill into page" feature and for tab audio capture
- `tabCapture` — capture tab audio (paired with an offscreen document, which needs no extra permission)
- `sidePanel` — open the persistent side panel (`chrome.sidePanel.open()`)
- `offscreen` — create the offscreen document for tab capture
- Host permissions: `https://dashscope.aliyuncs.com/*` + `https://dashscope-intl.aliyuncs.com/*` — Qwen/DashScope realtime WebSocket streaming endpoint (WebSocket origin is covered by the `https://` pattern; `wss://` is not a valid Chrome match pattern)

## License

MIT
