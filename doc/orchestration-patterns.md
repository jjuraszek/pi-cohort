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

When a child also has `outputSchema`, it writes the fenced `acceptance-report` in its final text message, then calls `structured_output` as its final action. The report stays in prose; the schema value stays in the tool payload and in `{outputs.name}` without the report.

Use `acceptance: { level: "attested" }` for tree-backed reviewers. Their patches are staged by construction, so `checked`, `verified`, and `reviewed` fail the `no-staged-files` runtime check with `Staged files present: ...`.

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

After a worktree parallel step completes, per-agent diff stats are appended to the output and full patch files are written to a run-scoped directory (`<session artifacts>/<runId>/worktree-diffs`), so concurrent or sequential worktree dispatches from the same session never overwrite each other's patches. Background keeps `<asyncDir>/worktree-diffs/step-<i>` and chain keeps `<chainDir>/worktree-diffs/step-<i>` - both already run-scoped. A later chain step references a task's patch by name with `{outputs.name.patchPath}` instead of the directory layout; the reference resolves only when the task made changes and the capture succeeded (see [Chain variables](agents-and-chains.md#chain-variables)). The diff is captured before every post-execution return - normal or interrupted - so the summary is attached even when a run ends early; a capture failure is reported in the summary rather than showing up as an empty patch. Worktrees and temp branches are cleaned up in the existing `finally` blocks on completion, `stopOn`, abort, or task error. When configured, `worktreeTeardownHook` runs exactly once per successfully created task checkout, before checkout removal and branch deletion. This includes setup-failure rollback: teardown runs for the failing checkout, then for any earlier checkouts. Setup and teardown hooks are independent; see [configuration.md](configuration.md#worktreesetuphook).

Teardown failures are best-effort warnings and do not prevent removal, branch deletion, or cleanup of other checkouts; task results and original setup errors are unchanged. Git removal and branch-deletion failures also produce warnings, even without a hook. Warning writes do not wait for delivery and may be lost on process exit. Task-checkout pruning remains best-effort and silent on failure. Hooks execute synchronously, with a timeout per checkout; cleanup is not guaranteed if the host process is killed.

A later chain child can use `cwd: "{outputs.impl_1.treePath}"` to review a named implementer's files. On first reference, the chain creates a detached checkout of the producer's base commit and applies its captured patch with `git apply --index`. The checkout root is `<chainDir>/worktree-trees/step-N/task-I-<agent>/` in foreground runs or `<asyncDir>/worktree-trees/step-N/task-I-<agent>/` in background runs (indices are 0-based). No patch means no tree: the referencing task fails before dispatch; a build failure also fails that task. Repeated references to the same name share one tree, including `count` copies. Read-only use is a persona convention, not enforced; tree-backed changes are not captured as another patch.

These output-reference trees are separate from task checkouts: no `node_modules` symlink, setup or teardown hook, or reapplication of the implementer's cwd subdirectory. They last only until the chain call or background run ends and are removed on completion, `stopOn`, abort, or error; cleanup failures are logged without changing the result. A consuming `worktree: true` step cannot use output references in `cwd`. See [Chain variables](agents-and-chains.md#chain-variables) for cwd rules and [Acceptance gates](#acceptance-gates) for the staged-patch caveat.

For a tree-backed async step, `reads:` instructions are rendered at start time against `runnerCwd`, not the later tree. Use absolute paths or name files in task text instead.

Patches include binary payloads for modifications, additions, and deletions, so `git apply <patchPath>` preserves exact binary contents when applied to the captured base commit. Git writes the patch directly to its artifact file without buffering its payload in the parent process.

A relative `output:` on a `worktree: true` task no longer resolves inside the throwaway checkout - it resolves to the run's per-task directory instead (`<session artifacts>/<runId>/task-<i>/` foreground, `<asyncDir>/step-<i>/task-<j>/` async), so the report survives worktree teardown and stays out of the captured patch. An absolute `output:` is used as-is. A relative path that escapes its per-task directory (e.g. `../report.md`) or normalizes to the directory itself (`.`) is rejected at dispatch. `reads:` and the task's working directory still resolve inside the checkout, unchanged.

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
