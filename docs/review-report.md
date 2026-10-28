# Full Review Report

## Scope and conclusion

- Reviewed baseline `b017a7c` on 2026-10-27 and completed the remediation
  review on 2026-10-28 in worktree `fix/review-findings`.
- Covered all runtime modules, messaging and resource ownership, storage,
  diagnostics, packaging, CI, tests, and user-facing documentation.
- Result: **9 confirmed findings: 1 P0, 3 P1, 2 P2, and 3 P3**.
- All product-code findings now have automated regression coverage and pass:
  **15 test suites / 138 assertions**, browser smoke **26/26**, lint, manifest
  validation, and both packaging paths.
- The only unresolved finding is the historical over-length squash-merge body:
  it is a process/CI issue, not a product-code defect.
- Findings below are ordered by severity. Subagent-only hypotheses that could
  not be reproduced or were already guarded were excluded.

### Remediation status

| Finding | Severity | Status |
|---|---|---|
| 1. Plaintext `ws://` transport | P0 | **Fixed** — only `wss://`, rejected before socket creation |
| 2. Concurrent Live Stream starts | P1 | **Fixed** — atomic `starting` state; one acquisition/session |
| 3. Inconsistent stream generations | P1 | **Fixed** — background issues one ID and offscreen echoes it |
| 4. Mic/Tab/Stream mutual exclusion | P1 | **Fixed** — background lease arbitration incl. mic port |
| 5. Graceful stream stop | P2 | **Fixed** — stop capture, await `provider.stop()`, then finalize |
| 6. Over-length commit body | P2 | **Open process item** — do not rewrite published history |
| 7. Diagnostic subscription boundary | P3 | **Fixed** — exact approved loopback page validated |
| 8. Diagnostic redaction | P3 | **Fixed** — URL userinfo and generic secret fields covered |
| 9. Dependencies/runtime docs | P3 | **Fixed** — audit 0 vulnerabilities and docs corrected |

### Final branch-review follow-up

The post-remediation review of `fix/review-findings` found four regressions or
gaps in the remediation itself. All are fixed and covered:

- **P1:** `STREAM_ENDED` released the audio lease before `closeDocument()`
  finished. A new stream could reuse the closing document and then lose its
  token when the old close completed. The lease is now held until teardown ends.
- **P2:** Provider `close()` during local stop/rollback was reported as a
  network failure. `onEnd('closed')` is now treated as an internal lifecycle
  event, not a remote error.
- **P2:** A popup/options save in flight recorded the *current* UI as saved,
  so a newer edit made during the await could be overwritten by the save echo.
  Both pages now baseline the exact submitted config.
- **P3:** Diagnostic export wrote the raw page URL before redaction. It now
  redacts `location.href` before writing the export header.

## P0 — Credential or audio disclosure

### 1. Custom `ws://` endpoints expose credentials and microphone audio

- **Locations:** `transcription/providers/qwen.js:189`,
  `transcription/providers/qwen.js:196`, `transcription/providers/qwen.js:404`
- **Trigger:** Configure a Custom endpoint using `ws://` and start Live Stream.
- **Impact:** The API key is placed in the URL query and PCM audio is sent over
  an unencrypted transport. A network observer can recover both.
- **Evidence:** The endpoint regex explicitly accepts `ws://` and `wss://`.
- **Required regression test:** Reject `ws://` before constructing a WebSocket;
  parse the URL and require exactly `wss:`.

## P1 — Core functionality or resource ownership at risk

### 2. Concurrent Live Stream starts can leak microphones and sessions

- **Locations:** `offscreen/offscreen-streaming.js:165`,
  `offscreen/offscreen-streaming.js:176`, `offscreen/offscreen-streaming.js:204`
- **Trigger:** Start from popup and side panel while `openMicrophone()` is pending.
- **Impact:** Both callers pass the null-session check. The later session
  overwrites the first, leaving its microphone, AudioContext, and potentially
  WebSocket without an owner.
- **Evidence:** A deferred-microphone VM reproduction allowed two starts and
  returned success for both.
- **Required regression test:** Hold microphone acquisition pending, issue two
  starts, and require one success, one `ALREADY_RECORDING`, and one acquisition.

### 3. Stream generation IDs use different sequences and break stale-event checks

- **Locations:** `background/background.js:289`,
  `background/background.js:323`, `offscreen/offscreen-streaming.js:146`
- **Trigger:** A normal stop reclaims the document, a new document starts while
  the persisted background generation advances, and that second session ends
  remotely without a Stop response.
- **Impact:** Offscreen restarts its local `streamSeq` at 1, but background
  expects its persisted generation (for example 2). The valid `STREAM_ENDED`
  is classified as stale. The stream resource is already torn down, but the
  persisted streaming flag and offscreen document remain until another stream
  operation reconciles them.
- **Evidence:** The two counters have different owners and reset rules. The
  existing sequential test recreates the document but hard-codes generation 2
  into `STREAM_ENDED`, masking the offscreen sequence resetting to 1.
- **Required regression test:** Reclaim between starts, then end the new stream
  and assert cleanup using an identifier issued by one authoritative owner.

### 4. Recording mutual exclusion does not include microphone recording

- **Locations:** `popup/app.js:399`, `background/background.js:270`,
  `background/background.js:412`
- **Trigger:** Start mic recording in one UI, then Tab recording or Live Stream
  in another UI; the reverse ordering is also possible.
- **Impact:** Multiple audio paths run concurrently despite the documented
  three-way mutex. Button state in one page cannot represent activity in the other.
- **Evidence:** Mic recording is local to each UI; background arbitrates only
  Tab and Stream.
- **Required regression test:** Drive both UIs and assert one active audio path
  for every start ordering, including startup-in-progress states.

## P2 — Incorrect behavior, recoverability, or repository health

### 5. Normal stream teardown skips graceful `finish-task`

- **Locations:** `offscreen/offscreen-streaming.js:97`,
  `transcription/providers/qwen.js:406`
- **Impact:** The provider's graceful `stop()` is never called. Closing the
  socket can discard final recognition results before history finalization;
  comments claiming finish-task runs are inaccurate.
- **Fix direction:** Await graceful stop with timeout before closing resources,
  and test a final result emitted during shutdown.

### 6. Current `main` CI fails on the latest commit body

- **Evidence:** GitHub Actions run `40557047115`, job `Commit messages`, failed
  because commit `b017a7c` exceeds the 280-character body limit.
- **Impact:** The main branch does not have an overall green CI signal even
  though code checks and tests pass.
- **Fix direction:** Keep squash-merge bodies within the enforced limit. No
  product-code change is needed.

## P3 — Lower-impact security hardening and maintainability

### 7. Any local HTTP service can subscribe to diagnostic telemetry

- **Locations:** `manifest.json:62`, `debug/bridge.js:56`,
  `background/background.js:493`
- **Impact:** An unrelated local server using `/stream-debug.html` can receive
  endpoint, device ID, model, timing, and error telemetry. This requires a
  local/loopback attacker and does not expose the API key directly.
- **Fix direction:** Bind diagnostics to an explicit development configuration
  or approved port/session, and validate sender URL/frame origin.

### 8. Diagnostic exports do not redact URL userinfo or generic secrets

- **Locations:** `popup/app.js:1009`, `tests/debug-redact.js:11`
- **Impact:** Endpoint credentials such as `wss://user:<password>@host/...` can
  survive into exported logs. The main DashScope key is redacted when using the
  expected `api_key` query shape.
- **Fix direction:** Prefer removing raw endpoint telemetry; otherwise test
  userinfo, encoded credentials, and generic `password`/`secret` fields.

### 9. Dependency audit and runtime documentation need maintenance

- **Dependencies:** `npm audit` reports four vulnerable packages (three high,
  one moderate), rooted in the Puppeteer/Zod development toolchain. They are
  not shipped in `extension.zip`; treat them as development/CI risk, not a
  demonstrated extension-runtime vulnerability.
- **Documentation:** `README.md:48` still says WebSocket streaming runs in the
  popup/side panel, while it now runs in the offscreen document.
- **Fix direction:** Update the lockfile after reviewing fixes and correct the
  runtime data-flow description.
- **Existing tracking:** The README and adjacent offscreen comments are already
  covered by issues #48 and #73; this entry is a verification result, not a new
  issue report.

## Open issue cross-check

All eight open issues were read on 2026-10-27 and rechecked against the
remediated worktree on 2026-10-28. **No clear false positive was found.**

- **#66:** **Fixed.** Popup rechecks unsaved edits after asynchronous
  `ConfigStore.load()`; options now has equivalent pre/post-load guards. Tests:
  `tests/config-ui-sync.test.js`, `tests/options-config-sync.test.js`.
- **#69:** **Fixed.** Offscreen subtitle cases now put `subtitles` in the
  message payload, and options `storage.onChanged` behavior has dedicated tests.
- **#73:** **Fixed.** Background/Qwen comments now state that Live Stream START
  relays the plaintext key in memory while WebSocket/audio stay in offscreen.
- **#56:** Partially code-backed. Missing recording transcribes is a deliberate
  current product gap, permission text is a real UX issue, and Custom model
  discoverability is a UX concern rather than a broken control.
- **#48:** **Fixed as a documented limitation.** README now explains the
  observed `api_key` query fallback, its operational risk, and the dedicated-key
  recommendation.
- **#45 and #46:** Valid enhancement requests; not current defects.
- **#32:** The `popup/app.js` size concern is code-backed. The PAT-scope item is
  explicitly account-level and not a repository defect.

## Verified boundaries

- No DOM-XSS found in transcript history, subtitles, or fill-text paths.
- The diagnostic static server correctly enforces loopback binding, Host
  checks, exact-file allowlisting, and traversal rejection.
- API key encryption prevents casual plaintext storage disclosure; it does not
  protect against code already executing in the extension origin.
- Plaintext history, user-initiated exports, remote ASR processing, and
  page-removable subtitle hosts are documented design limits, not findings.
- No direct website-to-runtime message bridge or `externally_connectable`
  exposure was found. Sender validation remains useful defense in depth.

## Residual validation gaps

- No live DashScope session was run; no API key was read or printed.
- Physical microphone hot-plug, audible Tab playback, speech recognition
  quality, keyboard accelerators, long-run performance, Chrome 116, and macOS
  were not validated in this environment.
- CodeRabbit was unavailable: the CLI was absent and its Unix installer could
  not run directly in this PowerShell environment. This report is a manual and
  subagent-assisted review, not a CodeRabbit result.

## Excluded after report self-review

- **Stop during startup:** A deferred-microphone VM reproduction showed that a
  direct `STREAM_STOP` returns `NOT_RECORDING` before `session` is assigned.
  However, neither popup nor side panel exposes a Stop action while its local
  streaming state is false, so this is an internal-message invariant rather
  than a confirmed user-facing defect. It should be covered when adding an
  authoritative `starting` state, but it is not counted as a confirmed finding.
- **Restarted worker reclaiming an in-flight start:** The VM reproduction
  artificially reset the worker token during an in-flight handler. Chrome does
  not normally terminate a worker while an event response is pending, so this
  remains a suspected hardening case rather than a confirmed bug.
- **Normal Stop leaving the stream button disabled:** Offscreen broadcasts
  `STREAM_UPDATE ended` before returning the `STREAM_STOP` response. That
  broadcast resets the button while the stop response is in flight, and
  `tests/offscreen-messaging.test.js` covers the ordering.
- **Failed stop permanently blocking future streams:** If reclamation succeeds
  while the stop result is failed, `isStreaming()` clears the stale session
  flag when it observes that no offscreen document exists. Stream start is
  arbitrated by the offscreen session itself.

