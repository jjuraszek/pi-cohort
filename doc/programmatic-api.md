# Programmatic API

These are the parameters the LLM (or an extension) passes when calling the
`subagent` tool directly. Most users ask naturally or use slash commands
instead - see [README](../README.md) and [commands.md](commands.md).

## Execution examples

```ts
// Single agent
{ agent: "worker", task: "refactor auth" }
{ agent: "scout", task: "find todos", maxOutput: { lines: 1000 } }
{ agent: "scout", task: "investigate", output: false }
{ agent: "scout", task: "write a large report", output: "reports/scout.md", outputMode: "file-only" }

// Forked context
{ agent: "worker", task: "continue this thread", context: "fork" }

// Parallel
{ tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] }
{ tasks: [{ agent: "scout", task: "audit auth", count: 3 }] }
{ tasks: [{ agent: "scout", task: "audit frontend" }, { agent: "reviewer", task: "audit backend" }], context: "fork" }

// Chain
{ chain: [
  { agent: "scout", task: "Gather context for auth refactor" },
  { agent: "planner" },
  { agent: "worker" },
  { agent: "reviewer" }
]}

// Chain in the background, suitable for unblocking the main chat
{ chain: [...], async: true }

// Chain with fan-out/fan-in
{ chain: [
  { agent: "scout", task: "Gather context", phase: "Context", label: "Map code", as: "context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {outputs.context}", label: "Feature A", as: "featureA" },
    { agent: "worker", task: "Implement feature B from {outputs.context}", label: "Feature B", as: "featureB" }
  ], concurrency: 2, failFast: true },
  { agent: "reviewer", task: "Review {outputs.featureA} and {outputs.featureB}" }
]}

// Dynamic fanout from structured output
{ chain: [
  {
    agent: "scout",
    task: "Return review targets as structured_output: { items: [{ path, reason }] }",
    as: "targets",
    outputSchema: { type: "object" }
  },
  {
    expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 12 },
    parallel: { agent: "reviewer", task: "Review {target.path}. Reason: {target.reason}", outputSchema: { type: "object" } },
    collect: { as: "reviews" },
    concurrency: 4
  },
  { agent: "worker", task: "Synthesize fixes from {outputs.reviews}" }
] }

// Strict structured output for reliable handoff data
{ chain: [
  {
    agent: "scout",
    task: "Return the key files and risks for {task}",
    as: "scan",
    outputSchema: {
      type: "object",
      required: ["files", "risks"],
      properties: {
        files: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } }
      }
    }
  },
  { agent: "planner", task: "Plan from this scan: {outputs.scan}" }
] }

// Worktree isolation
{ tasks: [
  { agent: "worker", task: "Implement auth" },
  { agent: "worker", task: "Implement API" }
], worktree: true }
```

## Management actions

Agent definitions are not loaded into context by default. Management actions let the LLM discover, inspect, create, update, and delete agents and chains at runtime.

```ts
{ action: "list" }
{ action: "list", agentScope: "project" }
{ action: "get", agent: "scout" }
{ action: "get", agent: "code-analysis.scout" }
{ action: "get", chainName: "review-pipeline" }

{ action: "create", config: {
  name: "Code Scout",
  package: "code-analysis",
  description: "Scans codebases for patterns and issues",
  scope: "user",
  systemPrompt: "You are a code scout...",
  systemPromptMode: "replace",
  inheritProjectContext: false,
  inheritSkills: false,
  model: "anthropic/claude-sonnet-4",
  fallbackModels: ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"],
  tools: "read, bash",
  extensions: "",
  skills: "parallel-scout",
  thinking: "high",
  output: "context.md",
  reads: "shared-context.md",
  progress: true
}}

{ action: "create", config: {
  name: "review-pipeline",
  description: "Scout then review",
  scope: "project",
  steps: [
    { agent: "scout", task: "Scan {task}", output: "context.md" },
    { agent: "reviewer", task: "Review {previous}", reads: ["context.md"] }
  ]
}}

{ action: "update", agent: "code-analysis.scout", config: { model: "openai/gpt-4o" } }
{ action: "update", chainName: "review-pipeline", config: { steps: [...] } }
{ action: "delete", agent: "scout" }
{ action: "delete", chainName: "review-pipeline" }
```

`create` uses `config.scope`, not `agentScope`. `config.name` is the local frontmatter name; optional `config.package` registers the runtime name as `{package}.{name}` and is saved as separate `name` and `package` frontmatter. `update` and `delete` use the runtime name and `agentScope` only when the same runtime name exists in multiple scopes. To clear optional string fields, including `package`, set them to `false` or `""`.

### Foreground stop by id

To stop one child and its subtree without cancelling its siblings:

```ts
subagent({ action: "interrupt", id: "3f9a1c" })
```

Use the id at the start of the child's row, not a position. Every child has its own UUID before launch, stable across retries; rows and session names show exactly its first six characters. A run row has its own run id. This applies to single calls, `tasks[]` items after `count` expansion, sequential chain steps, static parallel tasks, and materialized dynamic parallel items. Pending and settled rows keep their ids. Expanded views retain every live nested row at any depth; detail lines and settled rows remain foldable.

`interrupt` resolves exact ids or prefixes of at least four characters in one namespace of run and child ids, live and settled. An exact full id wins; otherwise the prefix must match exactly one distinct full id. A six-character collision remains ambiguous even after one match settles; use a longer prefix from the error or slash completion. `status` and `resume` resolve run ids only, without the interrupt minimum length.

A child-id stop does not trigger `failFast`; siblings finish before the waiting call returns. When every interrupted child was stopped by child id, the foreground result is:

| Run shape | Returned result |
|---|---|
| Top-level parallel | The text includes sibling outputs and `INTERRUPTED` for the stopped child, for example `2/3 succeeded`. `details.results` retains every child; the stopped entry has `exitCode: 0` and `interrupted: true` and does not count as a success. The tool does not set `isError`. |
| Static parallel chain step | The chain returns `isError: true` with `Parallel step N failed:` and an `interrupted` failure line. `## Outputs` contains sibling outputs and a `- interrupted` heading for the stopped task, whether or not a `stopOn` condition matched. No later step runs. Only successful, non-interrupted tasks register named outputs. With `worktree: true`, all partial diffs are captured, including the stopped child's, and patch locations appear in the failure text. |
| Dynamic chain step | The chain returns `isError: true` with `Dynamic step N failed:`, an `interrupted` item line, sibling outputs, and an interrupted heading. The group status is `failed`; no later step runs. The collection in `details.outputs` retains the stopped item's partial text. Dynamic steps do not support `worktree`. |

Task headings and cleanup diagnostics use one-based numbers. Interrupted output headings include the child's error when present; cleanup diagnostics remain visible in the aggregate or chain failure text. A single call or sequential chain step stopped by child id still returns its pause notice. A run-id stop signals every running child and prevents queued tasks and later chain steps from starting. A queued foreground child settles interrupted without spawning. A run-id stop, a bare `interrupt`, or a mix of run-id and child-id stops keeps the whole-run pause notice instead of the aggregate above. Stopping every child individually by id still produces the targeted result.

### Background stop by id

The same child-id request targets one child of a running async run, including static parallel and materialized dynamic children. Siblings finish with their own statuses and outputs; the stopped child remains `paused` with `interrupted: true`. The run settles as `paused` with `Paused after interrupt. Waiting for explicit next action.`, and later chain steps do not run. Sibling outputs remain in the async result's `results[]` and are accessible through per-child output paths in `status`, not in the paused summary text. Background results do not use the foreground chain-failure wrapper. A run-id stop signals every running child, starts no pending step, and leaves pending steps pending while the run settles paused.

The executor atomically writes `interrupt-request-<target id>.json` in the run's async directory before signaling the runner. The filename uses the full resolved child or run UUID, for example `interrupt-request-3f9a1c00-0000-4000-8000-000000000001.json`. The JSON body must contain a `targetId` equal to the full id in the filename; the executor also writes `requestedAt` as diagnostic metadata. The runner consumes and deletes request files on the signal, ignoring malformed JSON or a missing or mismatched `targetId`. A signal without a valid request stops nothing. A stop accepted while a child is running but has no interrupt callback latches until callback registration, including a fallback attempt. The runner deduplicates repeated stops so they do not invoke the registered interrupt callback again. This is not API-level repeat acceptance: each accepted async request writes a file and signals the runner, and a child already recorded as `paused` is rejected as `interrupted` by the resolver, even while siblings are still running.

### Subtree stops and ownership

Every owner-stop path, including the waiting call's abort signal and a control-policy kill, closes admission, signals the target, sweeps detached background descendants, then answers. Admission closes with an empty stop record named by the full target id in the root route's `stops/` directory. Before spawning, owners check their run id and every ancestor run and child id against those records. A match refuses foreground launch with `Subagent launch refused: <stop id> is stopping.`; a background runner settles paused without spawning. Launch registration precedes the admission check so the sweep also sees launches racing with the stop. Only ancestry containing the stopped target is suppressed; siblings remain eligible to launch.

Nested background targets use their runner's request file and signal. For a nested foreground target, the caller writes a shared-inbox request carrying the full `targetId`; only the process owning that run or child acts, replies, and removes it. Non-owners leave it untouched. The caller waits up to 1000 ms, then removes only its own request and reports `The owner of <stop id> did not confirm the stop within 1000 ms; the stop may still take effect.` No fallback whole-run signal follows an unanswered request; the owner applies the stop before writing its reply.

Native children receive `PI_SUBAGENT_OWNER_PID` and check owner liveness every 1000 ms. A dead owner triggers SIGTERM and a forced exit 3000 ms later if needed; unknown liveness leaves the child running. A reused pid can mask owner death. External attempts set this variable empty to disable the pid watch across namespaces; their host terminates the active attempt when its socket to the owner closes. An explicit external stop aborts and shuts down the attempt, with bounded backend cleanup as described below. Native descendants watch their immediate owner; detached background descendants are reached by the ancestry sweep.

When a foreground root returns with live nested descendants, this process retains its route for resolution, completion, subtree sweeps, and widget rows until the last descendant settles. Only routes this process created are retained. The stop contract does not cancel arbitrary processes spawned by tools or sweep detached background runs merely because their launching child crashed. `resume` creates a new run id under the caller's ancestry, so the stopped run's record does not prevent revival; resume indexing and the `Revive child` hint remain unchanged.

### Stop errors

Rejections stop nothing and send no signal:

| Input or state | Result |
|---|---|
| Id shorter than four characters | `Stop id '<text>' is too short; type at least 4 characters of the id at the start of the row.` |
| No recorded match | `No running subagent matches '<text>'.` followed by running stop ids and agent names, or `No subagent is running.` |
| Ambiguous prefix | Every match is listed as `<kind>:<prefix> <name>`, where kind is `run` or `child` and the prefix distinguishes the matches. Settled ids participate. |
| Pending child | `Subagent <stop id> (<agent>) has not started; stop its run to keep it from starting.` |
| Settled child on record | `Subagent <stop id> (<agent>) is no longer running: <state>.` Child states are `completed`, `failed`, or `interrupted`; background and nested child statuses `complete` and `paused` are normalized to `completed` and `interrupted` in this error. A returned foreground run's child no longer has a record and gets the no-match error. |
| `interrupt` with `index` | `interrupt no longer takes an index; pass the id at the start of the child's row.` Use `index` only with `resume`. |
| Background target without a live runner pid | `No running async run with an interrupt-capable pid was found` |

## Parameter reference

| Param | Type | Default | Description |
|---|---|---|---|
| `agent` | string | - | Agent name for single mode, or target for management actions. |
| `task` | string | - | Task string for single mode. |
| `label` | string | - | Single-agent child label, shown as `<agent> - <label>` on live and result rows. |
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `resume`, or `doctor`. |
| `chainName` | string | - | Chain name for management actions. |
| `config` | object/string | - | Agent or chain config for create/update. |
| `output` | `string \| boolean` | disabled | Top-level output is opt-in: `true` selects the agent-configured filename, a string selects that path, and `false` disables it. If no configured filename exists, `true` leaves output disabled; no filename is invented. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Return saved output inline or as a concise saved-file reference. `file-only` requires `output: true` with a configured filename or an explicit output path. |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all. |
| `model` | string | agent default | Override model. |
| `tasks` | array | - | Top-level parallel tasks. Supports `agent`, `task`, `label`, `cwd`, `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, and `acceptance`. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. An absolute task `output:` is left untouched at the caller-supplied path, outside the worktree; a relative `output:` is redirected instead to `<runDir>/task-<i>/<output>` (surviving teardown, kept out of the captured patch), and one that escapes that per-task directory (e.g. `../report.md`) or normalizes to it (`.`) is rejected at dispatch. `reads:` and the task cwd still resolve inside the worktree. |
| `chain` | array | - | Sequential, static parallel, and dynamic fanout chain steps. Steps and chain parallel tasks support `phase`, `label`, `as`, `outputSchema`, and `acceptance` in addition to the usual execution fields. Dynamic fanout uses `expand`, one child `parallel` template, and `collect`. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `planner`, `worker`, and `oracle` default to `fork`. |
| `chainDir` | string | temp chain dir | Persistent directory for chain artifacts. |
| `clarify` | boolean | false | Set `true` to show the TUI preview/edit flow when supported. Omitted or `false` launches directly; chains containing parallel steps skip the UI. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | false | Background execution. For chains, `clarify: true` explicitly keeps the run foreground for the clarify UI. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | string/object/false | inferred | An explicit level runs as given; `"auto"` or an unset level uses inference. Use `"attested"`, `"checked"`, `"verified"`, or `"reviewed"`; `none` requires the object form with a `reason`: `{ level: "none", reason: "..." }`. See [orchestration-patterns.md](orchestration-patterns.md#acceptance-gates). |
| `control` | object | config defaults | Override per-run control thresholds. Supports `needsAttentionAfterMs`, `activeNoticeAfterMs`, `inFlightSilenceCeilingMs`, `inFlightSilenceKillMs`, and `notifyOn`. |

Child labels render as `<agent> - <label>` on live and result rows for single calls, `tasks[]`, sequential chain steps, static parallel tasks, and dynamic parallel items. Dynamic template labels retain item interpolation; a parallel group's own label stays on its group header, not its children.

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. It never silently downgrades to `fresh`. In multi-agent runs, if any requested agent has `defaultContext: fork` and the launch omits `context`, the whole invocation uses forked context; pass `context: "fresh"` when you intentionally want a fresh run.

At top level, output starts disabled for foreground and async single/parallel runs. Omitted parallel-task progress is disabled, while omitted parallel-task `reads` inherit the agent's `defaultReads`. Clarify also starts top-level output and parallel progress disabled; an edit opts in only for that invocation. Migrate callers that relied on defaults to `output: true` (agent-configured filename), `output: "path"` (explicit path), or `progress: true` (parallel progress).

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. It requires `output: true` with an agent-configured filename or an explicit output path. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Non-BLOCKED file-only failures return failure status and `Full reply preserved at <path>` only after the artifact copy is written, or `Full reply not preserved (artifact output disabled)` / `Full reply not preserved (artifact write failed: <msg>)` when it is not preserved. Foreground single failures return `FAILED (exit code N)[: error]`, a blank line, then the pointer. Save errors return `Output file error: <path>\n<err>`, a blank line, then the pointer, without the reply inline; foreground save errors keep exit code 0, while background save errors flip it to 1. The runner does not write the requested output path on child failure. `BLOCKED:` handoffs remain inline, and inline mode is unchanged. Disabling artifact output can make the full reply unavailable. In chains, successful file-only steps pass the compact reference as `{previous}`; exit-0 save-error steps pass the save error plus pointer, while failed chains stop with their existing summaries.

Sequential and parallel chain tasks accept `agent`, `task`, `phase`, `label`, `as`, `outputSchema`, `cwd`, `output`, `outputMode`, `reads`, `progress`, `skill`, and `model`. Parallel tasks also accept `count`. Parallel step groups accept `parallel`, `concurrency`, `failFast`, and `worktree`. Every step shape accepts `stopOn: { path, in }` - a JSON Pointer into the step's structured output and the string values that end the chain after that step (see [Stop conditions](agents-and-chains.md#stop-conditions-stopon)); it requires `outputSchema` on the step (every task of a parallel step). If `outputSchema` is present, the child must call `structured_output` with schema-valid JSON; prose-only completion or invalid JSON fails the step. Validated structured values are preserved on the step result, `as` exposes a compact text representation through `{outputs.name}`, and a `worktree: true` parallel task's patch through `{outputs.name.patchPath}`.

## Control configuration

Per-run `control` fields override global thresholds when a task legitimately runs without observable output:

| Field | Default | Description |
|---|---|---|
| `needsAttentionAfterMs` | `60000` | Emit `needs_attention` when a child shows no activity for this many milliseconds. |
| `activeNoticeAfterMs` | `240000` | Emit `active_long_running` (calm notice) at this interval while a long-running task continues producing output or while an in-flight turn is running within the silence ceiling. |
| `inFlightSilenceCeilingMs` | `600000` | While an assistant turn is in flight, a silent stretch under this bound is reported as the calm `active_long_running` state instead of `needs_attention`; silence past it re-escalates to `needs_attention`. Bounds zero-output turns without flagging healthy long thinking/streaming. |
| `inFlightSilenceKillMs` | `1800000` | Hard cap (foreground only): once an in-flight turn has produced no output for this long, the child is SIGTERMed and the run settles as a failure (non-zero exit, `result.error` naming the cap), feeding the orchestrator's normal failure handling instead of blocking indefinitely on a child wedged inside a tool call. Clamped up to `inFlightSilenceCeilingMs + needsAttentionAfterMs` so the `needs_attention` warning always fires first. Gated on `enabled`. |
| `notifyOn` | `["active_long_running", "needs_attention"]` | Which activity states trigger notifications: `"needs_attention"`, `"active_long_running"`, or both. |

Example:

```typescript
subagent({
  agent: "worker",
  task: "Run the slow migration test suite",
  control: {
    needsAttentionAfterMs: 300000,
    inFlightSilenceCeilingMs: 900000,
    notifyOn: ["needs_attention"]
  }
})
```

Status and control actions:

```ts
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>" })
subagent({ action: "status", id: "<nested-run-id>" })
subagent({ action: "interrupt", id: "<child-id-or-prefix>" })
subagent({ action: "interrupt", id: "<run-id-or-prefix>" })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "resume", id: "<nested-run-id>", message: "follow-up for a nested child" })
subagent({ action: "doctor" })
```

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching. Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands. Inside child-safe fanout mode, bare `status` requires an id when no local foreground run is active, so children cannot enumerate unrelated top-level async runs. Bare `interrupt` selects the current foreground run, or the background run when no foreground run exists, and stops that run and its subtree. Use an explicit child or nested run id to select a narrower subtree.

An interrupted child remains `paused` with `exitCode: 0`. The existing optional `interrupted` flag is preserved as `true` in public/status and persisted child results, including when external cleanup is uncertain. Accepted interrupted external results keep `error` as a diagnostic, not failure input: it does not trigger model fallback, failed-run promotion, or fail-fast. Clean confirmed pauses keep their existing output without a cleanup error; ordinary non-interrupted failures keep their existing handling.

When process exit cannot be confirmed, result/status error fields and each affected child's visible paused output include exactly `Process termination could not be confirmed; manual cleanup may be required.` Missing-result or protocol diagnostics can accompany this warning. A zero-exit pause is not a completed review: pi-gauntlet's closure and cadence checks require the exact agent, zero exit, and no explicit interruption.

Normal external interruption requests no routine surface closure. Bounded forced cleanup may close the diagnostic surface; the returned execution surface's `retained` boolean records the last known close outcome, not proof that the process is alive or the surface remains inspectable. A companion's independent EXIT trap is outside core's retention promise. There is no automatic reaper or automatic resume. See [cleanup and exit evidence](observability.md#persistent-child-host-wire-protocol) for the budgets and confirmation boundary; explicit `resume` below starts a new child, not control of the old OS process.

`doctor` prints a full setup report: config validation, registered agents/chains, run history, and a `Cost` section that breaks down spend by main/sync/async/external slices. When external producers have reported via the `cost:external` protocol, the `Cost` section includes a per-source row for each producer. See [observability.md](observability.md).

`resume` revives a finished, failed, or paused child by starting a new async child from its stored child session file, including a selected sibling while another sibling is running. Resuming a running child errors with `Selected child is still active; wait for completion, then resume.` Nested running children similarly error with `Nested run <id> is still active; wait for completion, then resume.` Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child. Nested runs can be resumed by nested id when persisted nested session metadata is available. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.
