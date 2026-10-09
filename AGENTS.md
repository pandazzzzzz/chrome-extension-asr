# Repository Guidelines

## Project Structure & Module Organization
This repository is a Manifest V3 Chrome extension with **no bundler step** (load-unpacked, no build).

Layered layout (see `docs/ARCHITECTURE.md` for the full architecture):

- `manifest.json`: extension metadata, permissions, and entry points.
- `popup/`: popup UI. `popup.html` + `popup.css` are reused by `sidepanel/`; `app.js` is the shared UI logic (mic recording, tab recording, realtime streaming, config forms, result actions).
- `sidepanel/`: persistent side panel (`sidepanel.html` — reuses `popup/app.js` + `popup.css`).
- `options/`: options page (`options.html` + `options.js`) — settings, history, storage status.
- `background/background.js`: service worker — message routing, offscreen coordination, fill-text forwarding.
- `content/content.js`, `content/content.css`: page dictation injection (`asr:fill-text`).
- `content/subtitle.js`: floating subtitle overlay on the active page (`asr:subtitle-show` / `asr:subtitle-hide`); renders into a **closed Shadow DOM** so page CSS/JS cannot reach it and its styles cannot leak out.
- `offscreen/`: offscreen document hosting tab-audio capture (MV3 cannot do this in a service worker).
- `audio/`: audio layer — `recorder.js` (MediaRecorder wrapper, mic + tab), `convert.js` (floatToInt16 / resampleFloat32), `devices.js` (input-device enumeration + `getUserMedia` constraints), `pcm-capture.js` + `pcm-worklet.js` (PCM frame capture via AudioWorklet for streaming). (VAD was removed with the old pseudo-streaming; server-side sentence-splitting handles streaming.)

Microphone selection: `#audioInput` in popup/sidepanel holds the chosen `deviceId` (`''` = system default) and persists it as `asrConfig.audioInput`. Device labels are only visible after the first successful `getUserMedia`, so the list is enumerated on load and refreshed after every grant; a stale id falls back to the default (`openMicrophone` in `audio/devices.js`).

- `transcription/`: transcription layer — `providers/base.js` (streaming interface + capability metadata), `providers/qwen.js` (Qwen/DashScope realtime WebSocket), `providers/index.js` (registry). Batch transcribe and transcriber dispatch were removed with the old pseudo-streaming.
- `store/`: storage layer — `config.js` (all config in `storage.local`), `crypto.js` (AES-GCM for API keys), `history.js` (transcription history, IndexedDB).
- `messaging/`: cross-context message contract — `messages.js` (action types + `target` routing) + `client.js` (Promise `sendMessage` wrapper).
- `shared/`: cross-context helpers — `errors.js` (unified error codes + `createError` / `normalizeError`), `timeout.js` (`withTimeout` guard for promises that never settle).
- `debug/bridge.js`: diagnostic telemetry bridge, injected as a content script (active only on the local debug page).
- `tests/`: browser-runnable smoke tests (`tests/p1-smoke-test.html` + `tests/p1-smoke-test.js`; the JS is external so the page also runs under the extension's MV3 CSP), plus `stream-debug.html` + `serve-debug.js` (streaming diagnostics page and its loopback-only static server).
- `scripts/pack.js`: builds `extension.zip`. `samples/` holds small committed test fixtures; `temp/` is local-only scratch (gitignored).
- `icons/`: extension icons (`16`, `48`, `128` sizes).
- Root docs: `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`.

Keep feature logic close to its runtime context (popup/sidepanel/options vs content vs background vs offscreen), and prefer small, focused files.

### Cross-context messaging
All messages are `{ type, payload, requestId, target? }`. `target` is **required in practice**: `chrome.runtime.sendMessage` broadcasts, so `background`, `offscreen`, and `content` each filter by `target` (`messaging/messages.js` → `TARGETS`). Missing `target` means "to background".

Current actions: `asr:fill-text`, `asr:subtitle-show`, `asr:subtitle-hide`, `asr:tab-record-start`, `asr:tab-record-stop`. Responses are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

The subtitle actions (`asr:subtitle-show` / `-hide`) turn the live transcript into a
floating overlay on the active tab: `popup/app.js` mirrors each `renderStreamText`
update, `background` forwards it to the active tab (same path as `fill-text`), and
`content/subtitle.js` renders it. Forwarding failures are swallowed on purpose —
the overlay is a side channel and must never break streaming.

### Global scripts (no modules)
Scripts attach to `globalThis` (never `window`) so the same file works in popup, sidepanel, options, **and the service worker** (`importScripts`) / offscreen. If you add a provider later, add its `<script>` tag to **`popup/popup.html`, `sidepanel/sidepanel.html`, and `options/options.html`** and register it in `transcription/providers/index.js`. (Background does not load the transcription layer — it only handles message routing / offscreen coordination / fill-text.)

## Build, Test, and Development Commands
- `npm ci`: installs the single devDependency (`puppeteer-core`) from `package-lock.json`. Only the gitignored `temp/` harness scripts need it — the extension itself has **no runtime dependencies** and no build step.
- `npm run build`: placeholder (no compile step — load the directory unpacked).
- `npm run lint`: placeholder; wire a linter before enforcing CI.
- `npm run pack`: creates `extension.zip` for distribution via `scripts/pack.js` — tries **PowerShell .NET `ZipFile` first** (explicit entry paths; `Compress-Archive` flattens relative paths and breaks the archive), falls back to a dependency-free `node:zlib` zip writer (`node scripts/pack.js --node` forces the fallback). The PowerShell path is Windows-only (`pack.js` returns early off-win32), so CI always uses the fallback. Excludes `.git*`, `node_modules/`, `*.zip`, `tests/`, `docs/`, `temp/` (local harness, may hold a ~200MB Chrome-for-Testing). Runs on any OS.
- `npm test`: runs `tests/streaming.test.js` — 12 Node cases over the PCM helpers (`floatToInt16` / `resampleFloat32`) and the streaming provider contract. No browser, no network, deterministic.
- `node scripts/check-manifest.js`: validates `manifest.json` and every path it references (popup, side panel, options, service worker, content scripts, icons), and checks declared icon sizes against the real PNG dimensions.

Local development:
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked** and select this repository.
4. Reload the extension after edits.

Automated checks (Node):
- Syntax: `node --check <file>` for every `.js`.
- Unit tests: `npm test` (see above). `audio/convert.js` and the streaming providers are pure `globalThis` scripts with no browser APIs, so they run directly under Node; `store/history.js` still needs small mocks if you add cases for it.
- Browser smoke test: open `tests/p1-smoke-test.html` in Chrome (loads real modules, verifies crypto / config / messaging / error helpers). Runs in all three contexts — `file://`, `http://`, and `chrome-extension://` (the cases live in `tests/p1-smoke-test.js` so the page is not blocked by the extension CSP).

CI (`.github/workflows/`): `ci.yml` runs the syntax check, manifest check, `npm test` and `npm run pack` on push/PR to `main` (Node 22.x); `codeql.yml` runs CodeQL static analysis (push/PR/weekly); `dependency-review.yml` checks new dependencies on PRs. The browser smoke test is **not** wired into CI yet.

## Coding Style & Naming Conventions
- JavaScript/CSS/HTML use 2-space indentation and semicolons, matching current files.
- Use descriptive `camelCase` for variables/functions (`handleTranscribe`, `showStatus`, `getActiveField`).
- Message contract names must match `messaging/messages.js` exactly (e.g. `request.type === MESSAGES.FILL_TEXT`) — never hardcode the string in `content/` (it loads `messages.js` first).
- Prefer `globalThis.X` over `window.X` for anything shared across contexts.

If you add lint/format tooling, keep rules aligned with the existing style and update `npm run lint`.

## Testing Guidelines
Manual validation before PR (each surface):
- **Popup**: record → stop → **Save audio** downloads a file; config fields save; API key appears encrypted in `chrome.storage.local`.
- **Microphone selection**: the **Microphone** dropdown lists input devices (labels appear after the first permission grant); the choice applies to both recording and Live Stream and survives a reload; unplugging the chosen device falls back to the system default with a status message.
- **Live Stream**: select Qwen + enter API key → **Live Stream** → partial text appears while speaking, final text locks after each sentence → stop → result copyable / fillable → history shows one entry.
- **Side panel**: open panel; mic/tab/stream recording works; status persists.
- **Options**: settings save; history lists streaming results; storage status shows key present.
- **Content**: paste text into Result → `Fill into page` inserts it into a focused input; with an empty Result, Copy/Fill are disabled (nothing to act on).
- **Floating subtitles**: with **Subtitles** on, run a Live Stream and confirm the overlay appears on the active page, updates with partial/final text, and fades ~2s after Stop.
- **Tab capture**: `Record Tab` keeps tab audio audible (must not mute the tab) and returns a recording.
- Re-test install/update by reloading the extension.

This is the short version. For a step-by-step procedure with expected status strings, failure triage (debug event names) and pass criteria, see [`docs/manual-verification.md`](docs/manual-verification.md) — use it when validating the Live Stream path, which no automated test covers.

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
