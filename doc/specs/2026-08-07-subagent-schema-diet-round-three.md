# Subagent tool schema diet, round three

Trim the last easy token wins from the `subagent` tool schema (`src/extension/schemas.ts`), applying the patterns established in rounds one (`doc/specs/2026-08-06-subagent-schema-diet.md`) and two (`doc/specs/2026-08-08-subagent-schema-diet-round-two.md`). Round three is additive: it does not undo or replace any prior round's edits, so no supersession banners.

## Goal

Remove ~1,250 bytes of near-zero-attention-value JSON Schema from the tool advertisement serialized into every prompt (measured deltas: TaskItem stub ~821, allOf ~332, runId ~100; landing around 8,230 bytes from today's 9,483). All three changes are advertisement-only - runtime behavior is untouched. The final number is measured post-implementation, not asserted here; the pass/fail bar is the existing 9,500-byte ceiling.

## Decisions (from questionary)

- **AcceptanceOverride stays full.** The top-level `AcceptanceOverride` (~250 tokens) remains the one fully documented acceptance site. Stubbing it is out of scope: it only works if the pi-cohort acceptance docs are reliably in context whenever acceptance is used, which is not guaranteed.
- **Budget ceiling stays at 9,500 bytes.** The size test keeps its current ceiling; the schema just lands further under it.
- **`runId` leaves prose too.** The tool description control line drops the `runId` mention alongside the schema field.
- **No supersession.** Rounds are cumulative; prior specs stay in force.

## Changes

### 1. TaskItem stub

`TaskItem` (schemas.ts, the fully spelled-out PARALLEL-mode `tasks[]` item) gets the round-two stub treatment already applied to chain-parallel items via `ParallelTaskSchema`. Replace it with this literal (a named const, matching `ParallelTaskSchema` style):

```ts
const TaskItem = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	required: ["agent", "task"],
	properties: {
		agent: { type: "string" },
		task: { type: "string" },
		count: { type: "integer", minimum: 1, description: "Repeat N times (same settings)." },
	},
	description: "Per-task overrides (model, output, reads, skill, ...): pi-cohort skill.",
});
```

Notes on the shape:

- `required: ["agent", "task"]` is unchanged - PARALLEL-mode tasks require both, unlike chain-parallel items where `task` defaults to `{previous}`. Do **not** copy `ParallelTaskSchema`'s `task` description (its `{previous}` templating does not apply here) and do **not** include `as` (top-level PARALLEL mode has no `{outputs.name}` wiring).
- The description must **not** advertise `label` - `TaskParam` (subagent-executor.ts) has no `label` field at this position; the runtime would silently ignore it.
- The dropped keys (`output`, `outputMode`, `reads`, `progress`, `model`, `skill`, `cwd`, `acceptance`) pass through `additionalProperties: true`. This makes the two parallel forms consistent instead of subtly different.

### 2. Remove ChainItem allOf conditionals

Delete the three `allOf` if/then/not entries on `ChainItem` (expand-requires-parallel+collect, collect-requires-expand+parallel, no-expand-with-parallel-array). Rationale: runtime enforces the same invariants at chain parse time (`src/runs/shared/dynamic-fanout.ts:178-203` - expand requires a parallel object plus collect, static-array mixing rejected, nested fanout rejected), so removing the schema conditionals moves rejection from provider-side to executor-side with identical outcomes. The `ChainItem` description already documents the `{expand,parallel,collect}` coupling for the model's benefit.

### 3. Drop `runId` from advertisement

- Delete the `runId` field from `SubagentParams` (schemas.ts). It is self-deprecating ("Prefer id").
- Update the tool description control line in `src/extension/index.ts` (the single `CONTROL: action=status/interrupt/resume (id/runId, message, index)` line) to say `(id, message, index)`.
- **Runtime acceptance is kept**: `subagent-executor.ts` (`params.id ?? params.runId`) and `async-resume.ts` (`assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId")`) are untouched, as is the `runId` member on the hand-written `SubagentParamsLike` runtime interface. The schema drop only stops advertising the alias; calls that still pass `runId` keep working - the stripped field is not rejected because `SubagentParams` does not forbid unknown top-level keys at the boundary the executor reads from. A regression test locks this in (see Test impact).

## Out of scope

- Stubbing or trimming the top-level `AcceptanceOverride` (decision above).
- Lowering the 9,500-byte budget ceiling (decision above).
- Any change to runtime validation, `SubagentParamsLike`, chain parsing, or acceptance handling.
- Skill/reference doc changes. The stub description's "pi-cohort skill" pointer resolves to the SKILL.md section "Top-level parallel tasks can override per-task behavior" (the worked example listing per-task overrides), which already covers this position. `skills/pi-cohort/reference/config-fields.md` does **not** document `tasks[]` execution overrides (it covers management `config` and call-time `control`) - do not cite it for this position.

## Test impact (`test/unit/schemas.test.ts`)

Reference tests by name, not line number:

- **`tasks[]` item structure test** (the test asserting explicit `output`/`reads`/`progress` fields on `tasks.items`): rewrite to assert the new stub shape - `additionalProperties: true`, explicit keys `{agent, task, count}`, `required: ["agent","task"]`, pointer description - alongside the existing chain-parallel stub tests, so the stub contract is tested uniformly across both positions.
- **`runId` schema assertion**: remove. Replace with a regression test asserting (a) `properties.runId` is absent from the advertised schema, and (b) the compiled `SubagentParams` still accepts `{action: "status", runId: "..."}` (the alias passes schema validation and remains consumable by the executor's `params.id ?? params.runId`).
- **ChainItem**: add an assertion that `ChainItem` carries no `allOf`.
- **"validates representative flexible field values" (TypeBox compiler test)**: three `invalidValues` fixtures become schema-valid after these changes - `{ tasks: [{ ..., reads: "input.md" }] }` (TaskItem stub) and the two chain expand/parallel fixtures (allOf removal). Move them to `validValues` as runtime-deferred pass-throughs, per the round-two convention already used in that test for chain-parallel arms. Runtime rejection of the fanout shapes stays covered by `dynamic-fanout` tests.
- **"nested acceptance stub" describe**: `stubSites` includes `["tasks-item", taskItem.acceptance]` and an identical-serialization comparison against chain-step. After the stub, `taskItem.acceptance` is undefined. Drop the tasks-item entry, leaving chain-step as the sole stub site, and reduce the identical-serialization test accordingly.
- **`brief()` invariant tests**: in `canonicalPositions`, `taskItem.reads` is the *canonical* `ReadsOverride` site (chain-step wraps it), so "remove the tasks-item entry" is not sufficient - restructure the `reads` group the way the self-referential `output`/`outputSchema` groups are structured (chain-step as its own reference), or drop the group if no cross-position comparison remains. Remove tasks-item entries from `outputSites` and any other const-reuse lists.
- **Shape-guard fixture** (`test/unit/fixtures/subagent-params.shape.json`): regenerate by serializing `stripDescriptions(SubagentParams)` (the helper already in the test file) into the fixture - a one-liner node script against the built schema, since no regeneration command ships in the repo. Also fix the test's regeneration comment: it points at `doc/plans/2026-08-06-subagent-schema-diet.md`, which does not exist; point it at this spec instead. Verify the fixture diff shows exactly the three declared changes (TaskItem stub shape, no `allOf`, no `runId`) and nothing else.
- **Size budget test**: ceiling unchanged at 9,500. Update the baseline comment with the measured post-change byte count.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:all` green.

## Risks / edge cases

- **Provider compatibility**: all three changes are widening-only (more permissive schema, fewer constraints). No provider can newly reject a previously valid call.
- **Lost provider-side type checks on demoted `tasks[]` keys - accepted.** The executor only validates `count` (expansion) and `acceptance` (`validateAcceptanceInput`) on `tasks[]` items. Unknown keys are silently ignored; mistyped known keys (`reads: "input.md"`, `model: 123`, ...) are no longer provider-rejected and either pass through silently or hit non-uniform runtime type errors. This is the same tradeoff round two accepted for chain-parallel arms, and is accepted here for consistency between the two parallel forms.
- **Fanout error-timing shift**: malformed expand/parallel/collect steps that the schema used to reject at the provider now reach the executor and fail at chain parse with `dynamic-fanout`'s existing messages.
- **Fixture drift**: any accidental shape change beyond the three declared ones fails the shape-guard test; review the fixture diff.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - entry (draft): "Schema diet round three: `tasks[]` items collapsed to the round-two stub form (overrides pass through, documented in the pi-cohort skill), `ChainItem` allOf conditionals removed (runtime-enforced at chain parse), and `runId` no longer advertised by the tool schema - still accepted at runtime, `id` preferred."
- Derived / memory docs invalidated: none

## Open questions

None - all questionary items resolved (see Decisions).
