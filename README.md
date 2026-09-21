# Chrome Extension — Multi-Provider ASR

A Manifest V3 Chrome extension that records audio from the popup and transcribes it using one of several speech recognition providers (Qwen / OpenAI Whisper / Deepgram / or your own).

## Features

- **Vendor-agnostic popup framework** — switch providers from a dropdown
- **Voice recording** directly from the popup (webm / mp4 / wav)
- **Real-time transcription** via configurable API endpoints
- **One-click copy** of the transcription result
- **Pluggable provider system** — add a new provider by dropping in one file under `popup/providers/`

## Project Structure

```
.
├── manifest.json             # Extension configuration (MV3)
├── popup/                    # Popup window
│   ├── popup.html
│   ├── popup.css
│   ├── app.js                # Main UI logic (provider-agnostic)
│   └── providers/            # Provider implementations
│       ├── base.js           # BaseProvider (abstract)
│       ├── qwen.js           # Qwen (DashScope, OpenAI-compatible)
│       ├── openai.js         # OpenAI Whisper
│       ├── deepgram.js       # Deepgram
│       └── index.js          # Provider registry
├── background/               # Background service worker
│   └── background.js
├── content/                  # Content scripts injected into web pages
│   ├── content.js
│   └── content.css
├── icons/                    # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── samples/                  # Committed test samples (audio, models)
└── temp/                     # Local-only temp files (not tracked by git)
```

## Quick Start

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this project directory.
2. Click the extension icon in the toolbar.
3. Choose a **Provider** from the dropdown (Qwen / OpenAI / Deepgram).
4. Enter your **API Key** for that provider.
5. Adjust **Endpoint URL** / **Model** if needed (defaults are pre-filled).
6. Click **Start recording**, speak, then click **Stop recording**, and then **Transcribe**.

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

- `storage` — persist configuration (provider, API key, endpoint, model, audio format)
- `activeTab` — access the currently active tab
- Host permissions for each built-in provider endpoint

## License

MIT
