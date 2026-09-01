# Run-scoped worktree artifacts (gh-8)

Issue: [jjuraszek/pi-cohort#8](https://github.com/jjuraszek/pi-cohort/issues/8)

## Problem

Three independent data-loss paths in worktree-isolated dispatch: two where a path
resolves somewhere shared between runs or destroyed at teardown, one where the capture
that is supposed to preserve the work never runs.

**1. Foreground parallel patch files are not run-scoped.** `buildParallelWorktreeSuffix`
(`src/runs/foreground/subagent-executor.ts:1468-1477`) returns
`path.join(artifactsDir, "worktree-diffs")`, and `getArtifactsDir(sessionFile)`
(`src/shared/artifacts.ts:7-12`) is `<sessionDir>/subagent-artifacts` - the same
directory for every run in the session. Patch filenames are
`task-<index>-<safeAgent>.patch` (`src/runs/shared/worktree.ts:541`), encoding only
task position and agent. Two parallel `worktree: true` dispatches from one session -
concurrent or sequential - silently overwrite each other's patches. Second writer
wins, no error. Background (`<asyncDir>/worktree-diffs/step-<i>`) and chain
(`<chainDir>/worktree-diffs/step-<i>`) are already run-scoped one level up.

**2. Foreground parallel capture is skipped entirely on three reachable return paths.**
`runParallelPath` returns early on the interrupted, detached, and intercom-receipt
branches (`subagent-executor.ts:1875-1912`), all of which precede the function's only
capture call (`buildParallelWorktreeSuffix`, `:1914`), while the enclosing `finally`
runs `cleanupWorktrees` unconditionally. Agent edits in those states are deleted with
no patch ever written. `diffWorktrees` additionally converts a `diffsDir` mkdir failure
or a per-task capture exception into an empty patch and reports success
(`worktree.ts:525-548`), so a capture failure is indistinguishable from "agent changed
nothing".

**3. A relative `output:` under isolation is written inside the throwaway checkout.**
`resolveSingleOutputPath` (`src/runs/shared/single-output.ts:29-40`) resolves a
relative path against `requestedCwd`, which under `worktree: true` is the generated
worktree `agentCwd`. The report is then staged by `captureWorktreeDiff`'s `git add -A`
(`worktree.ts:441-452`), polluting the patch, and deleted with the worktree. Affects
**foreground and async** parallel dispatch; `test/integration/async-execution.test.ts:799-853`
currently codifies the broken behavior as expected. Chain steps are already correct -
`chain-execution.ts:625-628` resolves relative outputs under `chainDir`.

## Contract

> A worktree checkout is throwaway. Nothing a caller wants to keep may resolve inside
> it, and nothing durable a run produces may share a path with another run.

Three mechanisms. Two are pure path resolution; the third makes capture unskippable.
No change to the synthetic-path exclusion set, patch content, or worktree cleanup
timing.

### 1. Run-scoped artifacts root (foreground)

`buildParallelWorktreeSuffix` (private to `subagent-executor.ts:1468-1477`; it returns
`formatWorktreeDiffSummary(diffs)`, a possibly-empty summary string) takes `runId` and
builds its internal `diffsDir` as `<artifactsDir>/<runId>/worktree-diffs` instead of
`<artifactsDir>/worktree-diffs`. `runId` is already in scope at the call site
(`:1914`) - it is generated once per execute invocation (`:2408-2412`) and already
passed to `createWorktrees`. `diffWorktrees` mkdirs the directory it is given
(`worktree.ts:527`), so no caller-side directory creation is added.

Background and chain diff directories are **unchanged**: `asyncDir` and `chainDir`
already contain a run id, and adding a second segment would be redundant.

### 2. Capture before every teardown path

Every post-execution return in `runParallelPath` - normal, interrupted, detached,
intercom-receipt - passes through one capture attempt before `cleanupWorktrees` runs,
and the resulting summary is appended to that branch's response text. Capture is
attempted exactly once per run.

`diffWorktrees` stops reporting failure as success: a `diffsDir` creation failure or a
per-task capture exception is surfaced in the summary text naming the affected task and
the error, instead of yielding a silent empty patch. The worktree is still removed -
retaining checkouts past cleanup is explicitly out of scope (see
[Out of scope](#out-of-scope)) - but the loss is now reported rather than invisible.

### 3. Relative-output redirect under isolation

A task with `worktree: true` and a **relative** `output:` resolves that path against a
per-task leaf of the run's durable directory instead of the worktree cwd:

| Surface | Leaf |
|---|---|
| foreground parallel | `<artifactsDir>/<runId>/task-<i>/` |
| async parallel | `<asyncDir>/step-<i>/task-<j>/` |
| chain | unchanged (already `chainDir`-relative) |

An **absolute** `output:` is written to exactly that path, always, unchanged. A
non-worktree task is unchanged. The redirect rides `resolveSingleOutputPath`'s
existing `requestedCwd` parameter - that function's signature and resolution rule do
not change.

Per-task leaves make collision structurally impossible, so `count: N` fan-out with a
single relative filename keeps working, and no duplicate-path validation is added to
the background dispatch path (which has none today).

## Design

### Single resolution seam

Three foreground sites resolve a parallel task's output with the identical two-line
pattern (`resolveParallelTaskCwd(...)` then `resolveSingleOutputPath(output, ctx.cwd, taskCwd)`):

| Site | Purpose |
|---|---|
| `subagent-executor.ts:1491-1492` | duplicate-path validation (`findDuplicateParallelOutputPath`) |
| `subagent-executor.ts:1513-1514` | dispatch (`runForegroundParallelTasks`) |
| `subagent-executor.ts:1805-1806` | `outputMode: "file-only"` validation |

Three copies of one rule is where a redirect drifts. All three are replaced by a
single helper returning the final absolute path:

```
resolveParallelTaskOutputPath({ output, ctxCwd, taskCwd, isolated, runDir, index })
  -> { path: string } | { error: string }
```

- `isolated` and relative output -> `path.join(runDir, \`task-${index}\`, output)`
- otherwise -> today's `resolveSingleOutputPath(output, ctxCwd, taskCwd)`, byte-identical
- absolute output short-circuits inside `resolveSingleOutputPath` (`single-output.ts:36`)
  and never reaches the branch

`runDir` is the **parent of the per-task leaf**, and the helper always appends
`task-<index>` itself - `<artifactsDir>/<runId>` foreground, `<asyncDir>/step-<i>`
async. `index` is the 0-based in-group task index. The leaf paths in the contract table
are the result after that join, not values passed in.

**Async seam.** The only async site is `resolveSingleOutputPath` inside `buildSeqStep`
(`async-execution.ts:395`). `async-execution.ts:723` is `executeAsyncSingle`, which has
no `worktree` concept at all, and is **not** a site. `buildSeqStep` is shared by
sequential, dynamic, and static-parallel steps and currently receives neither index, so
`stepIndex` and `taskIndex` are threaded in as parameters from the existing
`chain.map` / `s.parallel.map` closures (`:465-473`); sequential and dynamic callers
pass none and are unaffected. `isolated` is the enclosing group's `s.worktree` flag
alone - not the predicted `behaviorCwd`, which is `undefined` only when
`resolveExpectedWorktreeAgentCwd` throws on a non-git cwd, in which case the runner's
own `createWorktrees` fails the same check and the task never runs. `asyncDir` is
already in scope (`:350`), before `buildSeqStep` is defined.

Only the output resolution is redirected. `instructionCwd` still governs `reads:` and
the task's working directory, which must keep resolving against the worktree.

No explicit `mkdir` for the leaf: `persistSingleOutput` already mkdirs `dirname`
(`single-output.ts:102`) for inline mode, and in file-only mode the child's write tool
creates parent directories.

### Escape guard

A relative `output:` that normalizes outside its per-task leaf (`"../report.md"`), or
whose normalized remainder is empty (`"."`, `"dir/.."` - which would create `task-<i>`
as a file where the contract says directory), is **rejected**, at dispatch, on both
surfaces. Without this, two tasks using `../report.md` collide in `<runDir>/`;
foreground's duplicate check would catch it, async has no such check and would silently
clobber.

The helper **returns** `{ error }` and never throws - async only converts
`AsyncStartValidationError` and `UnavailableSubagentSkillError` into clean tool errors
(`async-execution.ts:508-510`), so a thrown generic error would crash async start.
Callers map it: foreground through `buildParallelModeError`, async by wrapping in
`new AsyncStartValidationError`. The message uses the existing **1-based** task
numbering (as in `findDuplicateParallelOutputPath`'s `previous.index + 1`), the raw
`output:` value, and the resolved path.

### Duplicate validation

`findDuplicateParallelOutputPath` is kept unchanged. For worktree tasks its resolved
paths are now structurally distinct so it never fires; it still guards non-worktree
parallel tasks. It is not deleted and not ported to the background path.

### Patch purity

With the report outside the checkout, `git add -A` no longer stages it, so a
`worktree: true` task's patch contains only agent-edited files. This is an observable
behavior change, covered by an acceptance criterion rather than left as a side effect.

### Retention

`cleanupOldArtifacts` (`src/shared/artifacts.ts:43-71`) calls `fs.unlinkSync` on every
entry inside a swallowing try/catch. `unlinkSync` on a directory always throws, so
`worktree-diffs/` is **already** never pruned. Run-scoping multiplies that leak from
one directory to one per run, and now leaks reports rather than only patches.

The function gains an `isDirectory()` branch using
`fs.rmSync(entry, { recursive: true, force: true })`, inside the existing try/catch and
subject to the same `cutoff` and marker logic. Session run directories then age out on
`DEFAULT_ARTIFACT_CONFIG.cleanupDays` like every other artifact, and existing orphaned
`worktree-diffs/` directories are swept retroactively. Directory mtime tracks child
additions - the correct signal for write-once run directories.

`ASYNC_DIR` and `CHAIN_RUNS_DIR` live under `TEMP_ROOT_DIR` (`src/shared/types.ts:931-935`)
and were never in `cleanupOldArtifacts`' scope; async and chain outputs already rely on
OS temp reaping. This spec does not change that, and does not introduce a new gap
there - it inherits an existing, deliberate arrangement.

## Deviation from the issue

The issue's Phase 2 proposes **rejecting** a relative `output:` under isolation,
citing issue #1's precedent that reviewers preferred a breaking reject over silent
relocation. This spec **redirects** instead. Rationale:

- **The codebase already redirects.** Chain steps resolve relative outputs under
  `chainDir` (`chain-execution.ts:625-628`) - the same problem, already solved by
  redirection. Parallel dispatch is the outlier.
- **There is no caller contract to violate.** Under `worktree: true` the cwd is a
  generated throwaway (`pi-worktree-<runId>-...` under tmp) that the caller never named
  and cannot predict at dispatch time. Redirecting away from it does not move a file
  the caller asked for; it replaces an unusable resolution with a usable one. #1's
  "don't write to a path the caller didn't ask for" reasoning applied to the caller's
  own cwd - here no such path exists.
- **Rejection is unimplementable for async in practice.** An async caller cannot
  reasonably mint an absolute path per task before dispatch, so rejection would leave
  async either broken or permanently exempt.
- **Discoverability is preserved.** `formatSavedOutputReference` (`single-output.ts:74`),
  used by `finalizeSingleOutput`, reports the absolute path back as
  `Output saved to: <path> ...`.

Consequence: **this is not a breaking change.** The issue's cross-repo coordination
note - that `pi-gauntlet`'s parallel-wave example passes a relative `output:` and must
be corrected in lockstep - no longer applies. That example keeps working, and its
report now survives. No `pi-gauntlet` change is required by this spec.

Also deviating: the issue scopes Phase 2 to foreground parallel dispatch. Async has the
identical bug (`async-execution.test.ts:799-853`) and is included here.

## Acceptance criteria

**Patch scoping**

1. Two parallel `worktree: true` runs from one session write patches to different
   absolute directories, each containing that run's id.
2. A second parallel dispatch leaves the first dispatch's patch files byte-identical.
3. `formatWorktreeDiffSummary` prints exactly one containing directory per run, holding
   only that run's patches.
4. Background runs keep `<asyncDir>/worktree-diffs/step-<i>` and chain runs keep
   `<chainDir>/worktree-diffs/step-<i>`, with no added run-id segment.

**Capture reliability**

5. A foreground parallel worktree run that ends on the interrupted, detached, or
   intercom-receipt branch still writes each task's patch before cleanup, and the
   response text includes the diff summary.
6. A `diffsDir` creation failure or a per-task capture exception is surfaced in the
   response, naming the task and the error; it is not reported as an empty patch.

**Output resolution**

7. A foreground parallel `worktree: true` task with `output: "report.md"` writes to
   `<artifactsDir>/<runId>/task-<i>/report.md`, and the file exists after teardown.
8. The async equivalent writes to `<asyncDir>/step-<i>/task-<j>/report.md` and survives
   teardown.
9. A `reads:` entry under isolation still resolves against the worktree cwd, unchanged.
10. An absolute `output:` is written to exactly that path, never redirected, never
    rejected.
11. A non-worktree task's output path - including sequential and dynamic async steps -
    is unchanged from current behavior.
12. `count: 3` with one relative `output:` filename under isolation produces three
    distinct files.
13. A relative `output:` normalizing outside its per-task leaf, or to the leaf itself,
    is rejected before any agent starts; the error names the 1-based task index and the
    offending value, and surfaces as a tool error on both surfaces (never an uncaught
    throw).
14. A `worktree: true` task's captured patch contains only agent-edited files - no
    report file.
15. The linked dependency directory and setup-hook-declared synthetic paths remain
    excluded from every captured patch.

**Retention**

16. A run directory older than `cleanupDays` is removed recursively by
    `cleanupOldArtifacts`; a fresh one is retained.

## Testing

Unit (`env -u PI_CODING_AGENT_DIR npm run test:unit`):

- `test/unit/single-output.test.ts` - `resolveParallelTaskOutputPath`: absolute
  passthrough, non-worktree passthrough identical to current behavior, worktree
  redirect (single `task-<i>` segment, no doubling), `../` escape and empty-remainder
  (`.`, `dir/..`) rejection returning `{ error }` rather than throwing.
- `test/unit/worktree.test.ts` - `diffWorktrees` writes patches under the run-scoped
  directory it is given and surfaces a per-task capture failure instead of an empty
  patch. `buildParallelWorktreeSuffix` is module-private and returns a summary string,
  not a path, so the run-scoped directory itself is asserted through the integration
  tests below rather than a unit test.
- **New `test/unit/artifacts.test.ts`** - no unit coverage of `artifacts.ts` exists
  today. `cleanupOldArtifacts`: stale directory removed recursively, fresh directory
  kept, marker and cutoff logic unchanged, unreadable entry still swallowed.

Integration (`npm run test:integration`):

- `test/integration/parallel-execution.test.ts` - two sequential worktree runs both
  retain patches in distinct run-scoped directories; relative `output:` lands outside
  the worktree and survives teardown; `count: 3` fan-out yields three files; patch
  contains no report; a run ending on the interrupted, detached, and intercom-receipt
  branches still leaves patches on disk.
- `test/integration/async-execution.test.ts:799-853` - this test asserts **instruction
  strings** only (`Read from: <worktree>/input.md`, `Write your findings to:
  <worktree>/report.md`); it never checks a file after teardown. The `Read from:`
  assertion stays unchanged - `reads:` must keep resolving against the worktree. Only
  the `Write your findings to:` expectation changes, to the durable per-task leaf, plus
  a **net-new** post-teardown existence assertion for that path.

Full suite: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact

Materiality bar per pi-gauntlet's `skills/brainstorming/reference/documentation-impact.md`
(sibling repo; not resolvable inside pi-cohort): a doc entry must change what a reader
does, not mirror code.

- Feature / user-facing docs introduced: none.
- Materially amended existing docs: `doc/orchestration-patterns.md:74-78` (run-scoped
  patch directory; relative `output:` redirect under isolation);
  `doc/programmatic-api.md:151` (the `worktree` row gains the output-resolution rule);
  `CHANGELOG.md`.
- Derived / memory docs invalidated: none. `README.md:135` only links
  `orchestration-patterns.md`, and no `AGENTS.md` section describes artifact paths.

## Out of scope

- Retaining throwaway checkouts or branches past cleanup - including when capture
  failed. The issue names this a hard constraint; the fix is to report the failure, not
  to keep the checkout.
- After-the-fact collision detection - run-scoping removes the collision, so a detector
  would guard an unreachable state.
- Porting duplicate-output validation to the background dispatch path.
- Changing chain output or chain diff paths.
- Bringing `ASYNC_DIR` / `CHAIN_RUNS_DIR` under `cleanupOldArtifacts`.
- Redesigning the synthetic-path exclusion set (`worktree.ts:335-358`) - regression
  guard only.

## Open questions

None.
