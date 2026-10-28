# Review Verification Matrix

Baseline: `b017a7c`; remediation worktree: `fix/review-findings`. Windows,
Node `v24.22.1`, npm `11.19.1`, local Google Chrome.

| Area | Result | Evidence / limitation |
|---|---|---|
| Dependency install | PASS with environment note | `npm ci` installed 87 packages; Husky could not write sandboxed `.git/config` |
| JavaScript syntax | PASS | 45 JS files parsed |
| Manifest and icons | PASS | 13 referenced paths; PNG dimensions valid |
| Node tests | PASS | 138 assertions across 15 suites, including new TOCTOU/options-sync coverage |
| Browser smoke | PASS | 26/26 in real local Chrome |
| Node zip backend | PASS | 36 entries, 97 KB |
| PowerShell zip backend | PASS | 36 entries, 97 KB |
| Runtime dependency exposure | PASS | No runtime dependencies; `npm audit --omit=optional` reports 0 vulnerabilities |
| Main CI | PROCESS ITEM | Historical squash body exceeds commitlint limit; no code fix, do not rewrite published history |
| CodeQL | PASS remotely | Run `40557047053` succeeded |
| Dependency review | PASS | Audit is clean; dependency-review workflow previously passed |
| Open issue cross-check | PASS | 8 issues rechecked; no clear false positive; #66/#69/#73 fixed, #48 documented |
| Stream concurrent starts | PASS | One acquisition/one success; second start returns `ALREADY_RECORDING` |
| Stop during startup | PASS by design | Atomic `starting` state closes the vulnerable gap |
| Generation ownership | PASS | Background issues generation and offscreen echoes the same value |
| Three-way recording mutex | PASS | Background lease arbitration covers mic, Tab, and Stream, including failure cleanup |
| Plaintext Custom transport | PASS | `ws://` rejected before WebSocket construction |
| Worker restart during start | NOT CONFIRMED | Artificial in-flight worker reset; normal Chrome termination behavior unverified |
| Stop button reset | PASS | Offscreen broadcasts `ended` before the stop response; covered by existing test |
| Graceful stream shutdown | PASS | Offscreen stops capture, awaits `provider.stop()` with timeout, and preserves final results |
| Stop failure state cleanup | PASS | `isStreaming()` clears a stale flag when the offscreen document is absent |
| Diagnostic subscriber boundary | PASS | Exact approved loopback page and sender URL are enforced |
| Diagnostic redaction | PASS | URL userinfo, `client_secret`/`credential`, and generic secret fields are covered |
| Popup config TOCTOU (#66) | PASS | Edit during deferred load is preserved |
| Options config sync (#69) | PASS | Decrypted apply, unsaved-edit guard, and deferred-load guard covered |
| Save-in-flight config edits | PASS | Popup/options baseline only the submitted config; later edits stay protected |
| Stream teardown ownership | PASS | Audio lease is held until document close finishes; regression test covers the race |
| Local provider close | PASS | Local `close()` no longer broadcasts a network error |
| Diagnostic export URL | PASS | Export header redacts `location.href` before writing |
| Live DashScope protocol | NOT RUN | Requires dedicated valid key and network |
| Mic/tab recording audible output | NOT RUN | Requires physical listening and media |
| Device hot-plug | NOT RUN | Requires physical devices |
| Subtitle/fill visual behavior | NOT RUN | Static and existing automated coverage only |
| Keyboard shortcuts | NOT RUN | Requires real browser accelerators |
| 10-minute stream/performance | NOT RUN | Blocked by live key and audio requirements |
| Chrome 116 / macOS | NOT RUN | Environment unavailable |
| CodeRabbit | NOT RUN | CLI unavailable; installer requires Unix shell |

The pre-existing untracked `tests/manual-test-plan.md` was not modified.
Issue cross-check details are recorded in `docs/review-report.md`.

