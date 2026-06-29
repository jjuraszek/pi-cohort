# Foreground wall-clock kill-cap: SIGTERM a child wedged in unbounded in-flight silence

## Context

A foreground subagent dispatch can block the orchestrator indefinitely when the
child wedges **inside a tool call**. Observed in a real `gridstrong-dashboard`
session (`019f0f86-...`): a `code-reviewer` child fired two parallel `bash`
calls that each booted the full Rails env (`require_relative
'config/environment'`); neither tool result ever returned. The child's last
productive signal was `20:00:08Z`; the parent's tool result did not land until
`21:42:09Z` - **~102 minutes** blocked - and only because an *external* SIGTERM
finally arrived (`exitCode 143`, `finalOutput: ""`, acceptance `rejected`).

The orchestrator was running the `subagent-driven-development` flow from
`pi-superpowers`, which dispatches reviews **synchronously and gated** by design
(see [Why sync is correct](#why-sync-is-correct)). Sync is right. The defect is
that sync has **no upper bound** on how long it will block for a child that has
gone silent.

### Why nothing caught it (verified against code)

The subagent control system already *detected* the wedge. The run's
`controlEvents` show `active_long_running` at +240s (`activeNoticeAfterMs`) and
`needs_attention` at +600s of in-flight silence (`inFlightSilenceCeilingMs`).
The `2026-06-16-in-flight-turn-activity-state` change is what classifies this:
the child's `message_start` opened a turn (`turnOpen = true`), the wedged tool
call produced no `message_update` / `tool_result_end`, so
`lastProductiveSignalAt` froze and `deriveActivityState`
(`src/runs/shared/subagent-control.ts:108-123`) returned `needs_attention` with
`silenceMs` climbing past the ceiling.

But the control system is **notify-only**. The activity `setInterval`
(`src/runs/foreground/execution.ts:561-569`, 1 s tick) kept re-evaluating that
growing silence and had nothing to do but re-notify. The one auto-SIGTERM path
in `runSync`, `startFinalDrain` (`execution.ts:287-303`), arms **only after** a
clean terminal assistant stop (`cleanTerminalAssistantStopReceived`); a child
stuck mid-tool emits no terminal stop, so the drain never schedules. The only
other termination routes are `options.signal` / `options.interruptSignal`
(`execution.ts:622-659`) - both **external**. So the detector classified the
hang correctly and then could not act on it; the only escape hatch was a human.

This spec adds the **enforcement arm**: a wall-clock cap, keyed on the same
in-flight-silence signal the detector already computes, that SIGTERMs the wedged
child so `runSync` settles with a terminal, attributable failure result the
orchestrator's existing failure ladder can consume.

## Why sync is correct

`pi-superpowers`' `subagent-driven-development` makes the orchestrator a
strictly **sequential gated pipeline**: dispatch -> block on the child's
structured return -> decide (re-dispatch / spec-review / integrate / test-gate /
quality-gate / commit). Every decision consumes the *complete* prior result, and
the "When a Subagent Fails" ladder (attempt 1, attempt 2 with feedback, then
stop and surface) assumes the child **returns** - including on error. Flipping
to async does not help: the orchestrator has nothing to do until the result
exists, so async merely relocates the same block while losing the gate's
sequencing guarantees. Sync stays. The fix belongs in the executor that owns the
blocking wait - `runSync` in `src/runs/foreground/execution.ts` - which also
backs foreground single, parallel-wave, and chain dispatches (all route through
`runSync`: `subagent-executor.ts:1499,2077`, `chain-execution.ts:265,1050`).

## Decisions (locked with user)

- **Signal-based, not absolute (option A).** The cap measures **silence since
  last productive signal during an in-flight turn**, reusing
  `deriveActivityState`'s existing `lastProductiveSignalAt` baseline - not a flat
  wall-clock-from-start deadline. A child that keeps streaming `message_update`s
  or emitting tool events refreshes `lastProductiveSignalAt` and is never killed,
  however long it legitimately runs (big test suites, large worktree installs).
  Only true zero-output silence is bounded - exactly the `code-reviewer`
  signature. An absolute `maxRunMs` was rejected: it kills demonstrably-alive
  long children on a dumb timer.
- **Gated on `control.enabled` (option C).** The kill is the enforcement arm of
  the same attention system that detects the wedge, so it shares that system's
  on/off gate. When `control.enabled` is true (the default), the cap is armed and
  ships protective out of the box; when control tracking is disabled, no kill.
  No separate enable flag.
- **Default ceiling `1_800_000 ms` (30 min).** `3x` the `inFlightSilenceCeilingMs`
  default (600_000 / 10 min), which is the `needs_attention` trigger for
  in-flight silence. Rationale: the kill must sit strictly **above** the
  `needs_attention` escalation so the human-visible warning always fires first
  and a human still has a window to intervene before the automatic kill; 30 min
  of *zero observable output* is decisively a wedge, not slow thinking (the
  longest legit TTFT measured in the prior spec was 506 s). The session that
  motivated this would have been killed at +30 min instead of +102 min.
- **Floor under the configured ceiling.** Because the kill is meaningless unless
  it sits above `needs_attention`, the resolved kill ceiling is clamped to
  `max(configured, inFlightSilenceCeilingMs + needsAttentionAfterMs)`. A
  misconfiguration that sets the kill ceiling below the silence ceiling cannot
  invert the ordering and kill a run the warning has not even flagged yet.
- **Reuse the existing SIGTERM -> SIGKILL grace mechanism.** No new termination
  primitive. The kill path reuses `trySignalChild(proc, "SIGTERM")` followed by a
  `HARD_KILL_MS` (3000 ms) SIGKILL fallback, mirroring `startFinalDrain`. The
  child settles through the existing `proc.on("close")` handler with a non-zero
  exit code (143 for SIGTERM).
- **Terminal result is an attributable failure, not an interrupt.** The killed
  run resolves with `result.error` naming the cap and the silence duration, a
  non-zero `exitCode`, and `acceptance` rejected (no structured report) - it must
  flow into the failure ladder, **not** the `interruptedByControl` path
  (`execution.ts:649`) which resets `exitCode` to 0 and marks `interrupted`.
- **Foreground only.** Async/background (`src/runs/background/subagent-runner.ts`)
  has its own watchdog, its own SIGTERM machinery (`subagent-runner.ts:383-408`),
  and external `subagent interrupt` / `status` remedies; it does not block the
  orchestrator. Extending the cap there is **out of scope**.

## Design

### 1. Config: new `inFlightSilenceKillMs` knob

Add a single optional control field, plumbed identically to its siblings.

- `src/shared/types.ts`: add `inFlightSilenceKillMs?: number` to `ControlConfig`
  (line 101) and `inFlightSilenceKillMs: number` to `ResolvedControlConfig`
  (line 113).
- `src/runs/shared/subagent-control.ts`:
  - `DEFAULT_CONTROL_CONFIG.inFlightSilenceKillMs = 1_800_000` (line 14).
  - In `resolveControlConfig` (line 38), resolve via the existing
    `parsePositiveInt` precedence (`override ?? global ?? default`), exactly like
    `inFlightSilenceCeilingMs` (lines 49-51), then **clamp**:
    `inFlightSilenceKillMs = max(resolved, inFlightSilenceCeilingMs +
    needsAttentionAfterMs)`. The clamp uses the already-resolved sibling values so
    a per-call override of either field is respected.
- `src/extension/schemas.ts`: add to `ControlOverrides` (line 221) as
  `inFlightSilenceKillMs: Type.Optional(Type.Integer({ minimum: 1, description:
  "Hard cap: SIGTERM a child whose in-flight turn has been silent this long
  (default: 1800000; clamped to sit above the needs_attention escalation)" }))`.
  Without the schema entry a per-call override is dropped at tool-call validation
  before `resolveControlConfig` sees it.

### 2. Kill trigger in the activity timer

The kill decision lives in `runSync`'s activity loop, which already runs only
when `controlConfig.enabled` (the option-C gate) and already computes the
in-flight-silence state every second.

`deriveActivityState` is **not** modified - its three-value contract
(`undefined` / `active_long_running` / `needs_attention`) is consumed unchanged
by both foreground and background callers, and the kill is a foreground-only
caller-side action.

**The trip predicate is an exported pure helper.** Extract
`shouldSilenceKill` into `src/runs/shared/subagent-control.ts` alongside
`deriveActivityState` so it is unit-testable without a child process:

```
export function shouldSilenceKill(input: {
  turnOpen?: boolean;
  lastProductiveSignalAt?: number;
  startedAt: number;
  now: number;
  killMs: number;
}): boolean {
  if (!input.turnOpen) return false;
  const silenceMs = input.now - (input.lastProductiveSignalAt ?? input.startedAt);
  return silenceMs > input.killMs;
}
```

**`updateActivityState` must be refactored, not just appended to.** Its current
`needs_attention` branch early-returns
(`return progress.activityState === "needs_attention" ? false :
emitNeedsAttention(now)`, `execution.ts:403-404`). Because the resolved `killMs`
is always `> inFlightSilenceCeilingMs`, the kill can only trip while
`idleState === "needs_attention"` - so a kill check placed *after* that branch
is **unreachable**. Refactor to capture the emitted-flag first, then always
evaluate the kill check before returning, including on ticks where the run was
already in `needs_attention`:

```
// inside updateActivityState(now), control already enabled
if (idleState === "needs_attention") {
  const notified = progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
  if (shouldSilenceKill({
    turnOpen: progress.turnOpen,
    lastProductiveSignalAt: progress.lastProductiveSignalAt,
    startedAt: startTime,
    now,
    killMs: controlConfig.inFlightSilenceKillMs,
  })) {
    requestSilenceKill(now, now - (progress.lastProductiveSignalAt ?? startTime));
  }
  return notified;
}
```

The guard is `progress.turnOpen` (a turn is open) plus
`silenceMs > inFlightSilenceKillMs`. Because the resolved `killMs` is clamped
above `inFlightSilenceCeilingMs + needsAttentionAfterMs`, by the time it trips
the run has already transitioned to `needs_attention` for at least
`needsAttentionAfterMs`. The `progress.activityState = "needs_attention"`
transition (set inside `emitNeedsAttention` before `emitControlEvent`) therefore
always precedes the kill; the *notice* emission itself is subject to `notifyOn`
(a run with `notifyOn: []` transitions state and is killed but emits no
user-visible notice). Under default config the notice always precedes the kill.
A genuinely-idle run
with **no** open turn (`turnOpen` false) is *not* killed - that path stays a
notify-only `needs_attention`, since an idle-but-not-in-a-turn child is between
turns (e.g. awaiting the parent), not wedged mid-production.

### 3. `requestSilenceKill`

A new closure in `runSync`, alongside `startFinalDrain`, idempotent and
no-op once the run is settling:

```
let silenceKillRequested = false;
const requestSilenceKill = (now: number, silenceMs: number) => {
  if (silenceKillRequested || childExited || settled || processClosed || detached) return;
  silenceKillRequested = true;
  const termSent = trySignalChild(proc, "SIGTERM");
  if (!termSent) return;
  forcedTerminationSignal = true;
  result.error = result.error ??
    `Subagent killed: in-flight turn produced no output for ${Math.round(silenceMs / 1000)}s ` +
    `(exceeded inFlightSilenceKillMs=${controlConfig.inFlightSilenceKillMs}ms). Likely wedged in a tool call.`;
  setTimeout(() => {
    if (settled || processClosed || detached) return;
    forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
  }, HARD_KILL_MS).unref?.();
};
```

It reuses the existing `forcedTerminationSignal` flag and `HARD_KILL_MS`
constant. Setting `forcedTerminationSignal = true` (without
`cleanTerminalAssistantStopReceived`) makes the existing `proc.on("close")`
handler (`execution.ts:601-607`) compute a non-zero `finalCode`
(`forcedTerminationSignal ... ? (code ?? 1) : ...`) and preserve `result.error`
- so the run settles as a failure, **not** a clean exit and **not** an
interrupt. No change to the close handler is required.

### 4. Terminal result shape

The killed run produces a `SingleResult` with:

- `error` = the silence-kill message from S3 (names the cap + silence seconds).
- `exitCode` = non-zero (**typically 1**, not 143). Node delivers `code=null,
  signal="SIGTERM"` for a signal-terminated child, so the unchanged close handler
  (`forcedTerminationSignal || signal ? (code ?? 1) : ...`, `execution.ts:606`)
  computes `code ?? 1 = 1`. The orchestrator only needs non-zero; no close-handler
  change is made. Tests assert `exitCode !== 0`, never `=== 143`.
- `interrupted` unset (this is **not** the `interruptedByControl` path).
- `acceptance` rejected with the existing "Structured acceptance report not
  found" attestation - a killed child never emits a report.
- A final `needs_attention` control event already in `controlEvents` (emitted by
  the prior tick), now followed by the actual termination.

This matches what the orchestrator's "When a Subagent Fails" ladder already
expects from a failed dispatch: a returned result carrying an error, which it
re-dispatches (attempt 2 with feedback) or surfaces and stops on. The 102-minute
block becomes a ~30-minute bounded failure.

### 5. Notice emission

No new event type, notice copy, channel, or dedup key. The `needs_attention`
notice that precedes the kill is the existing one. The kill itself is reflected
in the terminal `result.error` and non-zero `exitCode`; it does not emit a new
control-event type. (A dedicated `killed` event type was considered and rejected
as YAGNI - the error string + exit code are sufficient for the orchestrator and
for log forensics, and adding an event type would touch `notifyOn`, schema, and
notice-rendering for no consumer benefit.)

## Edge cases

- **SIGTERM ignored.** The `HARD_KILL_MS` SIGKILL fallback handles a child that
  traps or ignores SIGTERM, identical to `startFinalDrain`.
- **Kill races a real result.** All `settled` / `processClosed` / `childExited`
  guards short-circuit `requestSilenceKill`; if the child's tool result lands in
  the same tick window, the close/finish path wins and the kill is a no-op.
- **Detached for intercom.** `detached` guards the kill, so an intercom-detached
  run (which intentionally outlives the foreground wait) is never killed by this
  path.
- **Streaming-but-slow turn.** Refreshes `lastProductiveSignalAt` every
  `message_update`, so `silenceMs` stays small and the kill never trips - the
  whole point of the signal-based design.
- **`control.enabled = false`.** The activity timer is never created
  (`execution.ts:560`), so no kill - the option-C gate.
- **Misconfigured kill ceiling below silence ceiling.** The S1 clamp raises it
  above `inFlightSilenceCeilingMs + needsAttentionAfterMs`; the kill can never
  fire before the warning.

## Testing

- **Unit (`resolveControlConfig`)** - extend `test/unit/subagent-control.test.ts`:
  - default applies `inFlightSilenceKillMs = 1_800_000`.
  - per-call override resolves through `parsePositiveInt` precedence.
  - clamp: a configured kill ceiling below `inFlightSilenceCeilingMs +
    needsAttentionAfterMs` is raised to that floor; a configured value above it
    is preserved.
  - `ControlOverrides` schema accepts the field (mirror the sibling field's
    schema test if one exists).
- **Unit (kill-decision predicate)** - test the exported `shouldSilenceKill`
  helper (S2, in `src/runs/shared/subagent-control.ts`) directly: asserts
  `turnOpen=false` never trips; `turnOpen=true` with `silenceMs <= killMs` does
  not trip; `silenceMs > killMs` trips; missing `lastProductiveSignalAt` falls
  back to `startedAt`.
- **Integration (foreground)** - drive `runSync` against a stub child that opens
  a turn (`message_start`) then goes silent, with small per-call control
  overrides (`needsAttentionAfterMs`, `inFlightSilenceCeilingMs`,
  `inFlightSilenceKillMs` in the hundreds-of-ms range, matching the existing
  small-threshold convention). Assert: a `needs_attention` control event is
  emitted first, then the child is SIGTERM'd, and the settled `SingleResult` has
  a non-zero `exitCode` (assert `!== 0`, not a specific code), `result.error`
  naming the cap, and `interrupted` unset. Assert the converse: a stub child that keeps emitting `message_update`s past
  the kill ceiling is **not** killed and settles normally.

## Documentation impact

- `README.md` - control knobs table (around line 884-887): add one
  `inFlightSilenceKillMs` row (default 1800000 / 30 min) stating it SIGTERMs a
  child whose in-flight turn has been silent past the cap, that it is clamped to
  sit above the `needs_attention` escalation, and that it is gated on
  `control.enabled`. Add `inFlightSilenceKillMs` to the `control` per-run
  override row's supported-field list (line 870).
- `CHANGELOG.md` - one entry under the next version: foreground wall-clock
  kill-cap for in-flight-silent children.
- No `AGENTS.md` change: the "Behaviors we own" table covers discovery/overrides,
  not control internals.

## Out of scope

- Async/background watchdog kill (`subagent-runner.ts`) - separate executor with
  existing remedies.
- Any absolute run-duration cap (`maxRunMs`) - explicitly rejected in Decisions.
- A new `killed` control-event type - rejected as YAGNI.
- Changes to `deriveActivityState`'s return contract - the kill is caller-side.
- `pi-superpowers` skill edits (e.g. bounding the reviewer's `bash` calls or
  flipping the review to async) - mitigations tracked separately; this spec fixes
  the harness gap.
