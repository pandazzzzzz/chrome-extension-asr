# Chrome Extension — Speech Recording

A Manifest V3 Chrome extension that records audio from the popup or the active tab. Transcription providers have been removed pending a future true WebSocket streaming layer; the extension currently serves as a **recording shell** with config + encrypted API-key storage reserved for that next step.

## Features

- **Microphone recording** directly from the popup (webm / mp4 / wav)
- **Tab audio recording** — record tab audio (meetings, videos) via `chrome.tabCapture` + offscreen document
- **Save audio** — download the last recording (mic or tab) to disk
- **Config forms** — Provider / API Key / Endpoint / Model / audio format, persisted locally
- **Encrypted local storage** — API keys stored encrypted (AES-GCM via WebCrypto) in `chrome.storage.local` (no cloud sync)
- **Result area + Copy + Fill into page** — UI reserved for transcription results (no transcription backend yet)
- **Side panel + options page** — persistent panel (reuses popup logic); options page for settings, history, and storage status
- **Transcription history** — IndexedDB store kept; will record results once transcription is reconnected

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
│   └── recorder.js           # MediaRecorder wrapper (shared: popup mic + offscreen tab)
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
3. Fill in Provider / API Key / Endpoint / Model as desired (stored encrypted / locally).
4. Click **Start Recording**, speak, then **Stop Recording** — or click **Record Tab** to record the active tab's audio (e.g. a meeting or video).
5. Click **Save audio** to download the recording. Transcription is not yet wired back in; the Result / Copy / Fill area is reserved for it.

Other entry points: the **Side panel** button keeps the panel open for long sessions; **Options** opens the settings/history/storage page (also available via `chrome://extensions` → Details → Extension options).

## Permissions

- `storage` — persist configuration locally (provider, API key, endpoint, model, audio format); API keys are encrypted in `storage.local` (no cloud sync)
- `activeTab` — query the active tab for the "Fill into page" feature and for tab audio capture
- `tabCapture` — capture tab audio (paired with an offscreen document, which needs no extra permission)
- `sidePanel` — open the persistent side panel (`chrome.sidePanel.open()`)
- `offscreen` — create the offscreen document for tab capture

## License

MIT
