# Worktree teardown hook before `worktree: true` checkout removal

**Goal:** Give the consuming repo one chance to release resources attached to a `worktree: true` checkout before pi-cohort deletes it, through a `worktreeTeardownHook` that mirrors `worktreeSetupHook`.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Ticket:** #27
**Date:** 2026-10-26

## Problem

A `worktree: true` dispatch removes each task checkout with `git worktree remove --force` followed by `git branch -D` (`src/runs/shared/worktree.ts:479-486`, and the rollback at `361-369` when the setup hook fails). Nothing runs before that removal, and git has no hook that fires on `worktree remove`. A consuming repo whose setup hook provisions per-checkout resources (the ticket's reporter found 24 leaked Postgres databases and 11 stale registry rows after an audit; those are the consumer's examples, not a requirement for database-specific cleanup) has no point at which to release them.

Ticket #27 asks for a consumer-configured teardown hook that runs while the checkout still exists, with failure never blocking removal. The user's instruction "stay generic about how it's implemented" fixes the observable contract (config keys, stdin payload, ordering, failure handling) and leaves internal placement to the plan.

Premise correction: AC3 expects the failure to be "logged where existing worktree-cleanup failures are logged". For `worktree: true` checkouts there is no such place: `cleanupSingleWorktree` and the prune in `cleanupWorktrees` (`worktree.ts:592-599`) swallow every error silently; only output-reference tree removal logs, via `console.warn` in `removeTrees` (`worktree.ts:582`, `587`). This spec introduces the log site and, by the user's decision (Q1 B), extends it to the `git worktree remove` and `git branch -D` failures on the same path.

Framing: kept

## Acceptance criteria

Ticket #27, `## Acceptance criteria`, rows verbatim:

- [ ] With `worktreeTeardownHook` configured to a script that records its stdin, a `worktree: true` task runs to completion; the script ran exactly once per created worktree, received a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`, and `worktreePath` still existed on disk at the moment the script ran.
  in-scope
- [ ] Using the recording script from the preceding criterion, exercise normal completion, `stopOn`, abort, error, and the rollback that removes a worktree whose setup hook failed; in each case the script recorded exactly one invocation per created task checkout while `worktreePath` still existed, and the checkout is absent afterward.
  in-scope
- [ ] A hook that exits nonzero or exceeds `worktreeTeardownHookTimeoutMs` (default 30000, like the setup hook's timeout) does not prevent the worktree from being removed; the failure is logged where existing worktree-cleanup failures are logged, naming the checkout path and the exit code or timeout, and the task result is unchanged. The hook's stdout is ignored.
  in-scope
- [ ] With no `worktreeTeardownHook` configured, worktree creation and cleanup behave exactly as before; the existing worktree test suite passes without modification.
  in-scope
- [ ] `worktreeTeardownHook` accepts the same path forms and has the same rejection behavior as `worktreeSetupHook`.
  in-scope
- [ ] `doc/configuration.md` documents `worktreeTeardownHook` and `worktreeTeardownHookTimeoutMs` beside `worktreeSetupHook`, the worktree-isolation section of `doc/orchestration-patterns.md` names the teardown hook, and `CHANGELOG.md` has an entry.
  in-scope

Design clauses that fix the readings of these rows:

- AC2 "created task checkout" means a checkout whose `git worktree add` succeeded. The hook runs in the existing rollback inside `createSingleWorktree`, which today is reached only when the setup hook throws; it does not run when `git worktree add` itself failed, because no checkout exists. No new rollback condition is introduced.
- AC3 "logged where existing worktree-cleanup failures are logged" is satisfied by the new cleanup-failure log site this spec introduces on the `worktree: true` cleanup path, carrying the same information the existing `removeTrees` warning carries (path and cause). The warning's exact wording is not part of the contract; its observable fields are (see Failure semantics).
- AC4 "behave exactly as before" covers worktree creation, successful removal, and task results, plus the existing no-hook regression suite passing unchanged. The one explicit exception is the Q1 B decision: a failing `git worktree remove --force` or `git branch -D` is now logged on the failure path whether or not a teardown hook is configured; that path was silent before.
- AC5 "same rejection behavior" holds at two boundaries, each mirroring the setup pair. At the public configuration boundary, the three executors pass `worktreeSetupHook` through a truthiness guard, so an empty string is treated as unset; the teardown twin does the same. At the resolver boundary, a non-empty teardown path and the timeout are validated once at `createWorktrees` time, before any checkout exists, and an invalid value throws the same way an invalid setup hook does.

## Design

### Configuration

Two new `ExtensionConfig` keys beside `worktreeSetupHook` / `worktreeSetupHookTimeoutMs` (`src/shared/types.ts:870-871`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `worktreeTeardownHook` | string | unset | Path to the hook. Same forms as the setup hook: absolute, `~/`-prefixed, or repo-relative (must contain a path separator; resolved against the repo toplevel). A bare name, a missing file, or a directory is rejected by the resolver. An empty string is treated as unset at the executor boundary, exactly as `worktreeSetupHook: ""` is today; the resolver itself rejects an empty path for direct `createWorktrees` callers, as the setup resolver does. |
| `worktreeTeardownHookTimeoutMs` | positive integer | 30000 | Wall-clock limit for one invocation. Non-positive, non-integer, or non-finite values are rejected. |

Neither key implies the other; setup-only and teardown-only configurations are both valid. Absent `worktreeTeardownHook`: no teardown validation or invocation (AC4; the Q1 B cleanup-failure logging is independent of the hook, see the AC4 design clause).

Validation happens once per `createWorktrees` call, before any `git worktree add`, by a teardown resolver that applies exactly the setup resolver's rules (`resolveWorktreeSetupHook`, `worktree.ts:199-230`, and `parseHookTimeout`, `worktree.ts:191-197`) and throws the same-shaped messages with "teardown" in place of "setup" - for example `worktree teardown hook must be an absolute path or a repo-relative path` and `worktree teardown hook timeout must be an integer greater than 0`. A rejected configuration fails the dispatch up front with no checkout to roll back (AC5). Per the chosen approach (A, inline sibling), the teardown hook gets its own resolver and runner entry points beside the setup pair; whether they reuse the existing parsing and path-expansion helpers is a plan decision. Merging the two runners or the two removal paths stays rejected (Out of scope).

The configured values reach `createWorktrees` the way the setup pair does today: each of the three executors (`src/runs/foreground/subagent-executor.ts:1296-1318`, `src/runs/foreground/chain-execution.ts:658-662`, `src/runs/background/subagent-runner.ts:2131-2135`) and the background config relay (`src/runs/background/async-execution.ts`) carry the teardown twin beside every place they carry the setup pair.

### Payload

The teardown hook receives on stdin the identical JSON object the setup hook receives for that checkout - `WorktreeSetupHookInput` (`worktree.ts:54-64`): `version: 1`, `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, `baseCommit`, and `agent` when present. The ticket's seven fields are a subset. There is no `phase` discriminant and no narrower teardown type; the consumer configures two distinct paths and so already knows which phase is running.

The payload is built once at creation time, before the setup hook runs, and is available to both removal paths: the rollback inside `createSingleWorktree` (which runs before any record is returned) and the ordinary cleanup, which reads it from the per-checkout record that `createWorktrees` returns and `cleanupWorktrees` consumes, together with the resolved teardown config. It is built the same way when no setup hook is configured, so a teardown-only configuration receives the same object a setup hook would have. Building the payload once, rather than rebuilding it at teardown, guarantees the two hooks see identical values; where it is stored and where it is constructed are plan decisions. `cleanupWorktrees`' signature does not change; its three callers need no edit.

### Invocation

A teardown runner is the first statement of both removal paths for a `worktree: true` checkout:

1. the existing rollback inside `createSingleWorktree` (the `catch` at `worktree.ts:361-369`), reached today only when the setup hook throws;
2. `cleanupSingleWorktree` (`worktree.ts:479-486`), which every executor reaches from its `finally` block and which `createWorktrees` calls for earlier checkouts when a later one fails.

The runner is skipped when the record carries no teardown config. It mirrors `runWorktreeSetupHook` (`worktree.ts:271-314`): `spawnSync`, `shell: false`, cwd = the checkout path, stdin = the serialized payload, timeout from config - with two deliberate differences fixed under Failure semantics: stdout is discarded without buffering, and termination at the timeout is bounded. The checkout exists on disk when it runs, which is the whole point of the ordering (AC1, AC2).

Each record reaches exactly one removal path: a checkout whose setup failed is removed by the rollback and never enters the returned list; every checkout in the returned list is removed once by `cleanupWorktrees`. So the hook fires exactly once per created checkout (AC2).

### Failure semantics

The runner never throws. Non-zero exit, timeout, and spawn error (for example the file became non-executable or vanished after validation) each produce one log emission that names the checkout path and the cause - the exit code, the timeout in ms, or the spawn error message - with the hook's trimmed stderr appended when present. The contract is those observable fields, not an exact message template. Removal then proceeds unchanged and the task result is untouched (AC3).

The timeout is a hard bound on how long removal can be delayed. `spawnSync`'s default timeout handling sends SIGTERM and keeps waiting for the child to exit, so a hook that handles SIGTERM without exiting would hold removal past `worktreeTeardownHookTimeoutMs`; the teardown runner must terminate the hook within a bounded time even then (the mechanism - kill signal, escalation, or equivalent - is a plan decision). The hook's stdout is discarded without buffering: a chatty hook must not turn into a buffer-limit spawn error (the runner's exact stdio options are a plan decision; the setup runner cannot share them because it parses stdout).

Both git operations at both removal sites - `git worktree remove --force` and `git branch -D` in the rollback and in `cleanupSingleWorktree` - also log on failure (Q1 B), identifying the checkout path and the failed operation, and the branch name for a branch-deletion failure, with the git error message. The existing `removeTrees` warning at `worktree.ts:582` is the model for the information carried.

Logging policy for every emission above: nonwaiting and best-effort. Nothing is awaited, no UI or notification path is involved, and no sink error or backpressure can escape into cleanup - a log call that fails leaves removal, the returned records, and the task result exactly as if it had succeeded. The implementation chooses the sink (the foreground executors' `console.warn` and the background runner's file-backed stderr, `async-execution.ts:148-165`, are the existing ones); the policy, not `console.warn`, is the requirement. The rollback rethrows the original setup error unchanged after logging, so a dispatch with a failing setup hook still fails as it does today.

### Not changed

- Output-reference trees (`materializeTree` / `removeTrees`, `worktree.ts:562-590`): no hook, no behavior change; the ticket excludes them.
- The `git worktree prune` in `cleanupWorktrees` stays silent on failure; the Q1 B decision names only worktree removal and branch deletion.
- The setup hook's resolver, runner, error strings, payload, and tests are untouched.

## Errors and edge cases

| Situation | Behavior |
|---|---|
| Invalid `worktreeTeardownHook` or timeout | `createWorktrees` throws before any `git worktree add`; the dispatch fails with the resolver's message; nothing to roll back |
| Hook exits non-zero | one log emission with path, exit code, trimmed stderr; removal proceeds; task result unchanged |
| Hook exceeds timeout | the runner terminates the child within a bounded time even if it handles SIGTERM; one log emission with path and the timeout in ms; removal proceeds |
| Spawn error at run time (EACCES, ENOENT after validation) | one log emission with path and error message; removal proceeds |
| Hook writes to stdout | discarded without buffering; any volume of stdout is not a failure |
| Log sink fails or blocks (closed stderr, slow file-backed stderr in a background runner) | the emission is best-effort; removal, records, and task result unaffected |
| Hook deletes or moves the checkout itself | `git worktree remove --force` fails and is now logged with the checkout path; `git branch -D` failure, if any, is logged with the branch; cleanup continues to the next record and the prune |
| `worktreeTeardownHook: ""` in settings | treated as unset at the executor boundary, as `worktreeSetupHook: ""` is today; no validation, no invocation |
| Setup hook configured, teardown not (or vice versa) | each hook independent; the absent one is simply not run |
| Setup hook fails on checkout N | teardown runs for checkout N (rollback), then `createWorktrees` runs `cleanupWorktrees` for checkouts 0..N-1, each running teardown once; original error rethrown |
| Executor `stopOn`, abort, or task error | `cleanupWorktrees` already runs in `finally`; teardown runs there once per checkout |
| Process killed (SIGKILL) during a run | no teardown, as with every other `finally`; no promise is made for this case, matching the setup hook |
| Slow hook in a foreground executor | `spawnSync` blocks the event loop up to the timeout per checkout, as the setup hook does today; the default 30000 ms bound applies |

## Tests

Unit tests in `test/unit/worktree.test.ts`, beside the existing hook tests (`319-480`), reusing `createHookScript` (Node shebang script, chmod 755, skipped on win32 via `hookScriptSkip`) and a temp git repo. The recording script asserts that `worktreePath` exists at run time and appends its stdin JSON to a file outside the checkout.

1. Teardown hook runs exactly once per checkout on `cleanupWorktrees`, receives the identical payload the setup hook received (compare the two recorded JSON objects per checkout), and the checkout is absent afterward. A teardown-only variant (no setup hook) receives the same object shape.
2. Non-zero exit, timeout, and spawn error: `cleanupWorktrees` completes, `git worktree list` shows no task checkouts, the captured log output names the path and the exit code / timeout / spawn error (asserted on those fields, not on an exact template); the function returns normally. Timeout regression: a hook that traps SIGTERM and keeps running is still terminated, removal proceeds within a bounded time, and the returned result is unchanged.
3. Rollback: setup hook fails on checkout 1 of 2; teardown recorded exactly once for checkout 1 and once for checkout 0; the setup error is rethrown unchanged.
4. Resolver rejection: invalid teardown path forms (bare name, missing file, directory, empty string at the resolver) and invalid timeout values are rejected before any checkout exists, with `worktree teardown hook ...` messages, including `worktree teardown hook timeout must be an integer greater than 0`. Public parity: at the executor boundary `worktreeTeardownHook: ""` dispatches as if unset, exactly as `worktreeSetupHook: ""` does.
5. Git cleanup failure logs: a checkout path removed from disk before `cleanupWorktrees` produces a log line naming the checkout path for the failed `git worktree remove`; a branch deleted before cleanup produces one naming the branch for the failed `git branch -D`; cleanup still completes in both cases.
6. Log sink isolation: with the log sink made to throw (for example a stubbed `console.warn`), teardown-hook and git-cleanup failures still leave removal complete and the function's result unchanged.
7. Large stdout: a hook writing several MiB to stdout is not reported as a failure and removal proceeds.
8. AC4: the existing worktree unit and integration tests pass with no edits.

Terminal-path coverage (AC1, AC2) is dedicated executor-level scenarios, not edits to existing ones: the existing no-hook `worktree: true` integration tests (`test/integration/chain-execution.test.ts`, `parallel-execution.test.ts`, `async-execution.test.ts`) stay unchanged as AC4's baseline. New scenarios, one each, run a `worktree: true` step with `worktreeTeardownHook` set to the recording script and end it by: normal completion; `stopOn` matching on the worktree-bearing group itself (not a later step); aborting the supplied `AbortSignal` while the worktree task runs; and a task error on the worktree task. Each asserts exactly one record per successfully created checkout, that `worktreePath` existed at invocation (the script checks), and that the checkout is absent afterward. A scenario in which no checkout was created proves nothing and does not count. The rollback leg of AC2 is unit test 3.

Run: `env -u PI_CODING_AGENT_DIR npm run test:unit`, `npm run test:integration`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/configuration.md` `## worktreeSetupHook` - gains `worktreeTeardownHook` and `worktreeTeardownHookTimeoutMs`, the shared stdin payload, and the best-effort failure contract (operations / tunable parameters; communication contract); `doc/orchestration-patterns.md` `## Worktree isolation` - names the teardown point in the checkout lifecycle and the cleanup-failure logging now true for task checkouts (architecture); `CHANGELOG.md` - a `## [Unreleased]` `### Added` entry naming `worktreeTeardownHook` and `worktreeTeardownHookTimeoutMs` with `(#27)`, written in this change (the file currently has no `[Unreleased]` section; this change creates it). Only promotion of that section to a release heading is deferred to release (AC6).
- Derived / memory docs invalidated: none - `README.md` routes settings to `doc/configuration.md` and does not list the hook keys

Bar applied per `reference/documentation-impact.md`.

## Out of scope

- Running the teardown hook for output-reference trees (`{outputs.<name>.treePath}`); the ticket names this as a separate decision.
- Wiring the hook in any consuming repo.
- A `phase` field or any other change to the setup hook's stdin contract.
- Refactoring the two removal paths into one function, or the two hook runners into one; both were considered and rejected as not required by the contract.
- Asynchronous or non-blocking hook execution; the teardown runner mirrors the setup runner's `spawnSync`.

## Open questions

none
