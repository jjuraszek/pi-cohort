# Cap foreground child runtime with `control.maxRuntimeMs`

**Ticket:** [#61](https://github.com/jjuraszek/pi-cohort/issues/61)
**Goal:** Every foreground child is terminated once it has run for `control.maxRuntimeMs` (default 14400000 ms, 4 h; overridable in `settings.json` under `subagents.control` and per call), whatever activity it shows, and the call returns it as an ordinary failure whose `error` names the cap. A child already stopped by index (`interruptSignal`) keeps today's interruption behavior and is exempt from the cap.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-11
**Source bases:** pi-cohort `ecabac56` (7.7.3). Line numbers below are at this commit.
**Predecessor:** `doc/specs/2026-06-28-foreground-silence-killcap.md`, the "Signal-based, not absolute" decision in `Decisions (locked with user)` and the `maxRunMs` line in `Out of scope` only. The silence kill itself stays as that spec designed it.

## Problem

Ticket #61, "Foreground child that never goes silent can run with no time limit". In a foreground run the calling agent waits until its children return. A child is stopped early only when it goes silent for 30 minutes (`inFlightSilenceKillMs: 1_800_000`, `src/runs/shared/subagent-control.ts:19`) or when a person stops it by hand (`/interrupt-child`). Every tool call counts as activity, so a child that stays busy without getting anywhere never trips the silence limit and can run and spend tokens with no upper bound; overnight, nobody is watching to stop it.

The ticket also says a limit set too low does more harm than good, because a clock cannot tell a loop from long legitimate work. So the limit is a backstop: on by default, above every run on record, and raisable by a call that expects longer work.

Framing: kept (ticket #61). The 2026-06-28 silence-cap spec rejected an absolute cap ("it kills demonstrably-alive long children on a dumb timer"). The ticket reverses that on purpose with a default far above the silence cap, and the recon found no alternative beyond the silence-only status quo the ticket shows insufficient.

Premises checked against the source:

- Corrected: the ticket's Idea says the silence limit's forced stop already routes a kill through an ordinary failure. That holds only on the built-in backend (`src/runs/foreground/execution.ts:244-257`, close handler `:571-587`). The external backend has no silence kill, and every stop there settles as `interrupted: true` with exit 0, either returned (`src/runs/foreground/attempt-finalization.ts:185-189`) or thrown and mapped (`src/runs/foreground/execution.ts:814-820`). The external path needs a failure mapping the built-in path does not.
- Supported: settings reach the resolver. `subagents.control` from `settings.json` is passed with the call-time `control` block to `resolveControlConfig` (`src/runs/foreground/subagent-executor.ts:693,2383`), and `parsePositiveInt` (`src/runs/shared/subagent-control.ts:25-29`) drops anything that is not a positive integer so the next level applies.
- Supported: every foreground child runs through `runSync` (`src/runs/foreground/subagent-executor.ts:1503,2070`, `src/runs/foreground/chain-execution.ts:302,1155`). The background runner resolves the same config object (`src/runs/background/subagent-runner.ts:1403`) and never calls `runSync`.
- Supported: top-level parallel `tasks` has no fail-fast, and a chain parallel group defaults `failFast` to false (`src/runs/foreground/chain-execution.ts:219`).
- Found defect the cap depends on: the native abort handler escalates with `setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000)` (`src/runs/foreground/execution.ts:606`). `proc.killed` is true as soon as SIGTERM is sent (observed on Node v26.12.0: a child trapping SIGTERM reported `killed true, exitCode null` 500 ms later), so SIGKILL never follows and a child that ignores SIGTERM survives any abort.
- Unverified: the Reporter note's sample (about 36,000 foreground child runs of 30 seconds or longer between 2026-07-14 and 2026-11-11; a 60-minute limit would have ended 27 successful runs to cut short 13 failed ones; longest successful run 202 minutes; one read-only review child ran 77 minutes against a 19-minute 99th percentile). The issue text and the repo hold no dataset. These figures describe the input that motivated the 4 h default; they are not a target or a limit.

The Reporter note preserves the original proposal. Where it disagrees with the ticket body, the body wins: the note's default-off, `timed_out` status, per-task override, clamp against `needsAttentionAfterMs`, and kept partial `output:` are all excluded by the body's Out of scope section. The note's statement that the parent gets `active_long_running` notices does not match the code, which drops that event type in `handleSubagentControlNotice` (`src/extension/control-notices.ts:69-70`); nothing here depends on it.

## Acceptance criteria

Ticket #61, Acceptance Criteria, rows verbatim:

- [ ] A foreground child still running `control.maxRuntimeMs` ms after it started is terminated even though it emitted tool activity throughout; the call returns it as a failure whose `error` names `maxRuntimeMs` and the value.
  in-scope
- [ ] In a foreground parallel run, the siblings of a capped child finish and return their own results.
  in-scope
- [ ] With only `subagents.control.maxRuntimeMs` set in settings, a foreground child is terminated at that value.
  in-scope
- [ ] With both a settings value and a call-time value set, a foreground child is terminated at the call-time value.
  in-scope
- [ ] With neither set, a foreground child is terminated at 14400000 ms (4 h) and not before.
  in-scope
- [ ] With a call-time value above 14400000, a foreground child runs past 4 h and is terminated at the call-time value.
  in-scope
- [ ] A `maxRuntimeMs` value that is not a positive integer is ignored and the next level applies (settings, then the default).
  in-scope
- [ ] A foreground child on an external execution backend is terminated at the cap like one on the built-in backend.
  in-scope
- [ ] An async (background) child that runs past the cap is not terminated by it.
  in-scope
- [ ] The control-field tables in `doc/programmatic-api.md`, `doc/configuration.md`, and `skills/pi-cohort/reference/config-fields.md` list `maxRuntimeMs`, its 14400000 default, and its foreground-only scope.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-61-foreground-max-runtime-cap
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (`release.sh <level>`) per overrides `## Release`
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/observability.md
Rules: doc/agents-and-chains.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7, AC 8, AC 9, AC 10
design: owns `src/shared/types.ts`, `src/runs/shared/subagent-control.ts`, `src/runs/foreground/execution.ts`, `src/runs/foreground/attempt-finalization.ts`, `src/extension/schemas.ts`, `test/support/mock-pi.ts`, `test/support/mock-pi-script.mjs`, the test files named in `## Tests`, `doc/configuration.md`, `doc/programmatic-api.md`, `skills/pi-cohort/reference/config-fields.md`, `skills/pi-cohort/SKILL.md`, `CHANGELOG.md`, and the banner in `doc/specs/2026-06-28-foreground-silence-killcap.md`; observable outcomes are the ten acceptance rows above plus the abort escalation fix in Design

## Design

`maxRuntimeMs` is one more `control` field, resolved where every other control field is. `runSync` owns one clock per foreground child and delivers the stop through the abort signal both backends already obey.

### Inventory

Remove:

- the `!proc.killed` guard and the bare `proc.kill("SIGKILL")` in the native abort escalation (`src/runs/foreground/execution.ts:606`)
- `NEVER_ABORTED_SIGNAL` (`src/runs/foreground/execution.ts:98`); its only use at `:774` is replaced by the per-child controller's signal
- the two `"Interrupted. Waiting for explicit next action."` string literals that set a single result's `finalOutput` (`src/runs/foreground/execution.ts:622`, `src/runs/foreground/attempt-finalization.ts:189`); the exported constant below replaces both

Add:

- `maxRuntimeMs?: number` on `ControlConfig` and `maxRuntimeMs: number` on `ResolvedControlConfig` (`src/shared/types.ts`)
- `maxRuntimeMs: 14_400_000` in `DEFAULT_CONTROL_CONFIG` and its resolution in `resolveControlConfig` (`src/runs/shared/subagent-control.ts`)
- an exported constant `INTERRUPTED_FINAL_OUTPUT` holding `"Interrupted. Waiting for explicit next action."` in `src/runs/foreground/attempt-finalization.ts`, used at the two sites above and by the failure rewrite
- in `runSync` (`src/runs/foreground/execution.ts`): the monotonic start mark, the cap timer, the cap-fired state, the per-child `AbortController` with caller-signal forwarding, the options copy carrying the controller's signal, the cap-aware wait on backend selection, the failure rewrite at two call sites, the loop exit after a rewrite, and cleanup of the timer and the forwarding listener on every exit
- an optional `monotonicNow?: () => number` on `RunSyncDependencies` (`src/runs/foreground/execution.ts:91-96`), defaulting to `performance.now()`, as `src/runs/shared/external-execution.ts:248` already has
- a `!childExited` guard and `trySignalChild(proc, "SIGKILL")` in the native abort escalation (`src/runs/foreground/execution.ts:606`)
- the field count in the control stub comment (`src/extension/schemas.ts:245`): 10 becomes 11. The schema needs no change; `ControlOverrides` already has `additionalProperties: true`
- an `ignoreSigterm` option on `MockPiResponse` that makes the mock child ignore SIGTERM, and an option that makes it exit on SIGTERM while a descendant holds its stdout open. `test/support/mock-pi.ts` holds only the response interface; the behavior is implemented in `test/support/mock-pi-script.mjs`, which has no signal handler today
- the tests in `## Tests`
- the documentation and skill-file changes in `### Documentation and skill files`
- the supersession banner in `doc/specs/2026-06-28-foreground-silence-killcap.md`

### Config resolution

`resolveControlConfig` resolves `maxRuntimeMs` as `parsePositiveInt(override?.maxRuntimeMs) ?? parsePositiveInt(globalConfig?.maxRuntimeMs) ?? DEFAULT_CONTROL_CONFIG.maxRuntimeMs`. The value is not clamped against the silence fields, has no upper bound, and is not gated on `enabled`. `enabled: false` turns off attention tracking and the silence kill only; the cap still applies. No value disables the cap: zero and negative numbers are ignored like any other invalid value, and a caller who wants no practical limit passes a very large integer.

The settings key is `subagents.control.maxRuntimeMs`. Settings levels keep replacing the whole `control` object between profile and project (`doc/configuration.md`, `control`); this change adds no merge behavior.

`runSync` reads the field itself, `options.controlConfig?.maxRuntimeMs ?? DEFAULT_CONTROL_CONFIG.maxRuntimeMs`, so a caller that passes no control config, or one without the field, gets the 4 h default. A whole-object fallback is not enough: existing callers pass partial `controlConfig` literals (`test/integration/foreground-in-flight-control.test.ts:328,346,364,395`, `test/integration/single-execution.test.ts:440,473,497`), which would leave the duration `undefined` and the timer budget `NaN`. `runSync` does not validate the value again; settings and call-time validation stays in `resolveControlConfig`.

The 4 h default sits above the longest successful run in the Reporter note's sample (202 minutes); the ticket chose it as a backstop, and this spec adopts the ticket's value without re-deriving it.

### Clock

One clock per `runSync` call, which is one foreground child: a single run, each child of a top-level parallel run, and each sequential or parallel chain step.

- The clock starts immediately after `runSync`'s unknown-agent check (`src/runs/foreground/execution.ts:662-672`), before backend selection and before an external owner is created, so external startup counts toward the cap. Time a child spends waiting behind the concurrency limit is not counted, because `runSync` has not been called yet.
- The clock spans every model-fallback attempt of that child. It does not restart per attempt.
- Elapsed time is measured on a monotonic clock: `monotonicNow()` (`performance.now()` by default) minus the mark taken at clock start, as the external termination budgets do (`src/runs/shared/external-execution.ts:248`). A wall-clock change during the run does not move the deadline. `Date.now()` stays in use only for the timestamps and durations the attempts already report.
- The timer is deadline-based and re-arms in chunks: each arm waits `min(remaining, 2147483647)` ms, and the callback fires the cap only when elapsed time has reached `maxRuntimeMs`, otherwise it re-arms. Node fires a `setTimeout` above 2147483647 ms after 1 ms (observed on Node v26.12.0), so a single timer would fire a large cap immediately. The cap never fires before `maxRuntimeMs` has elapsed.
- The timer is unref'd, like the other kill timers in this file, and is cleared on every exit of `runSync`, whether it returns or throws.
- Nothing carries elapsed time across `runSync` calls.

### Stop delivery

`runSync` creates one `AbortController` per child.

- The caller's `options.signal` forwards into it through an `abort` listener (an already-aborted caller signal aborts it at once). The listener is removed on exit. `AbortSignal.any` is not used: `package.json` allows Node `>=20`, and that API needs 20.3.
- When the cap fires, the callback records the elapsed time, sets the cap-fired state, and aborts the controller. The callback does nothing when the controller is already aborted or when `options.interruptSignal` is already aborted, so a user cancel or a stop by index that came first is never relabeled as a cap failure.
- `runSync` passes a copy of its options with `signal` set to the controller's signal to `createExternalOwner` and to both attempt runners (`runNativeAttempt`, `runExternalAttempt`). Both backends already terminate the child on that signal: the native attempt at `src/runs/foreground/execution.ts:602-612`, the external owner through `runAttempt({ signal })` (`src/runs/foreground/external-single-attempt.ts:117-126`) and at launch (`src/execution-backend/child-host-controller.ts:31,121-125`).

After a stop by index the child is exempt from the cap. It keeps the existing interruption behavior (SIGINT, then SIGTERM after 1000 ms, no SIGKILL; `src/runs/foreground/execution.ts:615-630`), so a child that resists both signals is not terminated by this change.

Backend selection is the one await the signal does not reach: `runSync` awaits it directly (`src/runs/foreground/execution.ts:693-701`), and selection awaits `backend.detect()` with no signal and no deadline (`src/execution-backend/selection.ts:41-83`). `runSync` therefore waits for selection and the cap together. When the cap fires first, `runSync` returns a failed result (exit 1) whose `error` is the cap text defined in `### Failure rewrite`, creates no owner, and runs no attempt. The pending selection is abandoned, not cancelled: selection gains no signal parameter, and a rejection that arrives later is caught and dropped. No await sits between the end of that wait and the missing-`pi-cohort`-skill return (`:719-728`), so no result returned after the cap fired carries a selection or missing-skill error in place of the cap error. A caller cancel during selection is unchanged: it takes effect when the owner or the attempt starts.

The controller is per child, so a cap on one child never signals its siblings.

### Failure rewrite

One helper in `src/runs/foreground/execution.ts`, called at two sites:

1. inside the fallback loop, on each attempt's result after it is obtained or mapped from a thrown error and before it becomes `lastResult` and is recorded in `modelAttempts` (`:836-848`). An external attempt stopped by abort comes back as exit 0 with `interrupted: true`, which the loop records as a successful attempt (`:840`), so the rewrite has to run first.
2. on the external startup-failure result (`:777-779`), which skips the loop.

The helper acts only when the cap fired and the result is not a clean success. A clean success is `exitCode === 0`, no `error`, and not `interrupted`; it is kept as returned. An external result already finalized as interrupted is not a clean success, even when the child's completion raced the cap. Otherwise the helper:

- sets `exitCode` to 1 and `interrupted` to `undefined`
- sets `error` to `Subagent killed: ran for <s>s (exceeded maxRuntimeMs=<ms>ms).`, where `<s>` is the elapsed time recorded when the cap fired, as `Math.round(elapsedMs / 1000)`, and `<ms>` is the resolved `maxRuntimeMs`. When the result already carried an `error`, that text follows on a new line, so an external owner's `Process termination could not be confirmed; manual cleanup may be required.` diagnostic survives.
- clears `finalOutput` when it equals `INTERRUPTED_FINAL_OUTPUT`, and keeps any other partial output. The placeholder would otherwise contradict the failure in `details.results[].finalOutput` and in parallel aggregation. Tool text is not the reason: an inline failed single result renders `error` alone, only the file-only branch appends `finalOutput` (`src/runs/foreground/subagent-executor.ts:2158-2162`), and the post-loop file-only formatting has replaced `finalOutput` by then (`src/runs/foreground/execution.ts:979`).
- sets `progress.status` to `"failed"` and `progress.error` to the new `error` when the result has `progress`, as the acceptance-failure rewrite does (`:942-948`).

After a rewrite inside the loop, `runSync` records the attempt as failed and leaves the loop; no fallback model is tried. The existing post-loop code then treats the result as any failure: acceptance cannot turn it into a success, an external owner finishes as `retained`, and file-only output formats the failure.

A cap kill emits no control event. The failed result is the signal to the caller.

The rewrite emits no `onUpdate`. The native attempt's final update is sent before the rewrite (`src/runs/foreground/attempt-finalization.ts:289-302`), so live progress for a capped child shows a failure without the cap reason, in a parallel run until the siblings finish. The returned failure and its `progress` fields carry the reason.

### Abort escalation

The native abort handler's SIGKILL follow-up runs `if (!childExited) trySignalChild(proc, "SIGKILL")` after 3000 ms. The guard is `childExited`, not `processClosed`: `close` waits for stdio, which the post-exit stdio guard (`src/runs/foreground/execution.ts:550`, idle 2000 ms, hard 8000 ms) can hold open for up to 8 s after `exit`, so at 3000 ms a child can be gone while `processClosed` is still false. `trySignalChild`, which the silence kill already uses (`:252-254`), swallows a throw from signaling a process that is gone. A child that traps SIGTERM then dies 3 s after any abort, whether the abort came from the cap or from a user cancel. This changes user cancellation for such a child: today it lingers, afterward it is killed.

Descendants of the child (its own subagents and tool processes) are not signaled by this change. Their cleanup relies on the child's own SIGTERM shutdown finishing within 3 s, as with the silence kill, and is not otherwise handled; on a user cancel that shutdown ran to completion before and is now cut off at 3 s.

Kill timing after the cap fires:

- built-in backend: SIGTERM at once, SIGKILL 3000 ms later when the process has not exited
- external backend: the owner's existing interruption sequence (abort request, shutdown, host shutdown, then explicit cleanup) bounded by its control timeout, 30 s by default and 60 s when it falls back (`src/runs/shared/external-execution.ts:296-325`)

### Background

The async runner resolves the same config object and never reads `maxRuntimeMs`, so a background child is not capped. No code changes in `src/runs/background/`.

### Row readings

- AC 1, "after it started": the clock start defined in `### Clock`.
- AC 2: a capped child is an ordinary failure. Top-level parallel runs and chain parallel groups with the default `failFast: false` let the siblings finish. A chain parallel group with explicit `failFast: true` behaves as it does for any failed child: siblings already running finish, and siblings still queued are skipped (`src/runs/foreground/chain-execution.ts:217-235,384-386`). This change does not alter fail-fast.
- AC 5 and AC 6, "at" the value: the cap fires when elapsed time reaches the resolved value and not earlier; the child is gone within the kill timing above.
- AC 10, `doc/configuration.md`: that file documents `control` with a JSON example and a prose paragraph, not a table. The example gains `"maxRuntimeMs": 14400000` and the paragraph states the default, the foreground-only scope, and that `enabled: false` does not disable it.

### Documentation and skill files

- `doc/configuration.md`, `control`: as in the AC 10 reading above.
- `doc/programmatic-api.md`: a `maxRuntimeMs` row in the Control configuration table (default `14400000`; foreground only; an absolute cap from child start regardless of activity; failure with `result.error` naming the cap; not gated on `enabled`), and `maxRuntimeMs` in the supported-fields list of the `control` parameter row (`:193`).
- `skills/pi-cohort/reference/config-fields.md`: a `maxRuntimeMs` row in the call-time `control` table (integer >= 1; default `14400000`; foreground only).
- `skills/pi-cohort/SKILL.md:77`: `maxRuntimeMs` in the thresholds line. Edited under `/skill:forge-skill`, as AGENTS.md requires for skill files.
- `CHANGELOG.md`, `## [Unreleased]`: the new field and settings key; that existing foreground runs are now capped at 4 h by default; the abort SIGKILL fix. Entries carry `(#61)`.

### Predecessor scope

This spec supersedes two statements of `doc/specs/2026-06-28-foreground-silence-killcap.md`: the "Signal-based, not absolute (option A)" decision's rejection of an absolute cap, and the `Out of scope` line "Any absolute run-duration cap (`maxRunMs`)". The silence kill, its `enabled` gate, its clamp, and its guarantee that a streaming child is not killed by the silence cap all stay. The predecessor receives one banner line naming this spec and that scope.

### Paid or external actions

None. Implementation and verification use the repo's unit and integration suites with the mock child; no paid API, network service, or external system is called. The loop treats any paid or external action without a clause here as unreachable, and adding one needs separate explicit authorization.

## Errors and edge cases

- The child finishes as the cap fires: only a result that reaches the helper already clean (`exitCode` 0, no `error`, not `interrupted`) is kept. On the built-in backend the existing close handling decides that and does not change. A native child killed by the abort inside its final drain window, before the drain's own forced termination, exits non-zero and becomes a cap failure, exactly as a user cancel in that window fails it today. On the external backend a terminal result that arrives after interruption was requested is finalized as interrupted (`src/runs/shared/external-execution.ts:393-397`), so a completion that races the cap becomes a cap failure. Backend finalization does not change.
- The caller cancels first: the cap callback finds the controller aborted and does nothing; the result is whatever a cancel produces today.
- A stop by index (`interruptSignal`) comes first: the cap callback does nothing; the child settles as interrupted. From then on it is exempt from the cap, and a child that resists SIGINT and SIGTERM is not guaranteed to terminate (the stop-by-index path has no SIGKILL follow-up and is out of scope).
- The cap fires first and a cancel follows: the cap failure stands.
- The cap fires during external startup: owner creation or `ready` fails, the startup result is rewritten to the cap failure, no attempt runs, and an acquired owner finishes as `retained`.
- The cap fires during backend selection: `runSync` stops waiting and returns the cap failure; no owner is created and no attempt runs. A selection rejection that arrives afterward is dropped.
- The cap fires while a failing attempt settles: that attempt's result is rewritten and the loop exits without a fallback. No await sits between one attempt's result and the start of the next (`src/runs/foreground/execution.ts:836-856`), so the cap cannot fire between attempts.
- An ordinary retryable failure before the cap starts a fallback attempt: that attempt runs against the original deadline, not a fresh `maxRuntimeMs`.
- The wall clock changes during the run: the deadline does not move.
- A `controlConfig` without `maxRuntimeMs` reaches `runSync`: the 14400000 default applies.
- A child ignores SIGTERM: SIGKILL follows after 3000 ms on the built-in backend.
- A child exits on SIGTERM while its stdio stays open past 3000 ms: the follow-up sends no signal and does not throw.
- A value above 2147483647 ms: the chunked timer waits the full time; `9999999999999` works as "effectively off".
- A value that is not a positive integer (0, negative, fractional, string, `null`, `NaN`): ignored at that level; the next level applies.
- A child crashes for an unrelated reason in the same instant the cap fires: it is reported as a cap failure with the original error appended.
- The external owner cannot confirm termination: its diagnostic is appended to the cap error and the surface is retained.

## Tests

- Default is 14400000; a call-time value above the default resolves to that value; a settings-only value resolves; call-time beats settings; 0, -1, 1.5, a numeric string, `null`, and `NaN` fall through to the next level (AC 3, 4, 5, 6, 7) - `resolves maxRuntimeMs with call-time, settings, default precedence` and `ignores non-positive-integer maxRuntimeMs` in `test/unit/subagent-control.test.ts`
- A child that keeps emitting tool events is terminated at the cap with `control.enabled: false`, not before the cap, with a non-zero exit and an `error` containing `maxRuntimeMs` and the value; one model attempt is recorded (AC 1) - `kills an active child at maxRuntimeMs even with control disabled` in `test/integration/foreground-in-flight-control.test.ts`
- A child shorter than the cap succeeds - `does not cap a child that finishes before maxRuntimeMs`, same file
- A cap of 3000000000 does not fire early (AC 6, chunked timer) - `does not fire a maxRuntimeMs above the 32-bit timer limit early`, same file
- In a top-level parallel run the sibling of a capped child returns its own successful result (AC 2) - `siblings of a capped parallel child finish`, same file
- With only settings carrying the value, the child is terminated at it (AC 3) - `caps a child at the settings maxRuntimeMs`, same file, through the executor's `resolveConfig`
- With settings and call-time both set, the child is terminated at the call-time value and the error names it (AC 4) - `call-time maxRuntimeMs beats settings`, same file
- A child that ignores SIGTERM is killed after the cap (abort escalation): `runSync` resolves with a non-zero exit after the 3 s escalation and well before the mock's much longer remaining script would finish - `SIGKILLs a capped child that ignores SIGTERM`, same file, using `ignoreSigterm`; skipped on win32
- A child that exits on SIGTERM while a descendant holds its stdout open past 3000 ms: the follow-up raises no uncaught exception and `runSync` settles as that abort does today - `does not signal an exited child whose stdio is still open`, same file; skipped on win32
- External attempt returned as interrupted after the cap becomes exit 1 with the cap error, `interrupted` unset, placeholder output cleared, owner diagnostic appended, and `finish("retained")` called (AC 8) - `rewrites an external interrupted attempt to a maxRuntimeMs failure` in `test/unit/foreground-execution-routing.test.ts`, with injected `createExternalOwner` and `runExternalAttempt`
- External attempt that throws an interrupted error after the cap becomes the same failure (AC 8) - `rewrites a thrown external interruption to a maxRuntimeMs failure`, same file
- External startup failure after the cap becomes the cap failure with no attempt run - `rewrites an external startup failure to a maxRuntimeMs failure`, same file
- The cap fires while a failing attempt settles: that attempt's result is rewritten and no fallback attempt follows - `does not try a fallback model after the cap`, same file
- Backend selection still pending at the cap returns the cap failure; no owner is created and no attempt runs - `returns a maxRuntimeMs failure when backend selection outlives the cap`, same file, with an injected `selectBackend` that never settles
- Backend selection that rejects after the cap returns the cap failure, not the selection error, and raises no unhandled rejection - `drops a backend selection rejection that arrives after the cap`, same file
- A retryable first-attempt failure before the deadline starts a second attempt; that attempt's signal is not aborted one tick before the original deadline and is aborted at it - `keeps the original deadline across a fallback attempt`, same file, deterministic clock
- The signal is not aborted one tick before, and is aborted at, 14400000 ms (AC 5) - `aborts at the default maxRuntimeMs and not before`, same file, deterministic clock
- The same at 3000000000 ms, re-arming across the 2147483647 ms chunk (AC 6, chunked timer) - `re-arms across the 32-bit timer limit and aborts at maxRuntimeMs`, same file, deterministic clock
- With the mocked `Date` moved back one hour mid-run, the abort still comes at the monotonic deadline - `a wall-clock change does not move the cap deadline`, same file, deterministic clock
- A `controlConfig` literal without `maxRuntimeMs` gets the 14400000 default - `uses the default maxRuntimeMs for a controlConfig without the field`, same file, deterministic clock
- A caller abort before the cap is not relabeled - `leaves a caller abort before the cap unchanged`, same file
- A stop by index before the cap is not relabeled - `leaves an interrupt before the cap unchanged`, same file
- The helper keeps a result returned clean after the cap has fired - `keeps a clean success when the cap has fired`, same file. This is a rewrite test with an injected attempt; it does not exercise the external completion race, which finalizes as interrupted and is a cap failure by design
- An async child that runs past the cap completes (AC 9) - `async child is not capped by maxRuntimeMs` in `test/integration/top-level-async.test.ts`
- Termination at exactly 14400000 ms, and a run past 4 h under a larger call-time value, in real time (AC 5, AC 6) - none: a 4 h run is not runnable in a test; the deterministic-clock tests above drive the real `runSync` clock to those deadlines, and the integration tests cover a real child with short values
- The documentation lists `maxRuntimeMs`, the default, and the scope (AC 10) - none: documentation text, checked by the conformance review against `### Documentation and skill files`

The integration tests follow the silence-kill tests in the same file (`test/integration/foreground-in-flight-control.test.ts:353-400`), which the Reporter note names as the template, with caps of a few hundred milliseconds and mock children that emit events throughout.

The deterministic-clock unit tests inject `runNativeAttempt` and observe the signal it receives. They advance timers with the test runner's timer mocking, `t.mock.timers.enable({ apis: ["setTimeout"] })`, as `test/unit/close-grace-timer.test.ts:34` does, and advance elapsed time through the injected `monotonicNow`. The runner's timer mocking covers `setInterval`, `setTimeout`, `setImmediate`, and `Date` (`node_modules/@types/node/test.d.ts:2285`), not `performance.now()`, which is why the monotonic source is injected. No test waits in real time for hours.

## Documentation impact

Per `reference/documentation-impact.md`:

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/configuration.md` (operations / tunable parameters: the new setting, its default, its scope, and that `enabled: false` does not disable it); `doc/programmatic-api.md` (operations / tunable parameters: the call-time field and the failure it produces); `CHANGELOG.md` (operations / tunable parameters: a default that changes existing foreground runs, and the abort escalation fix)
- Derived / memory docs invalidated: none

## Out of scope

- A `timed_out` status. A cap kill is an ordinary failure, so existing retry handling works unchanged (ticket).
- Per-task and per-persona caps. A dispatch that needs a tighter limit passes its own `control` block (ticket).
- Async (background) runs (ticket).
- Partial `output:` files. Handling for a failed run stays as it is (ticket).
- A tighter cap on pi-gauntlet's spec-council dispatch; a separate pi-gauntlet ticket (ticket).
- A control event or notice for the cap.
- Any change to the silence kill, its `enabled` gate, or its clamp.
- The stop-by-index path (`interruptSignal`), which sends SIGINT then SIGTERM with no SIGKILL follow-up.
- Field-level merging of `control` between settings levels.
- A way to disable the cap other than a very large value.

## Open questions

- The Reporter note's run sample cannot be reproduced from the repo; the 4 h default rests on the ticket's figures as stated.
- Issue #62 has a worktree from the same base that touches foreground interruption and result handling in the same files. Whichever lands second rebases; no design dependency exists between them.
