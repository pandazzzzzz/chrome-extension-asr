# Repository Guidelines

## Project Structure & Module Organization
This repository is a Manifest V3 Chrome extension with **no bundler step** (load-unpacked, no build).

Layered layout (see `docs/ARCHITECTURE.md` for the full architecture):

- `manifest.json`: extension metadata, permissions, and entry points.
- `popup/`: popup UI. `popup.html` + `popup.css` are reused by `sidepanel/`; `app.js` is the shared UI logic (recording shell: mic + tab recording, config forms).
- `sidepanel/`: persistent side panel (`sidepanel.html` — reuses `popup/app.js` + `popup.css`).
- `options/`: options page (`options.html` + `options.js`) — settings, history, storage status.
- `background/background.js`: service worker — message routing, offscreen coordination, fill-text forwarding.
- `content/content.js`, `content/content.css`: page dictation injection (`asr:fill-text`).
- `offscreen/`: offscreen document hosting tab-audio capture (MV3 cannot do this in a service worker).
- `audio/`: audio layer — `recorder.js` (MediaRecorder). (VAD / PCM-capture / convert were removed with the old pseudo-streaming; realtime streaming will rebuild a new audio layer.)
- `transcription/`: transcription layer — **currently empty** (providers + transcriber removed; realtime WebSocket streaming will rebuild it).
- `store/`: storage layer — `config.js` (all config in `storage.local`), `crypto.js` (AES-GCM for API keys), `history.js` (transcription history, IndexedDB).
- `messaging/`: cross-context message contract — `messages.js` (action types + `target` routing) + `client.js` (Promise `sendMessage` wrapper).
- `shared/errors.js`: unified error codes + `createError` / `normalizeError`.
- `tests/`: browser-runnable smoke tests (`tests/p1-smoke-test.html`).
- `icons/`: extension icons (`16`, `48`, `128` sizes).
- Root docs: `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`.

Keep feature logic close to its runtime context (popup/sidepanel/options vs content vs background vs offscreen), and prefer small, focused files.

### Cross-context messaging
All messages are `{ type, payload, requestId, target? }`. `target` is **required in practice**: `chrome.runtime.sendMessage` broadcasts, so `background`, `offscreen`, and `content` each filter by `target` (`messaging/messages.js` → `TARGETS`). Missing `target` means "to background".

Current actions: `asr:fill-text`, `asr:tab-record-start`, `asr:tab-record-stop`. Responses are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

### Global scripts (no modules)
Scripts attach to `globalThis` (never `window`) so the same file works in popup, sidepanel, options, **and the service worker** (`importScripts`) / offscreen. If you add a provider later, register it in **both** `popup/popup.html` and `background/background.js`.

## Build, Test, and Development Commands
- `npm run build`: placeholder (no compile step — load the directory unpacked).
- `npm run lint`: placeholder; wire a linter before enforcing CI.
- `npm run pack`: creates `extension.zip` for distribution via `scripts/pack.js` — tries **PowerShell .NET `ZipFile` first** (explicit entry paths; `Compress-Archive` flattens relative paths and breaks the archive), falls back to a dependency-free `node:zlib` zip writer (`node scripts/pack.js --node` forces the fallback). Excludes `.git*`, `node_modules/`, `*.zip`, `temp/` (local harness, may hold a ~200MB Chrome-for-Testing). Runs on any OS.

Local development:
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked** and select this repository.
4. Reload the extension after edits.

Automated checks (Node):
- Syntax: `node --check <file>` for every `.js`.
- Unit logic (no browser needed): `store/history` are pure logic — testable in Node with small mocks. (VAD/convert were removed with pseudo-streaming.)
- Browser smoke test: open `tests/p1-smoke-test.html` in Chrome (loads real modules, verifies crypto / config / messaging / error helpers).

## Coding Style & Naming Conventions
- JavaScript/CSS/HTML use 2-space indentation and semicolons, matching current files.
- Use descriptive `camelCase` for variables/functions (`handleTranscribe`, `showStatus`, `getActiveField`).
- Message contract names must match `messaging/messages.js` exactly (e.g. `request.type === MESSAGES.FILL_TEXT`) — never hardcode the string in `content/` (it loads `messages.js` first).
- Prefer `globalThis.X` over `window.X` for anything shared across contexts.

If you add lint/format tooling, keep rules aligned with the existing style and update `npm run lint`.

## Testing Guidelines
Manual validation before PR (each surface):
- **Popup**: record → stop; config fields save; API key appears encrypted in `chrome.storage.local`.
- **Side panel**: open panel; mic/tab recording works; status persists.
- **Options**: settings save; history lists recent transcriptions; storage status shows key present.
- **Content**: `Fill into page` keeps the message path working (empty result shows "Nothing to fill"; the channel itself must not error).
- **Tab capture**: `Record Tab` keeps tab audio audible (must not mute the tab) and returns a recording.
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
