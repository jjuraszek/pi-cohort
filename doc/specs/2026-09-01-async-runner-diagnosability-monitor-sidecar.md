# Async runner diagnosability + monitor sidecar

## Problem

Session evidence (gridstrong-excavation, 2026-09-01): a user asked for an async
monitor of a multi-hour build with 15m reports. 4/4 async dispatches - including a
trivial `echo async-smoke-ok` - died in ~1s with
`Async runner process <pid> exited or disappeared before writing a result` and run
directories containing **no files at all**. The agent concluded "async infra is
broken on this host today" and fell back to a hand-rolled `nohup` shell loop the
user then had to poll manually.

Two defects compound:

1. **Silent runner death.** `spawnRunner()` (`src/runs/background/async-execution.ts`)
   launches the detached runner with `stdio: "ignore"` and no log file. Any death
   before the runner writes `status.json` (jiti resolution failure, module-not-found,
   config parse crash) leaves zero trace. `jitiCliPath` is resolved once at module
   load (`async-execution.ts:65-91`) and never revalidated; a `node_modules` change
   mid-session makes every spawn instantly fatal - invisibly.
2. **No natural monitoring shape.** Nothing in pi-cohort makes "async job + periodic
   monitor" the default pattern for long-running work. The agent hand-rolled sleep
   loops, and even that required the user to prompt for it.

This spec is one feature - "long-running work runs async with a monitoring sidecar" -
with a hard sequential dependency: part 1 (diagnosability bug fix) is prerequisite
grunt work, because a monitor persona is worthless while async runs can die silently.

## Constraints (all hard)

- The `subagent` tool schema must not grow. All monitor semantics live in persona
  body/frontmatter and skill prose, dispatched via existing params only.
- No new dependency. pi-intercom and pi-messenger are pattern inspiration only
  (see Prior art below).
- No file written under any git-managed path. `runner.log` lives in the async run
  dir; the monitor's trail file lives in the monitor's own run dir - both under
  pi-cohort's temp root (`TEMP_ROOT_DIR`, `src/shared/types.ts:929-976`), never the
  workspace. The persona states this as an imperative.
- Persona and skill prose: dense, imperative, workable by a smaller model, minimal
  conditionality. Shortest text that expresses the intent.

## Part 1 - make async runner death diagnosable (runtime code)

Sequenced first; part 2 must not land without it.

### 1.1 `runner.log` capture (parent-held fd)

`spawnRunner()` (`src/runs/background/async-execution.ts:181-214`) gains an explicit
`asyncDir` parameter - both call sites already hold the resolved async run dir when
they spawn (`cfg` is typed `object`, and the current `cwd` param is the workspace,
which must never receive the log):

- Before spawn: `openSync(join(asyncDir, "runner.log"), "a")`.
- Spawn with `stdio: ["ignore", fd, fd]` instead of `stdio: "ignore"`. Detached +
  `unref()` + `windowsHide` unchanged; fd inheritance survives `unref()` and works
  cross-platform.
- The parent closes its fd copy in a `finally` that covers all exit paths -
  spawn-throw, the existing missing-`proc.pid` early return, and success after
  `unref()`. A parent-side close failure never misreports an already-launched child
  as unstarted. The child keeps its inherited copy for its lifetime.
- Every pre-`status.json` death - jiti failure, module-not-found, config crash, the
  runner's top-level `console.error` handlers (`subagent-runner.ts:2296-2331`) - now
  leaves its stack in `runner.log`.
- **Fallback:** if the fd open fails (run dir vanished, permissions), warn once via
  `console.error` with the existing `[pi-cohort]` prefix (the file's convention; it
  has no logger abstraction) and proceed with `stdio: "ignore"`. Capture is
  best-effort and never blocks a dispatch.
- Log rotation/size limits: out of scope. The runner is near-silent by design
  (results flow through `status.json`/events); the log captures crashes and stray
  writes, not streaming output.

### 1.2 Spawn-time jiti revalidation

The module-load `const jitiCliPath` becomes a mutable cache behind an exported
`validate-or-resolve` helper (resolver and fs checks injectable, for tests): each
spawn validates the cached path with `existsSync`; on miss, re-resolve; if
re-resolution fails, surface the existing "upstream jiti for TypeScript execution
could not be found" error **inline at dispatch time** through the existing
`return { error }` -> `formatAsyncStartError` path - no API shape change, no thrown
exception, no doomed child. `isAsyncAvailable()` uses the same helper so it reflects
current reality, not the module-load snapshot. A jiti that exists but is broken
(half-installed) still dies as a child - but now with the stack in `runner.log`. No
smoke-test spawn.

### 1.3 Reconciler enrichment

`stale-run-reconciler.ts`: enrichment lives in `buildFailedRepair` (`:167-170`, the
function composing `Async runner process <pid> exited or disappeared before writing
a result`) so that **both** its call sites - dead-pid and stale-live-pid - funnel the
enriched message through `writeFailedRepair` (`:222`). When marking a run failed,
read `<run-dir>/runner.log`. If non-empty, append: `Runner log tail (<path>):` plus
the last ~20 lines, reading only the final ~4KB of the file (bounded regardless of
log size). If empty **or missing**, append the expected path as a hint - identical
behavior for both cases. The `subagent.run.repaired_stale` event carries the same
enriched message.

### 1.4 Status surfacing

`run-status.ts` diagnostics include the `runner.log` path alongside the existing
output/events paths. Additionally: `reconcileAsyncRun()` returns null status when
`status.json` is absent and no in-memory `startedRun` is supplied, so
`inspectSubagentStatus` / `listAsyncRuns` would still print `Status file not found`
for a pre-status crash. Whenever an async dir is resolved but `status.json` is
missing, the status/list paths surface the `runner.log` path and bounded tail
directly - independent of tracker memory, so the diagnosis survives session reload.

### 1.5 Run-dir plumbing for monitors (minimal runtime, enables part 2)

Nothing currently tells a child its own async run dir, and the async start text
(`Async: <agent> [<id>]`) omits the job's dir - so a prose-only monitor cannot
locate its target or a safe trail location. Two one-line additions:

- The runner sets `PI_SUBAGENT_RUN_DIR=<own asyncDir>` in the child's spawn env
  (beside the existing `PI_SUBAGENT_RUN_ID`, `subagent-runner.ts:243-251`).
- The async start message gains `Async dir: <path>` (the resume path already prints
  it), so the parent can paste the job's dir into the monitor's task.

## Part 2 - builtin `monitor` persona + skill guidance (prose only; runtime hooks land in 1.5)

**Reporting-channel caveat (narrows the headline claim):** live 15-minute push
reports reach the parent only when the pi-intercom bridge supplies
`contact_supervisor`. On a base install the monitor is a bounded stall-detector and
post-hoc diagnostic: it writes the trail and delivers its final summary as its run
result, but nothing pushes mid-run. SKILL.md states this so the parent knows what it
bought.

### 2.1 `agents/monitor.md` (new builtin, target <= 40 lines)

Frontmatter: `name: monitor`; `description` states it watches a job someone else
already started and is **not for doing the work** (so the parent LLM cannot grab it
as the job runner); tools: read + bash only; `completionGuard: false` (bash-enabled
observer that must never be judged as an implementation agent - the repo's own
prescription for advisors, `doc/agents-and-chains.md:182`); `thinking: low`
(cheap fixed reasoning budget - ratified at ship: the monitor is a polling
observer and the persona targets smaller models).

Body, imperative, in this order:

1. **Role fence (line 1):** "You observe a job someone else runs. Never execute,
   restart, or modify it."
2. **Target resolution:** the task names one of - the job's **absolute async run
   dir** (preferred; read its `status.json`, tail its output logs / `runner.log`),
   a PID (use the platform's PID-liveness check - `ps -p` on POSIX, `tasklist` on
   Windows), a log file (`tail`), or a probe command. If the target is unreadable
   or already terminated at first check, report that and exit - never guess, never
   loop.
3. **Trail location:** `$PI_SUBAGENT_RUN_DIR/trail.md` (injected per 1.5). If the
   variable is unset, `mktemp -d` under the OS temp dir and use that - **never
   write under the workspace**.
4. **Cycle loop:** record your start time, then run the **first check immediately**
   (before any sleep). Each cycle: check liveness + collect progress -> compose a
   one-line **delta** vs the previous cycle (new log lines, counts, phases;
   best-effort ETA) -> append it with a timestamp to the trail -> if
   `contact_supervisor` is available, send the delta with
   `reason: "progress_update"` -> sleep the interval in chunks of <= 5 minutes.
5. **Cadence:** default 15 minutes; the task may override.
6. **Stall rule:** stall = no growth in the watched log **and** no change in
   `status.json` `lastUpdate` since the previous cycle. A stalled cycle's report is
   an explicit stall warning ("no output for <interval>, possible stall"). Two
   consecutive silent cycles -> escalate via `contact_supervisor`
   `reason: "need_decision"`. Never report "still working" without evidence.
7. **Exit:** target reached a terminal state -> send a final summary and exit; the
   summary is the monitor's own run result. Hard cap: stop 24h after your recorded
   start time even if the target lives. No `contact_supervisor` available -> trail
   file + final result are the record; behave identically otherwise.

The existing async control machinery (attention notices, silence ceiling, kill cap -
`src/runs/shared/subagent-control.ts`) applies to the monitor run itself as backstop.

### 2.2 `skills/pi-cohort/SKILL.md` amendment (~10 lines)

Purely additive rules in the async guidance section (SKILL.md already mandates
`async: true` unconditionally - no duration threshold is introduced), imperative
form:

- The job's task must instruct it to emit observable progress as it works (log
  lines, counts, phase names; best-effort ETA). A silent long job is a defect.
- Pair it with a second dispatch: `monitor`, async, given the job's **absolute
  async dir** (from the `Async dir:` line in the start message, per 1.5) and report
  cadence.
- Live 15m reports require the pi-intercom bridge; without it the monitor's trail
  and final summary are post-hoc records.

Plus one canonical example showing the two-dispatch shape:

```
subagent({ agent: "worker", async: true, task: "<long job - emit progress lines as you work>" })
  -> Async: worker [R]  Async dir: <D>
subagent({ agent: "monitor", async: true, task: "Watch async run R at <D>. Report every 15m. Stop when it ends." })
```

The two dispatches keep job and monitor unconfusable: the monitor is never asked to
do the work, and its description says so.

## Error handling and edge cases

| Case | Behavior |
|---|---|
| fd open fails in `spawnRunner` | one `console.error` `[pi-cohort]` warning, fall back to `stdio: "ignore"`, dispatch proceeds |
| spawn throws / no `proc.pid` | parent fd closed via `finally`; launched child never misreported as unstarted |
| `PI_SUBAGENT_RUN_DIR` unset in monitor | `mktemp -d` under OS temp dir; never the workspace |
| huge `runner.log` at reconcile | read final ~4KB only, take last ~20 lines |
| jiti path stale (deleted/moved) | caught at spawn; inline dispatch error, no child |
| jiti present but broken | child dies; stack lands in `runner.log`; reconciler surfaces it |
| monitor target dead at first check | report and exit, no loop (first check runs immediately, before any sleep) |
| monitor target unreadable | report "cannot observe target: <reason>", exit; never restart the job |
| intercom bridge absent | trail file + final result only; same loop otherwise |
| runaway monitor | persona 24h hard cap + existing async attention/kill machinery as backstop |
| long single sleep tripping liveness heuristics | persona mandates sleeps chunked <= 5m (the incident's own mitigation) |
| stalled job | stall = no log growth and no `status.json` `lastUpdate` change; explicit stall warning; 2 silent cycles = `need_decision` escalation |

## Testing

Part 1 (only runtime code), existing `node --test` style beside current
async/reconciler tests:

The seams: `spawnRunner` and the jiti path are currently module-private, so 1.1/1.2
export a testable spawn helper and the jiti validate-or-resolve helper (injectable
resolver/fs); cases that can't use those seams go through the public
`executeAsyncSingle`.

- Unit: spawn helper writes child stderr to `<async-dir>/runner.log` (child prints
  to stderr, exits nonzero; assert log content).
- Unit: fd-open failure falls back to `stdio: "ignore"` without throwing; parent fd
  closed on spawn-throw and missing-pid paths.
- Unit: jiti validate-or-resolve - stale cached path + missing file -> `{ error }`
  at dispatch (no child); valid path -> spawn proceeds. Simulate via injected
  resolver/fs, not global install mutation.
- Unit: `buildFailedRepair` message - log tail included when `runner.log` non-empty;
  path hint when empty or missing (identical behavior); tail bounded; both dead-pid
  and stale-live-pid call sites enriched.
- Unit: status path with resolved async dir + missing `status.json` surfaces the
  `runner.log` path/tail instead of bare `Status file not found`.
- Unit: child env contains `PI_SUBAGENT_RUN_DIR`; async start message contains
  `Async dir:`.
- Integration (existing async suite): async run whose runner crashes at startup ends
  `failed` with the cause in the failure message.
- Run: `env -u PI_CODING_AGENT_DIR npm run test:all`.

Part 2: `test/unit/monitor-persona.test.ts` (runs under `test:unit`) loads the
shipped `agents/monitor.md` and the amended SKILL.md section and asserts the prose
invariants: role fence on line 1 of the body, `completionGuard: false`, 15m default,
chunked sleeps, `$PI_SUBAGENT_RUN_DIR` trail rule with temp-dir fallback, delta
reports, stall definition and `need_decision` escalation, 24h cap, banned "still
working" phrasing, no-workspace-write imperative, and the SKILL.md pairing example
passing an absolute async dir.

## Sequencing

1. Part 1 lands first (1.1 -> 1.2 -> 1.3 -> 1.4 -> 1.5), with its tests.
2. Part 2 (persona + skill prose) lands only after part 1 is green.

Approved deviation (recorded at ship): part 1 landed wave-grouped
(1.3 -> 1.1+1.2 -> 1.5 -> 1.4 -> integration tests) rather than in subsection
order; the binding clause - part 1 fully green before part 2 - held.

Same branch, same feature; the plan derives its task order from this section.

## Prior art (inspiration, not dependencies)

- **pi-intercom**: `contact_supervisor` with `reason: "progress_update"` /
  `"need_decision"` is the monitor's live channel; pi-cohort already documents the
  bridge (`skills/pi-cohort/SKILL.md:460-482`). Persona degrades gracefully when
  absent.
- **pi-messenger**: PID-liveness dead-peer detection (validates the existing
  reconciler approach), graceful stop (message -> grace -> terminate), bounded stuck
  threshold. Counter-example honored: its project-scoped `.pi/messenger/` writes are
  exactly what the no-repo-dirty constraint forbids.

## Out of scope

- First-class `monitor:` dispatch option, new tool schema params, new settings keys.
- `runner.log` rotation or size limits.
- Auto-retry of failed spawns; smoke-test spawns.
- Monitoring processes on remote hosts.
- Changes to `doc/orchestration-patterns.md` (pairing guidance lives in SKILL.md
  only - one home).

## Documentation impact

- Feature / user-facing docs introduced: none (`agents/monitor.md` persona body is
  implementation surface, not a doc-impact entry)
- Materially amended existing docs: `skills/pi-cohort/SKILL.md` (progress-emission
  rule + monitor pairing example), `doc/agents-and-chains.md` (builtin-agents table:
  one `monitor` row + rule-of-thumb sentence), `README.md` (extend the inline agent
  name list on the Agent concept row - the README has no per-agent table),
  `doc/observability.md` (async-run file layout gains `runner.log`), `CHANGELOG.md`
- Derived / memory docs invalidated: none

## Open questions

None.
