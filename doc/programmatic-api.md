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

## Parameter reference

| Param | Type | Default | Description |
|---|---|---|---|
| `agent` | string | - | Agent name for single mode, or target for management actions. |
| `task` | string | - | Task string for single mode. |
| `action` | string | - | `list`, `get`, `create`, `update`, `delete`, `status`, `interrupt`, `resume`, or `doctor`. |
| `chainName` | string | - | Chain name for management actions. |
| `config` | object/string | - | Agent or chain config for create/update. |
| `output` | `string \| boolean` | disabled | Top-level output is opt-in: `true` selects the agent-configured filename, a string selects that path, and `false` disables it. If no configured filename exists, `true` leaves output disabled; no filename is invented. |
| `outputMode` | `"inline" \| "file-only"` | `inline` | Return saved output inline or as a concise saved-file reference. `file-only` requires `output: true` with a configured filename or an explicit output path. |
| `skill` | `string \| string[] \| false` | agent default | Override skills or disable all. |
| `model` | string | agent default | Override model. |
| `tasks` | array | - | Top-level parallel tasks. Supports `agent`, `task`, `cwd`, `count`, `output`, `outputMode`, `reads`, `progress`, `skill`, `model`, and `acceptance`. |
| `concurrency` | number | config or `4` | Top-level parallel concurrency. |
| `worktree` | boolean | false | Create isolated git worktrees for parallel tasks. |
| `chain` | array | - | Sequential, static parallel, and dynamic fanout chain steps. Steps and chain parallel tasks support `phase`, `label`, `as`, `outputSchema`, and `acceptance` in addition to the usual execution fields. Dynamic fanout uses `expand`, one child `parallel` template, and `collect`. |
| `context` | `fresh \| fork` | agent default or `fresh` | `fork` creates real branched sessions from the parent leaf. Packaged `planner`, `worker`, and `oracle` default to `fork`. |
| `chainDir` | string | temp chain dir | Persistent directory for chain artifacts. |
| `clarify` | boolean | true for chains | Show TUI preview/edit flow. |
| `agentScope` | `user \| project \| both` | `both` | Agent discovery scope. Project wins on collisions. |
| `async` | boolean | false | Background execution. For chains, `clarify: true` explicitly keeps the run foreground for the clarify UI. |
| `cwd` | string | runtime cwd | Override working directory. |
| `maxOutput` | object | 200KB, 5000 lines | Final output truncation limits. |
| `artifacts` | boolean | true | Write debug artifacts. |
| `includeProgress` | boolean | false | Include full progress in result. |
| `share` | boolean | false | Upload session export to GitHub Gist. |
| `sessionDir` | string | derived | Override session log directory. |
| `acceptance` | string/object/false | inferred | Override the run's inferred acceptance gates. Use `"auto"`, `"attested"`, `"checked"`, `"verified"`, `"reviewed"`, or `{ level: "none", reason: "..." }`. See [orchestration-patterns.md](orchestration-patterns.md#acceptance-gates). |
| `control` | object | config defaults | Override per-run control thresholds. Supports `needsAttentionAfterMs`, `activeNoticeAfterMs`, `inFlightSilenceCeilingMs`, `inFlightSilenceKillMs`, and `notifyOn`. |

`context: "fork"` fails fast when the parent session is not persisted, the current leaf is missing, or the branched child session cannot be created. It never silently downgrades to `fresh`. In multi-agent runs, if any requested agent has `defaultContext: fork` and the launch omits `context`, the whole invocation uses forked context; pass `context: "fresh"` when you intentionally want a fresh run.

At top level, output starts disabled for foreground and async single/parallel runs. Omitted parallel-task progress is disabled, while omitted parallel-task `reads` inherit the agent's `defaultReads`. Clarify also starts top-level output and parallel progress disabled; an edit opts in only for that invocation. Migrate callers that relied on defaults to `output: true` (agent-configured filename), `output: "path"` (explicit path), or `progress: true` (parallel progress).

Use `outputMode: "file-only"` when a saved output may be large and the parent only needs a pointer. It requires `output: true` with an agent-configured filename or an explicit output path. The returned text is a compact reference like `Output saved to: /abs/report.md (48.2 KB, 2847 lines). Read this file if needed.` Failed runs and save errors still return normal inline output for debugging. In chains, later `{previous}` steps receive the same compact reference when the prior step used file-only mode.

Sequential and parallel chain tasks accept `agent`, `task`, `phase`, `label`, `as`, `outputSchema`, `cwd`, `output`, `outputMode`, `reads`, `progress`, `skill`, and `model`. Parallel tasks also accept `count`. Parallel step groups accept `parallel`, `concurrency`, `failFast`, and `worktree`. If `outputSchema` is present, the child must call `structured_output` with schema-valid JSON; prose-only completion or invalid JSON fails the step. Validated structured values are preserved on the step result, and `as` also exposes a compact text representation through `{outputs.name}`.

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
subagent({ action: "interrupt", id: "<run-id>" })
subagent({ action: "interrupt", id: "<nested-run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "follow-up question" })
subagent({ action: "resume", id: "<run-id>", index: 1, message: "follow-up for child 2" })
subagent({ action: "resume", id: "<nested-run-id>", message: "follow-up for a nested child" })
subagent({ action: "doctor" })
```

`status` resolves exact foreground ids, top-level async ids, and nested run ids before falling back to prefix matching. Nested status shows the root/parent path, nested children, session/artifact paths when known, and nested control commands. Inside child-safe fanout mode, bare `status` requires an id when no local foreground run is active, so children cannot enumerate unrelated top-level async runs. Bare `interrupt` still targets only the visible top-level run; interrupting a nested run requires its explicit nested id.

`doctor` prints a full setup report: intercom reachability, config validation, registered agents/chains, run history, and a `Cost` section that breaks down spend by main/sync/async/external slices. When external producers have reported via the `cost:external` protocol, the `Cost` section includes a per-source row for each producer. See [observability.md](observability.md).

`resume` sends the follow-up directly when an async child is still reachable over intercom. After completion, it revives the child by starting a new async child from the stored child session file. Multi-child async runs and remembered foreground single, parallel, or chain runs can be revived by passing `index` to choose the child. Nested runs can be resumed by nested id when their live route or persisted session metadata is available. Revive starts a new child process from the old session context; it does not restart the same OS process, and it requires the chosen child to have a persisted `.jsonl` session file.
