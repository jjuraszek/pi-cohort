---
name: pi-cohort
description: Use when a `subagent` call needs a decision the tool schema leaves open - fresh vs fork, which acceptance level, a per-task override, a control action on a running job, or an agent/chain config field.
---

# pi-cohort: subagent judgement the schema leaves open

## Overview

The `subagent` tool description and schema are the reference for modes, chain variables, management and diagnostics; this skill covers only what they leave open. The parent orchestrates and owns every write to the repository; children execute narrow tasks and report.

## Boundaries

- Parent: writes to the repo, decides, synthesizes. Children: write only to their `output` path or a file the task explicitly assigns.
- `output` in parallel mode is an absolute path outside the repo; a relative path resolves against the child's `cwd` and lands in the tree.
- `context` and `async` are invocation-level (beside `tasks`/`chain`), never inside a task object. When top-level `context` is unset and any task's agent has `defaultContext: fork` (`worker`, `oracle`, `planner`), the whole invocation forks.
- Nesting depth defaults to 2; a child runs `subagent` only when its resolved tools include it.
- A child that needs an unapproved decision stops with `BLOCKED: <decision needed>` as its first line, then `Done:` and `Remaining:`.

## When to use

- Choosing fresh vs fork, or a fork failed with "no persisted session".
- Deciding an `acceptance` level or reading an acceptance ledger.
- A per-task field (`reads`, `outputMode`, `outputSchema`, `skill`, `as`) is unclear.
- A run emitted `needs_attention`, or you need `status` / `interrupt` / `resume`.
- Authoring agent or chain config: read `reference/config-fields.md`.

## Fresh vs fork

| Need | Use | Why |
|---|---|---|
| Adversarial review of a diff, file, or plan | `context: "fresh"` | the reviewer sees the repo, not your reasoning |
| Advice that must know decisions already taken | `context: "fork"` with `oracle` | a branched thread inherits the whole parent history |
| Implementation of an approved plan | `worker` (forks by default) | the worker sees the approval and constraints |
| No persisted parent session | `context: "fresh"` | forks fail without a session file |
| Parallel fanout | `context: "fresh"` | one forked copy per task is a full-price call each |

A fork is a branch of the persisted parent session: full history, no filtering. It is not a lighter context.

## Acceptance levels

`acceptance.level` unset means `auto`: read-only agents and read-only task wording infer `attested` with `review-findings` + `residual-risks`; other non-write tasks infer `attested` with `manual-notes` + `residual-risks`; write tasks infer `checked`; async write tasks, dynamic fanout, and risky wording (release, migration, security, destructive) infer `reviewed` with a required `reviewer` gate.

| Level | Required evidence | Use when |
|---|---|---|
| `none` | - | throwaway probe |
| `attested` | `manual-notes`, `residual-risks` (explicit); auto read-only: `review-findings`, `residual-risks` | read-only findings |
| `checked` | `changed-files`, `tests-added`, `commands-run`, `residual-risks`, `no-staged-files` | ordinary write task |
| `verified` | `checked` + `validation-output` | runtime must run `verify` commands |
| `reviewed` | same as `verified`, plus a `review` result | independent reviewer gate expected |

A child saying "done" is evidence, not verification. `reviewed` means a reviewer returned a result.

## Per-task overrides

| Field | Effect |
|---|---|
| `model` | overrides the agent's model for this task |
| `label`, `phase` | status/graph readability only |
| `output` | file the child's result is saved to; absolute in parallel mode |
| `outputMode: "file-only"` | result goes to `output` only; the parent receives a file reference (use for large handoffs) |
| `reads` | files injected into the child before its task; `false` disables the agent's `defaultReads` |
| `progress` | child appends to `progress.md` in the chain dir |
| `skill` | csv of skills injected into this task's child (execution-time; management config uses plural `skills`) |
| `cwd` | child working directory; pass the worktree path or the child inherits pi's launch dir |
| `acceptance` | per-task override, same shape as top-level |
| `as`, `outputSchema` | the child must call `structured_output` with schema-valid JSON or the step fails; later steps read `{outputs.<as>}` |

## Control actions

Lifecycle (`queued`, `running`, `paused`, `complete`, `failed`) is separate from attention. `needs_attention` means no activity past the threshold; it is not a failure.

- `status` (optionally `id`): active runs and their children.
- `interrupt` (optionally `id`, including a nested run id): cancels the current child turn and leaves the run `paused`. Bare `interrupt` does not reach hidden nested descendants. Then decide: `resume` with clearer instructions, replace the task, ask the user, or stop.
- `resume` (`id`, `message`, `index` for multi-child runs): revives a finished, failed, or paused child from its persisted session file as a new child process. A running child cannot be resumed; a child with no `.jsonl` session fails with that reason.
- Thresholds: `control: { needsAttentionAfterMs, inFlightSilenceCeilingMs, inFlightSilenceKillMs, notifyOn }` beside `tasks`; the kill is `max(inFlightSilenceKillMs, inFlightSilenceCeilingMs + needsAttentionAfterMs)`.
- Long-running async job: its task must instruct it to emit observable progress (log lines, counts, phase names). A silent long job is a defect. Pair it with a monitor, giving it the `Async dir:` from the start message:

```
subagent({ agent: "worker", async: true, task: "<long job - emit progress lines as you work>" })
  -> Async: worker [R]  Async dir: <D>
subagent({ agent: "monitor", async: true, task: "Watch async run R at <D>. Report every 15m. Stop when it ends." })
```

## Quick reference

```
// parallel, fresh, outputs outside the repo
subagent({ async: false, context: "fresh", tasks: [
  { agent: "scout", cwd: "<root>", reads: false, output: "/tmp/x/scout.md", task: "Read-only ..." },
  { agent: "reviewer", cwd: "<root>", reads: false, output: "/tmp/x/review.md", task: "Read-only ..." }
]})

// chain with a parallel step and a structured producer
subagent({ async: false, chain: [
  { agent: "scout", as: "targets", outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } }, required: ["files"] }, task: "..." },
  { parallel: [ { agent: "reviewer", task: "Review {outputs.targets}" }, { agent: "reviewer", task: "Test gaps in {outputs.targets}" } ] },
  { agent: "worker", task: "Apply accepted fixes from {previous}" }
]})

// background job, then control (pair long jobs with a monitor - see Control actions)
subagent({ agent: "worker", async: true, task: "<long job - emit progress lines as you work>" })
subagent({ action: "status" })
subagent({ action: "resume", id: "<run-id>", message: "Continue with ..." })
```

## Config fields

Agent and chain management config (`action: create|update`, `config.steps[].skills`, `control` thresholds): read `reference/config-fields.md`.

## Red flags

- `context` or `async` inside a task object.
- Relative `output` in a parallel dispatch.
- Calling a run `reviewed` because the worker reported success.
- Forking for a parallel fanout or an adversarial review.
- Interrupting a child because it was quiet for a minute; check `status` first.
