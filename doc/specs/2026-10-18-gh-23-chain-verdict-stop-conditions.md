# Chain stop conditions on structured output (`stopOn`) and `patchPath` output references

**Goal:** A chain step can declare an optional `stopOn` condition over its tasks' schema-validated structured output; when any task matches, the chain ends after that step with a controlled (non-error) stop, a fixed machine-readable stop record, and every finished task's output in the model-facing result. A worktree parallel task's output entry gains `patchPath` so a later step can reference its patch by name.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#23
**Consumer:** jjuraszek/pi-gauntlet#70 (wave as one chain)

## Problem

A reviewer child that returns `{"verdict":"FAIL"}` exits 0, so nothing in chain execution stops the chain: the next step runs. The existing stop mechanisms all mean failure. Sequential steps already stop on any non-zero exit (`src/runs/foreground/chain-execution.ts:1119-1129`; async `src/runs/background/subagent-runner.ts:2377-2379`); a parallel step lets all siblings finish and then fails the chain when any exited non-zero (`chain-execution.ts:689-710`; async `:2243-2245`); `failFast` is a parallel queue policy that only skips not-yet-started siblings (`chain-execution.ts:205-216, 341-343`). A `BLOCKED:` first line maps to exit 1 (`src/runs/shared/completion-guard.ts:65-68`) and an explicit acceptance failure maps to exit 1 (`src/runs/foreground/execution.ts:850-891`); both turn a legitimate verdict into a failed dispatch and change child semantics, so they are not a substitute for a caller-selected condition.

A second gap: the chain result's model-facing `content` carries no child output. `buildChainSummary` (`src/shared/formatters.ts:54-100`) returns a status line, progress, and an artifacts path; child outputs live only in `details.outputs` / `details.results` and the background result JSON, which Pi does not show to the model (`details` is for rendering and state, `docs/extensions.md:136`). A parent that wants three reviewer verdicts in one turn cannot read them today.

Premise corrections carried from the questionary: the ticket's "failFast lets the chain continue" wording overgeneralizes `failFast` to sequential steps; sequential steps have no `failFast` (`src/shared/settings.ts:42-60`). The ticket's `output: "<as>"` selector names one task, whereas its parallel AC promises any matching task; this spec uses a step-level condition instead. #70's cost figures (64 parent calls, 260k tokens) are reporter measurements, not verified here, and the design does not depend on them.

Framing: kept. Traced call-time `ChainItem` -> `subagent-executor` -> `executeChain`; saved-chain parser/management -> `mapSavedChainSteps` -> executor; async mapping -> runner -> result JSON -> `result-watcher`; structured-output validation -> named bindings / dynamic collections -> `buildChainSummary`.

## Acceptance criteria

Ticket jjuraszek/pi-cohort#23, Acceptance criteria, rows verbatim:

- [ ] A chain with a sequential step whose child's structured output matches the step's stop condition ends after that step; the chain result marks the step as stopped-by-condition, names the matching path and value, and includes the child's full output.
  in-scope
- [ ] A chain with a parallel step of N tasks where one task's output matches the stop condition lets all N finish, then ends; the result names the matching task index and includes all N outputs; the following step does not run.
  in-scope
- [ ] A chain whose outputs match nothing runs every step as today; a step with no stop condition behaves exactly as before (unit tests for the existing `failFast` paths still pass).
  in-scope
- [ ] The stop condition is accepted in the call-time `chain:` array of `subagent()` and in file-authored chains; an invalid condition (unknown output name, non-string values) is rejected before any step runs with a message naming the field.
  in-scope
- [ ] `skills/pi-cohort/SKILL.md` and `README.md` document the field with one example: implementers -> spec reviewers (stop on `FAIL`) -> code reviewer.
  in-scope
- [ ] `CHANGELOG.md` `## Unreleased` names the field; pi-gauntlet's follow-up ticket (wave as one chain) is linked from the PR.
  in-scope - the PR-body link is written when the PR is opened at the finish step ("Unblocks jjuraszek/pi-gauntlet#70"); no branch artifact carries it

Readings for ambiguous rows, as Design clauses: row 4's "unknown output name" is read against the chosen step-level shape, which has no output name - the equivalent pre-run rejection is "step has `stopOn` but no `outputSchema`" (D3). Row 2's "task index" is 0-based in the record and 1-based in the rendered headings, both stated (D6). Row 6's PR link is a workflow artifact, satisfied by the PR body.

## Design

### D1. The `stopOn` field

`stopOn` is an optional object on every chain step shape - sequential, static parallel, dynamic parallel - on every authoring surface:

```ts
type StopCondition = { path: string; in: string[] };
```

- `path` is an RFC 6901 JSON Pointer evaluated against the task's validated structured output (`""` selects the root). Reuses `assertJsonPointer` / `resolveJsonPointer` from `src/runs/shared/dynamic-fanout.ts:56-112`; `resolveJsonPointer` throws `DynamicFanoutError` on a missing key, a non-object intermediate, an out-of-range index, or a non-numeric segment over an array, and the evaluator (D4) catches that throw as no match.
- `in` is a non-empty array of strings. A match is strict string equality between the resolved value and any member.
- Call-time (`src/extension/schemas.ts` `ChainItem`) and `.chain.json` / management `config.steps[]` (`src/agents/agent-management.ts#parseStepList`, `src/agents/chain-serializer.ts` JSON path) carry the object as-is.
- `.chain.md` carries one line per step whose value is the condition object as JSON: `stopOn: {"path":"/verdict","in":["FAIL","BLOCKED"]}`. The key is matched case-insensitively like every other `parseStepBody` key (`chain-serializer.ts:8-19` lowercases keys). JSON is the encoding because the object's string domain (root pointer `""`, members containing commas or whitespace, empty strings) has no lossless comma-list spelling, and management writes `.chain.md` for created and updated chains (`agent-management.ts:517, 648`), so a lossy line form would silently narrow conditions authored as objects. `serializeChain` emits the same line with `JSON.stringify`; parse -> serialize -> parse is byte-identical for every valid condition. This replaces the comma-list form discussed in the questionary.
- Dynamic parallel steps: `stopOn` is added to `DYNAMIC_STEP_KEYS` (`dynamic-fanout.ts:43`) and applies to every materialized item.
- Absence of `stopOn` means no evaluation. No existing chain file, schema, or saved agent changes; `stopOn` is purely additive and no migration is needed.

### D2. Field plumbing

The field is copied through every path that rebuilds steps field-by-field today, each of which would otherwise drop it silently:

| Surface | Change |
|---|---|
| `src/shared/settings.ts` | `stopOn?: StopCondition` on `SequentialStep`, `ParallelStep`, `DynamicParallelStep` |
| `src/shared/types.ts:26` `ChainOutputMapEntry` | `patchPath?: string` (D7); `Details.stop?: StopRecord` (D6) |
| `src/extension/schemas.ts` `ChainItem` | `stopOn` property (object with `path`, `in`); fixture `test/unit/fixtures/subagent-params.shape.json` regenerated; stays under the 9,500-byte budget (`test/unit/schemas.test.ts:430-435`, 8,173 bytes today) |
| `src/agents/agents.ts` `ChainStepConfig` | `stopOn?` |
| `src/agents/agent-management.ts#parseStepList` (`:163`) | parse `stopOn`; validation failures return through its existing `{ error }` result (callers at `:514`, `:629` check `parsed.error` and do not catch) with messages naming `config.steps[i].stopOn.path` / `config.steps[i].stopOn.in` |
| `src/agents/chain-serializer.ts` | `.chain.md` parse + serialize line; `.chain.json` passes the object through to validation |
| `src/slash/slash-commands.ts#mapSavedChainSteps` | sequential steps carry `stopOn` |
| `src/runs/background/async-execution.ts` (`buildSeqStep`, step mapping at `:536-590`) and `src/runs/shared/parallel-utils.ts` runner step/group types | `stopOn` copied to runner steps |
| `src/runs/foreground/subagent-executor.ts#expandChainParallelCounts` | already spreads `...step`; no change |

### D3. Pre-run validation

A new `validateStopConditions(steps)` in `src/runs/shared/stop-conditions.ts` runs wherever `validateChainOutputBindings` runs today (foreground `chain-execution.ts:473`, async `async-execution.ts:396`, `.chain.json` parse `chain-serializer.ts:176`). At those executor boundaries it throws before any child starts; `parseStepList` calls the same checks and converts the failure into its `{ error }` return (D2). Messages name the step and field:

| Condition | Message shape |
|---|---|
| sequential step with `stopOn` and no `outputSchema` | `Chain step N has stopOn but no outputSchema.` |
| parallel/dynamic step with `stopOn` and a task without `outputSchema` | `Chain step N task M has no outputSchema; stopOn requires one on every task.` |
| `path` not a valid JSON Pointer | `Chain step N stopOn.path '<value>' is not a JSON Pointer (must be "" or start with "/").` |
| `in` empty, not an array, or any member not a string | `Chain step N stopOn.in must be a non-empty array of strings.` |
| `.chain.md` line whose value is not a JSON object with string `path` and string-array `in` | `stopOn line '<line>' must be a JSON object {"path": "<json-pointer>", "in": ["<value>", ...]}.` |

### D4. Evaluation

`evaluateStopCondition(step, results) -> StopMatch[]` in `stop-conditions.ts`. For each task in the step that has a validated `structuredOutput` (exit 0; schema-invalid output is already exit 1 via `attempt-finalization.ts:218` / `subagent-runner.ts:782, 915`): resolve `path`, catching `DynamicFanoutError` as no match; a resolved value that is not a string (object, number, null) is no match; otherwise match when the value is in `in`. Returns matches in task order. Evaluation never fails a chain.

Named task outputs (`outputs[as]`) are bound only for exit-0 tasks on both executors; a failed task's error reaches the parent through `results[].error` and the `## Outputs` failed-task line, never through `{outputs.name}`. A dynamic step's `outputs[collect.as]` is the whole ordered collection, every item included with its `exitCode` and `error`, so nothing finished is discarded (D5). Evaluation runs once per step after every task's result is final, on both the success and the failure path. Today the foreground failure returns precede the output binding (parallel: failure return at `chain-execution.ts:692-710`, `outputs[as]` bound at `:713-717`; dynamic: failure return at `:887-910`, `outputs[collect.as]` at `:914`), so in both foreground branches binding the successful siblings' outputs and calling `evaluateStopCondition` move ahead of the failure return - binding outputs for a step that then fails is a deliberate new behavior. The async runner already binds before its breaks (parallel bind at `subagent-runner.ts:2222-2228`, break `:2251`; dynamic failure/collect at `:1933-1996`; sequential break `:2386`); evaluation slots in before each break. Existing collection-schema validation and group-acceptance checks (`chain-execution.ts:887-942`, `subagent-runner.ts:1935-2006`) finish before the outcome is chosen; a match never skips them.

Sites: foreground sequential after `chain-execution.ts:1149-1151`; foreground parallel and dynamic as reordered above; async runner before the breaks named above.

A `StopMatch` is `{ stepIndex, taskIndex?, as?, label?, agent, value }`; `taskIndex` is 0-based and omitted for sequential steps.

### D5. Chain outcome on a match

With at least one match and no process failure in the step:

- the chain returns after this step; no later step runs;
- foreground: `isError: false`; `details.stop` carries the stop record (D6); `details.outputs` holds every binding so far;
- background: the result JSON gains the same `stop` object, written in the same `writeAtomicJson` call as `state`/`success`/`exitCode` (`subagent-runner.ts:2486-2527`) so `result-watcher` (which spreads the result onto the completion event, `result-watcher.ts:159`) delivers it in one read; `state` is `complete`, `success` true, `exitCode` 0. The model-facing turn for a background run is `notify.ts#handleComplete` (`:47-96`), which today renders only `summary`; it gains: status word `stopped` in the header (`Background task stopped: **<agent>**`) when `result.stop` is present and `success` is true, and the `## Stop` block (D6) rendered from `result.stop` directly - never from `summary`, which `truncateOutput` may cut (`subagent-runner.ts:2391-2400`). The runner's `summary` already concatenates every result's output, so finished outputs reach the parent through it as today;
- the `workflowGraph` marks the stopped step `completed` and later steps stay `pending` (no new node status).

Precedence with a process failure in the same step - a task exit code other than 0 and -1, a collection-schema validation failure, or a group-acceptance failure: the existing failed result stands - `isError: true`, status `failed`, failed header - and `details.stop` / result-JSON `stop` is still populated from the successful siblings' matches, and the `## Stop` and `## Outputs` sections (D6) are appended. This applies to results built by `buildChainExecutionErrorResult` (`chain-execution.ts:163`) as well as by `buildChainSummary`. Nothing finished is discarded: the failed result carries the stop record and every finished output so the parent can issue a new call that reuses the successful work.

`failFast`-skipped siblings (exit -1) are neither matches nor failures; they render as skipped in the outputs section. An interrupted run performs no evaluation. A match on the last step is still a stop (record present) so the parent can tell "finished" from "finished with FAIL". `failFast`, acceptance ledgers, the `BLOCKED:` guard, and child semantics are unchanged.

### D6. The stop record and model-facing content

The record is one object serialized identically into `details.stop`, the background result/status JSON `stop`, and the content block:

```json
{
  "reason": "condition",
  "stepIndex": 1,
  "condition": { "path": "/verdict", "in": ["FAIL"] },
  "matches": [
    { "taskIndex": 0, "as": "sr_1", "label": "task 3 review", "agent": "spec-reviewer", "value": "FAIL" }
  ]
}
```

`buildChainSummary` gains a third status `"stopped"` beside `"completed"` / `"failed"`. Content for a stop:

```
⏹ Chain stopped at step 2/3 by condition /verdict in [FAIL]
<existing progress / artifacts lines>

## Stop
```json
<the record above>
```

## Outputs
### Step 1
#### Task 1 (implementer, as impl_1)
<retained final output text>
```json
<validated structured output, present only when the task had an outputSchema>
```
### Step 2
#### Task 1 (spec-reviewer, as sr_1)
...
#### Task 2 (spec-reviewer, as sr_2) - skipped (fail-fast)
```

`## Outputs` lists every finished task of every executed step, grouped by step in execution order; a sequential step renders one task heading. Each task shows its retained final text (`getSingleResultOutput`) and, when it had an `outputSchema`, its validated structured output as a fenced JSON block - both, because `outputEntryFromResult` binds only the JSON as `text` (`chain-outputs.ts:85`) and a reviewer's explanation outside the schema would otherwise be lost. Skipped (`failFast`, exit -1) tasks render their heading with the skipped marker and no body; failed tasks render their error line. No size cap is applied: the ticket requires the full output, and truncation could corrupt the record. Headings use the one-based numbering `aggregateParallelOutputs` already uses (`parallel-utils.ts:108-142`); the record uses 0-based `taskIndex`.

The `## Stop` and `## Outputs` sections are rendered in three cases: a controlled stop; a failed chain whose failing step had matches (header stays `❌ Chain failed ...`); and an ordinary completion of a chain in which any step carries `stopOn` (header stays `✅ Chain completed ...`, no `## Stop` section, `## Outputs` present) - so an all-PASS reviewer wave followed by a finished code reviewer hands the parent every verdict in one turn. A chain with no `stopOn` anywhere renders byte-identically to today. `compactForegroundDetails` (`src/shared/utils.ts:190-325`) keeps `stop`.

### D7. `patchPath` on worktree task outputs

When a parallel step runs with `worktree: true`, `diffWorktrees` captures one `WorktreeDiff` per task (`src/runs/shared/worktree.ts:409-548`). It writes a `.patch` file on every path except a `mkdirSync` failure - an unchanged worktree gets an empty file, and a capture failure gets an empty file plus `captureError` - so file existence is not the eligibility test. The output entry bound for a task (`ChainOutputMapEntry`, `types.ts:26`) gains `patchPath: <absolute path>` iff its diff has no `captureError` and `hasWorktreeChanges(diff)` is true (`worktree.ts:489`); otherwise the field is absent. Both executors bind `patchPath` after capture: foreground outputs are bound at `chain-execution.ts:713-717` and diffs are captured by `appendParallelWorktreeSummary` (`:183-193`); the async runner binds at `subagent-runner.ts:2222-2228` and captures at `:2240` (`appendParallelWorktreeSummary` defined `:1206`). On both surfaces the diff list is threaded into the output-entry builder (`outputEntryFromResult` / `outputEntryFromAsyncResult`, `chain-outputs.ts:85, 94`) so the path is bound before the next step's templates resolve.

`OUTPUT_REF_PATTERN` (`chain-outputs.ts:6`) accepts exactly one sub-field: `{outputs.<name>.patchPath}`. `validateChainOutputBindings` rejects it pre-run when the producing step is not `worktree: true` (`Chain step N references {outputs.<name>.patchPath} but step M is not a worktree step.`), on foreground and async chains alike (`async-execution.ts:396`). At resolve time a producer whose entry has no `patchPath` throws `Output '<name>' has no patch (<no changes | capture failed: <captureError>>).`. That failure is discovered after producers finished, so it is caught at the chain execution boundary and finalized as a failed chain carrying the diagnostic plus all accumulated results and output bindings - not through today's outer error conversion, which returns `details.results: []` in the foreground (`subagent-executor.ts:918-929`) and only logs in the detached runner's top-level rejection handler (`subagent-runner.ts:636`). No other sub-fields are introduced.

### D8. Consumer note for pi-gauntlet #70

Steps 1-2 of #70's wave are expressible: parallel implementers with `outputSchema` carrying `status`, `stopOn: { path: "/status", in: ["NEEDS_CONTEXT", "BLOCKED"] }`, `worktree: true`, `as: impl_<n>`; parallel spec reviewers reading `{outputs.impl_<n>.patchPath}` with `stopOn: { path: "/verdict", in: ["FAIL"] }`. Patch integration and scoped tests (`skills/subagent-driven-development/SKILL.md` steps 4-5 at pi-gauntlet `06bc7266`) are parent actions between spec review and code review; a pure `implementers -> SR -> CR` chain has no integrator. That is #70's design point (an integrator worker step with its own `stopOn`, or code review as a separate call); this spec adds no resume-at-step or branching API. The parent re-enters by issuing a new chain starting at the code-reviewer step.

## Errors and edge cases

| Case | Behavior |
|---|---|
| `stopOn` present, task's pointer resolves to undefined / non-string | no match; chain continues |
| `stopOn` on a step; a task's structured output fails schema validation | task is exit 1 today -> step failure path (D5 precedence); no evaluation for that task |
| match + sibling failure (exit != 0, != -1) | failure wins for status; record and outputs still rendered |
| match + `failFast`-skipped siblings | skipped rendered as skipped; not matches |
| dynamic fanout materializes zero items | no evaluation |
| match on the last step | stop record present, `stopped` status |
| interrupted run | no evaluation, existing interrupted path |
| `{outputs.x.patchPath}` where step x is not `worktree: true` | pre-run rejection |
| `{outputs.x.patchPath}` where task x produced no changes, or its capture failed | runtime error at template resolution naming which; chain finalized as failed with all accumulated results and bindings |
| collection-schema or group-acceptance failure on a dynamic step with matches | failure wins; record and outputs rendered (D5) |
| background stop; `summary` truncated by `maxOutput` | `## Stop` rendered from `result.stop`, unaffected by truncation |
| `stopOn` on a `.chain.md` step without `outputSchema:` line | pre-run rejection (D3 row 1) |

## Tests

Node `--test` unit tests, run as `env -u PI_CODING_AGENT_DIR npm run test:unit`; integration via `npm run test:integration` where the harness already covers the path.

- `test/unit/stop-conditions.test.ts` (new): every D3 rejection and the accept path; evaluator match / no match / non-string / root pointer; missing key, non-object intermediate, and out-of-range index all resolve to no match without throwing; multi-match ordering; 0-based `taskIndex`; sequential omits `taskIndex`.
- `test/unit/chain-serializer.test.ts`: `.chain.md` round-trip (parse -> serialize -> parse) with `stopOn` on a step, including the root pointer `""`, a member containing a comma, leading/trailing whitespace, and an empty-string member; malformed line rejection; key matched case-insensitively; `.chain.json` with `stopOn` validated.
- `test/unit/agent-management.test.ts` (or the existing management test file): `parseStepList` accepts `stopOn` and returns `{ error }` naming `config.steps[i].stopOn.<field>` on rejection.
- `test/unit/slash-commands` coverage: `mapSavedChainSteps` keeps `stopOn` on sequential steps.
- `test/unit/schemas.test.ts`: fixture regenerated; byte budget holds.
- `test/unit/chain-outputs.test.ts`: `{outputs.x.patchPath}` resolves; non-worktree pre-run rejection; runtime error for no changes and for capture failure, each naming its cause; `{outputs.x.other}` still rejected; `patchPath` bound only for a diff with changes and no `captureError`.
- `test/integration/chain-execution.test.ts`: sequential stop (content has `## Stop` record, retained text, and structured JSON, `isError: false`); a child whose final text differs from its structured output shows both; parallel stop with all N outputs and the following step not run; sibling failure + match (`isError: true`, record present, successful siblings' outputs bound and rendered); dynamic fanout stop; collection-invalid + match and group-acceptance-failure + match (failure wins, record present); all-PASS wave whose next step completes renders `## Outputs` on completion; no-`stopOn` chains byte-identical; worktree step binds `patchPath` after capture; completed producer followed by an unavailable patch reference finalizes as failed with accumulated results.
- `test/integration/async-execution.test.ts` / `test/unit/async-execution.test.ts`: `stopOn` copied to runner steps; result JSON carries `stop`; `result-watcher` delivers it; background `patchPath` reference resolves; unavailable patch reference finalizes the result file as failed; background sibling failure + match.
- `test/unit/notify.test.ts` (or the existing notify test): completion event with `stop` renders `Background task stopped:` and the `## Stop` block from `result.stop`; failure + match renders `failed` header with the block; truncated `summary` leaves the block intact.
- `test/unit/formatters.test.ts`: `buildChainSummary("stopped", ...)` renders header, `## Stop`, `## Outputs` grouped by step with one-based headings, skipped markers, and both text and JSON per task; `"completed"` with a `stopOn` chain renders `## Outputs`; `"completed"` without `stopOn` unchanged.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` (chain authoring: `stopOn` field, `.chain.md` JSON line form, the implementers -> spec reviewers -> code reviewer example - communication contract); `doc/agents-and-chains.md` (chain step fields: `stopOn`, `{outputs.name.patchPath}`, the stop record shape - communication contract); `doc/programmatic-api.md` (step field list - communication contract); `skills/pi-cohort/SKILL.md` quick reference (one `stopOn` example - implementation surface of the skill, listed because the ticket AC names it); `skills/pi-cohort/reference/config-fields.md` (file-authored field list); `CHANGELOG.md` `## [Unreleased]` Added entry naming `stopOn` and `patchPath` `(#23)`
- Derived / memory docs invalidated: `doc/orchestration-patterns.md:78` (worktree-diffs path paragraph now points at `{outputs.name.patchPath}` instead of the raw filename)

Materiality bar: [`reference/documentation-impact.md`](reference/documentation-impact.md). `AGENTS.md` is unchanged.

## Out of scope

- Text/regex conditions over output text (`stopOnPattern`); add when a consumer needs one.
- Cancelling running or queued siblings on a match; branching, retry, or resume-at-step inside a chain.
- pi-gauntlet #70's deliverables (skill edits, eval sample, version pin, integrator design).
- Any change to `failFast`, acceptance, or `BLOCKED:` semantics.

## Open questions

none
