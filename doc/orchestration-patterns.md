# Orchestration patterns

The recommended loop, acceptance gates, worktree isolation for parallel writers,
the recursion guard, and session sharing. Back to [README](../README.md).

## Recommended orchestration pattern (scaffolding)

Use orchestration as parent-agent guidance, not as a runtime workflow mode. For implementation work, the recommended loop is:

```text
clarify -> planner -> worker -> fresh reviewers -> worker
```

Use the optional prompt shortcuts in [skills-and-companions.md](skills-and-companions.md#optional-shortcuts) when you want the pattern to be repeatable.

Packaged `planner`, `worker`, and `oracle` default to forked context when a launch omits `context`; pass `context: "fresh"` when you intentionally want a fresh child run.

Child-safety boundaries are enforced at runtime. Spawned child sessions do not receive the bundled `pi-cohort` skill, and forked child context filtering removes parent-only subagent artifacts (including old hidden orchestration-instruction messages, slash/status/control messages, and prior parent `subagent` tool-call/tool-result history) while preserving ordinary prose and unrelated tool calls/results. By default, children do not register the `subagent` tool and receive boundary instructions that they are not the parent orchestrator and must not propose or run subagents. The explicit exception is an agent whose resolved builtin `tools` includes `subagent`; that child gets a child-safe `subagent` tool for the fanout work the parent assigned, still bounded by `maxSubagentDepth`.

## Acceptance gates

Every run resolves an effective acceptance policy. Callers may omit `acceptance` for the inferred default, or set it on single runs, top-level parallel task items, chain steps, static parallel tasks, and dynamic fanout templates.

```ts
{
  agent: "worker",
  task: "Implement the fix",
  acceptance: {
    level: "verified",
    criteria: ["Patch the bug without widening scope"],
    evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
    verify: [{ id: "focused", command: "npm test", timeoutMs: 120000 }]
  }
}
```

Accepted levels are `auto`, `none`, `attested`, `checked`, `verified`, and `reviewed`. `acceptance: "auto"` is the default. Read-only reviewer/scout tasks infer lightweight attestation, normal writer tasks infer checked evidence, and async/risky/dynamic writer contexts infer a reviewed gate. To disable gates, prefer `{ level: "none", reason: "..." }`.

Acceptance provenance is stored separately from child prose:

- `claimed`: child finished but did not provide structured evidence.
- `attested`: child returned a structured acceptance report.
- `checked`: runtime structural checks passed, such as required evidence and no staged files.
- `verified`: configured runtime verification commands passed. Child-reported command success does not count.
- `reviewed`: an independent reviewer result is present.
- `rejected`: attestation, structural checks, verification, or review failed.

For `attested` or stricter levels, the child prompt includes a standardized acceptance section and asks for a fenced `acceptance-report` JSON block. Explicit failed gates fail the run. Inferred gates are persisted for observability without breaking older calls that omit `acceptance`.

## Worktree isolation

Parallel agents can clobber each other if they edit the same checkout. `worktree: true` gives each parallel child its own git worktree branched from `HEAD`.

```ts
{ tasks: [
  { agent: "worker", task: "Implement auth", count: 2 },
  { agent: "worker", task: "Implement API" }
], worktree: true }

{ chain: [
  { agent: "scout", task: "Gather context" },
  { parallel: [
    { agent: "worker", task: "Implement feature A from {previous}" },
    { agent: "worker", task: "Implement feature B from {previous}" }
  ], worktree: true },
  { agent: "reviewer", task: "Review all changes from {previous}" }
]}
```

Requirements:

- run inside a git repo
- working tree must be clean
- `node_modules/` is symlinked into each worktree when present
- task-level `cwd` overrides must be omitted or match the shared cwd
- configured `worktreeSetupHook` must return valid JSON before timeout - see [configuration.md](configuration.md#worktreesetuphook)

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to artifacts. Worktrees and temp branches are cleaned up in `finally` blocks.

## Session sharing

Pass `share: true` to export a full session to HTML, upload it to a secret GitHub Gist through your `gh` credentials, and return a `https://shittycodingagent.ai/session/?<gistId>` URL.

```ts
{ agent: "scout", task: "...", share: true }
```

This is disabled by default. Session data may contain source code, paths, environment variables, credentials, or other sensitive output. You need `gh` installed and authenticated.

## Recursion guard

Subagents can call `subagent` only when their resolved builtin tools explicitly include `subagent`. That is meant for delegated fanout agents, not ordinary worker/reviewer children. A depth guard prevents unbounded nesting.

By default, nesting is limited to two levels: main session -> subagent -> sub-subagent. Deeper calls are blocked with guidance to complete the current task directly. Nested runs appear in the parent status widget and `status` output as a tree, and `status`, `interrupt`, and `resume` can target a nested run by its id.

Configure the limit with:

1. `PI_SUBAGENT_MAX_DEPTH` before starting Pi
2. `config.maxSubagentDepth`
3. `maxSubagentDepth` in agent frontmatter, which can only tighten the inherited limit

```bash
export PI_SUBAGENT_MAX_DEPTH=3
export PI_SUBAGENT_MAX_DEPTH=1
export PI_SUBAGENT_MAX_DEPTH=0
```

`PI_SUBAGENT_DEPTH` is internal and propagated automatically. Do not set it manually.
