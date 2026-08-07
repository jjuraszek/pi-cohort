# Subagent Schema Diet, Round Two: Parallel-Item Stubs, Control Stub, Description Compression

Follow-up to `2026-08-06-subagent-schema-diet.md` (23.1KB -> 18KB) and the 5.1.0
acceptance-stub dedup (`4bf7e8d`, 18.0KB -> 12.4KB). Three further cuts to the
`subagent` tool's per-call token payload, totaling ~3.9k chars: permissive stubs
for the `chain[].parallel` item schemas (~2.2k), a permissive stub for `control`
(~1.1k), and one-line compression of the MANAGEMENT/CONTROL description blocks
(~0.6k). All three are declaration-only: the provider sees less, the runtime
behaves identically.

## Evidence base (measured, not estimated)

Measured at `ff7af45` (5.1.0) by serializing `SubagentParams`
(`JSON.stringify(SubagentParams).length`); savings computed from the literal
replacement objects/strings in this spec:

| Target | Current bytes | After | Saved |
|---|---|---|---|
| `chain.items.parallel` union (ParallelTaskSchema 1,317 + DynamicParallelTemplateSchema 1,264) | 2,707 | ~500 | ~2,200 |
| `ControlOverrides` (10 documented fields) | 1,287 | 226 (literal stub below) | ~1,060 |
| Tool description MANAGEMENT (654) + CONTROL (356) blocks | 1,010 | ~410 (literal lines below) | ~600 |
| **Total SubagentParams** | **12,374** | **9,483 (measured post-implementation)** | |

### Session-history audit (reproducible)

Corpus: `~/.pi/agent/sessions/**/*.jsonl` (~3.7GB, snapshot 2026-08-08).
Method: (1) `rg -o 'Validation failed for tool \\"([a-z_-]+)\\"' -r '$1'` over the
corpus, counted by tool name; (2) a node script streaming every JSONL line
containing `"name":"subagent"`, JSON-parsing each entry, walking to `subagent`
tool calls, and tallying key usage at each position (top-level, `tasks[]`,
chain step, `chain[].parallel[]`, `control`). 14,517 subagent calls across
1,108 session files. Results:

- Zero client-side schema validation failures for `subagent`, ever (`edit`:
  1,826; `context_tree_query`: 1,100; `subagent`: 0). The
  `additionalProperties: false` guard on `DynamicParallelTemplateSchema` has
  never fired; losing it costs nothing observed.
- `chain[].parallel[]` item key usage: only `agent`/`task`/`label`/`model`/`phase`
  ever used. Zero uses of `output`, `outputMode`, `reads`, `skill`, `cwd`,
  `progress`, `outputSchema`, `acceptance` inside parallel items.
- `control` used 1,316 times, but 1,316/1,316 set `needsAttentionAfterMs` - all
  scripted by the pi-gauntlet repo's `skills/roasting-the-spec/SKILL.md` (line
  61 at pi-gauntlet HEAD), whose dispatch template hardcodes
  `control: { needsAttentionAfterMs: 600000 }` beside `tasks:`. Callers learn
  `control` field names from skill text, not the schema; a permissive stub
  keeps accepting them. (Other keys: `inFlightSilenceKillMs` 51,
  `activeNoticeAfterMs` 15.)

### Runtime decoupling (why these changes cannot affect stability)

- The executor types params as `SubagentParamsLike`, a hand-written TS interface
  (`src/runs/foreground/subagent-executor.ts:113`); the JSON schema is never
  consulted at runtime.
- `resolveControlConfig` (`src/runs/shared/subagent-control.ts:39`) defensively
  re-parses the numeric and list control fields (`parsePositiveInt`,
  `parseControlList`) with fallback to defaults; `enabled` is a plain `??`
  chain but stays explicitly typed in the stub. Garbage degrades, it does not
  crash.
- Dynamic-fanout steps are runtime-validated independently of the schema:
  `assertOnlyKeys(step.parallel, DYNAMIC_PARALLEL_KEYS, ...)`
  (`src/runs/shared/dynamic-fanout.ts:47,146`) rejects unknown keys on the
  dynamic template at chain-validation time.
- `ChainItem`'s `allOf` conditionals test only the *presence* of
  `parallel`/`expand`/`collect`, not their shape - unaffected by stubbing.

## Change 1: parallel-item stubs (`src/extension/schemas.ts`)

The `chain.items.parallel` union keeps its two-arm structure (static array vs
dynamic template object); both arms' item schemas become stubs following the
`AcceptanceOverrideStub` pattern (schemas.ts:132-138): non-empty `properties`,
`additionalProperties: true`, description pointing at the full docs.

**Selection rule for explicit keys:** keep the structural/wiring keys that
define fanout arity and result routing; demote all per-task *overrides*
(passthrough decoration and behavior tweaks) to implicit passthrough documented
in the skill. `agent`/`task` define the dispatch; `count` (static arm) defines
arity; `as` (static arm) wires `{outputs.name}` references. `phase`, `label`,
`model`, and the rest are overrides: historically used ones (`model` 370,
`label` 444, `phase`) are carried by skill dispatch templates (e.g. pi-gauntlet
`skills/roasting-the-spec/SKILL.md:86` passes `model:` explicitly per member;
pi-cohort SKILL.md examples carry `output:` in parallel steps), and the
permissive stub still accepts every one of them. Decided with the user.

**Static item stub** (replaces `ParallelTaskSchema`, schemas.ts:155-173):

- Explicit: `agent` (required, string), `task` (string), `count` (integer,
  min 1, description "Repeat N times."), `as` (string, description
  "Identifier for {outputs.name}.").
- `additionalProperties: true`.
- Description on the object: `"Per-task overrides (model, label, output, skill,
  ...): pi-cohort skill."` (trimmed during implementation to meet the 9,500-byte
  budget; the spec's original longer list produced 9,535 bytes)

**Dynamic template stub** (replaces `DynamicParallelTemplateSchema`,
schemas.ts:184-198):

- Explicit: `agent` (required, string), `task` (string), keeping the exact
  current templating description verbatim:
  `"{item},{item.path},{task},{previous},{chain_dir},{outputs.name} template."`
- `additionalProperties: true` (was `false`; widening, see Compatibility).
- Same overrides-pointer description on the object.
- The second position-unique fact - `label` supports item templates
  (schemas.ts:188 "Label; item templates supported.") - loses its schema home;
  it moves to the pi-cohort skill's dynamic-fanout reference
  (`skills/pi-cohort/reference/chains.md` or the SKILL.md fanout section,
  whichever documents `expand`/`collect` - implementer confirms at edit time).

`Type.Unsafe` is the construction mechanism, as with `AcceptanceOverrideStub`.
The top-level `tasks[]` schema and the chain-step (`ChainItem`) fields are
untouched - they remain the canonical documented positions for the override
fields, per the brief() convention (full description at exactly one position).

## Change 2: control stub (`src/extension/schemas.ts`)

`ControlOverrides` (schemas.ts:247-256; 10 fields: `enabled`,
`needsAttentionAfterMs`, `activeNoticeAfterMs`, `inFlightSilenceCeilingMs`,
`inFlightSilenceKillMs`, `activeNoticeAfterTurns`, `activeNoticeAfterTokens`,
`failedToolAttemptsBeforeAttention`, `notifyOn`, `notifyChannels`) becomes:

```json
{
  "type": "object",
  "additionalProperties": true,
  "properties": { "enabled": { "type": "boolean" } },
  "description": "Attention-tracking overrides (needsAttentionAfterMs, notifyOn, ...); fields: pi-cohort skill reference/config-fields.md."
}
```

This literal object serializes to 226 bytes (the table above uses this figure).
`enabled` stays explicit to satisfy the non-empty-`properties` rule (bare
`{type:"object"}` risks provider rejection, same wall as `$defs`/`$ref` - issue
#6). Naming one or two high-traffic keys in the description preserves scent
without re-inlining the table.

The full 10-field table (name, type, default, meaning - defaults sourced from
`resolveControlConfig` and the `DEFAULT_*` constants in `subagent-control.ts`)
moves to `skills/pi-cohort/reference/config-fields.md` as a new "Call-time
`control` overrides" section. Extending the existing reference file rather than
minting a new one: the `config` field's pointer precedent (schemas.ts:293)
already routes readers there. The file's scope header currently reads "Fields
accepted by `subagent({action: create|update, config})`" - amend it to cover
both the config fields and the new call-time section (e.g. "Field reference for
`subagent()`: agent/chain `config` fields, and call-time `control` overrides").

## Change 3: description compression (`src/extension/index.ts`)

In the tool description, the MANAGEMENT bullet list (6 bullets starting
index.ts:442, 654 chars) and CONTROL bullet list (3 bullets starting
index.ts:450, 356 chars) each compress to one line, keeping every action name
(the retrieval keys) and dropping per-action examples:

- MANAGEMENT: `MANAGEMENT: action=list/get/create/update/delete (chainName for
  chains; packaged agents use dotted names); config fields: pi-cohort skill
  reference/config-fields.md.`
- CONTROL: `CONTROL: action=status/interrupt/resume (id/runId, message, index);
  details: pi-cohort skill.`

The literal replacement lines total ~410 chars -> ~600 saved (not the ~1k a
full deletion would give; the action names are kept deliberately). The
EXECUTION section, chain template variables, and examples are untouched - they
carry the highest-frequency usage. DIAGNOSTICS (one line already) is untouched.

## Compatibility

- **Widening only, never narrowing.** Every input valid today remains valid.
  The prior spec's roast killed shape *narrowing* as a hard exclusion; that
  exclusion is honored - these stubs accept strictly more.
- **Typo behavior differs per arm.** Static-arm (`parallel: [...]`) items:
  `ParallelTaskSchema` never had `additionalProperties: false`, and no runtime
  key check exists - unknown keys were and remain silently ignored; the stub
  changes nothing observable. Dynamic-arm (`parallel: {...}` template): the
  schema-level `additionalProperties: false` goes away, but
  `assertOnlyKeys(step.parallel, DYNAMIC_PARALLEL_KEYS, ...)`
  (dynamic-fanout.ts) still rejects unknown keys at chain-validation time - the
  error moves later (runtime instead of provider), it does not disappear.
- **Wrong-type values in demoted fields** (e.g. a non-string dynamic `label`)
  now pass the provider schema and reach runtime paths that assume types.
  Accepted risk, decided with the user: zero schema-validation rejections for
  `subagent` in the audited history means this class of input has not occurred;
  no executor-boundary type validator is added (option explicitly declined).
- **Nested `acceptance` rejection moves, not disappears.** Malformed acceptance
  inside parallel items now passes the provider schema (via
  `additionalProperties: true`) but is still rejected at runtime by
  `validateAcceptanceInput` (added in `4bf7e8d`) with per-site path labels.
  Schema-level reject tests for those positions are dropped; the
  executor-boundary tests already cover it.
- **`fanout-child.ts`** imports `SubagentParams` wholesale (line 12); it
  inherits the diet automatically, no change needed.
- **`$ref`/`$defs` remain off the table** (provider rejection, issue #6).

## Testing

All in `test/unit/schemas.test.ts` unless noted:

1. **Size budget**: assertion drops `13_000` -> `9_500` (measured post-change:
   9,483). Update the baseline comment. This budget gates the
   serialized `SubagentParams` **schema only**; the description-string savings
   (Change 3) are not gated by a test - the exact replacement lines in this
   spec are the contract.
2. **Shape-guard fixture**: regenerate
   `test/unit/fixtures/subagent-params.shape.json` by serializing the new
   `SubagentParams`, applying the existing `stripDescriptions()` helper, and
   overwriting the fixture (by-design failure, same protocol as `4bf7e8d`).
   Review the fixture diff: it must show only the three declared shape changes
   (two parallel arms, control).
3. **Stub-structure tests**: extend the existing stub-site tests
   (schemas.test.ts:671-714) - assert both parallel arms and the control field
   have `additionalProperties: true`, the declared explicit keys (static:
   agent/task/count/as; dynamic: agent/task; control: enabled), and the
   pointer descriptions.
4. **Existing position-matrix tests are pruned, not left untouched.** The
   `brief()` clone invariants block (schemas.test.ts:543-668) dereferences
   `skill`/`outputMode`/`reads`/`output`/`outputSchema` on both
   `staticParallel` and `dynamicTemplate`; those nodes are deleted by Change 1,
   so both parallel positions are removed from `canonicalPositions` /
   `outputSites` / `outputSchemaSites` and the invariants are asserted only on
   the surviving positions (tasks-item, chain-step). The nested-acceptance
   stub test's `stubSites` shrinks from 4 to 2 (tasks-item, chain-step);
   acceptance *valid-shape* checks at the two parallel positions stay (the
   permissive stubs accept them), schema-level *reject* fixtures there are
   removed with a comment pointing at the `validateAcceptanceInput` runtime
   tests.
5. **Live smoke** (manual, post-implementation): one real `subagent` chain
   dispatch with a static parallel step carrying `model` + `label` overrides -
   observable: `action: "status"` (or the run tree) reports each child's
   resolved model and label matching the overrides; and one dispatch with
   `control: { needsAttentionAfterMs: 5000 }` - observable: the call passes
   provider schema validation and executes. Observing an actual
   needs_attention notice is NOT part of the smoke: `applyTurnLifecycleEvent`
   (`src/runs/shared/subagent-control.ts`) counts streaming `message_update`
   and tool events as productive signals, so the notice cannot fire for a
   healthy child by design - it requires a genuinely silent/wedged run.
   Threshold application is instead covered by the `resolveControlConfig` /
   `deriveActivityState` unit tests (`test/unit/subagent-control.test.ts`).
   If a required model/provider is unavailable, skip with a named note in
   the PR; the unit assertions above are the merge gate.

   Executed 2026-08-08: both smokes ran against a live provider (isolated
   `PI_CODING_AGENT_DIR`, worktree extension). Parallel smoke: schema
   accepted, labels `smoke-a`/`smoke-b` and the per-child `model` override
   applied. Control smoke: `control: { needsAttentionAfterMs: 5000 }`
   accepted end-to-end and the run executed; no notice observed, consistent
   with the semantics above.

## Out of scope

- Executor-boundary key/type validation for static parallel items (offered,
  declined).
- Any change to top-level `tasks[]`, `ChainItem` step fields, `acceptance`
  handling, or the EXECUTION portion of the description.
- Skill body rewrites beyond the config-fields.md control table, its scope
  header, and the relocated `label`-templating fact.

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `skills/pi-cohort/reference/config-fields.md`
  (new "Call-time `control` overrides" table + scope-header amendment);
  pi-cohort skill dynamic-fanout reference (relocated `label` item-templating
  fact); `CHANGELOG.md` (`Unreleased` / `Changed` entry with measured
  before/after payload and the widening note, matching the 5.0.1/5.1.0
  precedent); predecessor spec `doc/specs/2026-08-06-subagent-schema-diet.md`
  (partial-supersession banner)
- Derived / memory docs invalidated: none

## Open questions

None.
