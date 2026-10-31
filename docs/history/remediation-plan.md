# Review Remediation Plan

Work in small, test-first batches. Do not combine lifecycle fixes with unrelated
refactoring. Reproduce each finding before changing behavior.

## Final status

All code/test/documentation batches are complete in worktree
`fix/review-findings`. Final automated evidence:

- `npm test`: 15 suites, 138 assertions passed.
- `node tests/smoke-run.js`: 26/26 passed in local Chrome.
- `npm run lint`: 45 JavaScript files parsed.
- `node scripts/check-manifest.js`: 13 manifest references and icon sizes valid.
- `node scripts/pack.js --node` and `npm run pack`: 36 entries, 97 KB.
- `npm audit --omit=optional`: 0 vulnerabilities.

The over-length squash-merge body process item is fixed by issue #96 without
rewriting published history. Push CI now validates generated squash subjects
and exempts only the aggregate body; source commits remain fully linted in PR CI.

The final pre-merge review also fixed and regression-tested four follow-up
issues: teardown-before-lease-release, local `close()` misclassified as a
network error, save-in-flight UI snapshots, and raw diagnostic export URLs.

## Batch 1 — Sensitive transport and diagnostics (complete)

1. ✅ Require `wss:` for every streaming endpoint before WebSocket construction;
   test mixed-case schemes, `ws://`, malformed URLs, and no-socket-on-reject.
2. ✅ Restrict diagnostic subscriptions to an explicit development configuration
   or approved port/session and validate sender origin.
3. ✅ Remove raw endpoint telemetry where possible; extend redaction tests for
   any credential shapes that remain.

## Batch 2 — One authoritative stream state machine (complete)

1. ✅ Add an atomic `starting` state before microphone acquisition in offscreen.
2. ✅ Move stream generation issuance to one owner and pass the same identifier
   into the offscreen session and back in `STREAM_ENDED`.
3. ✅ Add cross-UI and reclaimed-document tests, plus direct-message
   stop-during-start coverage while introducing the `starting` state.

## Batch 3 — Recording ownership and cleanup (complete)

1. ✅ Put microphone recording under the same background arbitration as Tab and
   Stream, including starting/stopping transitions.
2. ✅ Reconcile persisted streaming state after failed stops and actual document
   reclamation.
3. ✅ Await provider graceful stop with timeout, then close resources; preserve
   final results and exactly one history entry.

## Batch 4 — Repository health and verification (complete except live/manual matrix)

1. ✅ Fix the squash-merge commit-body validation in push CI without rewriting
   published history.
2. ✅ Update vulnerable development dependencies through the lockfile and rerun
   smoke, packaging, and browser tests.
3. ✅ Correct the README offscreen WebSocket data flow and remove stale
  verification references as encountered.
4. ◻ Run the complete manual matrix with a dedicated test key, physical audio
   devices, current stable Chrome, and the minimum supported Chrome version.

## Exit criteria

- Every P1/P2 finding has a regression test that fails on `b017a7c` and passes
  after its fix.
- `npm run lint`, manifest validation, all Node tests, browser smoke, both zip
  backends, and CI pass.
- No startup path can own multiple sessions; every terminal path releases mic,
  AudioContext, WebSocket, and offscreen resources exactly once.
- Real Live Stream, audible Tab capture, keyboard shortcuts, device fallback,
  history, subtitles, and long-run stability have current-version evidence.
- Any remaining `N/A` or `NOT RUN` item has an explicit owner and reason.
