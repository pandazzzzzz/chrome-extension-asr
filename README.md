# Chrome Extension — Multi-Provider ASR

A Manifest V3 Chrome extension that records audio from the popup and transcribes it using one of several speech recognition providers (Qwen / OpenAI Whisper / Deepgram / or your own).

## Features

- **Vendor-agnostic popup framework** — switch providers from a dropdown
- **Voice recording** directly from the popup (webm / mp4 / wav)
- **Cloud transcription** via configurable API endpoints (Qwen / OpenAI Whisper / Deepgram)
- **Background API proxy** — transcription goes through the service worker; API keys are never exposed to content scripts
- **Page fill-in** — inject transcription into any focused input / textarea / contenteditable on the current page
- **One-click copy** of the transcription result
- **Pluggable provider system** — add a new provider by dropping in one file under `popup/providers/`
- **Encrypted local storage** — API keys stored encrypted (AES-GCM via WebCrypto) in `chrome.storage.local` (no cloud sync)

## Project Structure

```
.
├── manifest.json             # Extension configuration (MV3)
├── popup/                    # Popup UI (recording + transcription)
│   ├── popup.html
│   ├── popup.css
│   ├── app.js                # Main UI logic
│   └── providers/            # Cloud ASR providers (also used by background)
│       ├── base.js           # BaseProvider (abstract)
│       ├── qwen.js           # Qwen (DashScope)
│       ├── openai.js         # OpenAI Whisper
│       ├── deepgram.js       # Deepgram
│       └── index.js          # Provider registry
├── background/
│   └── background.js         # Service worker — message router + API proxy
├── content/                  # Content scripts (page dictation injection)
│   ├── content.js
│   └── content.css
├── store/                    # Storage layer
│   ├── config.js             # Config read/write (all in storage.local)
│   └── crypto.js             # WebCrypto AES-GCM encryption for API keys
├── messaging/                # Cross-context message contract
│   ├── messages.js           # Action type constants
│   └── client.js             # sendMessage Promise wrapper
├── shared/
│   └── errors.js             # Unified error codes
├── icons/                    # Extension icons
├── docs/
│   └── ARCHITECTURE.md       # Full architecture design doc
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
6. Click **Start recording**, speak, then **Stop recording**, then **Transcribe**.
7. Optional: click **Fill into page** to inject the transcription into the currently focused input field on the active tab.

## Built-in Providers

| Provider | Endpoint field | Default model | Host permission |
|---|---|---|---|
| Qwen (DashScope) | required | `qwen3-asr-flash` | `dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` |
| OpenAI Whisper | required | `whisper-1` | `api.openai.com` |
| Deepgram | required | `nova-2` | `api.deepgram.com` |

## Adding a New Provider

1. Create `popup/providers/<id>.js` extending `BaseProvider`.
2. Register it in `popup/providers/index.js`.
3. Import the script in `popup/popup.html` (before `app.js`).
4. Add the provider's host domain to `host_permissions` in `manifest.json`.

## Permissions

- `storage` — persist configuration locally (provider, API key, endpoint, model, audio format); API keys are encrypted in `storage.local` (no cloud sync)
- `activeTab` — query the active tab for the "Fill into page" feature
- Host permissions for each built-in provider endpoint

## License

MIT
