# Result watcher safety rescan (#21)

**Goal:** A result file that the native directory watcher never reports is still consumed within about 1 s while the watcher is healthy, on every platform, without a `session_start` rescan or a re-write of the file.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#21
**Date:** 2026-10-16

## Problem

`createResultWatcher` (`src/runs/background/result-watcher.ts`) relies on `fs.watch(resultsDir)` rename events plus one `readdirSync` scan at factory time and on each `session_start`. On macOS libuv serves every directory `fs.watch` in a process from one FSEventStream (`libuv/src/unix/fsevents.c`): `uv__fsevents_init` flags a reschedule and signals the CoreFoundation thread without waiting, and `uv__fsevents_reschedule` destroys the stream and creates a new one with `kFSEventStreamEventIdSinceNow`. A rename that lands between destroy and the new stream's start is lost for every directory watcher in the process. `uv__fsevents_close` blocks on `fsevent_sem`, so closing a watcher opens no gap, and non-directory paths use kqueue (`src/unix/kqueue.c`), so pi-cohort's session-file watchers are not involved.

The gap opens at the result watcher's own start, when a sibling SDK session creates its own result watcher (`src/extension/index.ts:281-288`), and when pi's footer git watchers arm or retry (`dist/core/footer-data-provider.js:289,312` via `dist/utils/fs-watch.js`, 5 s retry). A result written in any of those gaps sits on disk until the next `session_start`, so the parent gets no completion notification.

Repro (Node v26.10.0, Darwin 25.6.0, `fs.watch` on a temp dir): quiet machine 0/15 misses in every mode; with 10 busy writer processes, a write immediately after own `fs.watch` missed 6/15, a write immediately after a second directory `fs.watch` in the same process missed 5/15, a write after a second watcher's `close()` 0/15, a write 300 ms after start 0/15. Under that load the window was 1/12 at 0 ms and 0/12 at 25 ms and above; it is scheduling-bound, not fixed.

The ticket's idea - one rescan a few hundred ms after own start - covers only the own-start window. `test/unit/multi-session.test.ts:163-168` publishes right after `pi_B`'s factory, which is the sibling re-arm window, so that idea alone cannot deliver the ticket's second acceptance row.

Framing: pivoted to a low-frequency safety rescan while the native watcher is healthy - the stream is re-armed by any directory `fs.watch` in the process, which the watcher cannot observe, so only a periodic rescan is mechanism-independent. User chose this over the as-framed one-shot rescan and over a test-only wait.

## Acceptance criteria

Ticket jjuraszek/pi-cohort#21, Acceptance criteria, rows verbatim:

- [ ] Deterministic recovery test in `npm run test:unit`: with the directory-watch factory stubbed to return a watcher that never emits events (and no `EMFILE`/`ENOSPC` error, so the polling fallback does not engage), the result watcher is started, its initial rescan completes, then one result file for the current session is written; the file is consumed and exactly one completion notification is sent within 2 s, with no further `session_start` and no re-write of the file.
  in-scope
- [ ] The re-publish workaround in `test/unit/multi-session.test.ts` (`publishAndAwait` re-writing the file every 250 ms) is replaced by a single write, and the full unit suite passes 10 consecutive runs on macOS (baseline: the single-write version failed 2 of 4 full-suite runs before commit a556882).
  in-scope
- [ ] Fallback behavior unchanged: with the directory-watch factory stubbed to throw `EMFILE`, the watcher logs the existing fell-back-to-polling message and consumes a result file within the existing 3 s poll interval; with a successfully created watcher, the polling fallback is not started. `test/integration/result-watcher.test.ts` passes.
  in-scope

Readings adopted as Design clauses: row 1's "initial rescan completes" means `primeExistingResults()` has returned (its `readdirSync` ran; file handling still sits on the coalescer's 0 ms timer), and "within 2 s" is proven under fake timers by asserting the recorded `setInterval` delay equals `SAFETY_RESCAN_INTERVAL_MS` (1000, under 2000), invoking that handler once, then awaiting the coalescer's real 0 ms timer and `handleResult`. Row 2's 10 consecutive runs are a one-off observation at the PR gate on a macOS machine, reported in the PR, not a CI loop. Row 3's "polling fallback is not started" is asserted on the fallback log line and on `state.watcherRestartTimer` staying null, since the safety interval is a separate `setInterval` call on `deps.timers`.

## Design

Scope: `src/runs/background/result-watcher.ts`; the `SubagentState` shape in `src/shared/types.ts`, its two production initializers (`src/extension/index.ts:273`, `src/extension/fanout-child.ts:44`) and the ten test fixtures that build a `SubagentState` literal with `watcherRestartTimer: null` (`test/unit/{run-id-resolver,control-notices,nested-control,doctor}.test.ts`, `test/integration/{slash-commands,result-watcher,doctor-executor,foreground-result-size,async-job-tracker,fork-context-execution}.test.ts`), each gaining `safetyRescanTimer: null` so type-stripping never leaves the field `undefined`; one new unit test; one edited unit test; `CHANGELOG.md`.

### Safety rescan loop

- New constant `SAFETY_RESCAN_INTERVAL_MS = 1000` beside `POLL_INTERVAL_MS` and `WATCHER_RESTART_DELAY_MS` in `result-watcher.ts`.
- New field `safetyRescanTimer: ReturnType<typeof setInterval> | null` on `SubagentState` next to `watcherRestartTimer`, initialized to `null` in both state initializers. `watcherRestartTimer` stays the shared slot for the restart timeout and the fallback interval; the safety loop never touches it.
- `startResultWatcher`: as the last statement of the existing `try` block, after `state.watcher.on("error", ...)` and `state.watcher.unref?.()`, if `state.safetyRescanTimer` is null set it to `timers.setInterval(primeExistingResults, SAFETY_RESCAN_INTERVAL_MS)` and call `.unref?.()` on it. Any throw inside the `try` (from `fsApi.watch`, `.on`, or `.unref`) therefore reaches the `catch` before the interval exists, and the `catch`'s EMFILE/ENOSPC fallback or `scheduleRestart` runs with the interval unarmed. A successful restart via `scheduleRestart -> startResultWatcher` arms it again.
- Each tick calls the existing `primeExistingResults` unchanged: `readdirSync`, filter `.json`, `schedule(file, 0)` on the coalescer. No new processing path; the tick is a second trigger for the existing one. ENOENT is swallowed, other readdir errors log once per tick as today.
- The interval is cleared (`timers.clearInterval`, field set to `null`) wherever the native watcher is torn down: `stopResultWatcher`; `startPollingFallback`, immediately after `state.watcher = null` and before both its `watcherRestartTimer` early return and its `timers.setInterval(primeExistingResults, POLL_INTERVAL_MS)` call - this ordering is required because the asynchronous ENOSPC/EMFILE error path (`watcher.on("error")`) arrives after the interval is armed, and the integration test's timers stub forgets its captured handler on any `clearInterval`, so the clear must precede the fallback `setInterval`; and the `watcher.on("error")` non-fallback branch, after `state.watcher = null` and before `scheduleRestart`.
- `primeExistingResults` and `resetSessionState` are unchanged; the loop belongs to the watcher's lifetime, not the session's.

### Invariant

At any moment exactly one of four states holds, read from `(watcher, safetyRescanTimer, watcherRestartTimer)`:

| State | `watcher` | `safetyRescanTimer` | `watcherRestartTimer` |
|---|---|---|---|
| healthy | set | 1 s interval | null |
| restart pending | null | null | 3 s timeout |
| fallback polling | null | null | 3 s interval |
| stopped | null | null | null |

The fallback's trigger (EMFILE/ENOSPC only), interval, and log line are unchanged.

### Dedup and cost

A file delivered by both a native event and a tick reaches `handleResult` twice at most; the second arrival returns at the `existsSync` guard because the first unlinked the file, a re-written file with the same id is dropped by `markSeenWithTtl("id:<id>")`, and the coalescer's pending-file check already drops a second `schedule` while the first is queued. Cost is one `readdirSync` of a usually empty directory per second per session on every platform; this is accepted over a macOS-only switch so behavior and tests are identical across platforms.

### Test-side change

`publishAndAwait` in `test/unit/multi-session.test.ts` writes each result file once and polls for its disappearance within `SETTLE_MS` (2 s). `REPUBLISH_MS` and the re-write loop are removed; the comment explaining FSEvents re-arm is replaced by one sentence pointing at the safety rescan. The gh-20 spec's note on the workaround (`doc/specs/2026-10-16-gh-20-multi-session-cleanup-guard.md`, Test approach) is history and is not edited.

## Errors and edge cases

- Results dir missing at tick time: ENOENT swallowed, interval keeps running; `ensureAccessibleDir(RESULTS_DIR)` at extension registration (`src/extension/index.ts:251`) and `scheduleRestart`'s `mkdirSync` are the only creators, as today.
- Persistent readdir error (permissions): logs each tick via the existing `console.error` in `primeExistingResults`. Accepted; the native watcher is still primary and this state is already loud on `session_start`.
- File `handleResult` cannot finish: malformed JSON (parse catch, logs and leaves the file; runs before the session filter, so every session's watcher sees it) or a nested-registry enrichment failure ("will retry later", leaves the file). Today these log once per `session_start` or rename; with the loop they are retried and logged once per second per scanning session until the file is removed. Accepted as the cost of the mechanism; no suppression, quarantine, or per-file once-only logging is added in this change. Result files are written atomically (`writeAtomicJson`), so a partially written file is not a case.
- Wrong-session files are left on disk by `handleResult` and are re-read every tick. Accepted: they are small, rare, and consumed by their own session's watcher.
- Result with an id outside the 10 min TTL still on disk: re-emitted, same as the existing `session_start` rescan; not widened, because consumed files are unlinked.
- `startResultWatcher` with `state.watcher` already set: existing early return, so never two intervals.
- Runtime retirement and `resetSessionState`: `stopResultWatcher` clears the interval, so a retired runtime's loop stops re-reading the directory (the "retires only the reloaded runtime" multi-session case); the interval is `unref`'d so it never holds the process open.
- Linux/Windows: identical behavior; no platform switch.

## Tests

1. New `test/unit/result-watcher-safety-rescan.test.ts`, using `createResultWatcher` with an injected `fs` whose `watch` returns `{ on() { return this }, close() {}, unref() {} }` and never emits, and an injected `timers` that records `setInterval`/`clearInterval` calls and exposes each handler. Cases:
   - Silent watcher recovery (AC row 1): `startResultWatcher(); primeExistingResults();` with an empty dir, assert the recorded `setInterval` delay is 1000, then write one result for `state.currentSessionId`, invoke that handler, await the coalescer's real 0 ms timer and `handleResult` (a short real wait), assert exactly one `SUBAGENT_ASYNC_COMPLETE_EVENT` emission, the file is unlinked, `watcherRestartTimer` is null, and the fallback log line never printed.
   - Stop clears the loop: after `stopResultWatcher()`, `clearInterval` was called with the safety handle and `state.safetyRescanTimer` is null.
   - EMFILE fallback (AC row 3, first half): with `watch` throwing `EMFILE`, the existing fallback log prints and `safetyRescanTimer` is null; then write one current-session result, invoke the recorded 3000 ms interval handler, await the coalescer, and assert exactly one emission and the file unlinked, with `safetyRescanTimer` still null.
2. `test/unit/multi-session.test.ts`: `publishAndAwait` single-write form; all three existing cases pass unchanged otherwise.
3. `test/integration/result-watcher.test.ts` passes. Its `createState()` fixture gains `safetyRescanTimer: null`; its ENOSPC case additionally asserts that the safety interval is active after `startResultWatcher()` and that `safetyRescanTimer` is null once the fallback has taken over. Because `startPollingFallback` clears the safety interval before creating the fallback interval (Design), the stub's captured `poll` is the fallback's 3 s handler and `poll?.()` keeps driving the case.
4. PR-gate observation for AC row 2: `for i in $(seq 10); do env -u PI_CODING_AGENT_DIR npm run test:unit || break; done` on macOS, 10 passes, reported in the PR body.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - new `## [Unreleased]` Fixed entry in the implementing commit (macOS FSEvents re-arm gap, result files picked up within 1 s by a safety rescan, multi-session test workaround removed); the release skill requires the entry to exist before `release.sh` runs. `doc/observability.md` is not amended: it describes only `subagent:async-complete` emission, and the safety rescan has no tunable and changes no contract (fails the operations and architecture bars of `reference/documentation-impact.md`).
- Derived / memory docs invalidated: none - the gh-20 spec's workaround note is history, not a current-state guide.

## Out of scope

- Moving watcher creation from extension registration to `session_start` (gh-20 left it out; unchanged here).
- A macOS-only switch or an FSEvents-specific re-arm detector.
- Changing the EMFILE/ENOSPC fallback interval, trigger, or log line.
- A CI job that loops the unit suite.

## Open questions

none
