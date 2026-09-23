# Repository Guidelines

## Project Structure & Module Organization
This repository is a Manifest V3 Chrome extension with **no bundler step** (load-unpacked, no build).

Layered layout (see `docs/ARCHITECTURE.md` for the full architecture):

- `manifest.json`: extension metadata, permissions, and entry points.
- `popup/`: popup UI. `popup.html` + `popup.css` are reused by `sidepanel/`; `app.js` is the shared UI logic.
- `sidepanel/`: persistent side panel (`sidepanel.html` — reuses `popup/app.js` + `popup.css`).
- `options/`: options page (`options.html` + `options.js`) — settings, history, storage status.
- `background/background.js`: service worker — message routing, API proxy, offscreen coordination.
- `content/content.js`, `content/content.css`: page dictation injection (`asr:fill-text`).
- `offscreen/`: offscreen document hosting tab-audio capture (MV3 cannot do this in a service worker).
- `audio/`: audio layer — `recorder.js` (MediaRecorder), `vad.js` (VAD state machine), `convert.js` (PCM→WAV), `pcm-capture.js` + `pcm-worklet.js` (PCM frames).
- `transcription/`: transcription layer — `providers/` (Qwen/OpenAI/Deepgram) + `transcriber.js` (dispatch: validation, call, result normalization).
- `store/`: storage layer — `config.js` (all config in `storage.local`), `crypto.js` (AES-GCM for API keys), `history.js` (transcription history, IndexedDB).
- `messaging/`: cross-context message contract — `messages.js` (action types + `target` routing) + `client.js` (Promise `sendMessage` wrapper).
- `shared/errors.js`: unified error codes + `createError` / `normalizeError`.
- `tests/`: browser-runnable smoke tests (`tests/p1-smoke-test.html`).
- `icons/`: extension icons (`16`, `48`, `128` sizes).
- Root docs: `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`.

Keep feature logic close to its runtime context (popup/sidepanel/options vs content vs background vs offscreen), and prefer small, focused files.

### Cross-context messaging
All messages are `{ type, payload, requestId, target? }`. `target` is **required in practice**: `chrome.runtime.sendMessage` broadcasts, so `background` and `offscreen` each filter by `target` (`messaging/messages.js` → `TARGETS`). Missing `target` means "to background".

Current actions: `asr:transcribe`, `asr:fill-text`, `asr:tab-record-start`, `asr:tab-record-stop`. Responses are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

### Global scripts (no modules)
Scripts attach to `globalThis` (never `window`) so the same file works in popup, sidepanel, options, **and the service worker** (`importScripts`) / offscreen. When adding a provider, register it in **both** `popup/popup.html` and `background/background.js`.

## Build, Test, and Development Commands
- `npm run build`: placeholder (no compile step — load the directory unpacked).
- `npm run lint`: placeholder; wire a linter before enforcing CI.
- `npm run pack`: creates `extension.zip` for distribution. **Requires the `zip` CLI**, which is not present by default on Windows. Windows alternative: `powershell -c "Compress-Archive -Path * -DestinationPath extension.zip -Force"`.

Local development:
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked** and select this repository.
4. Reload the extension after edits.

Automated checks (Node):
- Syntax: `node --check <file>` for every `.js`.
- Unit logic (no browser needed): the audio layer (`vad`, `convert`) and `store/history` are pure logic — testable in Node with small mocks.
- Browser smoke test: open `tests/p1-smoke-test.html` in Chrome (loads real modules, verifies provider registry / messaging / blob helpers).

## Coding Style & Naming Conventions
- JavaScript/CSS/HTML use 2-space indentation and semicolons, matching current files.
- Use descriptive `camelCase` for variables/functions (`handleTranscribe`, `showStatus`, `getActiveField`).
- Message contract names must match `messaging/messages.js` exactly (e.g. `request.type === MESSAGES.TRANSCRIBE`) — never hardcode the string in `content/` (it loads `messages.js` first).
- Prefer `globalThis.X` over `window.X` for anything shared across contexts.

If you add lint/format tooling, keep rules aligned with the existing style and update `npm run lint`.

## Testing Guidelines
Manual validation before PR (each surface):
- **Popup**: record → transcribe → copy/fill; API key appears encrypted in `chrome.storage.local`.
- **Side panel**: open panel; Live Stream produces incremental results while speaking.
- **Options**: settings save; history lists recent transcriptions; storage status shows key present.
- **Content**: `Fill into page` inserts text into a focused input (test input, textarea, and contenteditable).
- **Tab capture**: `Record Tab` keeps tab audio audible (must not mute the tab) and transcribes it.
- **Streaming**: silence alone produces no requests; speech→silence closes a segment.
- Re-test install/update by reloading the extension.

Known environment constraints: MV3 service worker has no DOM (`FileReader`/`MediaRecorder` unavailable there — use `Blob.arrayBuffer()`); tab capture must run in the offscreen document.

## Commit & Pull Request Guidelines
Follow the commit prefixes documented in `CONTRIBUTING.md`:
- `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `test:`, `chore:`.

A commit-msg hook enforces: `<type>: <subject>` — subject on a single line, ≤80 chars for `feat`/`fix`/`test`, ≤50 for `docs`/`style`/`chore`, 20–200 for `refactor`. **No scope parentheses** (e.g. `feat(P1): …` is rejected).

> **Hook scope warning**: the enforcing hook lives at the *global* `core.hooksPath`
> (`C:/Users/panda-zzz/.git-hooks/commit-msg`) on the original dev machine, **not**
> inside this repository. A fresh clone or CI **will not be checked** unless you
> install your own hook (e.g. `npx husky init` + commitlint) and update
> `npm run lint` / CI accordingly. Format is still binding by convention either way.

PR checklist:
- Clear summary of behavior changes.
- Linked issue (for bugs/features).
- Reproduction and verification steps (manual-test checklist above).
- Screenshots or short recordings for popup/UI changes.
