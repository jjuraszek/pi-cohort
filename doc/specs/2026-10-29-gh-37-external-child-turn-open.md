# External child turn-open: synthesize `message_start` in the session replay

**Ticket:** [jjuraszek/pi-cohort#37](https://github.com/jjuraszek/pi-cohort/issues/37)
**Goal:** An async child on an external execution backend is no longer flagged `needs_attention` while one tool call outlasts the 60s idle threshold; its session replay tells the shared lifecycle that a turn is open, exactly as the native child's event stream does.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Predecessors:** `doc/specs/2026-06-16-in-flight-turn-activity-state.md` (turn-open contract, reused unchanged); `doc/specs/2026-09-06-mux-execution-backends.md` (session replay; this closes a gap in its synthesized event vocabulary). Neither is superseded.

## Problem

With an execution backend registered (the issue names pi-cohort 7.6.1 with the cmux backend from pi-cohort-mux), an async child whose tool call runs longer than `needsAttentionAfterMs` (default 60000 ms) is flagged `needs_attention`, and the step stays flagged until it ends. The same child on the native backend is left alone and only gets the calm `active_long_running` notice at the 240000 ms `activeNoticeAfterMs` trigger.

Cause: the background runner learns what an external child did by replaying its session file entry by entry. `synthesizeChildEvents` (`src/runs/background/external-attempt.ts:118-138`) turns an `assistant` entry into one `tool_execution_start` per tool call followed by `message_end`, and a `toolResult` entry into `tool_execution_end` plus `tool_result_end`. It never emits `message_start` or `turn_start`. The shared reducer `applyChildEventToLifecycle` (`src/runs/shared/subagent-control.ts:92-112`) opens a turn only on those two events, so `step.turnOpen` stays `false` for the whole run, and `deriveActivityState` (`:115-133`) reads any gap over the idle threshold with no new entry and no output written as `needs_attention` instead of `active_long_running`. The native child's JSON stream forwards pi's own `message_start` before each assistant message, which is why that path behaves.

The issue's scenario is a source-read trace, not an executed run (`source: none (not recorded at filing)`); `cmux` is not installed on the authoring machine, so no live reproduction backs this spec. The 2026-06-16 in-flight spec accepts reducer/composition unit coverage for the detached background watchdog because `updateRunnerActivityState` is a private closure and a spawn-based timing assertion is flaky.

Framing: kept - the scout objected that the runner never publishes `active_long_running` at 60s because it routes the reducer's calm result through `maybeEmitActiveLongRunning`, which fires at the 240000 ms time trigger (`src/runs/background/subagent-runner.ts:1554-1570,1699-1745`; `src/runs/shared/long-running-guard.ts:117-121`). That is the native child's behavior too, and the issue's Problem already states "after 4 minutes", so matching native is exactly what the one-event fix delivers; the objection yields no alternative.

Not checkable during gather: the live cmux repro (no `cmux` binary, no live session) and the docs spec index (readonly database; the two covering docs were found by recon). Neither changes the design.

## Acceptance criteria

Ticket #37, Acceptance Criteria, rows verbatim:

- [ ] `synthesizeChildEvents` (src/runs/background/external-attempt.ts) emits `{ type: "message_start" }` before the `tool_execution_start` and `message_end` events it derives from an assistant session entry; the existing "synthesizes tool_execution_start + message_end from assistant messages" unit test in test/unit/background-external-attempt.test.ts asserts the new sequence.
  in-scope
- [ ] A unit test feeds the synthesized sequence for an assistant entry with one tool call through `applyChildEventToLifecycle`, then calls `deriveActivityState` with default control and a `now` where `needsAttentionAfterMs < elapsed <= inFlightSilenceCeilingMs` since the last event, and expects `active_long_running`, not `needs_attention`.
  in-scope
- [ ] From that same open-turn state (no further events), `deriveActivityState` with a `now` more than `inFlightSilenceCeilingMs` past the last event expects `needs_attention` (the ceiling still re-escalates inside the open turn).
  in-scope
- [ ] The sequence continued with a tool-result entry, a final assistant entry without tool calls, and a `now` more than `needsAttentionAfterMs` past that last event expects `needs_attention` (the turn closes on a message end without tool calls).
  in-scope
- [ ] `CHANGELOG.md` `## [Unreleased]` carries an entry for this fix referencing (#37).
  in-scope

## Design

Approach chosen: synthesize the turn-open fact in the external replay adapter, where the omission lives. Rejected: opening the turn on `tool_execution_start` inside the shared reducer (widens the 2026-06-16 spec's locked turn definition for both backends to fix one adapter); a `turnOpen` flag on `SynthesizedChildEvent` (a second channel beside the event-type contract the runner already reads at `subagent-runner.ts:1682-1694`).

**Change.** In `synthesizeChildEvents`, the `assistant` branch calls `emit({ type: "message_start" })` first, then the existing per-tool-call `tool_execution_start` events, then the existing `message_end` carrying `message`. The `toolResult` branch and every other entry kind are unchanged. No type change: `SynthesizedChildEvent.type` (`external-attempt.ts:30`) is already `type?: string`, as is the runner's `ChildEvent.type`, so the new event type needs no declaration edit. No `turn_start` is emitted: the 2026-06-16 spec derives turn-open from `message_start`/`message_end` alone and treats `turn_*` as belt-and-suspenders, and the reducer handles both identically.

**Data flow for one tool call.** Assistant entry written -> `message_start` (reducer sets `turnOpen: true`, no productive refresh) -> `tool_execution_start` (productive signal) -> `message_end` with tool-call content (runner derives `hasToolCall: true` from `message.content`, turn stays open) -> tool runs with no new entry -> `updateRunnerActivityState` ticks each second: `deriveActivityState` sees an open turn, so for silence in `(needsAttentionAfterMs, inFlightSilenceCeilingMs]` it returns `active_long_running`, which the runner routes to `maybeEmitActiveLongRunning` and publishes at the 240000 ms trigger as on native -> `toolResult` entry -> next assistant entry -> ... -> final assistant entry without tool calls: `message_start` then `message_end` with `hasToolCall: false`, turn closes in the same batch -> ordinary idle escalation resumes. The reducer state is only `{ turnOpen, lastProductiveSignalAt }`; the runner sets `step.lastActivityAt = now` on every child event (`subagent-runner.ts:1693`) and the watchdog passes it to `deriveActivityState`, which otherwise falls back to `startedAt`. Silence past `inFlightSilenceCeilingMs` (600000 ms) inside the open turn still returns `needs_attention`. The background runner has no in-flight silence kill (`doc/programmatic-api.md` documents `inFlightSilenceKillMs` as foreground-only) and gains none.

**Responsibilities.** The external adapter owns "what the child's session says happened"; the shared reducer owns "is a turn open"; the runner owns publication. Only the first changes.

**Workflow artifacts.** AC row 5 is satisfied by a `## [Unreleased]` entry in `CHANGELOG.md` referencing `(#37)`, added in the implementation commit; `CHANGELOG.md` currently has no `## [Unreleased]` heading, so the entry creates it above the latest release section in the file's existing format.

**pi-gauntlet non-regression (checked against `../pi-gauntlet` at 7.40.0).** pi-gauntlet's only contact with this area is the `control` block it passes on `subagent()` (`needsAttentionAfterMs`, `inFlightSilenceCeilingMs`, `inFlightSilenceKillMs`, asserted by `scripts/brainstorming-contract.test.mjs:265`) and the foreground kill diagnostic "Likely wedged in a tool call" it quotes in coverage lines. It registers no execution backend and names no child event type. This change runs only inside `synthesizeChildEvents`, which executes only when a backend is registered and only on the background path; the native subprocess stream, the foreground path, the control schema, and the diagnostic text are untouched. In the background runner, `message_start` has no consumer other than `applyChildEventToLifecycle` (the other branches key on `tool_execution_*`, `tool_result_end`, `message_end`), so the new event changes `turnOpen` and the activity timestamps and nothing else.

Remove: none.
Add: one `emit({ type: "message_start" })` call in `synthesizeChildEvents` (`src/runs/background/external-attempt.ts`); extended assertion in the existing assistant-sequence test plus one no-tool-call case in `test/unit/background-external-attempt.test.ts`; a `describe("external replay composition")` block in `test/unit/background-external-attempt.test.ts` that captures the adapter's real synthesized events through `runExternalBackgroundAttempt` with the file's existing fake owner and captured `onNewSessionMessage` callback, reproduces the runner's `hasToolCall` derivation, and reduces them with `applyChildEventToLifecycle` / `deriveActivityState` imported from `src/runs/shared/subagent-control.ts`; `## [Unreleased]` entry in `CHANGELOG.md`. No synthesizer export is needed.

## Errors and edge cases

- `onChildEvent` absent (`runExternalBackgroundAttempt` called without it): nothing is synthesized, as today. The emit is synchronous and introduces no throw of its own; a throwing callback already propagates from the existing emits and keeps that behavior.
- Assistant entry with no tool calls (the final answer): `message_start` then `message_end` with `hasToolCall: false`; the turn opens and closes in one batch, `lastActivityAt` advances, `turnOpen` ends `false`. Same as native.
- Assistant entry with several tool calls: one `message_start`, N `tool_execution_start`, one `message_end`; the turn stays open through all of them.
- Entry that is neither `assistant` nor `toolResult` (user, system, custom): unchanged, nothing emitted.
- Step already latched `needs_attention` before the first assistant entry lands stays latched: `updateRunnerActivityState` never clears the flag while a step runs. Out of scope (below).
- Parallel-group external steps: each step carries its own `turnOpen`; the emit is per attempt, no cross-step state.

## Tests

- Synthesized sequence for an assistant entry with one tool call is `message_start, tool_execution_start, message_end` - existing "synthesizes tool_execution_start + message_end from assistant messages via onChildEvent" in `test/unit/background-external-attempt.test.ts`, assertion extended.
- An assistant entry without tool calls synthesizes `message_start, message_end` - new case in `test/unit/background-external-attempt.test.ts`.
- `toolResult` entries still synthesize `tool_execution_end, tool_result_end` only - existing tool-result case in `test/unit/background-external-attempt.test.ts`, unchanged.
- Composition provenance: `describe("external replay composition")` in `test/unit/background-external-attempt.test.ts` obtains the synthesized sequence from the adapter itself - it calls `runExternalBackgroundAttempt` with the file's existing fake `ExternalExecution` owner, captures `request.onNewSessionMessage`, feeds session entries through it, and records every `onChildEvent` event including its `message` payload. It then reduces those events with `applyChildEventToLifecycle`, deriving `hasToolCall` from `message.content` exactly as `subagent-runner.ts:1682-1694` does (reproduced inline), and assigns each reduced event a timestamp. No hand-written event literals and no synthesizer export.
- Each composition row passes `lastActivityAt` equal to the timestamp of the last reduced event, mirroring `step.lastActivityAt = now` at `subagent-runner.ts:1693`, and measures the idle and ceiling intervals from that timestamp, not from `startedAt`.
- Captured sequence for an assistant entry with one tool call through `applyChildEventToLifecycle`, then `deriveActivityState` with default control and `now` in `(60000, 600000]` ms past `lastActivityAt` returns `active_long_running` - same describe. This row is the payload-loss guard: a bare `{ type: "message_end" }` without `message` derives `hasToolCall: false` and closes the turn, so a regression that stops carrying `message` on the synthesized `message_end` fails here with `needs_attention`.
- Same open-turn state, `now` past 600000 ms, returns `needs_attention` - same describe.
- Sequence continued with a `toolResult` entry, a final no-tool assistant entry, and `now` more than 60000 ms past that entry's `lastActivityAt` returns `needs_attention` - same describe. This row checks final-turn closure only; it cannot detect a missing payload because a final text message and a bare `message_end` both derive `hasToolCall: false`.
- Runner publishes the calm notice at 240000 ms for an external child - none: the background watchdog is a private closure in the detached runner and the 2026-06-16 spec rejects spawn-timing tests; proof level is reducer plus composition.
- pi-gauntlet non-regression - none: no code path in `../pi-gauntlet` consumes child event types; verified by recon and recorded in Design as a non-goal.
- Live cmux repro - none: no `cmux` on this machine; the ticket records `source: none`.

Run: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts`, then `env -u PI_CODING_AGENT_DIR npm run test:unit`.

## Documentation impact

Per `reference/documentation-impact.md`:

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - the implementation commit creates `## [Unreleased]` above `## [7.6.3]` and adds the fix entry referencing `(#37)` (AC row 5). `doc/programmatic-api.md` (Control configuration) and `README.md` (Execution backend extension API) need no change: they describe the control contract this fix restores, not a changed one, and neither mentions per-backend event synthesis.
- Derived / memory docs invalidated: none

## Out of scope

- First-turn blind spot: silence before the first assistant entry lands still derives `needs_attention` after the idle threshold, because the replay is entry-granular and a synthesized turn can only open once an entry is written. Inferred from the code path, not observed; separate ticket if it shows up.
- Foreground external attempts (`async: false` on an external backend) run no activity watchdog at all: `runExternalSingleAttempt` (`src/runs/foreground/external-single-attempt.ts`) forwards no session entries and the foreground watchdog lives inside the native attempt path only. Separate ticket, named in the issue.
- Sticky `needs_attention` recovery and notice deduplication (`claimControlNotification`, once per step) are unchanged.
- A background in-flight silence kill: none exists and none is added.
- Raising idle thresholds: `control.needsAttentionAfterMs` per dispatch delays the false alarm and is not the fix.

## Open questions

none
