# Chrome Extension — Multi-Provider ASR

A Manifest V3 Chrome extension that records audio from the popup and transcribes it using one of several speech recognition providers (Qwen / OpenAI Whisper / Deepgram / or your own).

## Features

- **Vendor-agnostic popup framework** — switch providers from a dropdown
- **Voice recording** directly from the popup (webm / mp4 / wav)
- **Cloud transcription** via configurable API endpoints (Qwen / OpenAI Whisper / Deepgram)
- **Background API proxy** — transcription goes through the service worker; API keys are never exposed to content scripts
- **Page fill-in** — inject transcription into any focused input / textarea / contenteditable on the current tab
- **Tab audio recording** — record tab audio (meetings, videos) via `chrome.tabCapture` + offscreen document
- **Live streaming transcription** — mic PCM → energy-threshold VAD segments → each segment transcribed and shown incrementally
- **Side panel + options page** — persistent panel for long sessions (reuses popup logic); options page for settings, history, and storage status
- **Transcription history** — recent results kept in IndexedDB (max 50), browsable in options
- **One-click copy** of the transcription result
- **Pluggable provider system** — add a new provider by dropping in one file under `transcription/providers/`
- **Encrypted local storage** — API keys stored encrypted (AES-GCM via WebCrypto) in `chrome.storage.local` (no cloud sync)

## Project Structure

```
.
├── manifest.json             # Extension configuration (MV3)
├── popup/                    # Popup UI (recording + transcription)
│   ├── popup.html
│   ├── popup.css
│   └── app.js                # Main UI logic
├── transcription/            # Transcription layer (used by popup + background)
│   ├── providers/            # Cloud ASR providers
│   │   ├── base.js           # BaseProvider (abstract + capability metadata)
│   │   ├── qwen.js           # Qwen (DashScope)
│   │   ├── openai.js         # OpenAI Whisper
│   │   ├── deepgram.js       # Deepgram
│   │   └── index.js          # Provider registry + lookup
│   └── transcriber.js        # Unified dispatch: validation, call, result normalization
├── sidepanel/                 # Side panel UI (persistent; reuses popup/app.js + popup.css)
│   └── sidepanel.html
├── options/                   # Options page (settings + history + storage status)
│   ├── options.html
│   └── options.js
├── background/
│   └── background.js         # Service worker — message router + API proxy + offscreen coordinator
├── offscreen/                # Offscreen document (tab audio capture, MV3 requirement)
│   ├── offscreen.html
│   └── offscreen.js
├── audio/                    # Audio layer
│   ├── recorder.js           # MediaRecorder wrapper (shared: popup mic + offscreen tab)
│   ├── vad.js                # Energy-threshold VAD state machine (pure logic, testable)
│   ├── convert.js            # Float32 PCM → WAV blob, chunk concat
│   ├── pcm-capture.js        # PCM frame capture (AudioWorklet, ScriptProcessor fallback)
│   └── pcm-worklet.js        # AudioWorklet processor (loaded via web_accessible_resources)
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
3. Choose a **Provider** from the dropdown (Qwen / OpenAI / Deepgram).
4. Enter your **API Key** for that provider (stored encrypted in `storage.local`, never synced).
5. Adjust **Endpoint URL** / **Model** if needed (defaults are pre-filled).
6. Click **Start Recording**, speak, then **Stop Recording**, then **Transcribe** — or click **Record Tab** to record the active tab's audio (e.g. a meeting or video), then **Transcribe**. **Live Stream** transcribes your speech segment-by-segment while you talk (no separate Transcribe step).
7. Optional: click **Fill into page** to inject the transcription into the currently focused input field on the active tab.

Other entry points: the **Side panel** button keeps the panel open for long sessions (recommended for Live Stream); **Options** opens the settings/history/storage page (also available via `chrome://extensions` → Details → Extension options).

## Built-in Providers

| Provider | Endpoint field | Default model | Host permission |
|---|---|---|---|
| Qwen (DashScope) | optional (defaults to DashScope) | `qwen3-asr-flash` | `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` |
| OpenAI Whisper | optional (defaults to OpenAI) | `whisper-1` | `api.openai.com` |
| Deepgram | optional (defaults to Deepgram) | `nova-2` | `api.deepgram.com` |

## Adding a New Provider

1. Create `transcription/providers/<id>.js` extending `BaseProvider`.
2. Register it in `transcription/providers/index.js`.
3. Import the script **before** main logic in every entry page: `popup/popup.html`, `sidepanel/sidepanel.html`, `options/options.html`, and via `importScripts` in `background/background.js`.
4. Add the provider's host domain to `host_permissions` in `manifest.json`.

## Permissions

- `storage` — persist configuration locally (provider, API key, endpoint, model, audio format); API keys are encrypted in `storage.local` (no cloud sync)
- `activeTab` — query the active tab for the "Fill into page" feature and for tab audio capture
- `tabCapture` — capture tab audio (paired with an offscreen document, which needs no extra permission)
- `sidePanel` — open the persistent side panel (`chrome.sidePanel.open()`)
- Host permissions for each built-in provider endpoint

## License

MIT
