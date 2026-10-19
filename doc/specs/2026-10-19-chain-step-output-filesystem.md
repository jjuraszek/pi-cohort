# Chain step output as a filesystem, and acceptance beside outputSchema

**Goal:** A later chain step can run in a prior worktree task's result (base commit plus captured patch) by referencing `{outputs.name.treePath}` in its `cwd`, and a child with both `outputSchema` and acceptance emits its acceptance report and its structured value every time.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Context:** jjuraszek/pi-gauntlet#70 (wave as one chain), pi-gauntlet 2df7fc8 (spec review in a parent-built snapshot), pi-gauntlet 8e14e30 (names this gap), pi-cohort #23 (`stopOn`, `patchPath`).

## Problem

pi-gauntlet (since 7.17.1, 2df7fc8; checked checkout 7f3af2f is 7.18.0) reviews each implementer's work in a snapshot the parent builds between two `subagent()` calls: `git worktree add --detach <tree> <WAVE_BASE_SHA>` then `git apply --index <patch>`, passed as the spec reviewer's `cwd` (`skills/subagent-driven-development/SKILL.md`, "Spec-review snapshots"). The wave chain #70 asks for cannot ship because a chain step has no way to produce that filesystem:

- A parallel worktree step creates its worktrees at step start (`src/runs/foreground/chain-execution.ts:640-660`) and removes them in that step's `finally` (`:795-796`; async `src/runs/background/subagent-runner.ts:2283-2284`). Only the patch files under `<chainDir>/worktree-diffs/step-N/task-I-<agent>.patch` survive into the next step.
- Output references resolve only in `task` and `label` templates (`src/runs/shared/chain-outputs.ts:29-33`, resolved at `chain-execution.ts:240`, `:1070`, `subagent-runner.ts:641`). `cwd` is resolved per step by `resolveChildCwd` (`chain-execution.ts:268`, `:640`, `:1114`; `src/runs/background/async-execution.ts:451`) and never passes through `resolveOutputReferences`. The only sub-field is `patchPath` (`chain-outputs.ts:7-17`), a file, not a directory.

The second half is a prompt collision on one child. The acceptance prompt says "Finish with a fenced JSON block tagged `acceptance-report`" (`src/runs/shared/acceptance.ts:267`); the structured-output instruction injected in the child says "Your final action must be to call `structured_output`" (`src/runs/shared/subagent-prompt-runtime.ts:11-15`). The runtime already keeps the two values apart - the report is parsed from the last assistant message with text (`src/shared/utils.ts:183-194`, tool-only messages skipped), the structured value from the `structured_output` capture file (`src/runs/foreground/attempt-finalization.ts:214-233`) - so a child that writes the report and then calls the tool works. A child that obeys the structured instruction literally and never writes the report fails loudly under explicit acceptance (`src/runs/foreground/execution.ts:883-885`) and records a quiet "Structured acceptance report missing" under inferred acceptance (`acceptance.ts:529-555`). No test drives a child through both contracts in prompt order; `test/integration/chain-execution.test.ts:572` mocks a child that already emits both.

Both halves are needed for #70's reviewer step: it runs in the implementer's tree (half one) and returns a verdict through `outputSchema` for `stopOn` while attesting under acceptance (half two).

Framing: kept - the snapshot recipe pi-gauntlet runs in the parent is the filesystem the ask wants; the gap is that a chain cannot run it between steps, and the root cause (output references never reach `cwd`) is reachable in `chain-outputs.ts`. Checked: the reference grammar and its three resolution sites, worktree capture and cleanup (`src/runs/shared/worktree.ts:399-470`, `:498-580`), the `resolveChildCwd` call sites, gauntlet's snapshot block and `scripts/wave-review.test.mjs` (4 pass on 7f3af2f), gauntlet 8e14e30.

## Acceptance criteria

Ticket jjuraszek/pi-gauntlet#70, `### Acceptance Criteria`, rows verbatim. The ticket belongs to pi-gauntlet; every row describes that repo's skill, telemetry, eval, or package manifest, so each row is `elsewhere: jjuraszek/pi-gauntlet`. This spec delivers the pi-cohort capability those rows depend on.

- [ ] On a fixture plan with one wave of 3 independent tasks that all pass review, the implement-phase parent transcript shows one `subagent()` call for the wave's implementers, spec reviewers, and code reviewer together, and the telemetry record shows 3 implementer, 3 spec-reviewer, and 1 code-reviewer dispatches.
  elsewhere: jjuraszek/pi-gauntlet
- [ ] On a fixture plan where one task's spec reviewer returns `FAIL`, the chain stops before the code reviewer runs (zero code-reviewer dispatches at that point), the parent runs the fix loop on that task only, and the code reviewer runs once after the re-review passes.
  elsewhere: jjuraszek/pi-gauntlet
- [ ] An implementer status of `NEEDS_CONTEXT` or `BLOCKED` stops the chain before any spec reviewer runs, and the parent handles it as the skill does today.
  elsewhere: jjuraszek/pi-gauntlet
- [ ] Escalation sentinels (`TRAJECTORY: STAGNANT`, `DIVERGING`, max severity Critical) and the one-escalation-per-loop rule behave as today; the skill's fix-loop section is unchanged in meaning.
  elsewhere: jjuraszek/pi-gauntlet
- [ ] `plan_tracker` statuses and the per-persona telemetry counts for a run are identical to the pre-change engine on the same fixture plan, except for the parent's call count, which is tabulated in the PR (baseline about 2 parent calls per dispatch).
  elsewhere: jjuraszek/pi-gauntlet
- [ ] `eval/subagent-driven-development/` gains a sample whose must-hold facts are: one chain call per wave, stop on `FAIL` before code review, fix loop only for the failed task; `node eval/run.mjs subagent-driven-development` is run and its `report.md` committed.
  elsewhere: jjuraszek/pi-gauntlet
- [ ] `package.json` names the minimum pi-cohort version that ships the stop condition, and the skill states what happens when the installed pi-cohort is older (fall back to today's per-dispatch calls, or refuse with a message naming the version).
  elsewhere: jjuraszek/pi-gauntlet

## Design

### Output reference grammar (`src/runs/shared/chain-outputs.ts`)

| Element | Today | After |
|---|---|---|
| `parseOutputReference` | `name`, `name.patchPath` | plus `name.treePath` |
| `ChainOutputMapEntry` | `text`, `structured?`, `agent`, `stepIndex`, `patchPath?`, `patchError?` | plus `taskIndex?`, `baseCommit?`, `repoCwd?` (set by the producer at the two capture sites that already hold the loop index and the `WorktreeSetup`: `chain-execution.ts:741`, `subagent-runner.ts:2246`; `repoCwd` is `WorktreeSetup.cwd`, the repository root), plus `treePath?` (set on first materialization) |
| `taskTemplatesForStep` | `task`, `label` strings | plus the step's `cwd` and each parallel task's `cwd` |
| `validateChainOutputBindings` | rejects `patchPath` on a non-worktree producer | same rule for `treePath`; a `cwd` template may carry only `treePath` references (`{outputs.x}` and `{outputs.x.patchPath}` in `cwd` are rejected pre-run: `Chain step N: only {outputs.<name>.treePath} may appear in cwd.`); rejects an output reference in any `cwd` of a step with `worktree: true` (`Chain step N: cwd output references cannot be combined with worktree: true.`) |
| `resolveOutputReferences(template, outputs)` | pure string substitution | `resolveOutputReferences(template, outputs, trees?)` - on a `treePath` hit calls the tree registry (below); `patchPath` and `name` unchanged |

The `worktree: true` + `cwd` reference rejection exists because `worktreeSetup` already overrides a task `cwd` silently (`chain-execution.ts:266`) and a worktree branched from a snapshot's detached HEAD would hold the base commit without the applied patch.

### Materialization (`src/runs/shared/worktree.ts`)

`materializeTree({ repoCwd, baseCommit, patchPath, dir }): string` runs `git -C <repoCwd> worktree add --detach <dir> <baseCommit>` then `git -C <dir> apply --index <patchPath>` and returns `dir`. It is gauntlet's snapshot recipe and is synchronous (`spawnSync`, like every git call in `worktree.ts:84-95`). `treePath` is the checkout root: patches are captured from the implementer worktree root (`captureWorktreeDiff` runs in `worktree.path`), so `apply --index` runs there too; the implementer's `cwdRelative` subdirectory (`worktree.ts:103-113`) is not re-applied, matching the root gauntlet passes today. No `.gitignore` entry, no `node_modules` symlink, no `worktreeSetupHook` - the snapshot is a plain detached checkout. The applied patch is staged by construction (`--index`).

`removeTrees(entries: Array<{ repoCwd, dir }>)` runs `git -C <repoCwd> worktree remove --force <dir>` per entry (missing dir ignored, errors logged and swallowed) then one `git -C <repoCwd> worktree prune` per distinct `repoCwd`, factored from the sequence `cleanupWorktrees` (`worktree.ts:560-567`) already runs. Each tree is removed against the repository that created it; a chain whose worktree steps use different repository `cwd`s therefore cleans both.

### Tree registry (chain run scope)

A `TreeRegistry` object created next to `outputs` in both executors (`chain-execution.ts` `executeChain`, `subagent-runner.ts` chain run) holds `built: Map<name, dir>` and `created: Array<{ repoCwd, dir }>`. On a `treePath` reference to `name`:

1. `built.has(name)` -> return the cached dir.
2. The entry's `patchPath` is absent -> throw the existing `ChainOutputValidationError` `Output '<name>' has no patch (no changes | capture failed: <reason>).` (`chain-outputs.ts:99-103`), no tree is built.
3. `dir = <chainDir>/worktree-trees/step-<entry.stepIndex>/task-<entry.taskIndex>-<entry.agent>/`, sibling of `worktree-diffs/` under the chain run directory - foreground `createChainDir` (`src/shared/settings.ts:151`, used at `chain-execution.ts:528`), async `<asyncDir>`. Push `{ repoCwd: entry.repoCwd, dir }` onto `created` **before** `materializeTree` runs, so a half-built tree is still removed.
4. `materializeTree` non-zero -> throw `ChainOutputValidationError` `Output '<name>' tree build failed: <first stderr line>`.
5. Record `built.set(name, dir)`, `entry.treePath = dir`, return `dir`.

Steps 1-5 run synchronously in one JS turn (`materializeTree` is `spawnSync`), so two parallel tasks referencing the same name cannot interleave between the lookup and the publication; the second caller sees the cached dir. If a future builder becomes asynchronous it must share one in-flight build per name.

Both error throws land where the `patchPath` error lands today: the referencing task alone gets `exitCode: 1` with the message as `finalOutput`, no child is dispatched, siblings run, `failFast` sets `aborted`. The executor changes below move each `cwd` resolution inside that boundary.

### Cleanup owner

Each executor wraps its step loop in one outer `try/finally` at the chain-run level; the `finally` calls `removeTrees(registry.created)`. Normal end, `stopOn` stop, `failFast` abort, a thrown error, and an async run interrupted through the runner's existing termination path all pass through it. Trees never outlive the `subagent()` call (foreground) or the async run (background). A failed removal is logged with the dir and does not change the chain result.

Resolution errors (`has no patch`, `tree build failed`) are caught per task and never escape the step, so they cannot trigger the `finally` while siblings run. An unexpected throw from inside a parallel worker rejects `mapConcurrent`'s `Promise.all` (`src/runs/shared/parallel-utils.ts:78-99`) while sibling workers may still be active; the step-level `cleanupWorktrees` already behaves this way for implementer worktrees today, and tree removal inherits that behavior - a stated parity, not a new guarantee. A sibling whose tree is removed under it fails on its next file read, which is the existing failure mode for a removed worktree.

### `cwd` resolution in the executors

Effective cwd precedence for every chain child is task `cwd` > step `cwd` > run `cwd`, resolved once per child inside that child's pre-dispatch error boundary, and the resolved value feeds every later consumer (backend selection, spawn, acceptance runtime checks, output paths).

| Site | Change |
|---|---|
| `chain-execution.ts:640` (`parallelCwd`) | today it feeds only worktree setup while `runParallelChainTasks` receives the run `cwd` (`:679-691`), so a non-worktree parallel step's `cwd` is dropped; pass `step.cwd` into `runParallelChainTasks` as the group default |
| `chain-execution.ts:268` (parallel task `cwd`) | move inside the existing per-task `try` at `:238-250`; `resolveChildCwd(cwd, resolveOutputReferences(task.cwd ?? step.cwd, outputs, trees))` |
| `chain-execution.ts:1114` (sequential step `cwd`) | move inside the `try/catch` at `:1068-1074`; a resolution error returns `buildChainExecutionErrorResult(error.message, ...)` as the sequential task error does today (a failed sequential step is a failed chain) |
| `async-execution.ts:451` (`buildSeqStep`, start time) | a `cwd` containing `{outputs.` is kept verbatim in the serialized step; the parallel group's `step.cwd` is serialized on the group (today `:549-568` drops it) and applied as the leaf default; `resolveSkillsWithFallback` (`:455`), `buildChainInstructions` (`:463`), `resolveParallelTaskOutputPath` (`:468-475`) receive `runnerCwd` for a templated step |
| `subagent-runner.ts:594` (`runSingleStep`) | resolve the effective cwd once at the top, before `selectConfiguredExecutionBackend` (`:618`), inside a task-local boundary returning the `:643` failure shape (`{ agent, output, exitCode: 1, error, sessionFile }`); route all seven `step.cwd ?? ctx.cwd` reads (`:618`, `:692`, `:738`, `:763`, `:884`, `:900`, `:1017`) through that local |

A resolved `treePath` is absolute, so `resolveChildCwd` returns it unchanged. The same `treePath` reference in task text resolves to the same absolute path. Dynamic fanout (`expand`) leaves inherit the template's `cwd` unchanged (`src/runs/shared/dynamic-fanout.ts:250-258` substitutes `{item}` into `task` and `label` only); an output reference in that `cwd` resolves per leaf like any other, and `{item}` in `cwd` stays unsupported.

### Acceptance beside outputSchema

`formatAcceptancePrompt(acceptance, { structuredOutput: boolean })`. With `structuredOutput` false the prompt is byte-identical to today. With it true, the sentence that introduces the JSON template (`acceptance.ts:267`, today "Finish with a fenced JSON block tagged `acceptance-report` in this shape:") becomes:

> Write a fenced JSON block tagged `acceptance-report` in your final text message, then call `structured_output` as your final action. Shape:

The JSON template that follows and the "End with a structured acceptance report." line (`:247`) are unchanged. Both callers already know whether a schema is present: `execution.ts:663-673` (foreground single and chain children share this call) and `subagent-runner.ts:648` (async). Report parsing (`acceptance.ts:309-343`), stripping (`:345-350`), the capture file, `result.structuredOutput`, and the child-side `STRUCTURED_OUTPUT_INSTRUCTIONS` are untouched. The report stays in prose; the structured value stays in the tool payload; `{outputs.name}` for a schema step stays compact JSON of the value with no report inside it.

### Data flow for #70

```yaml
- parallel:
    - { agent: implementer, as: impl_1, task: "..." }
    - { agent: implementer, as: impl_2, task: "..." }
  worktree: true
- parallel:
    - { agent: spec-reviewer, cwd: "{outputs.impl_1.treePath}", task: "Review ... patch at {outputs.impl_1.patchPath}", outputSchema: {...}, acceptance: { level: attested } }
    - { agent: spec-reviewer, cwd: "{outputs.impl_2.treePath}", task: "...", outputSchema: {...}, acceptance: { level: attested } }
  stopOn: { path: "/verdict", in: ["NEEDS_REWORK", "OUT_OF_SCOPE_CHANGES"] }
```

The reviewer uses `attested` because a tree has the patch staged by construction and `checked`/`verified`/`reviewed` require the `no-staged-files` runtime check (`acceptance.ts:51-61`, `checkNoStagedFiles` runs `git status` in the child's cwd), which would fail every tree-backed child. Step 1 captures patches and records `baseCommit`/`repoCwd`/`taskIndex` per output. Step 2 resolves each `cwd`, builds `<chainDir>/worktree-trees/step-0/task-<i>-implementer/` from base plus patch, dispatches the reviewer with that cwd, and the chain's `finally` removes both trees when the call returns. Gauntlet swaps its parent-side snapshot block for the `cwd` reference in a follow-up in that repo.

## Errors and edge cases

| Case | Behavior |
|---|---|
| `treePath` on a non-worktree producer | pre-run `ChainOutputValidationError`, same text family as the `patchPath` rule |
| Output reference in `cwd` on a `worktree: true` step | pre-run rejection naming the step |
| Producer made no changes | referencing task fails pre-dispatch: `Output 'x' has no patch (no changes).`; no tree built |
| Producer capture failed | `Output 'x' has no patch (capture failed: <reason>).`; no tree built |
| `git worktree add` or `git apply --index` fails | `Output 'x' tree build failed: <stderr first line>`; dir already registered, removed in `finally` |
| Two steps or two tasks reference the same `treePath` | one tree, cache hit |
| `count: n` task with a `treePath` cwd | copies share one tree; the persona owns read-only, the chain never captures a diff from a tree-backed step |
| `stopOn` stops the chain after a tree was built | `finally` removes it |
| `failFast` abort mid-step | `finally` removes every tree built so far |
| Thrown error anywhere in the step loop | `finally` removes every tree built so far |
| Async run: `cwd` template at start time | kept as a template through serialization; skill lookup, instruction text, and relative `output:` paths use `runnerCwd` |
| `removeTrees` fails for a dir | logged with the path; chain result unchanged |
| Worktree steps in two different repositories | each tree is removed and pruned against its own `repoCwd` |
| Tree-backed child with `checked`, `verified`, or `reviewed` acceptance | the `no-staged-files` runtime check fails (`Staged files present: ...`) because `apply --index` staged the patch; documented in `doc/orchestration-patterns.md`; use `attested` or a level without that evidence |
| `reads:` on a tree-backed async step | rendered at start time against `runnerCwd`, not the tree; use absolute paths or name files in task text |
| `{outputs.x}` or `{outputs.x.patchPath}` in `cwd` | pre-run rejection: only `treePath` may appear in `cwd` |
| Acceptance + `outputSchema`, child follows the ordering line | `acceptanceStatus: attested` (or the configured level's result) and `structuredOutput` both present |
| Acceptance without `outputSchema` | prompt unchanged byte for byte |

## Tests

Unit (`test/unit`, node `--test`, existing temp-repo helpers):

- `chain-outputs.test.ts`: `treePath` parses; `treePath` on a non-worktree producer rejected; `cwd` and per-task `cwd` templates are scanned; non-`treePath` references in `cwd` rejected; `worktree: true` plus a `cwd` output reference rejected; `resolveOutputReferences` with a registry calls the builder once per name and caches.
- `worktree.test.ts`: `materializeTree` on a temp repo reproduces an added file, a deleted file (absent in the tree), and a binary file from a `--binary` patch; an apply failure throws with the stderr line; `removeTrees` removes entries from two repositories and ignores a missing dir.
- `acceptance.test.ts`: prompt snapshot with `structuredOutput: false` equals today's text; with `true` line `:267` is the ordering sentence and the JSON template follows.

Integration (`test/integration`, mock pi from `test/support/mock-pi.ts`; step-1 file changes come from a `worktreeSetupHook` as in `chain-execution.test.ts:1075-1078`; the mock gains an `echoFiles: string[]` response field that prints the named files relative to its cwd, since the tree is gone before the test regains control):

- `chain-execution.test.ts`: two-step chain, step 1 `worktree: true` with the hook writing files, step 2 `cwd: "{outputs.impl_1.treePath}"` with a mock that echoes its cwd and the written file - asserts the contents, the cwd under `<chainDir>/worktree-trees/step-0/task-0-<agent>/`, and that `git worktree list` in the repo shows no tree after the call; a non-worktree parallel step's `cwd` reaches its children and a task `cwd` overrides it; absent patch fails only the referencing task and siblings run; `failFast` abort removes trees; a thrown error mid-chain removes trees; a `stopOn` stop removes trees; a sequential step with an absent-patch `treePath` cwd returns a chain error result.
- `async-execution.test.ts`: the same two-step chain through the background path; the serialized step keeps the `cwd` template and the group default; the runner resolves it before backend selection; absent patch fails only the referencing task; trees are gone when the run ends.
- Acceptance + `outputSchema`: the mock asserts the dispatched prompt contains the ordering sentence before it emits the `acceptance-report` block and calls `structured_output`; asserts `acceptanceStatus: attested` and `structuredOutput` on the two callers, foreground (`execution.ts`) and async (`subagent-runner.ts`).
- Combined: a tree-backed reviewer with `outputSchema` and `acceptance: { level: attested }` attests and emits its value; the same child with `level: checked` fails on `no-staged-files`.

Cross-repo regression: `node --test ../pi-gauntlet/scripts/wave-review.test.mjs` stays green (4 tests); this spec changes nothing in pi-gauntlet.

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` - Chain variables table gains the `{outputs.name.treePath}` row, the `cwd` placement rule (only `treePath` in `cwd`; task > step > run precedence), and the `patchPath` row drops "The only sub-field" (communication contract); `doc/orchestration-patterns.md` - "Worktree isolation" gains the tree lifecycle paragraph (checkout root under `worktree-trees/`, patch staged by construction, death at chain end, the `worktree: true` + `cwd` reference rejection) and "Acceptance gates" gains the report-then-`structured_output` ordering sentence and the `no-staged-files` caveat for tree-backed children (architecture, operations); `README.md:129-130` - chain example moves the reviewer to `cwd: "{outputs.impl_1.treePath}"` (contract example); `CHANGELOG.md` - `## [Unreleased]` entries for both halves
- Derived / memory docs invalidated: none - AGENTS.md routing unchanged; pi-gauntlet's `subagent-driven-development` SKILL.md "Spec-review snapshots" is the cross-repo consumer and changes in that repo's follow-up, not here

## Out of scope

- Keeping implementer worktrees alive past their step (rejected: cross-step lifecycle, writable implementer state and `.pi` metadata exposed to the reviewer).
- A base-only tree for a no-change producer (rejected: a no-change implementer did no work; the chain already knows that without a worktree).
- Capturing a diff from a step that runs in a tree; `node_modules`/setup hooks in a tree; a read-only enforcement mechanism (read-only is a persona convention; `count: n` copies share one writable tree).
- Re-applying the implementer's `cwdRelative` subdirectory to `treePath`; `{item}` substitution in `cwd`; draining or cancelling sibling workers before tree removal on an unexpected throw (parity with today's `cleanupWorktrees`).
- A dedicated `acceptance_report` tool or folding the report into the user's schema.
- Any change in pi-gauntlet: the chain-reference form of its wave loop, its eval sample, its pi-cohort version floor (ticket rows above).
- Resuming a stopped chain; reuse of trees across `subagent()` calls.

## Open questions

none
