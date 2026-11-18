# Observability

Where subagent activity shows up, how cost is tracked across the whole
session tree, and the event/log surface for debugging. Back to
[README](../README.md).

## Where running subagents show up

Foreground runs stream progress in the conversation while they run.

Background runs keep working after control returns to you. Inspect active runs with `subagent({ action: "status" })`, or a specific run with `subagent({ action: "status", id: "..." })`.

They also show a compact async widget and send completion notifications. Parallel background runs show per-agent progress instead of fake chain steps. Chains with parallel groups keep their grouped shape in progress and results, so failed or paused agents stay visible next to completed ones. When a child is explicitly allowed to fan out with `tools: subagent`, its nested runs appear under that parent child in the main status tree instead of being hidden inside the child process.

## Grand-total session cost

The footer shows a `Σ$` status (e.g. `Σ$1.234`) with the grand total cost of the
session: the main loop **plus** every subagent in the session's subtree -
foreground, background/async, and nested fanout. It is distinct from the
built-in `$` figure, which counts the main loop only; the gap between them is
your subagent spend.

A pane attempt counts its own assistant turns and charges on its final branch, including tool results, cache warming, compaction and branch summaries. Tool-result charges add tokens and cost, not turns. A retry on the same saved conversation does not count the earlier attempt again. A forked child's pane footer still shows the whole conversation's spend, including copied parent turns; that footer does not feed the parent's total.

A background run saves the token and cost totals from its steps' attempt records, including paid attempts when the run stops before a fallback starts. Background streaming counts tool-result charges from completed tool-result messages. If a pane attempt ends without a result, its record counts all owned charges in its readable session file. When a child rewinds before producing a result, the completed status excludes turns abandoned on the old branch; the live run total and the session footer can therefore show more spend.

The total is per-session: it is zeroed on a new session, seeded from prior spend
on resume, and only ever rises within a session for the main/sync/async slices
(finished subagents stay counted even after their state is cleaned up). The
external slice may move down if a producer corrects its cumulative total
downward. External model cost is opt-in via the `cost:external` protocol: any
extension can report its own LLM spend and it is folded into `Σ$`.

## cost:external protocol

Any extension can contribute its LLM spend to `Σ$` by emitting on the
`pi.events` string channel `"cost:external"`. The channel is generic - pi-cohort
does not hardcode a producer list. [pi-condense](https://github.com/jjuraszek/pi-condense)
is the canonical current producer: its own summarization calls cost money, and
it reports that spend here so it shows up in your total instead of vanishing.

**Payload fields**

| Field | Type | Meaning |
|---|---|---|
| `source` | string | Stable producer id, e.g. `pi-condense`. Required; empty string causes the payload to be dropped. |
| `totalCost` | number | Cumulative USD spent by this producer this session. Negative values are clamped to 0; non-finite values cause the payload to be dropped. |
| `inputTokens` | number (optional) | Cumulative input tokens this session. Invalid values are dropped individually; cost is kept. |
| `outputTokens` | number (optional) | Cumulative output tokens this session. Invalid values are dropped individually; cost is kept. |

- **Cumulative, not deltas.** A producer emits its running session total on every update. `pi-cohort` tracks the latest value per `source` and updates `Σ$` accordingly.
- **Idempotent/replay-safe.** Re-emitting the same `source` overwrites the stored value; it never double-counts.
- **Live-only.** `pi-cohort` does not persist or reseed the external slice. A producer SHOULD re-emit its cumulative total on its own `session_start` to restore visibility after a session resume.
- **Sanitization at the boundary.** Non-finite `totalCost` or a missing/empty `source` drops the whole payload with one `console.warn`. Negative `totalCost` is clamped to 0. Invalid optional token fields are dropped individually while the cost is kept.
- **Surfacing.** The external slice is folded into the `Σ$` footer. A per-source breakdown appears in `subagent({ action: "doctor" })`.

You can also ask naturally:

```text
Show me the current async runs.
```

If something feels misconfigured, run:

```text
/cohort-doctor
```

or ask:

```text
Check whether subagents are set up correctly.
```

## Files, logs, and observability

Each chain run creates a user-scoped temp directory like:

```text
<tmpdir>/pi-cohort-<scope>/chain-runs/{runId}/
```

It may contain files such as `context.md`, `plan.md`, `progress.md`, and `parallel-{stepIndex}/.../output.md`. Directories older than 24 hours are cleaned up on extension startup.

Debug artifacts live under `{sessionDir}/subagent-artifacts/` or a user-scoped temp artifact directory. Per task you may see:

- `{runId}_{agent}_input.md`
- `{runId}_{agent}_output.md`
- `{runId}_{agent}.jsonl`
- `{runId}_{agent}_meta.json`

Metadata records timing, usage, exit code, final model, attempted models, and fallback attempt outcomes.

Session files are stored under a per-run session directory. With `context: "fork"`, each child starts with `--session <branched-session-file>` produced from the parent's current leaf. That is a real session fork, not an injected summary.

Async completions notify only the originating session. The result watcher emits `subagent:async-complete`, and the extension consumes that event to render completion notifications.

Durable background records live under the pinned profile, not the temporary notification directory:

```text
<PI_CODING_AGENT_DIR>/pi-cohort/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
  runner.log
```

`runner.log` captures the detached runner's stdout/stderr, including startup crash stacks, and its tail is appended to stale-failure messages. `status.json` powers the widget and `subagent({ action: "status" })` output. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata. Nested fanout status is stored as compact sidecar event/registry metadata under `<PI_CODING_AGENT_DIR>/pi-cohort/nested-subagent-events/`, with nested run records under `nested-subagent-runs/`, and merged into parent status views and result payloads; full recursive status snapshots are not embedded in parent result files. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

Durable top-level and nested state, shared routes, and default sessions have no automatic age expiry. Sessions normally use a per-run directory derived from the parent session file; without one they use `<PI_CODING_AGENT_DIR>/pi-cohort/sessions/`. Explicit session bases can be outside the profile and have their own retention limits; see [configuration.md](configuration.md#defaultsessiondir).

`RESULTS_DIR` is `<tmpdir>/pi-cohort-<scope>/async-subagent-results/`: a disposable completion-notification queue, not the durable history store. Consuming a notification removes its result file but retains run history and sessions. Runner configs, prompt scratch, chain scratch, and debug artifacts are also disposable; artifact cleanup does not expire durable run records or session files. Legacy temporary run records and routes are inspected in their original paths, not migrated. Records missing the original runtime identity cannot be revived.

Queued runs that never publish running status remain unresolved and cannot be revived; there is no automatic startup recovery. Start a new run. For explicit history removal, follow the [README boundaries](../README.md#configuration): delete only a terminal top-level run directory whose subtree has stopped. Separately stored sessions and shared routes remain, and deleting history removes its resume lookup.

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Press `Ctrl+O` to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done scout -> running planner`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices and persisted for async runs.

While the session is streaming, foreground control notices are steered to a turn boundary - never between an assistant `toolCall` and its `toolResult`; while idle, they append without starting a turn.

### Execution reporting protocol

The experimental backend reporting slice persists versioned custom session entries with custom type `pi-cohort:execution-report:v1`. A reporter emits `ready`, then `settled`, then exactly one terminal `result`; each entry carries `protocolVersion: 1`, `runId`, `childId`, `attemptId`, a per-attempt sequence, and timestamp. Result entries contain an `outcome` (`success`, `failed`, or `interrupted`), `finalOutput`, and optional `error` and `stopReason` fields.

The host replays complete JSONL records only, tolerates one incomplete trailing write, filters other attempts, and rejects correlation/sequence/lifecycle violations. It validates the exact result entry's full `parentId` branch, then returns only messages appended after the attempt's `ready` report, matched by `runId`, `childId` and `attemptId`. Messages appended after `ready` off that branch reach only the live feed; before `ready`, the live feed is empty. A report positioned before that `ready` is inherited and does not claim the attempt's stream. The saved conversation and transcript keep the inherited history. Messages are not duplicated in result data. Reporter configuration is supplied only through `PI_COHORT_REPORT_CONFIG`, an owner-only regular JSON file; the configuration contains correlation identifiers, never task content or credentials.

The reporter also limits its result to branch messages appended after the attempt's exact `ready` report. With no assistant message of its own on that branch, the attempt ends as `failed` with `error: "result_missing"` and empty `finalOutput`, even after an applied abort. Otherwise, a correlated durable `control` entry with `action: "abort", state: "applied"` classifies a newly written terminal as `interrupted`, including an error-shaped final assistant message. Error text alone is not abort evidence. A previously written terminal remains immutable; accepted cancellation still stops fallback and preserves caller-facing interruption without rewriting that terminal.

### Persistent child-host wire protocol

The experimental external-terminal host uses a private owner-only Unix socket. Its
owner-only config file, named by `PI_COHORT_CHILD_HOST_CONFIG`, carries only
`protocolVersion`, socket path, `runId`, and `childId`. The command, attempt
arguments, cwd, and environment are sent only in memory over that socket.

Messages are version-1 JSON objects, newline-delimited, exact-schema, and capped
at 64 KiB per buffered frame. The controller accepts this lifecycle only:

```text
host_ready
start_attempt -> attempt_started -> attempt_exited | attempt_spawn_error
shutdown_host -> shutdown_ack
```

Every message is correlated by `runId` and `childId`; attempt messages also carry
one non-reusable `attemptId`. Protocol frames and environments are never logged.

For an accepted interruption, the execution owner sends child shutdown regardless of terminal classification, observes child exit, and requests host shutdown before the attempt resolves or rejects. Cleanup is one-shot. Two absolute budgets use `controlTimeoutMs` (default 30,000 ms): the graceful budget starts at accepted interruption and covers abort, terminal observation, and child/host shutdown and exit; at most one additional fallback budget covers forced cleanup, remaining exit observation, and resource disposal. The default coordinator wait is bounded to 60,000 ms; later awaits and `finish()` do not restart either budget. A stalled or rejected graceful shutdown uses `close(handle, "explicit_cleanup")` at most once within the fallback budget. Late completion cannot rewrite the settled result.

Confirmed termination requires both the correlated child's `attempt_exited` and the launched host's lease `exited` fact within those budgets. `shutdown_ack`, socket closure, `surface_closed`, and a successful close request are not exit evidence. Responsive shutdown without host-exit proof ends with uncertainty, not a destructive close solely to obtain proof. Unconfirmed termination adds exactly `Process termination could not be confirmed; manual cleanup may be required.` to paused diagnostics and visible output.

Each attempt's `ready` report is due within `control.startDeadlineMs` (default 300,000 ms) of its `start_attempt` request; host launch and connection are outside that window. At expiry the execution owner re-reads the session file, and without a correlated `ready` it requests `close(handle, "explicit_cleanup")` once, observes child and host exit within one `controlTimeoutMs` budget, releases its resources, and rejects the attempt with `Subagent killed: pi did not start its session within the start deadline (startDeadlineMs=<n>ms).` A pi that has not started its session has no control channel, so no abort or shutdown request precedes the close. No further model attempt starts, and `finish("retained")` returns the stored `{handle, retained}` as after an interruption.

Normal interruption retains the diagnostic surface without requesting routine closure; forced cleanup may sacrifice it. After interrupted settlement, `finish("retained")` returns the stored `{handle, retained}` without contacting the host or repeating cleanup; delivered finish is rejected. `retained: false` records a completed explicit-close request, and `true` means core has not confirmed a close. This boolean is the last known close outcome, not proof of process liveness or an inspectable surface. Companion EXIT traps remain outside core's retention promise.

Actual-process tests with fake backends verify core cleanup, not live cmux behavior or companion retention compliance. The live cmux runtime and the reporter's installed adapter version remain unavailable, so no live reproduction is claimed.
