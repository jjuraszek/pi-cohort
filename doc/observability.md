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
Check whether subagents and intercom are set up correctly.
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

Async runs write:

```text
<tmpdir>/pi-cohort-<scope>/async-subagent-runs/<id>/
  status.json
  events.jsonl
  output-<n>.log
  subagent-log-<id>.md
```

`status.json` powers the widget and `subagent({ action: "status" })` output. `events.jsonl` contains wrapper events plus child Pi JSON events annotated with run and step metadata. Nested fanout status is stored as compact sidecar event/registry metadata and merged into parent status views and result/intercom payloads; full recursive status snapshots are not embedded in parent result files. `output-<n>.log` is a live human-readable tail. Fallback information is persisted so background runs are debuggable after completion.

## Live progress

Foreground runs show compact live progress for single, chain, and parallel modes: current tool, recent output, token counts, duration, activity freshness, current-tool duration, and chain graph metadata when available.

Press `Ctrl+O` to expand the full streaming view with complete output per step.

Sequential chains show a flow line like `done scout -> running planner`. Chains with parallel steps show per-step cards instead. Chain status uses `label` and `phase` metadata when present, while falling back to agent names for older chains.

## Events

Async events:

- `subagent:async-started`
- `subagent:async-complete`

Intercom delivery events:

- `subagent:control-intercom`
- `subagent:result-intercom`

The result watcher emits `subagent:async-complete`; `src/extension/index.ts` registers the notification handler that consumes it. Control/attention events are surfaced as visible parent notices and persisted for async runs. With `pi-intercom`, needs-attention notices and grouped parent-side subagent result deliveries can reach the orchestrator over intercom.
