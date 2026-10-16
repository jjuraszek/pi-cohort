# Multi-session cleanup guard removal

**Goal:** A pi-cohort extension instance stops its result watcher and drops its event subscriptions only on its own `session_shutdown`, so two live sessions in one process stop retiring each other's watcher and subscriptions.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#20
**Baseline:** `d038341` (Release 7.2.0)

## Problem

Loading pi-cohort into a second SDK session in the same Node process stops the first session from receiving async results. The extension factory (`src/extension/index.ts:248-258`) reads `globalThis.__piSubagentRuntimeCleanup` and calls it, then (`index.ts:494-506`) reads `globalThis.__piSubagentEventUnsubscribes` and calls every entry; `registerSubagentNotify` (`src/runs/background/notify.ts:44-53`) does the same with `__pi_subagents_notify_unsubscribe__`. Those three globals were written by the previous instance, so registering session B stops A's result watcher and drops A's five event subscriptions before B even receives `session_start`. A completion file for A then stays in `RESULTS_DIR` unconsumed and A's parent never learns the child finished.

The guards exist to retire stale listeners after `/reload` (CHANGELOG, "stale legacy listeners still present"). pi already does that: `session_shutdown` is emitted on the old runtime before it is replaced on every retirement path the runtime drives - `reload` (`agent-session.js:2972`, pi 1.3.0), `new`/`resume`/`fork` via `teardownCurrent` (`agent-session-runtime.js:106`), and `quit` via `AgentSessionRuntime.dispose()` (`agent-session-runtime.js:297`) - and pi-cohort's existing `session_shutdown` handler (`index.ts:586-623`) already stops the watcher and unsubscribes. The cross-instance guards are redundant on reload and wrong for two live sessions.

One retirement path emits no `session_shutdown`: the SDK object's own `AgentSession.dispose()` (`agent-session.js:996` in 1.3.0, `:584` in 0.85.1) only calls `_extensionRunner.invalidate()`, which drops tracked `pi.events` subscriptions but does not stop pi-cohort's `fs.watch`. Today the next factory's `__piSubagentRuntimeCleanup` happens to stop that watcher; after this change nothing does. This is the "host retires a runtime without `session_shutdown`" leak the ticket accepts (see Errors and edge cases).

Premise correction to the ticket: the event bus is not "invalidated on reload". It is created once per `ResourceLoader` (`resource-loader.js:248`) and reused across `/reload`. What pi retires is the extension runtime: `pi.events.on` wraps each subscription in `runtime.trackEventBusSubscription` (`extensions/loader.js:424`) and `runtime.invalidate()` (`loader.js:141-149`) drops them, on reload (`agent-session.js:2973`) and inside `session.dispose()` (`agent-session.js:1007`). Verified in pi 1.2.0 and 1.3.0; not verified at the 0.85.0 peer floor, which this design makes irrelevant (see Design, notify).

Framing: kept - checked `index.ts` 244-309/493-530/586-623, `notify.ts` 44-107, `result-watcher.ts` 100-125 (sessionId filter at L105), and pi 1.3.0 `agent-session.js` `reload()`/`dispose()`, `agent-session-runtime.js` `teardownCurrent`/`dispose`, `extensions/loader.js` `createExtensionRuntime`/`events.on`, `resource-loader.js:248`. The reporter's alternative (scope the guard per runtime) was rejected in the ticket; pi already provides the scoping.

## Acceptance criteria

Ticket jjuraszek/pi-cohort#20, `## Acceptance criteria`, rows verbatim:

- [ ] Two independent SDK sessions A and B in one process: A loads pi-cohort, a completion published for A is consumed and A receives exactly one notification with `triggerTurn: true`; pi-cohort is then registered for B (before B's `session_start`) and a second completion is published for A - A consumes it and receives exactly one notification; after B's `session_start`, one completion is published for each session and each consumes only its own file with exactly one notification each.
  in-scope
- [ ] Reload in one process: A is torn down with `session_shutdown` (reason `reload`), a replacement runtime for A is registered and started, then one completion each is published for A and B; the replacement A and B each receive exactly one notification for their own file, and the retired A instance consumes nothing.
  in-scope
- [ ] Tests in the `npm run test:unit` suite cover both sequences above; the two-session test fails on the 7.2.0 tree.
  in-scope

Design clause for "independent SDK sessions": the tests model each session as an independent extension runtime - a distinct `pi` API object with its own event bus - and do not construct real `AgentSession`s (user decision, Q1 = A).

## Design

Approach: delete the three cross-instance guards; the existing per-instance `session_shutdown` handler is the sole teardown. The rejected alternative - keep a registry keyed by `pi` (a `WeakMap<ExtensionAPI, cleanup>`) - extends the process-global lifecycle machinery that is itself the debt and covers a case pi never produces (re-running the factory against a runtime it has not shut down).

### Factory start (`src/extension/index.ts`, today 248-258 and 299-307)

- Remove `runtimeCleanupStoreKey`, the `previousRuntimeCleanup` read and invocation, and the `runtimeCleanup` closure itself (`index.ts:299-307`): the shutdown handler already performs its three steps inline (`index.ts:597-600`), so without the global store the closure is dead code. Nothing is written to `globalThis` for lifetime purposes.
- `createResultWatcher`, `startResultWatcher()`, `primeExistingResults()` keep their current position in the factory (the ticket excludes moving watcher start into `session_start`).

### Event subscriptions (`index.ts`, today 494-530)

- Remove `eventUnsubscribeStoreKey`, the `previousEventUnsubscribes` read and loop, and the store-back at L530.
- `eventUnsubscribes` stays a local array holding the four existing subscriptions (`SUBAGENT_ASYNC_STARTED_EVENT`, `SUBAGENT_ASYNC_COMPLETE_EVENT`, `SUBAGENT_CONTROL_EVENT`, `cost:external`) plus the return value of `registerSubagentNotify(pi)`.
- `controlNoticeSeenStoreKey` / `__piSubagentVisibleControlNotices` stays process-global (ticket: out of scope). `globalStore` therefore remains in the factory for that one key.

### Notify (`src/runs/background/notify.ts`, today 43-53 and 107)

- Signature becomes `registerSubagentNotify(pi: ExtensionAPI): () => void`, returning the `pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete)` unsubscribe.
- Remove `unsubscribeStoreKey`, `globalStore`, the `previousUnsubscribe` read and call.
- `__pi_subagents_notify_seen__` via `getGlobalSeenMap` stays process-global (ticket: out of scope). Two sessions in one process share dedupe keyed by `buildCompletionKey` (`completion-dedupe.ts:22-24`): `id:<id>` when the result carries a non-empty `id`, which production result files set to the run UUID (`subagent-runner.ts`), so sessions cannot collide; a second file reusing an `id` is suppressed regardless of `sessionId`.
- No `session_shutdown` listener is added in notify.ts; index.ts's handler owns the unsubscribe (user decision, Q2 = C). This keeps teardown independent of which pi version tracks subscriptions, so the 0.85.0 peer floor stays.

### Shutdown (`index.ts`, today 586-623)

- The handler keeps its body, order, and existing error handling: unsubscribe every entry of `eventUnsubscribes` (now five, each in the existing try/catch), `stopResultWatcher()`, clear poller, clear pending foreground control notices, clear timers and async jobs, clear slash snapshots, dispose slash/prompt-template bridges, clear widget.
- Remove the two conditional deletes (`globalStore[eventUnsubscribeStoreKey] === eventUnsubscribes`, L594-596; `globalStore[runtimeCleanupStoreKey] === runtimeCleanup`, L611-613).
- The handler ignores `reason`; all five retirement paths behave the same.

### Data flow in the reported scenario

Session A loads: watcher A holds an `fs.watch` on `RESULTS_DIR` (`result-watcher.ts:241-255`; the 3 s poll is only the `EMFILE`/`ENOSPC` fallback), A's five subscriptions listen on A's bus. Session B loads: nothing touches A. A child of A writes `<run>.json` with `sessionId: A`; both watchers see it, B's drops it at the `sessionId` filter (`result-watcher.ts:105`), A's consumes it and emits `SUBAGENT_ASYNC_COMPLETE_EVENT` on A's bus; A's notify handler sends one `subagent-notify` with `triggerTurn: true`. On `/reload` in A: pi emits `session_shutdown` (reason `reload`) to A's old runtime, the handler stops watcher A and unsubscribes, pi invalidates the runtime, the factory runs again with a fresh `pi` and starts watcher A'.

## Errors and edge cases

- Nothing new can fail: the factory no longer reads `globalThis` for lifetime state, so the "previous cleanup threw" try/catch branches disappear with it. The shutdown handler's existing error handling is unchanged.
- Two live sessions, child of A completes: B's watcher drops the file at the `sessionId` filter; A consumes and notifies once. Shared dedupe sets are read by both (today's behavior).
- `/reload` in A: A's old watcher is stopped and its five subscriptions dropped before A' primes existing results; A' does not re-consume files A already unlinked. A and A' share one event bus (per `ResourceLoader`), so A's handlers must be unsubscribed, not merely orphaned.
- `/new`, `/resume`, `/fork`, quit through the runtime: same handler, different `reason`.
- A result file for A written between A's shutdown and A' start is picked up at A's `primeExistingResults()` only if the resumed session reports the same `sessionId`. A file whose `sessionId` matches no live watcher returns at `result-watcher.ts:105` before dedupe and unlink and stays in `RESULTS_DIR` until a watcher with that id consumes it; the 10-minute `completionTtlMs` (`index.ts:294`) expires in-memory seen entries, not files. Unchanged behavior; file expiry is out of scope.
- Mixed versions in one process (a 7.2.0 instance still live after `pi install` without restart): the old code's reads of the three globals find `undefined` and skip, as they do today on first load. No shim.
- A host that retires a runtime without emitting `session_shutdown` - including an SDK host calling `AgentSession.dispose()` directly - leaks the `fs.watch` and keeps logging on later result files for that session id. Accepted per ticket; shutdown delivery is the host's contract.

## Tests

All under `npm run test:unit` (`node --import ./test/support/isolate-test-env.mjs --test test/unit/*.test.ts`; the isolate hook gives each test process a fresh `HOME`/`TMPDIR`, so `RESULTS_DIR` is per process). Recommended invocation: `env -u PI_CODING_AGENT_DIR npm run test:unit`.

New file `test/unit/multi-session.test.ts`, harness per Q1: run the real `registerSubagentExtension` factory in-process against fake `pi` objects. Harness contract:

- `pi.events` implements `SubagentEventBus` (`src/shared/types.ts:746-749`): `on()` returns `() => emitter.off(channel, handler)`, never the raw `EventEmitter` (whose `on` returns the emitter and would make the shutdown loop's `unsubscribe()` throw and be swallowed).
- `pi.on` captures handlers by event name so the test fires `session_start` and `session_shutdown` itself; `sendMessage` records `(message, options)` per instance; `registerTool`/`registerCommand`/UI surfaces are no-ops as in `test/unit/index-child-registration.test.ts`'s Proxy fake.
- `session_start` ctx: `{ cwd, hasUI: false, ui: { requestRender: () => {}, setWidget: () => {}, setStatus: () => {} }, sessionManager: { getSessionId: () => <id>, getSessionFile: () => null, getEntries: () => [], getBranch: () => [] } }`, since `resetSessionState` (`index.ts:560-573`) calls `resolveCurrentSessionId` (throws on empty identity), `getEntries()`, and `getBranch()`, and the async job tracker's completion handler calls `ctx.ui.requestRender?.()` on the stored ctx without a `hasUI` check (`async-job-tracker.ts:38-41`) - without the `ui` stub the completion handler throws before the watcher unlinks the file.
- The test process clears `SUBAGENT_CHILD_ENV` and `SUBAGENT_FANOUT_CHILD_ENV` from `process.env` before calling the factory, which returns early when the child marker is `"1"` (`index.ts:244-247`).
- Completion files are written into `RESULTS_DIR` with `sessionId` equal to the target's resolved id, that session's `cwd`, and a fresh `randomUUID()` in `id` for every publish (the shared seen map keys on `id`).
- Consumption is observed through the live `fs.watch` only: write the file, then wait with a bounded poll (up to 2 s in 20 ms steps) for the `sendMessage` recorder and the file's disappearance. On macOS libuv shares one FSEvents stream per process and recreates it on every new `fs.watch`, dropping events for files written while it re-arms; a publish that expects consumption therefore re-writes the same file (same `id`) every 250 ms until it is consumed or the 2 s deadline passes - the `id`-keyed dedupe makes a re-publish idempotent (a late consumer unlinks the duplicate without a second notification), and a stopped watcher still never consumes, so the 7.2.0 regression still fails. The retired-watcher probe in the reload test writes once, without retry. `session_start` is fired once per runtime at the AC's specified point and never re-fired to drive consumption - `primeExistingResults()` works on a stopped watcher and would mask the watcher-stop regression.
- Session ids are unique per test (`randomUUID()`-suffixed) and every runtime a test created receives `session_shutdown` in `finally`, because `RESULTS_DIR` is one directory per process and a leftover runtime with a reused id would race later tests for files.

1. **Two-session sequence** (AC row 1, step for step): factory on `pi_A`, `session_start` A, publish for A -> A has exactly one `subagent-notify` with `triggerTurn: true` and the file is gone; factory on `pi_B` (no `session_start` yet), publish for A -> A has exactly one more notification; `session_start` B, publish one for A and one for B -> each session has exactly one new notification and only its own file was consumed. Fails on 7.2.0 because B's factory ran A's `runtimeCleanup` (watcher stopped) and A's `eventUnsubscribes` (notify handler gone); the live-`fs.watch` driver is what makes the watcher half observable.
2. **Reload sequence** (AC row 2): factory on `pi_A1` and `pi_B`, both started; fire A1's `session_shutdown` with `{ reason: "reload" }`. Retired-watcher probe: publish a file for A with a fresh id, wait the bounded interval, assert A1's recorder is empty and the file is still on disk (A1's watcher is closed). Factory on `pi_A2` sharing A1's `events` object (pi reuses the `ResourceLoader` bus across reload) with its own `sendMessage` recorder and the same session id, `session_start` A2 (primes the probe file - A2's recorder gains one entry); publish one for A and one for B with fresh ids -> A2 and B each have exactly one new notification, A1's recorder is still empty. Emitting `SUBAGENT_ASYNC_COMPLETE_EVENT` with a never-seen id on the shared A bus after A2's shutdown produces no `sendMessage` on A1 either (listener removed, not just deduped).
3. **Globals absent**: after both sequences, `globalThis` has no `__piSubagentRuntimeCleanup`, `__piSubagentEventUnsubscribes`, `__pi_subagents_notify_unsubscribe__`. Direct regression check for the deletion.

`test/unit/notify.test.ts`: `createPi()` wraps its `EventEmitter` so `events.on` returns an unsubscribe (required by the new return type); existing cases unchanged in behavior; add one case that the returned function stops a later `SUBAGENT_ASYNC_COMPLETE_EVENT` with a never-seen id from reaching `sendMessage`. `test/integration/result-watcher.test.ts` untouched.

Before/after evidence: test 1 run against the 7.2.0 tree (`git stash` of the source change or a checkout of `d038341` with the new test file) fails; the plan records that run.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - new `## [Unreleased]` section (none exists today; `release.sh` promotes it) with a Fixed entry in the implementing commit: a second pi-cohort instance in the same process no longer stops the first instance's result watcher and event subscriptions `(#20)`; category: non-obvious rationale - why the cross-instance guards were removed
- Derived / memory docs invalidated: none

README and `doc/*.md` mention `reload` only for backend reload descriptors, not extension lifecycle; nothing documents the guards.

## Out of scope

- Moving result-watcher start from the factory into `session_start` (ticket Out of scope).
- The process-global dedupe sets `__pi_subagents_notify_seen__` and `__piSubagentVisibleControlNotices` (ticket Out of scope).
- Handling hosts that retire a runtime without `session_shutdown` (including direct `AgentSession.dispose()`).
- Module-level slash snapshot state (`src/slash/slash-live-state.ts:277-292`), which A's shutdown still clears for every instance in the process.
- Expiry of result files whose `sessionId` matches no live watcher.
- Bumping the `@earendil-works/pi-coding-agent` peer floor.
- Other `globalThis` users (`src/extension/fanout-child.ts:119-125` WeakSet, `src/execution-backend/registry.ts:19` symbol hub).

## Open questions

none
