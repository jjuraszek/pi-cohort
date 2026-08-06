# Subagent tool schema diet: 23,151 B -> <=18,000 B (description trimming only)

Issue: [jjuraszek/pi-cohort#4](https://github.com/jjuraszek/pi-cohort/issues/4)
Baseline: `eb7c74b`, schema measured at exactly 23,151 bytes via
`Buffer.byteLength(JSON.stringify(SubagentParams), "utf8")`.

## Goal

Shrink the serialized `SubagentParams` JSON schema from 23,151 bytes to <=18,000
bytes without removing or narrowing any accepted input shape. The only lever is
description-text trimming (issue #4's consolidated roast killed shape narrowing
and `$defs`/`$ref` dedup; both are hard exclusions, see [Out of scope](#out-of-scope)).

Why it matters: the schema ships in every request as part of the tool
advertisement (~5.8K tokens today), twice over - both `src/extension/index.ts:457`
and `src/extension/fanout-child.ts:156-166` register the same `SubagentParams`
object.

## Design

Single-file mechanical change to `src/extension/schemas.ts`, plus tests and one
skill-side doc absorption. Three levers:

### Lever 1: `brief()` helper + nested one-liners

TypeBox inlines a reused schema object at every composition site (no `$ref`), so
the replicated override consts each serialize their full description 4-6 times.
All sites reference the const at module init - a naive description edit changes
every copy at once. Mechanism:

```ts
// Descriptor-preserving clone: TypeBox 1.3.11 metadata ("~kind", "~unsafe",
// "~optional") lives in NON-ENUMERABLE string-keyed properties. Object spread
// would drop them (and Type.Optional on a plain clone would re-add "~optional"
// as an enumerable key, leaking `"~optional":true` into the serialized JSON).
const brief = <T extends object>(schema: T, description: string): T =>
  Object.defineProperties(
    Object.defineProperties({}, Object.getOwnPropertyDescriptors(schema)),
    { description: { value: description, enumerable: true, writable: true, configurable: true } },
  ) as T;
```

Example at a simple site: `outputMode: Type.Optional(brief(OutputModeOverride,
"inline (default) or file-only."))`. The wrapper applies uniformly regardless of
the underlying schema's complexity (plain enum or the full acceptance union).
Invariant: `Type.Optional()` always wraps the `brief()` clone - never clone an
already-Optional-wrapped schema.

- Canonical full descriptions live at exactly one position each: top-level
  `SubagentParams` for `acceptance`, `skill`, `outputMode`; the first-documented
  nested site for `reads` (task item). **`output` is the exception**: top-level
  `output` is a separate inline `Type.Unsafe`, not the `OutputOverride` const,
  so `OutputOverride`'s full text survives nowhere by design - the trimmed
  top-level `output` description is the sole carrier of the string/true/false
  facts, and all 4 nested `OutputOverride` sites get one-liners.
- Every non-canonical use site wraps: `acceptance:
  Type.Optional(brief(AcceptanceOverride, "Acceptance policy override for this
  task."))`. One-liners are ~40-60 bytes.
- Applies to: `AcceptanceOverride` (5 sites), `SkillOverride` (5),
  `OutputModeOverride` (5), `OutputOverride` (4), `ReadsOverride` (4), and
  `JsonSchemaObject` (the sixth replicated const: ~79 B description at its
  outputSchema sites, ~380 B total) - consts defined at
  `src/extension/schemas.ts:8-35` and `:80-109`.
- Validation semantics untouched: the descriptor clone copies `anyOf`/`enum`
  byte-identically and preserves the non-enumerable metadata, so `Value.Check`
  behavior is preserved (asserted by tests, see [Testing](#testing)).
- Canonical consts are never mutated; `Type.Optional()` wraps the clone, same
  order as today.

### Lever 2: `config` description -> pointer

The 640-byte `config` field list shrinks to a ~90-byte pointer:

> "Agent or chain config for create/update; field reference: pi-cohort skill,
> reference/config-fields.md. String values must be valid JSON."

The pointer names the skill and the filename so a caller whose context lacks the
skill body still has a retrievable locator. The full field list moves to a new
`skills/pi-cohort/reference/config-fields.md` (see
[Skill-side absorption](#skill-side-absorption)) so no information is lost
anywhere - and gains fields the 640B description never had (see below).

### Lever 3: named top-level trims

Each description below is shortened to fact-only text. Trim rule: guidance prose
already carried by `skills/pi-cohort/SKILL.md` may be dropped; an accepted-shape
fact ("string or false", "defaults to X", enum values, unit suffixes) may never
be dropped. The implementation PR enumerates each cut's before/after and measured
byte saving with a running total (issue AC #4).

Named trim list (current serialized description bytes in parentheses):

| Field | Bytes now | Trim direction |
|---|---|---|
| `config` | 640 | lever 2 pointer |
| `chain.items.task` | 227 | keep variable names, drop usage prose |
| `clarify` | 183 | keep foreground/async fact, drop guidance |
| `context` | 177 | keep enum + fork-default fact, drop rationale |
| `chain.items` | 160 | keep the three step forms, drop elaboration |
| `runId` | 150 | keep "prefer id" + target fact (no deprecated prefix - that is issue #5) |
| `worktree` | 149 | keep isolation + clean-git-state facts |
| `output` (top-level) | 149 | keep false/true/string semantics |
| `chain` | 146 | keep {previous} propagation fact |
| `control.inFlightSilenceKillMs` | 144 | keep SIGTERM + default + clamp facts |
| `chainDir` | 120 | keep default location fact |
| `sessionDir` | 85 | keep default + enables-sessions fact |
| `tasks` | 84 | keep the item-shape pointer |

**Second wave (required, not optional)** - council simulation showed the list
above cannot reach budget alone: dedup of the 5 named consts + the `config`
pointer + *deleting* every named-list description reaches only ~19,637 B, and
zeroing `control.*`/`agentScope` on top still lands ~18,772 B. Closing the
remaining gap requires the same trim rule applied to the duplicated nested
descriptions the first wave does not touch:

- `JsonSchemaObject` dedup (lever 1, sixth const): ~285 B recoverable.
- The per-item fields duplicated across `TaskItem`, `ParallelTaskSchema`,
  `DynamicParallelTemplateSchema`, and `ChainItem` - `phase`, `label`, `as`,
  `progress`, `count`, `model`, and the two `task` template descriptions:
  ~1.1 KB of near-identical text, trimmed to one-liners at all but one
  canonical site each (same canonical-site rule as lever 1, via `brief()` for
  shared consts or direct text edits for inline duplicates).
- Remaining `control.*` key descriptions shortened to fact-only (defaults and
  units kept).

The first wave alone lands at exactly 18,000 B - no margin; the second wave
closes the gap; the shipped result is <= 17,950 with explicit headroom kept for
future field additions (final figure in the budget test run); the budget test
is the arbiter and the PR's running total (AC #4) records the actual
arithmetic.

Sanity-check data points only (no depth heuristic is used by this spec):
stripping all descriptions floors the schema at 13,167 B; the issue's
depth>=4-strip figure is 16,992 B.

## Skill-side absorption

The `config` field reference lands as a `reference/` file, not inline -
`skills/pi-cohort/SKILL.md` is already ~820 lines, past writing-skills' 500-line
ceiling, so an inline table would compound an existing violation.

- New file `skills/pi-cohort/reference/config-fields.md`: two compact tables
  (agent config fields; chain config fields), each row = field, type, meaning,
  default. **Accuracy source is the runtime, not the old prose**: derive the
  tables from `applyAgentConfig()` and `parseStepList()` in
  `src/agents/agent-management.ts` - the 640B schema description is stale
  against them (it omits agent-level `fallbackModels` and `completionGuard`,
  chain-step `phase`, `label`, `as`, `outputSchema`, and says singular `skill`
  where the accepted step field is `skills`). SKILL.md's management-section
  prose (~lines 500-560) supplies wording, not field inventory.
- Completeness check (part of acceptance): every config key accepted by
  `applyAgentConfig()`/`parseStepList()` appears in the reference file; verified
  by review against the two functions and stated in the PR.
- One pointer line added to SKILL.md's management section: "Full config field
  reference: `reference/config-fields.md`" (progressive-disclosure pattern).
- **Writing-skills RED-GREEN applies** (reference-type change, gap/retrieval
  scenario; the discipline: no skill/reference edit ships without a baseline
  failure observed first). Inlined protocol so the cycle is executable without
  the external skill present:
  - Scenario prompt (identical for both runs, fresh-context `worker`, cwd = the
    worktree): "Using only skills/pi-cohort/SKILL.md and this schema
    description for `config`: '<the dieted ~100B pointer text>', compose a
    `subagent` create call for (1) an agent named `triage` in package `ops`,
    project scope, forked default context, inheriting project context but not
    skills, max subagent depth 2; and (2) a chain named `audit` with two steps
    where the second step reads the first's output file and injects two
    skills. Output the two exact tool-call JSON bodies."
  - The scenario deliberately targets fields ABSENT from current SKILL.md prose
    (`defaultContext`, `inheritProjectContext`, `inheritSkills`,
    `maxSubagentDepth`, chain-step `reads`/`skills` shape) - SKILL.md's
    existing create examples cover name/package/model/tools, so a scenario on
    those would stay green without the reference file.
  - RED (run before writing the reference file): pass = the worker guesses,
    omits, or invents at least one of the targeted fields (documented
    verbatim). If RED unexpectedly stays green, the reference file is not
    justified by this scenario: either target a field the worker actually
    missed or ship without the artifact and say so - do not ship an unjustified
    file.
  - GREEN (identical prompt, reference file present): pass = both call bodies
    use the targeted fields correctly per `applyAgentConfig()`/
    `parseStepList()` semantics.
  - Evidence: both transcripts (verbatim key excerpts) summarized in the PR
    description - process evidence, not a committed test.
- No other SKILL.md edits: recon verified the trimmed descriptions point at
  knowledge the skill body already carries (clarify gating, worktree semantics,
  control tuning) - no gaps to fill.

## Testing

All in `test/unit/schemas.test.ts` (existing file; node `--test` with
type-stripping, existing assertion conventions). Run with
`env -u PI_CODING_AGENT_DIR npm run test:unit` per AGENTS.md.

1. **Size budget test**: `Buffer.byteLength(JSON.stringify(SubagentParams),
   "utf8") <= 18_000`; failure message reports the actual byte count and the
   23,151 baseline. Named as an API payload budget - the whole-schema ceiling is
   intentional and also gates future field additions (issue AC #1). Test comment
   states the budget measures our canonical JSON, not provider re-serialization
   or tokenizer counts. Placement: a new top-level `describe("schema size
   budget")` block in `test/unit/schemas.test.ts`, importing `SubagentParams`
   directly (typebox is an optional peer dependency in this repo -
   package.json peerDependenciesMeta - so the block reuses the file's
   typebox-availability skip guard, per existing convention).
2. **Acceptance at all 5 positions** (issue AC #2): for each position -
   top-level, `tasks[]` item, chain step, static `parallel[]` member, dynamic
   fanout `parallel` template - three fixtures validate via the compiled
   schema (`typebox/compile` `Compile(...).Check`, the file's established
   validation path) against the actual schema object: object form
   (`{ level, criteria, verify }`), string form (`"checked"`), literal `false`.
3. **Shape-preservation guards** for the other replicated overrides, one nested
   position each: `skill` string/array/boolean, `output` string/boolean,
   `outputMode` both enum values, `reads` array/boolean.
4. **`brief()` invariant test**: for each wrapped nested copy, (a) the
   serialized JSON node deep-equals the canonical const's serialized node
   except the `description` value, with no `~`-prefixed key appearing in
   either; (b) `Object.getOwnPropertyDescriptor(clone, "~kind")` (and
   `"~unsafe"` where the const has it) exists and is non-enumerable - i.e. the
   descriptor clone preserved TypeBox metadata. Catches both a future editor
   "fixing" a nested copy's shape independently and a regression of `brief()`
   to a plain spread.
5. **Whole-schema shape guard** (issue AC #3): a helper recursively strips
   every `description` key from `JSON.parse(JSON.stringify(SubagentParams))`
   and deep-equals the result against a committed baseline fixture
   (`test/unit/fixtures/subagent-params.shape.json`, generated from the
   pre-diet schema at `eb7c74b` with the same helper). Any narrowing anywhere -
   enum, `minimum`, `additionalProperties`, chain conditionals - fails the
   diff, not just the positions covered by fixtures 2-3.

6. **Subagent sanity pass (end-to-end smoke)**: after the diet, the full
   integration suite (`npm run test:integration`) must stay green - it spawns
   real subagent runs (chain, parallel, async, management) whose dispatches
   validate against the dieted schema at runtime. On top of that, one live
   smoke check in a real pi session: `subagent({ action: "list" })`,
   `subagent({ action: "doctor" })`, and one trivial `worker` dispatch
   exercising a dieted nested position (e.g. a 2-task parallel call with
   `acceptance: "attested"` and `outputMode` set) - confirming the provider
   accepts the trimmed tool advertisement and the tool behaves identically.
   Result recorded in the PR description.

Existing suite stays green; no integration-test edits (runtime behavior
untouched) - the suite is a consumer here, not a change target.

## Edge cases

- **TypeBox metadata keys**: in the installed typebox@1.3.11, schema metadata
  (`~kind`, `~unsafe`, `~optional`) lives in **non-enumerable string-keyed**
  properties (not symbols). Object spread drops them, and `Type.Optional()` on
  a spread clone re-attaches `~optional` as an enumerable key that leaks
  `"~optional":true` into the serialized JSON (+17 B per site and a
  shape-diff violation). Hence `brief()` clones via
  `Object.getOwnPropertyDescriptors`; the invariant test (Testing item 4)
  asserts both the non-enumerable metadata survival and the absence of `~`
  keys in serialized output, and the position fixtures run `Value.Check`
  against the wrapped schemas.
- **Two registrations, one object**: `index.ts` and `fanout-child.ts` import
  `SubagentParams` by reference; one edit covers both, and the size test
  measures the shared object.
- **Shape-fact loss during trimming**: the failure mode of lever 3. Mitigation:
  per-cut before/after enumeration in the PR; review checklist item is "every
  accepted-shape fact in *before* survives in *after*".
- **ASCII only** in new description text (AGENTS.md rule); no multibyte
  surprises in `Buffer.byteLength`.

## Out of scope

- Removing or deprecating any param, control key, or persona - tracked in
  [issue #5](https://github.com/jjuraszek/pi-cohort/issues/5) (filed and roasted
  during this brainstorm). This includes the `(deprecated - use id)` prefix on
  `runId`: this spec only shortens its description.
- Restricting nested `acceptance` to string shorthand - killed by the issue #4
  roast; object form is integration-tested first-party behavior
  (`test/integration/chain-execution.test.ts:268-344`).
- `$defs`/`$ref` dedup - killed by the roast; the pi-ai Anthropic adapter
  rebuilds `input_schema` keeping only root `type/properties/required` and the
  Google legacy sanitizer strips `$defs`. Revisit only with per-provider canary
  calls.
- README changes (behavior/workflow docs are unaffected by description text).
- Any runtime behavior or error-path change (none touched).

## Documentation impact

- Feature / user-facing docs introduced: none
- Materially amended existing docs: CHANGELOG.md (new `## [Unreleased]` entry,
  non-breaking: schema diet, size test, config field reference relocation)
- Derived / memory docs invalidated: none

`skills/pi-cohort/reference/config-fields.md` and the SKILL.md pointer line are
implementation surface (covered by the RED-GREEN evidence above), not doc-impact
entries; skill bodies are excluded by the materiality bar. README makes no claim
this change falsifies. CHANGELOG convention verified: mid-cycle entries land
under `## [Unreleased]`, promoted at release (`92c93a1`). Suggested entry:
"subagent tool schema dieted 23.2KB -> <=18KB (description trimming only; all
accepted input shapes unchanged); `config` field reference moved to the
pi-cohort skill's `reference/config-fields.md`; schema size-budget test added."

## Acceptance criteria (from issue #4, restated)

1. Size-budget unit test as specified in [Testing](#testing) item 1.
2. Acceptance fixtures at all 5 positions, three shapes each (Testing item 2).
3. No accepted input shape removed or narrowed anywhere in the schema
   (guarded by Testing items 2-4).
4. PR description lists each description cut and its measured byte saving with
   a running total.
5. CHANGELOG entry under `## [Unreleased]` (non-breaking).

Plus this spec's additions:

6. `brief()` invariant test (Testing item 4) and whole-schema shape-guard
   fixture test (Testing item 5).
7. `skills/pi-cohort/reference/config-fields.md` exists, is sourced from
   `applyAgentConfig()`/`parseStepList()` (completeness check: every accepted
   config key appears), SKILL.md points at it, and the RED-GREEN gap-scenario
   transcripts are summarized in the PR.
8. Subagent sanity pass: integration suite green post-change plus the live
   smoke dispatches (Testing item 6), recorded in the PR.

## Open questions

None blocking. Exact one-liner wording and any extension of the trim list beyond
the named floor are implementer judgment bounded by the trim rule and the budget
test.
