# Stop one child of a parallel run by index

**Ticket:** [#58](https://github.com/jjuraszek/pi-cohort/issues/58)
**Goal:** `interrupt` with a child `index` stops exactly that child of a running foreground or background run, the siblings finish, and the waiting call returns their results with the stopped child marked interrupted; a slash command gives the person at the terminal the same stop while the calling agent is blocked.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-10
**Source bases:** pi-cohort `21a3bfb9` (7.7.2); pi-gauntlet `1aba5977` (8.4.6), read-only; `@earendil-works/pi-coding-agent` 1.5.0 (the worktree's `node_modules` copy, cited below; the host harness runs 1.5.2, where the same call sits at `dist/core/agent-session.js:1705`), read-only.
**Predecessor:** `doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md`, `Visible state and retained surfaces`: the visible paused output of a parallel run or chain parallel step, for a stop by index only.

## Problem

Ticket #58, "One stuck child of a parallel run cannot be stopped on its own". A parallel run with one child that never ends its turn can only be rescued by the silence watchdog (default `inFlightSilenceKillMs: 1_800_000`, `src/runs/shared/subagent-control.ts:19`) or by cancelling the whole call. The `interrupt` action accepts `index` in its schema (`src/extension/schemas.ts:266`) and ignores it.

User constraint, verbatim: "it has to play nice with pi-gauntlet idea". Adopted reading: the result a stop by index produces must let pi-gauntlet's foreground waves keep the healthy siblings and treat the stopped child as a failed task, with no pi-gauntlet change. How a gauntlet wave handles the stopped child stays in jjuraszek/pi-gauntlet#139.

Framing: kept

Supported by the source:

- The `interrupt` branch calls `foreground.interrupt()` with no index (`src/runs/foreground/subagent-executor.ts:2234-2262`).
- Every parallel child overwrites one shared `foregroundControl.interrupt` slot and clears it on settle when `currentIndex === index` (`src/runs/foreground/subagent-executor.ts:1469-1482`, `:1548-1553`; chain twin `src/runs/foreground/chain-execution.ts:280-292`). The request reaches the last-started child, or none.
- The background runner keeps one `activeChildInterrupt` slot (`src/runs/background/subagent-runner.ts:1391`, set at `:2023`, `:2317`, `:2501`); its signal handler marks every running step `paused` and calls that one slot (`:1795-1813`).
- pi-cohort registers no stop command. Slash commands are `/run`, `/chain`, `/run-chain`, `/parallel`, `/cohort-doctor` (`src/slash/slash-commands.ts:448-566`).
- pi-gauntlet counts a child as successful only with `exitCode === 0 && interrupted !== true` (`pi-gauntlet/extensions/phase-tracker.ts:89-95`, `:144-153`). Neither `subagent-driven-development` nor `roasting-the-spec` sets `failFast`.

Corrected premises:

- pi-gauntlet's implementer and wave-reviewer waves dispatch a one-step chain with one `parallel` step, not top-level `tasks` (`pi-gauntlet/skills/subagent-driven-development/SKILL.md:121`); only the council uses `tasks` (`pi-gauntlet/skills/roasting-the-spec/SKILL.md:65`). Foreground chain parallel and dynamic steps are in scope as Design clauses; the ticket rows stay verbatim.
- The chain path returns its pause notice before `captureParallelWorktreeDiffs` and the `outputs` collection (`src/runs/foreground/chain-execution.ts:747-759`, dynamic `:956-966`), so sibling patches are never captured and sibling outputs are never collected. Separately, the existing failure formatter prints `## Outputs` only when a `stopOn` condition matched (`failureSummaryOptions`, `:478-480`) and prints patch locations only on the success path (`:813`). pi-gauntlet's `### Chain stopped or failed` rule (`pi-gauntlet/skills/subagent-driven-development/SKILL.md:252-262`) also reads sibling results from the artifacts directory, so missing inline output alone is not total loss; patches that were never captured are.
- The foreground top-level parallel result already carries every child in `details.results`; only the text collapses to the pause notice (`src/runs/foreground/subagent-executor.ts:1836-1850`).
- The runner overwrites the stopped child's `paused` step status with `complete` or `failed` from its exit code at settle (`src/runs/background/subagent-runner.ts:2031`, `:2328`, `:2549`).
- The runner sets its run-level `interrupted` latch when a child settles interrupted (`:2030`, `:2327`, `:2548`); that latch ends the run `paused` (`:2611-2616`, `:2668`) and stops later chain steps (`:1831`). The handler's re-entry guard reads the same latch (`:1796`).

Implicit dependencies found missing or approximate:

| Dependency | Lookup | Result |
|---|---|---|
| Harness that types into a live interactive session | `test/integration/slash-commands.test.ts`, `test/support/` | not found; the test calls the registered command handler while a foreground call is blocked |
| Transport carrying a child index to the background runner | `interruptAsyncRun`, `src/runs/foreground/subagent-executor.ts:412-432` | not found; a bare `process.kill(pid, ASYNC_INTERRUPT_SIGNAL)` with no acknowledgement |
| Mock child that never ends its turn | `test/support/mock-pi-script.mjs:272-290` | approximate; a `delay` step after `message_start` |

Unverified, carried to Open questions: pi runs extension commands immediately while the agent is streaming (`@earendil-works/pi-coding-agent` 1.5.0, `dist/core/agent-session.js:1656-1665`, read, not exercised live).

The silence watchdog does not cover this ticket: a child that keeps emitting events is never killed (`test/integration/foreground-in-flight-control.test.ts`, "does not kill a turn that keeps emitting events past the kill cap"), the limit must sit above the slowest single command, and the watchdog can be off.

## Acceptance criteria

Ticket #58, Acceptance criteria, rows verbatim:

- [ ] Given a foreground parallel run of three children in which child `index: 1` never ends its turn, a test driving the tool directly sends `subagent({ action: "interrupt", id: "<run-id>", index: 1 })` while the run is in flight; child 1 alone stops, and children 0 and 2 run to completion.
  in-scope
- [ ] The tool result the calling agent receives for that run contains the outputs of children 0 and 2 and states that child 1 was interrupted; child 1's entry in `details.results` carries `interrupted: true`.
  in-scope
- [ ] Given the same three children started with `async: true`, the same request stops child 1 only: `status` never reports child 0 or 2 as `paused`, and still reports child 1 as `paused` after children 0 and 2 complete.
  in-scope
- [ ] `interrupt` with an `index` that names no running child of the run returns an error naming the index and stops no child.
  in-scope
- [ ] Given the foreground run in an interactive session, the user stops child 1 through the per-child stop control the README documents while the calling agent is blocked in the call; the call is not cancelled and returns as in the first two rows.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-58-interrupt-one-parallel-child
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
design: owns `src/shared/types.ts`, `src/runs/foreground/subagent-executor.ts`, `src/runs/foreground/chain-execution.ts`, `src/runs/shared/parallel-utils.ts`, `src/shared/formatters.ts`, `src/runs/background/subagent-runner.ts`, `src/slash/slash-commands.ts`, `skills/pi-cohort/SKILL.md`, the test files named in `## Tests`, `README.md`, `doc/commands.md`, `doc/programmatic-api.md`, `CHANGELOG.md`, and the banner in `doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md`; observable outcomes are the five acceptance rows above plus the chain-step result in Design

## Design

Terms. **Flat index**: the zero-based child index a run already exposes - the task index of a top-level parallel run, `globalTaskIndex + taskIndex` in a chain (`src/runs/foreground/chain-execution.ts:283`), the step index in `status.json`, and the `index` that `resume` takes. **Stop by index**: an `interrupt` request carrying `index`. **Whole-run interrupt**: an `interrupt` request without `index`.

### Inventory

Remove:

- Every assignment to `foregroundControl.interrupt` outside control creation: single path and parallel path in `src/runs/foreground/subagent-executor.ts` (`:1469-1482`, `:1548-1553`, single near `:2013-2080`), parallel and sequential paths in `src/runs/foreground/chain-execution.ts` (`:280-292`, `:373`, sequential near `:1127-1217`). Each site registers in `childInterrupts` and maintains `lastAssigned` instead (Foreground targeting).

Add:

- `childInterrupts: Map<number, () => boolean>`, `stoppedByIndex: Set<number>`, and `lastAssigned?: number` on the foreground control in `src/shared/types.ts:741-752` and its two inline copies in `src/runs/foreground/chain-execution.ts` (near `:122`, `:411`); `interrupt: (index?: number) => boolean`, defined once at control creation (`src/runs/foreground/subagent-executor.ts:2416-2422`).
- The stopped-by-index branch at three pause returns: top-level parallel (`src/runs/foreground/subagent-executor.ts:1846-1851`), chain parallel (`src/runs/foreground/chain-execution.ts:747-757`), chain dynamic (`:956-966`).
- An interrupted test in both chain failure filters (`:775-777`, `:984-986`) and in the `outputs[task.as]` registration (`:764`).
- `interrupted?: boolean` on `ChainTaskOutputEntry` (`src/shared/types.ts:48-58`), set by `logTaskOutput` (`src/runs/foreground/chain-execution.ts:481-489`), and an `- interrupted` heading in `renderTaskHeading` / `buildChainOutputsSection` (`src/shared/formatters.ts:68-95`).
- `interrupted?: boolean` on `ParallelTaskResult` and an `INTERRUPTED` status in `aggregateParallelOutputs` (`src/runs/shared/parallel-utils.ts:101-138`).
- The `index` branch in the `interrupt` action (`src/runs/foreground/subagent-executor.ts:2234-2266`) and in `interruptAsyncRun` (`:412-432`); the whole-run request file written by `interruptAsyncRun` without `index` and by `directNestedAsyncInterrupt` (`:541-555`).
- In the runner: a `childInterrupts` map filled by the three `registerInterrupt` call sites (`:2023`, `:2317`, `:2501`) beside the kept `activeChildInterrupt` slot (`:1391`), a `pendingStops` set, the request-file read in `interruptRunner` (`:1795-1813`), a handler-only re-entry flag, and `paused` kept at the three settle sites (`:2031`, `:2328`, `:2549`).
- The `/interrupt-child` command and its completions in `src/slash/slash-commands.ts`.
- `skills/pi-cohort/SKILL.md:75`: `interrupt` gains the optional `index`; edit per `/skill:forge-skill`.

### Foreground targeting

Each child registers its existing interrupt callback in `childInterrupts` under its flat index when it starts, sets `lastAssigned` to that index, and deletes its own entry when it settles. A settling child clears `lastAssigned` only when it still equals that child's flat index - the check that clears the shared slot today (`currentIndex === index`, `src/runs/foreground/subagent-executor.ts:1550`; `src/runs/foreground/chain-execution.ts:373`, `:1217`). The callback itself is unchanged: native children abort their `AbortController` (SIGINT then SIGTERM, `src/runs/foreground/execution.ts:615-635`); external children keep the #36 owner/backend teardown.

`interrupt(index?)`:

| Call | Behavior | Returns |
|---|---|---|
| `interrupt(i)`, `i` in the map, entry returns `true` | call the entry, delete it, add `i` to `stoppedByIndex` | `true` |
| `interrupt(i)`, `i` in the map, entry returns `false` | call the entry; nothing recorded | `false` |
| `interrupt(i)`, `i` not in the map | nothing | `false` |
| `interrupt()`, `lastAssigned` set | call `childInterrupts.get(lastAssigned)` when present, never another entry; `stoppedByIndex` untouched | the entry's result, `false` when absent |
| `interrupt()`, `lastAssigned` unset | nothing | `false` |

An entry returns `false` when its child was already aborted, for example by an earlier whole-run interrupt (`src/runs/foreground/subagent-executor.ts:1475-1481`). `interrupt()` never falls back to an older running sibling: once the last-started child settles, `lastAssigned` is unset and a whole-run interrupt finds no child, as today.

`currentIndex` and `currentAgent` keep their display role. The nested inbox listener (`src/extension/fanout-child.ts:51-85`) keeps calling `interrupt()` without an index.

### Foreground result

A step or run is **stopped by index only** when at least one result has `interrupted === true` and every such result's flat index is in `stoppedByIndex`. Otherwise today's pause return runs unchanged.

Top-level parallel, stopped by index only: skip the pause return and return the normal aggregate.

- `ok` counts `exitCode === 0 && !interrupted`.
- `aggregateParallelOutputs` receives `interrupted` and renders the status `INTERRUPTED` for that child, ahead of every other status.
- The text is `withWorktreeSuffix(summary + aggregate) + formatInterruptedCleanup(results)`.
- `details.results` is unchanged: the child keeps `exitCode: 0` and `interrupted: true`.
- `isError` is not set, as for a failed child in this path today.

Chain steps, stopped by index only: skip the pause return and take the existing failure route with the differences below. A failure without a stop by index keeps today's failure text.

Both step kinds:

- The failure filter is `interrupted === true || (exitCode !== 0 && exitCode !== -1)`.
- `logTaskOutput` records `interrupted`. `## Outputs` renders that child as `#### Task <n> (<agent>) - interrupted`, followed by its error line when it has one, never as a successful task.
- The summary is built by `buildChainSummary(..., "failed", ..., { ...(stopRecord ? { stop: stopRecord } : {}), outputs: outputLog })`. The collected outputs are passed whether or not a `stopOn` condition matched and whether or not the chain has any `stopOn`; `failureSummaryOptions()` would drop them (`:478-480`).
- `formatInterruptedCleanup(results)` is appended to the step error message, with the chain-wide `results` array the pause returns pass today (`:751`, `:960`). Its `Child <n>` labels are one-based positions in that array (`src/shared/formatters.ts:56-61`), not the zero-based flat index of the request.
- The return has `isError: true`. No later step runs.

Static parallel step:

- `captureParallelWorktreeDiffs` and the `outputs` collection run before the failure route.
- `outputs[task.as]` is registered only for `exitCode === 0 && !interrupted`.
- The stopped child's failure line reads `- Task <n> (<agent>): interrupted` under `Parallel step <n> failed:`.
- For a step with `worktree`, the summary text passes through `appendParallelWorktreeSummary(summary, diffs)` (`:201-205`), so the sibling patch locations appear in the failure text.

Dynamic step:

- Dynamic steps reject `worktree` (`DYNAMIC_STEP_KEYS`, `src/runs/shared/dynamic-fanout.ts:43`, `:183`): there is no patch capture and no patch text, and this spec adds none (Open questions).
- The collected array is built and registered under `outputs[step.collect.as]` as today (`:955`, `:978-983`); the interrupted item keeps its entry with its partial text. The item counts as a failure, not a success.
- The stopped item's failure line reads `- Item <n> (<agent>, key <k>): interrupted` under `Dynamic step <n> failed:`, and `dynamicGroupStatuses[stepIndex]` is set to `{ status: "failed", error }` as for any failed dynamic step (`:992`).

The header, `isError: true`, and `details` are the shape a silence kill produces (`src/runs/foreground/execution.ts:251-252`), so pi-gauntlet's `### Chain stopped or failed` rule and its success predicate apply unchanged; `## Outputs` and the patch summary are additions to that text.

Single runs and sequential chain steps register under their flat index like every child; their pause returns (`src/runs/foreground/subagent-executor.ts:2128`, `src/runs/foreground/chain-execution.ts:1231`) are unchanged.

### `interrupt` action

Run resolution is unchanged (`resolveSubagentRunId`, `getForegroundControl`). With `index`:

| Target | Outcome | Text |
|---|---|---|
| nested run | error, nothing stopped | `Interrupt by index is not supported for nested run <id>.` |
| foreground, `interrupt(index)` true | request accepted | `Interrupt requested for child <index> of foreground run <runId>.` |
| foreground, `interrupt(index)` false | error, nothing stopped | `Foreground run <runId> has no running child at index <index>.` |
| async, step `index` is `running` in `status.json` | request file written, signal sent | `Interrupt requested for child <index> of async run <asyncId>.` |
| async, step `index` absent or not `running` | error, no file, no signal | `Async run <asyncId> has no running child at index <index>.` |

A resolved foreground control owns the answer when `index` is present; the request does not fall through to an async run. Without `index` the branch behaves as today: a foreground control whose `lastAssigned` is unset falls through to the async lookup, as a control with an empty slot does today, and every existing message is kept.

### Background transport

Tool side, `interruptAsyncRun` with `index`: after the existing status and pid check, require `status.steps[index]?.status === "running"`, write `interrupt-request-<index>.json` (`{ index, requestedAt }`, `writeAtomicJson`, `src/shared/atomic-json.ts:4`) into the run's async directory beside `status.json`, then send `ASYNC_INTERRUPT_SIGNAL` as today.

Tool side, whole-run: `interruptAsyncRun` without `index` and `directNestedAsyncInterrupt` (`src/runs/foreground/subagent-executor.ts:541-555`) write `interrupt-request-all.json` (`{ requestedAt }`) the same way before they send the signal. Their checks and messages are unchanged. Every signal the tool sends follows a request file that states its intent; the runner never reads intent from an empty directory.

Runner side, `interruptRunner`:

1. Return when `statusPayload.state !== "running"`.
2. List files named `interrupt-request-<n>.json` and `interrupt-request-all.json` in the async directory and delete each one read. The index comes from the file name.
3. No request file: return. A signal whose request file an earlier handler run already read stops nothing.
4. Targeted files, for each `n`:
   - `n` has an entry in the runner's `childInterrupts`: mark only `statusPayload.steps[n]` `paused` (the fields today's loop sets), delete the entry, call it.
   - no entry and `statusPayload.steps[n].status === "running"`: add `n` to `pendingStops`; leave the step status.
   - otherwise: drop the request.

   Do not set the `interrupted` latch and do not touch other steps.
5. Whole-run file, after step 4 when both kinds were read: today's whole-run behavior - guard on a flag set only here, set the `interrupted` latch, mark every running step `paused`, call `activeChildInterrupt`.
6. Write status once when anything changed.

The three `registerInterrupt` call sites keep assigning `activeChildInterrupt` exactly as today: a callback sets it and `undefined` clears it, whichever child calls. The whole-run path never calls another child's callback in its place. In addition the call sites close over their flat index: a callback sets the map entry, `undefined` deletes it. When a callback registers for an index in `pendingStops`, the runner removes the index from the set, marks that step `paused`, writes status, and calls the callback at once. A settle site removes its index from `pendingStops`. The `registerInterrupt` signature is unchanged.

`pendingStops` covers the two windows in which a step is `running` with no registered callback: between the status write and the child's registration (`src/runs/background/subagent-runner.ts:1995` before `:2023`; twins `:2278`/`:2317`, `:2464`/`:2501`), and between a failed attempt's unregister and the fallback attempt's registration (`:483`, `:437`, loop at `:945`). A request read in either window stops the child when it registers, or is cleared when the step settles.

Settle sites write step status `paused` when `singleResult.interrupted`, otherwise `complete` or `failed` from the exit code as today. This applies to both forms of interrupt. The existing settle latch (`if (singleResult.interrupted) interrupted = true`) is kept; it ends the run in state `paused` and stops later chain steps, so `resume` with the index works as today. Step events are unchanged.

Because that latch is set, the async result and the completion notice after a stop by index keep today's paused summary (`Paused after interrupt. Waiting for explicit next action.`, `:2720`). Sibling outputs are in that result's `results[]` and in `status`, not in the summary.

### `/interrupt-child <index> [run-id]`

Registered in `registerSlashCommands(pi, state)` (`src/slash/slash-commands.ts:448-452`). The handler sends `{ action: "interrupt", index, id }` by calling `requestSlashRun` directly (`src/slash/slash-commands.ts:182-262`; bridge `options.execute`, `src/slash/slash-bridge.ts:117`), shows the action's result text with `ctx.ui.notify(text, isError ? "error" : "info")`, and clears the `subagent-slash` status that `requestSlashRun` sets. It does not go through `runSlashSubagent` (`:312-345`): no `pi.sendMessage`, which pi turns into a steer of the streaming agent (`agent-session.js:1862-1881`), and no `persistSlashSessionSnapshot`, which rewrites the session file mid-turn. It contains no stop logic of its own. "Print" below means `ctx.ui.notify`.

- `<index>` must match `^\d+$`; otherwise print `Usage: /interrupt-child <index> [run-id]` and send nothing.
- `[run-id]` is a run id or prefix, resolved by the action.
- No `run-id`, exactly one foreground run in `state.foregroundControls`: send that run's id.
- No `run-id`, several foreground runs: print their run ids and send nothing.
- No `run-id`, no foreground run: send without `id`; the action's own resolution and messages apply.
- `getArgumentCompletions`: one completion per key of `childInterrupts` of each in-flight foreground run; with several runs each completion carries the run id as the second argument.

### Predecessor scope

Supersedes `doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md`, `Visible state and retained surfaces`: the visible paused output of a parallel run or chain parallel step, for a stop by index only. That spec's zero exit plus `interrupted: true`, the cleanup warning, bounded teardown, and the pause text of a whole-run interrupt all stand.

### Paid or external actions

None. Implementation and verification run locally against the mock child. The loop treats an action without a clause here as unreachable; adding one needs separate explicit authorization.

## Errors and edge cases

- An index that is out of range, already finished, or not yet started returns the "no running child" error and stops nothing.
- A second stop for the same index returns the same error: the first request removed the entry.
- A stop by index for a child that a whole-run interrupt already aborted returns the same error: the entry is still in the map and returns `false`, `stoppedByIndex` is not changed, and the step keeps today's pause notice.
- A whole-run interrupt after the last-started child settled, with an older sibling still running, stops no child. Foreground: it falls through to the async lookup as today. Background: `activeChildInterrupt` is already cleared, as today.
- A stop by index never triggers `failFast`: the child keeps a zero exit, so siblings run to the end.
- A whole-run interrupt after a stop by index in the same step returns today's pause notice, because not every interrupted child is in `stoppedByIndex`.
- A single run or sequential chain step stopped by index pauses as today.
- Background: a stop by index does not set the handler's re-entry flag, so a later stop by index or whole-run interrupt is still processed.
- Background: the runner deletes every request file it reads, including one whose child has already settled; that request stops nothing.
- Background: a signal that finds no request file stops nothing. Two stops by index sent back to back cannot turn into a whole-run interrupt when the first handler run reads both files.
- Background: a whole-run request read together with targeted requests applies the targeted stops first, then the whole-run interrupt; the run ends as after a whole-run interrupt.
- Background: a request read while its step is `running` with no registered callback is held in `pendingStops` and stops the child when it registers. These windows are not part of the accepted race.
- Background, accepted race: a child that settles between the tool's `status.json` read and the signal still gets `Interrupt requested for child <index> ...` although nothing was stopped.
- In a static parallel step with `worktree`, a stopped child's partial worktree diff is captured with its siblings', as a killed child's is.

## Tests

All tests use the mock child (`test/support/mock-pi.ts`); a child that never ends its turn is a 60-second `delay` after `message_start`.

- Row 1, child 1 alone stops and children 0 and 2 complete; children 0 and 2 carry a delay that outlasts the request, the request is sent after all three callbacks are registered, and both siblings' completion outputs are asserted afterwards - `interrupt with index stops only that parallel child`, `test/integration/foreground-in-flight-control.test.ts`
- Row 2, result text carries sibling outputs and `INTERRUPTED` for child 1, `details.results[1].interrupted === true` - `parallel result after a stop by index keeps sibling outputs`, `test/integration/foreground-in-flight-control.test.ts`
- Row 3, `status` never shows child 0 or 2 `paused` and shows child 1 `paused` after they complete; children 0 and 2 carry a delay that outlasts the request, the request is sent after all three steps report `running`, both siblings' completion outputs are asserted in `results[]`, and the async result keeps the paused summary - `async stop by index pauses only that child`, `test/integration/top-level-async.test.ts`
- Row 4, foreground: out-of-range, finished, and repeated index each error naming the index, all children still complete or stay stopped as before - `interrupt with an index naming no running child errors`, `test/integration/foreground-in-flight-control.test.ts`
- Row 4, background: non-running index errors, no request file exists afterwards - `async interrupt with an index naming no running child errors`, `test/integration/top-level-async.test.ts`
- Row 5, handler invoked while a foreground call is blocked; the real `registerSlashSubagentBridge` (`src/slash/slash-bridge.ts:49`) is bound to the executor that shares `state` with `registerSlashCommands`, not a stubbed bridge; the call returns as rows 1-2 with the siblings' results, the text arrives through `ctx.ui.notify`, and `pi.sendMessage` is never called - `/interrupt-child stops one child of a blocked foreground run`, `test/integration/slash-commands.test.ts`
- Chain parallel step with `worktree` stopped by index returns `Parallel step 1 failed:` with `interrupted`, sibling outputs under `## Outputs`, the stopped child's `- interrupted` heading, and the sibling patch locations, no later step run; one variant has a gauntlet-style `stopOn` that no sibling matches, one has no `stopOn` - `chain parallel step stopped by index fails with sibling outputs`, `test/integration/chain-execution.test.ts`
- Chain dynamic step stopped by index returns `Dynamic step 1 failed:` with `- Item <n> (...): interrupted`, sibling outputs under `## Outputs`, the stopped item's `- interrupted` heading, the group status `failed`, no patch assertions, no later step run - `chain dynamic step stopped by index fails with sibling outputs`, `test/integration/chain-execution.test.ts`
- Chain step that fails without a stop by index keeps today's failure text - existing tests in `test/integration/chain-execution.test.ts` stay green
- `failFast: true` with a stop by index lets siblings finish - `stop by index does not trigger failFast`, `test/integration/chain-execution.test.ts`
- Whole-run interrupt after a stop by index returns the pause notice - `whole-run interrupt after a stop by index pauses`, `test/integration/chain-execution.test.ts`
- Whole-run interrupt without index is unchanged - existing tests in `test/integration/parallel-execution.test.ts` and `test/integration/foreground-in-flight-control.test.ts` stay green
- Whole-run interrupt after the last-started child settled, older sibling still running: no child stops and the request falls through as today - `whole-run interrupt does not reach an older sibling`, `test/integration/foreground-in-flight-control.test.ts`
- Stop by index for a child a whole-run interrupt already aborted, before it unregisters: error naming the index, pause notice kept - `stop by index after a whole-run interrupt errors`, `test/integration/foreground-in-flight-control.test.ts`
- Single run stopped by index pauses as today - `single run stopped by index pauses`, `test/integration/foreground-in-flight-control.test.ts`
- Index on a nested run id is rejected - `interrupt with index on a nested run is rejected`, `test/unit/nested-control.test.ts`
- Background: later stop by index and whole-run interrupt still processed; request file for a settled child is deleted and stops nothing - `async stop by index leaves later interrupts working`, `test/integration/top-level-async.test.ts`
- Background: interrupted child stays `paused` at settle after a whole-run interrupt - `async interrupted step stays paused at settle`, `test/integration/top-level-async.test.ts`
- Background: two stops by index for children 0 and 1 whose files are both present at the first handler run, then the second signal: child 2 is never `paused` and completes - `overlapping async stops by index leave the third child running`, `test/integration/top-level-async.test.ts`
- Background: a whole-run request file present together with a targeted one: the run ends `paused` as after a whole-run interrupt; a signal with no request file changes nothing - `async whole-run and targeted requests are told apart`, `test/integration/top-level-async.test.ts`
- Background: whole-run interrupt after the last-registered child settled, older sibling still running: that sibling's callback is not called - `async whole-run interrupt does not reach an older sibling`, `test/integration/top-level-async.test.ts`
- Background: a request sent as soon as its step reports `running`, and one sent as soon as a first attempt's failure is visible before the fallback attempt, each end with that child `paused` and the siblings complete; the test cannot force which side of the registration the request lands on and asserts the outcome that holds on both - `async stop by index survives registration and fallback gaps`, `test/integration/top-level-async.test.ts`
- Existing tests that signal the runner directly (`test/integration/async-execution.test.ts`, `test/integration/detached-external-orchestration.test.ts`, `test/integration/background-external-execution.test.ts`) write `interrupt-request-all.json` before the signal; the `status.steps[pausedIndex].status` assertion in `test/integration/background-external-execution.test.ts` changes from `complete` to `paused` to match the Design clause requiring interrupted steps to stay `paused` at settle. The other assertions of these tests are unchanged.
- `INTERRUPTED` label ahead of other statuses - `aggregateParallelOutputs labels an interrupted child`, `test/unit/parallel-utils.test.ts`
- `/interrupt-child` usage on a non-integer index; run list with several foreground runs and no run id; completions list running children - `/interrupt-child argument handling`, `test/integration/slash-commands.test.ts`
- Background accepted race - none: the window between the status read and the signal is not controllable from a test
- pi runs the command while the agent is streaming - none: no harness drives a live interactive session (Open questions)
- External-backend child stopped by index - none: the per-child callback is the one #36 tests cover; this change does not alter it

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (control paragraph: `index` on `interrupt`, the `/interrupt-child` command - operations); `doc/commands.md` (the `/interrupt-child` command - operations); `doc/programmatic-api.md` (Management actions: `interrupt` with `index`, the result of a stop by index for top-level parallel and chain steps, `paused` kept at settle, the async result keeping its paused summary with sibling outputs in `results[]` and `status` - communication contracts); `CHANGELOG.md` (new `## [Unreleased]` entry citing `(#58)`)
- Derived / memory docs invalidated: none

`doc/observability.md` is not amended: the child-host wire protocol does not change. pi-gauntlet's docs are not amended: `index` is an optional parameter it does not send.

## Out of scope

- What `interrupt` without an index does on a run with several children (ticket #58).
- How pi-gauntlet handles an interrupted child inside a wave, and its silence-limit tuning (jjuraszek/pi-gauntlet#139).
- Passing `index` through the nested control protocol.
- An acknowledgement channel from the background runner.
- A picker or keyboard shortcut for the stop control.
- Per-child mid-run visibility beyond what the widget and `status` show today.

## Open questions

- pi runs extension commands during streaming, and the slash bridge accepts a management action while a foreground call is blocked: both read in source, neither exercised live. A failure in a live session is an amendment to the `/interrupt-child` clause, not to the tool contract.
- Patches on dynamic steps: dynamic steps reject `worktree` (`src/runs/shared/dynamic-fanout.ts:43`, `:183`), so patch capture and patch assertions are limited to static parallel steps and no dynamic worktree support is added. The approved round-1 design named patch capture for dynamic steps as well; adding dynamic worktree support is a scope decision the user makes at the gate.
