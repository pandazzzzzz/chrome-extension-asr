# Full Review Plan & Result

Status: **complete** for code, tests, and documentation; live/manual-only checks
remain explicitly unrun below.

Final pre-merge pass: **PASS** — 138 Node assertions, 26/26 browser smoke,
lint, manifest validation, both pack backends, and `git diff --check`.

## Overview

We are in a Git worktree `fix/review-findings` with production fixes and new tests already completed. Remaining items per summary:

1. ✅ Fix **issue #66**: add TOCTOU guard for delayed `ConfigStore.load()` in popup (`hasUnsavedEdits` check must also be done *after* the async load during `onChanged`).
2. ✅ Fix **issue #69**: options page sync lacks an explicit regression test; fix offscreen subtitle payload shape.
3. ✅ Complete **issue #73**/README **#48**: update remaining stale comments/docs about where WebSocket runs and where API key is relayed.
4. ✅ Update review documents: `docs/review-report.md`, `docs/remediation-plan.md`, `docs/verification-matrix.md` to reflect completed changes.

## Execution strategy (TDD-first)

For each behavior change:
1. Write failing test(s) that clearly fail on the baseline.
2. Run tests to confirm failure.
3. Make minimal code changes to pass.
4. Confirm all tests green.
5. Refactor only if necessary without changing behavior.

---

## Batch A — Issue #66: Delayed load TOCTOU guard

### Behavior

- `popup/app.js`: when `chrome.storage.onChanged` fires, if there are no unsaved edits we call `await ConfigStore.load()` then apply config to UI. During that await, user might start typing in model/API key fields. The current implementation checks `hasUnsavedConfigEdits()` before starting the load, but does not re-check after loading completes. This leaves a window where external state overwrites UI edits in progress.

- Desired fix: snapshot the "current edited values" at the start of the handler, wait for decryption, then re-verify that no unsaved edits occurred since the snapshot. If any edit was detected during the wait, skip applying external state.

### Tests to write

- `tests/popup-onchange-toctou.test.js`: three cases:
  1. External change arrives, load takes long, no local edits → UI updated from decrypted store.
  2. External change arrives, load takes long, user begins typing custom model during wait → UI retains current model, external ignored.
  3. User edits, saves, immediately another external change arrives → load returns, apply succeeds because snapshot matched last saved.

### Minimal code changes

In `popup/app.js` listener for `storage.onChanged`: capture `snapshotOfChanges = snapshotCurrentConfig()` before awaiting, then after decrypting, re-evaluate `hasUnsavedConfigEdits()`. Only apply if unchanged.

---

## Batch B — Issue #69: Options sync test and offscreen payload shape

### Behavior

- Offscreen subtitle tests (#57) currently call provider mock with `{ subtitles: ... }` instead of wrapping it in `{ payload: { subtitles: ... } }`. This passes by accident because the real handler inspects `payload.subtitles`.

- Options page has no dedicated test for `onChanged` sync behavior, even though popup has one (`config-ui-sync.test.js`).

### Tests to write

- Extend `tests/offscreen-messaging.test.js`: two subtitle tests, rename them to use correct payload shape.
- Add `tests/options-config-sync.test.js`: port popup's sync test pattern to options, verifying: echo detection via snapshot, deferred apply when editing, and load-through-config-store (decryption) rather than passing raw ciphertext into input boxes.

### Minimal code changes

Update `tests/offscreen-messaging.test.js`: pass `{ subtitles: value }` as `payload.subtitles` inside `dispatch(..., 'asr:stream-set-subtitles', { subtitles: value })`.

Add `tests/options-config-sync.test.js`: same harness as popup, loading `options/options.js` in VM. Expectations mirror issues #54/#59.

---

## Batch C — Issue #73 / README #48: Documentation fixes

### What needs updating

- `background/background.js`: top comment still says background doesn't touch API keys; clarify that START messages relay plaintext key in memory.
- `transcription/providers/qwen.js`, `audio/pcm-capture.js`: remove mentions of old pseudo-streaming architecture.
- `README.md`: ensure offscreen WebSocket description is present, and mention where streaming tokenization occurs.

### Action

Apply documentation updates only (no behavioral changes).

---

## Batch D — Document maintenance

### Files to update

- `docs/review-report.md`: add "Completed fixes" section summarizing P0–P3 resolutions.
- `docs/remediation-plan.md`: mark batches 1–4 complete and summarize evidence (test counts, lint results).
- `docs/verification-matrix.md`: update Node test count, browser smoke count, zip artifacts, and CI status.

---

## Final verification

Before completing this work:

```bash
node --check *.js scripts/*.js
node scripts/check-manifest.js
npm run pack
npm test
node tests/smoke-run.js
git diff --check
```

Do not commit/push unless explicitly requested; provide a final diff summary.
