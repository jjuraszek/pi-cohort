# A `model` on a parallel or chain call is the default for its children

**Ticket:** [#75](https://github.com/jjuraszek/pi-cohort/issues/75)
**Goal:** A `model` set on a `subagent` call with `tasks` or `chain`, or on a chain's parallel group, runs every child below it that sets no `model` of its own, ahead of an agent's pinned model, in foreground and background runs.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-18
**Source bases:** pi-cohort `f1e5ef5` (8.4.0 plus one commit that does not touch model resolution).
**Predecessor:** none

## Problem

Ticket #75, "A top-level `model` on a parallel or chain `subagent` call is silently dropped". A top-level `model` on a call that runs several children is dropped without an error or a warning. Each task or chain step that sets no `model` runs on its agent's model, on the parent session's model when the agent defines none, or on the child's own default. The same field works on a single-agent call, and the tool describes it only as "Model override", so nothing tells the caller that it stops applying once the call has several children.

The reporter's case (Reporter note, kept as a description of the input, not a target): eight read-only tasks for one agent, sent as a background parallel call with `model: "anthropic/claude-haiku-5-5"`, `async: true`, `concurrency: 8` and no per-task `model`. Every `status.json` step recorded the parent's `anthropic/claude-opus-5-5:high` and the batch cost $12.34; the next batch set `model` on each task, ran on Haiku, and cost $0.13 for two tasks. The reporter hit this twice. Environment: pi 1.5.2, pi-cohort 8.4.0, provider `anthropic`.

The ticket's Idea names two outcomes: use the top-level `model` as the default (`task.model ?? params.model ?? agent.model`), or reject the call. The acceptance rows require the default, so the rejection alternative is not taken (ticket #75).

The Reporter note records how the body's rows came to be: the original first row asserted `status.json` in the foreground too, and was split because a foreground call writes no `status.json`; the chain row was added from a repository audit, not by the reporter; the schema row was widened from parallel mode to chain mode.

### Request, verbatim

1. `#75 check also ticket comment`
2. Question 1 reply: `B, this is actually the intention that if model is specified only override of specific subagent can change it. single rule and reasonable simple inheritance`
3. Approach reply: `A, explicit propagation is much better as its explicit and no guessing or failing with unknown key anymore, right?`
4. Design round 1 reply: `approve`
5. Design round 2 reply: `approve`

### Framing

Framing: kept

The scout's objection was that patching only the two parallel expressions the reporter cited extends scattered model resolution and misses the chain row. It yields no alternative to the ask; it shapes the approach (one owner for the rule) instead.

Question 1 offered, for a `model` on a chain's parallel group: A) leave it and report a follow-up; B) the group's `model` becomes the default for its tasks, ahead of the top-level one; C) reject it with an error. The user chose B and stated the intent: once a `model` is specified, only a specific child's own `model` changes it.

The approach question offered: A) fill the inherited model in once at entry; B) add the fallback at every place a child's model is picked. The user chose A.

### Claims checked

| Claim | Source | Lookup | Result |
|---|---|---|---|
| Single mode reads the top-level `model` | ticket Problem, Reporter note | `src/runs/foreground/subagent-executor.ts:1121` (background), `:1916-1919` (foreground) | Held: `params.model ?? agent.model`. |
| Background parallel ignores it | Reporter note `:1027` | `subagent-executor.ts:1026-1028` | Held: `task.model ?? agentConfigs[index]?.model`. |
| Foreground parallel ignores it | Reporter note `:1623-1626` | `subagent-executor.ts:1617-1627` | Held: `behaviorOverrides[i].model` is `task.model` only. |
| Background chain ignores it | ticket AC 4 | `subagent-executor.ts:1071-1100` passes no model to `executeAsyncChain`; `src/runs/background/async-execution.ts:467-477`, `:517` | Held. |
| Foreground chain ignores it (sequential, static parallel, clarify seed) | ticket AC 4 | `src/runs/foreground/chain-execution.ts:1134-1137`, `:285-287`, `:579-586` | Held. |
| Every place that picks a child's model prefers the child's own `model` over the agent's | approach A | the six read sites above plus `async-execution.ts:573-616` (static group and fanout template through `buildSeqStep`) | Held: a value written onto the child reaches every run path. |
| One entry step rewrites `tasks` and `chain` before validation and every mode branch | approach A | `subagent-executor.ts:875-892` (`normalizeRepeatedParallelCounts`), called once at `:2321`; `validateExecutionInput` at `:2347` | Held. Slash commands reach the same executor (`src/slash/slash-commands.ts:490,530,544`). |
| The chain leaf shapes are sequential step, static parallel task, fanout template | approach A | `subagent-executor.ts:940-966` (`wrapChainTasksForFork` maps exactly these three) | Held. |
| Fanout children take the template's `model` | design round 1 | `src/runs/shared/dynamic-fanout.ts:250-256` (`...step.parallel` spread), used by `chain-execution.ts:848` and `src/runs/background/subagent-runner.ts:1980` (`:56` is only the import) | Held. |
| A `model` on a static parallel group is silently dropped | question 1 | `src/shared/settings.ts:115-122` (`ParallelStep` has no `model`), `chain-execution.ts:285-287`, `async-execution.ts:573-589` | Held. |
| A `model` on a fanout group is silently dropped | question 1 | `dynamic-fanout.ts:43` (`DYNAMIC_STEP_KEYS` omits `model`), `:183` | Corrected: it fails validation today with `Dynamic chain step N does not support field 'model'.` (`dynamic-fanout.ts:149`). The same check runs when a saved `.chain.json` is loaded (`src/agents/chain-serializer.ts:189`), before any executor entry. Only the static group drops it silently, and a saved static group's keys are not checked at load. The template's own `model` is accepted (`:47`). |
| Foreground records the model in each child's `_meta.json` | ticket AC 2 | `src/runs/foreground/execution.ts:997-1006`, `src/shared/artifacts.ts:23` | Held. |
| Background records it in `status.json` `steps[].model` | ticket AC 1 | `async-execution.ts:270`; asserted in `test/integration/async-execution.test.ts:2215,2731` | Held. |
| The tool's `model` text is "Model override, e.g. 'anthropic/claude-sonnet-4'." | ticket AC 5 | `src/extension/schemas.ts:321`; chain-step `model` has no description (`:225`) | Held. |
| The serialized tool schema has a size ceiling | own recon | `test/unit/schemas.test.ts:442-451`: ceiling 9,500 bytes; measured 8,980 at `f1e5ef5` | Held: 520 bytes of headroom for both descriptions. |
| No in-repo caller sends a top-level `model` with `tasks` or `chain` | own recon | `slash-commands.ts:476-553` (`/run`, `/chain`, `/run-chain`, `/parallel`); `src/extension/index.ts:367-397` (prompt-template bridge) | Held for the paths checked: no slash command or prompt template changes behavior. Callers outside this repo are not covered by this row. |
| pi-gauntlet, the one hard dependent on `subagent()`, sends no top-level `model` with `tasks` or `chain` | council review | `rg 'model:' skills extensions` in the installed pi-gauntlet package, capped at 5 matches per file | No top-level `model` beside `tasks` or `chain` in the scanned matches; `model:` appears on single-agent dispatches and as per-task values. A capped scan, not an exhaustive compatibility guarantee. |
| An empty-string `model` on a task counts as unset today | edge | `src/runs/shared/model-fallback.ts:28` (`if (!model) return undefined`) | Held. |
| A task's, static-group task's, or fanout template's `model` can arrive as any value, and today's readers disagree on what counts as unset | council review | `src/extension/schemas.ts:151-203` (`TaskItem`, `ParallelTaskSchema`, `DynamicParallelTemplateSchema`: `additionalProperties: true`, no `model` property); `subagent-executor.ts:1027` (`task.model ?? ...`, nullish), `:1623` (`task.model ? ...`, truthiness); `model-fallback.ts:28` (truthiness) | Held: the fill needs one stated presence test (see "The rule"). |
| A fanout group whose template is a string reaches the fill unchanged and fails validation after it | malformed-input edge | `src/shared/settings.ts:131-133` (`isParallelStep` is false for a non-array `parallel`, so count expansion pushes the step unchanged, `subagent-executor.ts:854-857`); `dynamic-fanout.ts:146-147`, `:202` (`assertOnlyKeys(step.parallel, ..., "Dynamic chain step N parallel")` throws `Dynamic chain step N parallel must be an object.`); `src/runs/shared/chain-outputs.ts:63-66` rethrows it as a chain validation error | Held by reading; the text the executor returns around that message was not observed, so the test compares against the same call without a top-level `model`. |
| A saved chain's group keys reach the executor | saved-chain edge | `src/slash/slash-commands.ts:144-161` (`mapSavedChainSteps` spreads `...step` for static and fanout groups) | Held: a group `model` in a saved chain arrives at the executor entry as written. `test/integration/slash-commands.test.ts` captures the params a slash command sends (`captureSlashCommandParams`, `:176`) and does not dispatch them. |
| Resume has no model logic of its own | edge | `rg model src/runs/background/async-resume.ts` - no match | Held. |
| The ticket rows are behaviors, not workflow-stage proofs | ticket handling | the five rows read against shape-ticket's AC integrity gate | Held: each names a recorded model or schema text. |
| The reporter's costs and live-provider run | ticket Problem | not run - no provider call was made | Not checked: verification uses the fake pi the tests run on (`test/support/mock-pi.ts`). |

Implicit dependencies:

- A test that reads a child's `_meta.json` `model` - `rg "_meta|metadataPath" test` - one hit, `test/integration/background-external-execution.test.ts:759`, which creates a directory at `artifactPaths.metadataPath` and reads no `model`. `test/integration/single-execution.test.ts:1075` asserts only that `result.artifactPaths` exists. No test reads a child's `_meta.json` `model`, so the foreground rows' assertion is new test code reading `artifactPaths.metadataPath`.
- Live provider credentials and the reporter's model ids - not checkable, no provider call. Tests use the fake pi.
- Fake pi executable, `status.json` assertions, the detached-run loader - found (`test/support/mock-pi.ts:46-144`, `async-execution.test.ts:2155-2216`).

## Acceptance criteria

Ticket #75, Acceptance Criteria, rows verbatim:

- [ ] A background (`async: true`) parallel `subagent` call with top-level `model: X` and no per-task `model` runs every task on `X`, whether or not the task's agent defines a `model`: each `status.json` `steps[].model` is `X`, followed by the thinking suffix when one resolves (for example `X:high`).
  in-scope
- [ ] The same call in the foreground runs every task on `X`: the `model` recorded in each child's `_meta.json` artifact is `X`, followed by the thinking suffix when one resolves.
  in-scope
- [ ] In both calls above, a task with its own `model: Y` records `Y`, followed by the thinking suffix when one resolves.
  in-scope
- [ ] A chain `subagent` call with top-level `model: X`, one step that sets no `model` on an agent that defines one, and one step with `model: Y`: the first step's recorded model is `X` and the second's is `Y`, each followed by the thinking suffix when one resolves.
  in-scope
- [ ] The tool schema's description of `model` says that in parallel and chain mode it is the default for every task or step that sets no `model`, and that a task's or step's own `model` wins.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: top-level-model-batch-default
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (`release.sh <level>`) per overrides `## Release`
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5
design: owns `src/runs/foreground/subagent-executor.ts`, `src/runs/shared/dynamic-fanout.ts`, `src/shared/settings.ts`, `src/extension/schemas.ts`, `skills/pi-cohort/SKILL.md`, `doc/agents-and-chains.md`, `doc/programmatic-api.md`, `CHANGELOG.md`, and the test files under `## Tests`; a `model` on the call or on a parallel group reaches every child below it that sets none.

## Design

### The rule

Nearest wins. A child's model is the first of:

1. the task's or step's own `model`;
2. the `model` on the parallel group that holds it (chain mode);
3. the call's top-level `model`;
4. the agent's `model` after the `agentOverrides` merge;
5. the parent session's model;
6. none - the child pi uses its `defaultModel`.

Levels 4-6 are today's order and do not change. A `model` given anywhere on the call outranks an agent's pinned model.

One presence test decides "given" at levels 1-3, for a child, a group, and the call alike: a `model` is given only when it is a non-empty string. A whitespace-only string is non-empty, so it counts as given and is kept as written. Anything else - absent, `""`, `null`, or a non-string - counts as not given. The fill overwrites a child's not-given value only when a given group or call `model` exists above it; when none does, the child's value is left exactly as it arrived. The fill validates no model. The single-agent call stays outside the fill.

Example: `{ model: "X", chain: [{ agent: "a" }, { parallel: [{ agent: "b" }, { agent: "c", model: "Y" }], model: "Z" }] }` runs `a` on X, `b` on Z, `c` on Y.

### One owner at entry

`applyModelInheritance(params)` is a private function in `src/runs/foreground/subagent-executor.ts`. It runs once per call on the result of `normalizeRepeatedParallelCounts`, before `applyForceTopLevelAsyncOverride`, before `validateExecutionInput`, and before any mode branch. It returns a copy of the params with levels 2 and 3 written onto each child's own `model`, so every later reader sees an already-resolved level 1:

| Shape | Effect |
|---|---|
| `tasks: [...]` | each task without a `model` gets the call's |
| sequential chain step | a step without a `model` gets the call's |
| static group `{ parallel: [...], model }` | each task without a `model` gets the group's, else the call's; the group's `model` key is removed |
| fanout group `{ expand, parallel: {...}, collect, model }` | the template without a `model` gets the group's, else the call's; the group's `model` key is removed |
| single-agent call | untouched; it reads the top-level `model` itself |

The function writes the string as given. Bare-name resolution, the thinking suffix, and `fallbackModels` stay with the readers that own them today.

In the table, "without a `model`" means not given by the presence test under "The rule".

The function only writes onto steps, tasks, and templates that are objects. Any other shape that reaches the function passes through unchanged, so `validateExecutionInput` reports it as today. Count expansion runs first, so not every malformed input reaches the function: a `null` task throws there, and a string task is spread into an object. A fanout group whose template is a string does reach it; the function leaves that step as it arrived, and the call fails exactly as the same call without a top-level `model` does.

No reader changes: `chain-execution.ts`, `async-execution.ts`, `subagent-runner.ts`, `resolveStepBehavior`, and the two parallel expressions in `subagent-executor.ts` stay as they are. `dynamic-fanout.ts` gets one validation-only change - `DYNAMIC_STEP_KEYS` gains `model` - and its materialization and collection code stays as it is. Foreground, background, clarify, and background-from-clarify all receive the same resolved input. The recorded model (`_meta.json`, `status.json` `steps[].model`) follows because it records what the child ran on.

A fanout group with `model` is accepted because `DYNAMIC_STEP_KEYS` allows the key; today it fails with `Dynamic chain step N does not support field 'model'.`. The key has to be allowed in the validator, not only removed at entry, because a saved `.chain.json` is validated when it is loaded (`src/agents/chain-serializer.ts:189`), before the executor entry runs. With the key allowed, a group `model` behaves the same in a direct call and in a saved chain, for fanout and static groups alike; the entry fill still moves it onto the template and removes it from the group.

### Reading of the ticket rows

- AC 1 "whether or not the task's agent defines a `model`": the tests use one agent with a pinned model and one without.
- AC 4 names no run mode: it is verified in the foreground and with `async: true`.
- AC 5 names the `model` description: the top-level `model` description carries the row's two statements, qualified so they stay true when a nearer parallel group sets a `model`; the chain-step `model` description adds the group default and its place ahead of the call's.

### Schema text

The two descriptions are these literal strings. Together they state the whole order: the call's `model` is the default unless a nearer group or the child sets one, a group's overrides the call's, the child's own wins, and each outranks the agent's pinned model.

- Top-level `model` (`SubagentParams.model`, replaces "Model override, e.g. 'anthropic/claude-sonnet-4'."):
  `Model for a single call, e.g. 'anthropic/claude-sonnet-4'. With tasks or chain: default for every task or step that sets no model, unless its parallel group sets one; a task's or step's own model wins. Outranks the agent's model.`
- Chain-step `model` (`ChainItem.model`, no description today):
  `Step model. On a parallel group: default for its tasks, ahead of the call's model; a task's own model wins. Outranks the agent's model.`

Byte cost: the first string adds 180 bytes over the one it replaces, the second adds 152 with its `"description"` key, 332 together. From the 8,980 bytes measured at `f1e5ef5` that is 9,312, inside the 9,500-byte ceiling asserted in `test/unit/schemas.test.ts`. The figure is arithmetic on the strings; the budget test is the check that binds.

### Moving parts

Remove: nothing.

Add:

- `applyModelInheritance(params: SubagentParamsLike): SubagentParamsLike` in `src/runs/foreground/subagent-executor.ts`, and its one call on `normalized.params` where `normalizedParams` is assigned.
- `model?: string` on `ParallelStep` and on `DynamicParallelStep` in `src/shared/settings.ts`.
- `"model"` in `DYNAMIC_STEP_KEYS` in `src/runs/shared/dynamic-fanout.ts`.
- The two descriptions in `src/extension/schemas.ts` (`SubagentParams.model`, `ChainItem.model`).
- In `skills/pi-cohort/SKILL.md`, "Per-task overrides": the `model` row states the order - own, then the parallel group's, then the call's - and that each outranks the agent's model. This edit follows `/skill:forge-skill`.
- In `doc/agents-and-chains.md`, "Changing a builtin agent's model": the model row of the resolution table gains the group and call levels ahead of the agent's, and states that a group `model` in a saved `.chain.json` follows the same order.
- In `doc/programmatic-api.md`: the `model` row of the parameter table states that with `tasks` or `chain` it is the default for every task or step that sets none, ahead of the agent's model; the parallel step group field list gains `model`; both carry the order own, then group, then call, then agent.
- A `### Fixed` entry under `## [Unreleased]` in `CHANGELOG.md`, ending `(#75)`.
- The tests under `## Tests`.

Paid or external actions: none. Implementation and verification run on the fake pi; no provider call is made.

## Errors and edge cases

- No new error. One error goes away: a fanout group carrying `model` no longer fails with `Dynamic chain step N does not support field 'model'.`, in a direct call or when a saved `.chain.json` is loaded. Every other unknown key on a fanout group fails as today.
- A static group's `model` in a saved `.chain.json` loads today and is dropped at run time. After the change it takes effect through `/run-chain`, like a group `model` on a direct call.
- An empty `model` (`""`), `null`, or a non-string on the call, a group, or a child counts as not given; the next level applies, and with no given `model` above it a child's value is left as it arrived. A whitespace-only string counts as given and is kept as written.
- A task with `count` inherits on every copy, because the fill runs on the expanded list.
- A call with no `model` at any level behaves as today.
- A single-agent call behaves as today.
- The clarify screen seeds each step with its inherited model, shown as the step's own and followed by the thinking suffix when one resolves, as the unchanged seeder does for any step model today. A model picked on the screen still wins, as today.
- Resume reads no model of its own; an inherited model is the same stored field as one written on the task.
- A provider failure can still move a child to one of its agent's `fallbackModels`; the recorded model is then the fallback, as today.

## Tests

Every row that asserts an inherited model dispatches through `createSubagentExecutor(...).execute(...)`, because `applyModelInheritance` runs only at executor entry. `executeChain`, the only entry `test/integration/chain-execution.test.ts` drives, and `executeAsyncChain` called directly both bypass the fill and cannot verify it. Foreground rows, chain rows included, use the executor harness in `test/integration/parallel-execution.test.ts`, which already runs chains through the executor. Background rows use `createSubagentExecutor` with `async: true` in `test/integration/async-execution.test.ts`, not `executeAsyncChain`.

- Background parallel call with top-level `model: X`, one task on an agent with a pinned model and one on an agent without: every `status.json` `steps[].model` is X plus the thinking suffix - `test/integration/async-execution.test.ts`
- The same call in the foreground: each child's `_meta.json` `model` is X plus the suffix - `test/integration/parallel-execution.test.ts`
- A task with its own `model: Y` records Y plus the suffix, background and foreground - `test/integration/async-execution.test.ts`, `test/integration/parallel-execution.test.ts`
- Chain with top-level `model: X`, a step without `model` on a pinned agent, and a step with `model: Y`: recorded X then Y - `test/integration/parallel-execution.test.ts` (foreground), `test/integration/async-execution.test.ts` (background)
- The top-level `model` description and the chain-step `model` description equal the two strings under "Schema text", which carry the tasks-and-chain default, the nearer group, own-`model`-wins, and the agent's model being outranked - `test/unit/schemas.test.ts`
- The serialized schema stays within 9,500 bytes - `test/unit/schemas.test.ts` (existing budget test, unchanged)
- Static group with `model: Z` under top-level X: the task without `model` runs on Z, the task with `model: Y` on Y, a sibling sequential step on X - `test/integration/parallel-execution.test.ts`
- Fanout group with `model: Z` is accepted and its children run on Z; a fanout template without `model` under top-level X runs on X - `test/integration/parallel-execution.test.ts`, `test/integration/async-execution.test.ts`
- A saved `.chain.json` whose fanout group carries `model: Z` loads without a diagnostic, and `/run-chain` on it sends a chain whose group still carries `model: Z` - `test/unit/chain-serializer.test.ts` (load), `test/integration/slash-commands.test.ts` (params the command sends). The run on Z is the fanout row above.
- A fanout group with a non-`model` unknown key (for example `when: "later"`), sent through `createSubagentExecutor(...).execute(...)`, still fails with the existing `does not support field` error naming that key - `test/integration/parallel-execution.test.ts`. The direct-validator tests in `test/unit/dynamic-fanout.test.ts` stay unchanged; they call the validator without the entry fill and cannot show that the fill leaves other keys alone.
- A task with `count: 2` under top-level X: both copies run on X - `test/integration/parallel-execution.test.ts`
- An empty top-level `model`: tasks keep the agent's pinned model - `test/integration/parallel-execution.test.ts`
- The clarify seed for a step without `model` under top-level X is X followed by the thinking suffix when one resolves (`X:high` under a parent at thinking `high`); the seeder is not changed - `test/integration/parallel-execution.test.ts`. The test passes `{ ...makeMinimalCtx(dir), hasUI: true, ui: { custom } }` with the parent `model` and `thinkingLevel` as the executor's ctx argument (the ctx shape at `parallel-execution.test.ts:333-337`); the `custom` stub builds the component from the factory and reads `getEffectiveModel(i)`, as `chain-execution.test.ts:1797-1801` does.
- A chain whose fanout group has a string template (`parallel: "x"`), sent through `createSubagentExecutor(...).execute(...)` with top-level `model: X` and again without it: both calls fail with the same error text, and it contains `parallel must be an object` - `test/integration/parallel-execution.test.ts`
- No `model` at any level, and single-agent calls - none: covered by `parallel-execution.test.ts` "parallel tasks inherit the parent session model and thinking", `chain-execution.test.ts` "sequential and parallel-in-chain steps inherit the parent session model, thinking, and name", and the single-mode model tests, which stay green unchanged
- Resume - none: no resume code reads a model
- Fallback after a provider failure - none: `fallbackModels` handling is untouched and covered by `async-execution.test.ts` and `test/unit/model-fallback.test.ts`

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (communication contract: the model resolution order callers rely on), `doc/programmatic-api.md` (communication contract: the `model` parameter row and the parallel step group field list), `CHANGELOG.md` (`[Unreleased]` Fixed entry)
- Derived / memory docs invalidated: none

The bar applied is `reference/documentation-impact.md`. `skills/pi-cohort/SKILL.md` is implementation surface and is listed under Design, not here.

## Out of scope

- The prompt-template bridge drops its request's `model` when it sends several tasks (`src/extension/index.ts:372-381`). Forwarding it would start overriding pinned agent models for every multi-task prompt template; it is reported as an adjacent issue, not changed.
- The single-agent clarify screen seeds its display without the top-level `model` although the dispatch uses it (`subagent-executor.ts:1928`). Unchanged.
- A model flag on `/chain`, `/run-chain`, or `/parallel`.
- Thinking resolution, provider selection, `fallbackModels`, and model validation.

## Open questions

None.
