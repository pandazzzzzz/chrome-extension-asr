# Repository Guidelines

## Project Structure & Module Organization
This repository is a Manifest V3 Chrome extension with **no bundler step** (load-unpacked, no build).

Layered layout (see `docs/ARCHITECTURE.md` for the full architecture):

- `manifest.json`: extension metadata, permissions, and entry points.
- `manifest.json` → `commands`: `_execute_action` (popup, `Ctrl+Shift+Y`), `open-side-panel` (`Ctrl+Shift+U`), `open-options` (**no default key** — the user assigns one at `chrome://extensions/shortcuts`). Reserved keys cannot be claimed: Chrome silently drops a `suggested_key` that collides with a browser shortcut (e.g. `Ctrl+Shift+O` = Bookmark Manager), leaving that command with an empty shortcut.
- `popup/`: popup UI. `popup.html` + `popup.css` are reused by `sidepanel/`; `app.js` is the shared UI logic (mic recording, tab recording, realtime streaming, config forms, result actions). `popup.css` defines the palette as `:root` custom properties and flips them under `@media (prefers-color-scheme: dark)` — the options page keeps its own inline copy of the same variables, so **add new colours as variables in both places**, never as literals in a rule.
- `sidepanel/`: persistent side panel (`sidepanel.html` — reuses `popup/app.js` + `popup.css`).
- `options/`: options page (`options.html` + `options.js`) — settings, history (with **Export JSON**, a local download via `createObjectURL`), storage status.
- `background/background.js`: service worker — message routing, offscreen coordination, fill-text/subtitle forwarding, history writes (`asr:history-add`), and the `commands.onCommand` handler (keyboard shortcuts). **`chrome.sidePanel.open()` must be called synchronously** — no `await` before it (not even `chrome.tabs.query`), or the user gesture is gone; pass `chrome.windows.WINDOW_ID_CURRENT` and let Chrome resolve the window.
- `content/content.js`, `content/content.css`: page dictation injection (`asr:fill-text`).
- `content/subtitle.js`: floating subtitle overlay (`asr:subtitle-show` / `asr:subtitle-hide`); renders into a **closed Shadow DOM** so page CSS/JS cannot reach it and its styles cannot leak out. The host remains in the light DOM, so a page can still hide/remove the whole overlay.
- `offscreen/`: offscreen document hosting tab-audio capture and, in the future, any long-lived audio work that must survive popup closure (MV3 cannot do this in a service worker). Live Stream currently still runs in `popup/app.js`, so closing the popup ends that session.
- `audio/`: audio layer — `recorder.js` (MediaRecorder wrapper, mic + tab), `convert.js` (floatToInt16 / resampleFloat32), `devices.js` (input-device enumeration + `getUserMedia` constraints), `pcm-capture.js` + `pcm-worklet.js` (PCM frame capture via AudioWorklet for streaming; **frame size is a tuned constant** — the benchmark lives in the `STREAM.frameSize` comment in `popup/app.js`). (VAD was removed with the old pseudo-streaming; server-side sentence-splitting handles streaming.)

Microphone selection: `#audioInput` in popup/sidepanel holds the chosen `deviceId` (`''` = system default) and persists it as `asrConfig.audioInput`. Device labels are only visible after the first successful `getUserMedia`, so the list is enumerated on load and refreshed after every grant; a stale id falls back to the default (`openMicrophone` in `audio/devices.js`).

- `transcription/`: transcription layer — `providers/base.js` (streaming interface + capability metadata: `streamModels` run-task whitelist, `regions`/`endpointFor()`, `sampleRates`/`sampleRateFor()`, `modelOptions`/`modelSelectionFor()`), `providers/qwen.js` (Qwen/DashScope realtime WebSocket, task protocol `/api-ws/v1/inference`; declares `regions` = Beijing / Singapore / Custom), `providers/index.js` (registry). `isStreamModel` is an **explicit whitelist**, not a name regex — Alibaba Cloud Bailian has several WebSocket protocols and names like `qwen3-asr-flash-realtime` contain "realtime" but use the session protocol `/api-ws/v1/realtime`. Region and endpoint are coupled in the provider metadata (a region maps to a `wss://` URL; `custom` leaves it empty for the user to type) because the API key must match the region. **An empty Custom endpoint is a hard error** (`Errors.NO_ENDPOINT`), never a silent fallback to the provider default — both `startStreaming` and the options Save reject it. The PCM sample rate is **per model**, not fixed: `sampleRates` holds only the exceptions (the 8k telephony models) and everything else inherits `defaultSampleRate`; `popup/app.js` builds its `AudioContext` at `sampleRateFor(finalModel)` and must do so *after* the model fallback, so the declared `run-task.sample_rate` and the audio actually sent can never disagree. The Model dropdown is a **preset list, not the whitelist**: `modelOptions` is a curated subset of `streamModels` (the five models with free quota) plus a trailing `Custom…` sentinel (`model: ''`, structurally the same pattern as `regions`' `custom`) that reveals a text input; `modelSelectionFor()` maps a stored model to `{value, customText}` — a non-preset model (e.g. a dated snapshot or `fun-asr-realtime`) renders as Custom with the original text kept, never rewritten. Labels must describe only stable attributes (sample rate / scenario) — **never quota or pricing** (free quota resets monthly and expires). Every reader of "the current model" must go through `resolveModel()` (dropdown value, else the Custom input) — reading `#model.value` directly yields the empty sentinel in Custom mode. `popup/app.js` and `options/options.js` must render the same stored config identically: both call `modelSelectionFor`. Batch transcribe and transcriber dispatch were removed with the old pseudo-streaming.
- `store/`: storage layer — `config.js` (all config in `storage.local`; `save()` is a **merge**, not a replace — read-modify-write, so a writer that submits only the fields it edits (e.g. the options page) never wipes `audioType`/`subtitles`/`audioInput` set elsewhere; pinned by `tests/config.test.js`, issue #19), `crypto.js` (AES-GCM for API keys), `history.js` (transcription history, IndexedDB).
- `messaging/`: cross-context message contract — `messages.js` (action types + `target` routing) + `client.js` (Promise `sendMessage` wrapper).
- `shared/`: cross-context helpers — `errors.js` (unified error codes + `createError` / `normalizeError`), `timeout.js` (`withTimeout` guard for promises that never settle), `format.js` (`Format.timestampForFile` — filesystem-safe timestamp shared by the audio download and the history export).
- `debug/bridge.js`: diagnostic telemetry bridge, injected as a content script (active only on the local debug page).
- `tests/`: browser-runnable smoke tests (`tests/p1-smoke-test.html` + `tests/p1-smoke-test.js`; the JS is external so the page also runs under the extension's MV3 CSP), plus `stream-debug.html` + `serve-debug.js` (streaming diagnostics page and its loopback-only static server). **The server serves an exact allowlist of the diagnostic page, its redaction helper, and `samples/media/sample.mp4`, and rejects a non-loopback `Host` header** — it is the repo's only component that opens a socket, so those guards are load-bearing: serving the repo root would expose `.env.local` (the real API key), serving `tests/` as a directory would expose local manual plans and exported logs, and skipping the `Host` check lets DNS rebinding read those files as same-origin. `tests/serve-debug.test.js` pins both.
- `scripts/pack.js`: builds `extension.zip`. `samples/` holds small committed test fixtures; `temp/` is local-only scratch (gitignored).
- `icons/`: extension icons (`16`, `48`, `128` sizes).
- Root docs: `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`.

Keep feature logic close to its runtime context (popup/sidepanel/options vs content vs background vs offscreen), and prefer small, focused files.

### Cross-context messaging
All messages are `{ type, payload, requestId, target? }`. `target` is **required in practice**: `chrome.runtime.sendMessage` broadcasts, so `background`, `offscreen`, and `content` each filter by `target` (`messaging/messages.js` → `TARGETS`). Missing `target` means "to background".

Current actions: `asr:fill-text`, `asr:subtitle-show`, `asr:subtitle-hide`, `asr:tab-record-start`, `asr:tab-record-stop`, `asr:tab-record-state`, `asr:history-add`. Responses are `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

Tab-recording state lives in **`background`** (`chrome.storage.session` key `tabRecording`), not in the popup: the recording runs in the offscreen document and outlives the popup, so `popup/app.js` re-syncs its buttons on load via `asr:tab-record-state`. Never let the popup be the source of truth for "is a tab recording running".

The subtitle actions (`asr:subtitle-show` / `-hide`) turn the live transcript into a
floating overlay: `popup/app.js` mirrors each `renderStreamText` update, and
`background` forwards it to the tab captured when Live Stream was clicked (`payload.tabId`;
falling back to the active tab). This keeps the overlay on its original page if the
user switches tabs mid-session. Forwarding failures are swallowed on purpose — the
overlay is a side channel and must never break streaming.

### Global scripts (no modules)
Scripts attach to `globalThis` (never `window`) so the same file works in popup, sidepanel, options, **and the service worker** (`importScripts`) / offscreen. If you add a provider later, add its `<script>` tag to **`popup/popup.html`, `sidepanel/sidepanel.html`, and `options/options.html`** and register it in `transcription/providers/index.js`. (Background does not load the transcription layer — it only handles message routing / offscreen coordination / fill-text.)

## Build, Test, and Development Commands
- `npm ci`: installs the four devDependencies (`puppeteer-core` for the gitignored `temp/` harness; `husky` + `@commitlint/cli` + `@commitlint/config-conventional` for the commit-msg hook) from `package-lock.json`. The extension itself has **no runtime dependencies** and no build step.
- `npm run build`: placeholder (no compile step — load the directory unpacked).
- `npm run lint`: syntax check of every tracked `.js` file via `scripts/lint.js` (no dependencies); extend it if a style linter is added later.
- `npm run pack`: creates `extension.zip` for distribution via `scripts/pack.js` — tries **PowerShell .NET `ZipFile` first** (explicit entry paths; `Compress-Archive` flattens relative paths and breaks the archive), falls back to a dependency-free `node:zlib` zip writer (`node scripts/pack.js --node` forces the fallback). The PowerShell path is Windows-only (`pack.js` returns early off-win32), so CI always uses the fallback. Excludes `.git*`, `node_modules/`, `*.zip`, `tests/`, `docs/`, `temp/` (local harness, may hold a ~200MB Chrome-for-Testing), agent-skill installs (`.agents/`, `.claude/`, `skills-lock.json`) and dev-only files (`package*.json`, `samples/`, `scripts/`, `.github/`, editor config, `README.md`; `LICENSE` is kept). Runs on any OS. `tests/pack.test.js` pins these rules.
- `npm test`: runs `tests/streaming.test.js` (33 Node cases over the PCM helpers `floatToInt16` / `resampleFloat32` and the streaming provider contract — including the `run-task` wire payload's `sample_rate`, asserted through an in-file fake `WebSocket`, so it stays offline — plus the `modelOptions`/`modelSelectionFor` dropdown metadata invariants and post-handshake network errors), then `tests/config.test.js` (9 cases pinning `ConfigStore.save`'s **merge semantics** — a partial save must not wipe fields it did not submit, the issue #19 regression — the apiKey encrypt/clear boundary, one-shot legacy migration, and same-context write serialization, driven by minimal in-memory `chrome.storage` + `CryptoStore` mocks), then `tests/history.test.js` (6 cases pinning IndexedDB error propagation, successful writes surviving trim failures, and createdAt-based trimming), then `tests/content-fill.test.js` (5 cases pinning fill-text's no-false-success contract and open Shadow DOM support), then `tests/stream-lifecycle.test.js` (5 cases pinning that `pagehide` only finalizes a stream after capture has started), then `tests/recorder.test.js` (6 cases pinning MediaRecorder format fallback), then `tests/pcm-capture.test.js` (3 cases pinning the ScriptProcessor fallback's cross-buffer frame remainder), then `tests/debug-redact.test.js` (5 cases pinning credential redaction for query strings, JSON fields, and Bearer tokens), then `tests/serve-debug.test.js` (8 cases pinning the diagnostics server's security boundary — only the diagnostic page assets and sample video are served, `.env.local` and `tests/`-local plans/logs are unreachable, path traversal is blocked, a non-loopback `Host` gets 403, and `EADDRINUSE` exits 1 instead of crashing), then `tests/pack.test.js` (6 cases asserting the packaged zip contains every manifest-referenced path and no dev-only/agent artifacts). No browser, no network, deterministic.
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
The full spec is **[`docs/COMMIT_CONVENTION.md`](docs/COMMIT_CONVENTION.md)** — follow it.

- Format `<type>: <title>`, types (lowercase): `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- `title` ≤ **80 chars** (aim ≤50); `body` ≤ **280 chars** and **≤72 chars per line**, separated by one blank line, explaining *why*.
- **No scope parentheses** (`feat(popup): …`) and **no `!`** (`feat!: …`); put the area in the title and declare breaking changes with a `BREAKING CHANGE:` footer.
- Imperative mood, no trailing period on the title.

Enforced, not just documented: `commitlint.config.mjs` + `.husky/commit-msg` reject non-conforming
messages at commit time, and CI lints both the commits in a PR and the PR title (which becomes the
squash-merge subject). `Merge …` / `Revert …` / `fixup!` / `squash!` are skipped by commitlint's
`defaultIgnores`. Run `npm run lint:commit` to check a branch locally.

PR checklist:
- Clear summary of behavior changes.
- Linked issue (for bugs/features).
- Reproduction and verification steps (manual-test checklist above).
- Screenshots or short recordings for popup/UI changes.
