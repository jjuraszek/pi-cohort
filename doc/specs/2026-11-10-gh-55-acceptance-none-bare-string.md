# Refuse bare `acceptance: "none"` and run an explicit acceptance level as given

**Ticket:** [#55](https://github.com/jjuraszek/pi-cohort/issues/55)
**Goal:** The bare string `acceptance: "none"` is refused before any child starts with `acceptance.reason is required when level is none.`, and an explicit concrete acceptance level is the level that runs instead of being raised to the inferred one.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

## Problem

A caller overrides a run's inferred acceptance gate with the `acceptance` argument. On 7.7.2 (`21a3bfb`) three spellings of "no acceptance" behave three ways: `{ level: "none" }` is refused with `acceptance.reason is required when level is none.`, `false` disables the gate, and the bare string `"none"` validates and then runs at the inferred level. The string branch of `validateAcceptanceInput` checks only `VALID_LEVELS` (`src/runs/shared/acceptance.ts:136-159`), `normalizeAcceptanceInput` turns the string into `{ level: "none" }` with no reason (`:123-127`), and `resolveEffectiveAcceptance` disables only for `none` with a non-empty reason (`:130-132`, `:202-239`).

The same resolver raises every explicit level that ranks below the inferred one (`:218`, `LEVEL_RANK` max). Repro on 7.7.2, agent `delegate`, task `read-only startup smoke update`, `async: true`:

| `acceptance` | Resolved level | `explicit` | A rejected gate |
|---|---|---|---|
| omitted | `reviewed` | `false` | is recorded, run succeeds |
| `"none"` | `reviewed` | `true` | fails the run |
| `"attested"` | `reviewed` | `true` | fails the run |
| `{ level: "none", reason: "probe" }` | `none` | `true` | not evaluated |
| `false` | `none` | `true` | not evaluated |

Corrected premise: the ticket says a run with `acceptance: "none"` "is still gated at the inferred level". It is gated harder than a run with no `acceptance` at all, because any passed value sets `explicit: true` (`:230`) and a rejected ledger fails the run only when `explicit` is true (`src/runs/foreground/execution.ts:942`, `src/runs/background/subagent-runner.ts:1114`).

The raise also breaks published guidance. `doc/orchestration-patterns.md:52` and `README.md:133-134` tell callers to use `{ level: "attested" }` for tree-backed reviewers because stricter levels fail `no-staged-files`; agent `reviewer` with `{ level: "attested" }` and the task `security review of the diff` resolves to `reviewed` with `no-staged-files` in its evidence. No doc or test states a raise-only rule: `doc/programmatic-api.md:164` says "Override the run's inferred acceptance gates". One unit test asserts a raise (`test/unit/acceptance.test.ts:373`). A second one, `test/unit/foreground-execution-routing.test.ts:287`, passes the unknown level `"claimed"` straight to `runSync`, past both validation boundaries, and passes today only because the rank comparison falls back to the inferred level.

The ticket's remedy for the raise is a longer rejection summary. That explains the failure after the child's work is already rejected and needs a new persisted "requested level" field, because `ResolvedAcceptanceConfig` keeps only `explicit: boolean` (`src/shared/types.ts:324-334`).

Framing: pivoted to "an explicit concrete level is the level that runs; inference fills only `auto` or an omitted `acceptance`" - the raise contradicts the documented override contract (`doc/programmatic-api.md:164`, `doc/orchestration-patterns.md:22,48,52`) and the ticket's remedy only explains the failure after the fact. The user chose this at the framing question; it supersedes the ticket's implied "a requested level can only raise the inferred level" rule.

Ticket decisions adopted as recorded: the bare string is refused, not made to disable (the reporter's second remedy was dropped), and `"none"` stays in the schema's string enums so callers reach the specific message.

Unverified, not load-bearing: the reporter's run returned a plain `OK` and was rejected for missing `validation-output`. In the current evaluator an unparseable report fails the attestation check first (`src/runs/shared/acceptance.ts:544-564`). Implicit dependency not found: the reporter's original `status.json` and task text - the issue body and its one comment both say the artifacts are unavailable. The design relies on the synthetic repro above instead.

## Acceptance criteria

Ticket #55, Acceptance Criteria, rows verbatim:

- [ ] Given `validateAcceptanceInput("none")`, when it runs, then it returns exactly `["acceptance.reason is required when level is none."]`, and a `subagent` call with `acceptance: "none"` is refused before any child is dispatched with that message.
  in-scope
- [ ] Given `validateAcceptanceInput("attested")` and `validateAcceptanceInput({ level: "none", reason: "probe" })`, when they run, then each returns `[]`.
  in-scope
- [ ] Given `acceptance: false`, when it is validated and resolved, then validation returns `[]` and the effective level is `none`.
  in-scope
- [ ] Given a run with explicit level `attested`, an inferred level `reviewed` with the single inferred reason `async write-capable or risky run`, and a child report that lacks `validation-output`, when the rejection summary is produced, then it reads "Acceptance rejected: validation-output evidence missing from child report (effective level reviewed; raised from explicit attested because: async write-capable or risky run)."
  deviates: framing answer B - an explicit level is never raised, so no run produces this text; the run this row describes resolves to `attested` and is not checked for `validation-output`
- [ ] Given a run whose explicit level equals the effective level, or no explicit level, when the rejection summary is produced, then it is unchanged from today: "Acceptance rejected: <failed check message>".
  in-scope
- [ ] Given the tool schema's `acceptance` description, `doc/orchestration-patterns.md`, `doc/programmatic-api.md`, and `skills/pi-cohort/SKILL.md`, when they describe the `none` level, then each states that `none` requires the object form with a `reason`.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-55-acceptance-none-bare-string
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `env -u PI_CODING_AGENT_DIR npm run test:unit`; `npm run test:integration`; `npm run test:all` before ship (run in the worktree)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .agents/skills/release/SKILL.md
Rules: .pi/gauntlet-overrides.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6
design: owns acceptance validation and resolution in `src/runs/shared/acceptance.ts`, the top-level `acceptance` description in `src/extension/schemas.ts`, their unit and integration tests, the acceptance sections of `doc/orchestration-patterns.md`, `doc/programmatic-api.md` and `skills/pi-cohort/SKILL.md`, and the changelog. A bare `"none"` is refused before dispatch at every acceptance position; an explicit concrete level resolves to itself.

## Design

Both behavior changes live in `src/runs/shared/acceptance.ts`. No type, ledger field, status field, or call site changes.

### Validation

`validateAcceptanceInput(input, pathLabel)` gains one check in its string branch, after the level check: the string `"none"` returns one error, `<pathLabel>.reason is required when level is none.`, the text the object branch already returns for `{ level: "none" }` without a reason (`:157-159`). `false`, `"auto"`, every other level string, and `{ level: "none", reason: "<non-blank>" }` validate as today.

The two existing boundaries call this validator with their own path labels and need no edit:

| Boundary | Positions validated | Observable result for bare `"none"` |
|---|---|---|
| `validateExecutionInput` (`src/runs/foreground/subagent-executor.ts:698`, acceptance block `:793-817`, called once at `:2331`) | top-level, `tasks[i]`, chain step, static parallel member, dynamic template | tool result with `isError: true`, `details.results: []`, text `Invalid acceptance input:` followed by `- <position>.reason is required when level is none.`; no child is dispatched, foreground or async |
| `parseJsonChain` (`src/agents/chain-serializer.ts:167-184`) | saved `*.chain.json` step, parallel member, dynamic template | throws `Invalid JSON chain '<path>': <label>.reason is required when level is none.` with `<label>` one of `step <n> acceptance`, `step <n> parallel task <m> acceptance`, `step <n> dynamic template acceptance`; chain discovery reports it as a diagnostic and the chain does not load |

AC row 1's "refused ... with that message" reads as: the tool result text contains `acceptance.reason is required when level is none.` under the `Invalid acceptance input:` header, the shape every acceptance validation error already has.

Every path into the resolver passes one of these boundaries first: agent frontmatter, settings, `agentOverrides`, `.chain.md` steps, and the `/run`, `/chain`, `/parallel` slash commands carry no acceptance input. The resolver therefore trusts its input. A direct call to the exported `resolveEffectiveAcceptance` with an unvalidated bare `"none"` resolves to `none`. A level string outside `VALID_LEVELS` is outside the resolver's contract: the resolver adds no fallback to the inferred level, because the two boundaries above already validate the level once.

### Resolution

`resolveEffectiveAcceptance` replaces its level logic with three rules:

1. Level: the caller's level when it is concrete (`none`, `attested`, `checked`, `verified`, `reviewed`); the inferred level when the caller passes `"auto"`, an object without `level`, or nothing.
2. Review gate: the caller's `review` when given; otherwise the inferred review gate only when the level that runs equals the inferred level. In code terms: `explicit.review !== undefined ? explicit.review : (level === inferred.level ? inferred.review : undefined)`.
3. Criteria, evidence, `explicit`, `inferredReason`, `verify`, `stopRules`, and `reason` (the caller's, or `disabled by deprecated false shorthand` for `false`) are computed as today. Evidence keeps its existing guard (`:219`): inferred evidence when the level equals the inferred level, else that level's default evidence, plus the caller's `evidence`.

Rule 2 covers the one state the level rule creates: an explicit level below an inferred `reviewed`. Without it the child prompt would print `Review gate: required by reviewer.` (`formatAcceptancePrompt`, `:258-261`) although `evaluateAcceptance` consults review only at level `reviewed` (`:584-599`).

`inferredReason` still records what inference chose, so a lowered gate stays visible: explicit `"attested"` on the repro task yields `level: "attested"`, `explicit: true`, `inferredReason: ["async write-capable or risky run"]`.

| Call | 7.7.2 | After |
|---|---|---|
| `"none"` | accepted; runs at the inferred level; a rejected gate fails the run | refused before dispatch |
| `"attested"`, async `delegate`, task containing "update" | `reviewed`, optional review | `attested`, no review gate |
| `{ level: "checked" }`, `worker`, `dynamic: true` | `reviewed`, optional review, `reviewResult: needs-parent-decision` | `checked`, no review gate, no `reviewResult` |
| `{ level: "attested" }`, `reviewer`, task "security review of the diff" | `reviewed` with `no-staged-files` | `attested` |
| `"verified"` without `verify`, async `delegate`, task containing "update" (inferred `reviewed`) | `reviewed`, optional review, verify stage skipped; a complete report ends at ledger `checked` with no failure message | `verified`; ledger `rejected` with `Acceptance rejected: verified acceptance requires runtime verify commands.` |
| explicit level at or above the inferred level | that level | unchanged |
| omitted, `"auto"`, object without `level` | inferred level | unchanged |
| `false`, `{ level: "none", reason }` | `none` | unchanged |

A rejected gate at an explicit level still fails the run; that rule (`execution.ts:942`, `subagent-runner.ts:1114`) is not touched.

### Rejection summary

`acceptanceFailureMessage` (`src/runs/shared/acceptance.ts:605-613`) is not edited. After this change an explicit level always equals the effective level, so AC row 5's condition covers every run and the summary stays `Acceptance rejected: <failed check message>`.

### Schema

`"none"` stays in the string enum of `AcceptanceOverride` and `AcceptanceOverrideStub` (`src/extension/schemas.ts:91-137`). The top-level `AcceptanceOverride` description changes from `Acceptance: auto if omitted; verified needs cmds.` to `Acceptance: auto if omitted; none needs object form {level:"none",reason}; verified needs cmds.`. The nested stub description (`Acceptance override; same shape as top-level acceptance.`) is unchanged. `SubagentParams` serializes to 8,587 bytes today against the 9,500-byte budget (`test/unit/schemas.test.ts:428-436`).

### Skill and docs wording

- `skills/pi-cohort/SKILL.md`, `## Acceptance levels`: the `none` row's "Use when" cell reads `throwaway probe; requires { level: "none", reason: "..." }`, and the paragraph above the table gains one sentence stating that an explicit level runs as given and inference applies only when the level is `auto` or unset. The edit follows `/skill:forge-skill`.
- `doc/orchestration-patterns.md`, Acceptance gates paragraph (`:37`): "To disable gates, prefer `{ level: "none", reason: "..." }`" becomes a statement that `none` requires the object form with a `reason` and that the bare string `"none"` is refused before dispatch; one sentence is added stating that an explicit level is the level that runs and inference applies only to `"auto"` or an omitted `acceptance`.
- `doc/programmatic-api.md`, `acceptance` row (`:164`): states that `none` requires the object form with a `reason` and that an explicit level runs as given.
- `CHANGELOG.md`: a new `## [Unreleased]` section above `## [7.7.2]` with a `### Changed` entry covering both behaviors and ending `(#55)`. The entry names the two runs that pass on 7.7.2 and fail after the upgrade: a saved `*.chain.json` carrying a bare `"none"` no longer loads (and where its message appears, per `## Errors and edge cases`), and an explicit `verified` without `verify` commands that 7.7.2 raised to `reviewed` is now rejected for the missing verify commands.

`README.md:133-134` (`acceptance: { level: "attested" }` on tree-backed reviewers) and `doc/orchestration-patterns.md:52` need no edit; the change makes them hold for every task wording.

### Moving parts

- Remove: `explicitAcceptanceCanDisable` (`src/runs/shared/acceptance.ts:130-132`) and its call in `resolveEffectiveAcceptance`.
- Remove: the `LEVEL_RANK` comparison in the resolver's level expression (`:218`). `LEVEL_RANK` itself stays; `evaluateAcceptance` uses it (`:557`, `:569`).
- Remove: the block that sets `review.required: false` on a level raised to `reviewed` (`:225-227`).
- Remove: the raise assertions in the unit test "does not make explicit checked acceptance an explicit reviewed blocker when inference recommends review" (`test/unit/acceptance.test.ts:373`); the test is rewritten per `## Tests`.
- Change: the acceptance literal in "retains failed, blocked, interrupted, and acceptance-rejected surfaces" (`test/unit/foreground-execution-routing.test.ts:287`) from `{ level: "claimed", reason: "test", criteria: ["must report"] }` to `{ level: "checked", criteria: ["must report"] }`; its `exitCode === 1` assertion stays. With the unknown level `"claimed"`, rule 1 keeps the level, `requiredEvidenceForLevel` returns `undefined`, and the evidence spread (`src/runs/shared/acceptance.ts:219`) throws a `TypeError`.
- Add: the `"none"` check in the string branch of `validateAcceptanceInput`.
- Add: the `level === inferred.level` condition on the inferred review gate in `resolveEffectiveAcceptance`.
- Add: the new `AcceptanceOverride` description text in `src/extension/schemas.ts:122`.
- Add: test cases in `test/unit/acceptance.test.ts`, `test/unit/chain-serializer.test.ts`, `test/unit/schemas.test.ts`, `test/integration/single-execution.test.ts` per `## Tests`.
- Add: the wording in `skills/pi-cohort/SKILL.md`, `doc/orchestration-patterns.md`, `doc/programmatic-api.md`, and the `## [Unreleased]` section in `CHANGELOG.md`.

### Paid or external actions

None. Implementation and verification run the unit and integration suites against the local `createMockPi()` helper (`test/integration/single-execution.test.ts:4,20`); no model call, network access, or tracker write. The loop treats an action without a Design clause as unreachable; adding one needs separate explicit authorization.

## Errors and edge cases

- Bare `"none"` at a nested position reports that position's path label (`tasks[<i>].acceptance`, `chain[<i>].acceptance`, `chain[<i>].parallel[<j>].acceptance`, `chain[<i>].parallel.acceptance`), and several invalid positions in one call are listed together in one `Invalid acceptance input:` result.
- A resolved `none` config no longer carries an inferred `review` gate (rule 2). Nothing reads it: `formatAcceptancePrompt` returns an empty string and `evaluateAcceptance` returns early at `none`.
- A whitespace-only `reason` on `{ level: "none" }` is refused as today.
- `"auto"` and an object without `level` still resolve to the inferred level with `explicit: true`, so their rejected gates still fail the run.
- An explicit level below the inferred one asks for that level's default evidence plus the caller's `evidence`, keeps the inferred criteria unless the caller supplies `criteria`, has no review gate, and produces no `reviewResult`.
- An explicit `reviewed` without a reviewer result still fails with `Acceptance review required but no automatic reviewer result is available.`; explicit `reviewed` with `review: false` behaves as today.
- An explicit `verified` without `verify` commands fails with `verified acceptance requires runtime verify commands.` When the inferred level is at or below `verified` this is unchanged. When the inferred level is `reviewed` it is new: 7.7.2 raised the run to `reviewed` with an optional review and skipped the verify stage, so a complete report ended at ledger `checked`; after the change the run resolves to `verified` and is rejected. The CHANGELOG entry names this.
- Dynamic fanout groups and templates resolve through the same function (`src/runs/foreground/chain-execution.ts:859,1017`, `src/runs/background/async-execution.ts:527,606,836`), so an explicit level on a dynamic step or template is honored there too.
- A saved `*.chain.json` that carries a bare `"none"` stops loading after the upgrade. The parse error is pushed to chain diagnostics and the chain is skipped (`src/agents/agents.ts:997-1004`), which has two observables: the reason-required message appears under `Chain diagnostics:` in the result of `subagent` `action: "list"` (`src/agents/agent-management.ts:451-460`), and `/run-chain <name>` reports `Unknown chain: <name>` without the reason, because `discoverSavedChains` drops diagnostics (`src/slash/slash-commands.ts:114-119,524-528`). The CHANGELOG entry names both.
- Ledgers and async status files written before the upgrade read back unchanged; no field changes shape.

## Tests

- `validateAcceptanceInput("none")` returns exactly `["acceptance.reason is required when level is none."]`, and with the label `tasks[0].acceptance` returns `["tasks[0].acceptance.reason is required when level is none."]` (AC 1) - extend "validates invalid disable and verify shapes" in `test/unit/acceptance.test.ts`.
- A `subagent` call with top-level `acceptance: "none"`, and one with `tasks[0].acceptance: "none"`, returns `isError` with text matching `acceptance\.reason is required when level is none\.` and writes no `call-*` file to the mock pi dir (AC 1) - extend "rejects malformed acceptance at the executor boundary before any child runs" in `test/integration/single-execution.test.ts`.
- `validateAcceptanceInput("attested")` and `validateAcceptanceInput({ level: "none", reason: "probe" })` each return `[]` (AC 2) - extend "validates invalid disable and verify shapes".
- `validateAcceptanceInput(false)` returns `[]` and `resolveEffectiveAcceptance({ explicit: false, ... })` on the repro task has level `none` (AC 3) - new test "deprecated false validates and resolves to none" in `test/unit/acceptance.test.ts`.
- Explicit `"attested"` on agent `delegate`, task `read-only startup smoke update`, `async: true` resolves to level `attested`, `explicit: true`, `inferredReason` containing `async write-capable or risky run`, no `review`, and a prompt section without `Review gate`; `evaluateAcceptance` on that config with a report that omits `validationOutput` yields ledger status `attested`, and `acceptanceFailureMessage(ledger)` is `undefined` (AC 4's deviation; Resolution rules 1-2) - new test "an explicit level below the inferred level is the level that runs".
- Explicit `{ level: "checked" }` on the same task, with a report whose `criteriaSatisfied` marks both `criterion-1` and `criterion-2` satisfied (the two inferred criteria are kept, and the file's `report()` helper reports only `criterion-1`) and which omits `testsAddedOrUpdated`, yields `acceptanceFailureMessage(ledger)` exactly `Acceptance rejected: tests-added evidence missing from child report.`, with no `(effective level` text; the same report with `explicit` omitted (inferred `reviewed`) yields the same string. `tests-added` is required at both `checked` and `reviewed` (`src/runs/shared/acceptance.ts:57-61`) (AC 5) - new test "a rejected gate reports only the failed check at an explicit or inferred level".
- Explicit `{ level: "checked" }` for `worker` with `dynamic: true` resolves to `checked` with no `review`, and a satisfying report yields ledger status `checked` with no `reviewResult` (Resolution rule 2) - rewrite of "does not make explicit checked acceptance an explicit reviewed blocker when inference recommends review", renamed "explicit checked on a dynamic step runs at checked with no review gate".
- `runSync` with `acceptance: { level: "checked", criteria: ["must report"] }` in place of the unknown level `"claimed"` still ends with `exitCode === 1` and a retained surface (unknown levels are outside the resolver's contract) - edit of the literal in "retains failed, blocked, interrupted, and acceptance-rejected surfaces" in `test/unit/foreground-execution-routing.test.ts`; assertions unedited.
- Explicit `verified` above an inferred `attested` still resolves to `verified` (unchanged row) - existing "explicit acceptance can strengthen inferred policy", unedited.
- A JSON chain with `acceptance: "none"` on a step, and one with it on a parallel member, throws an error matching `acceptance\.reason is required when level is none` (saved-chain edge) - extend "parses and validates acceptance in JSON chains" in `test/unit/chain-serializer.test.ts`.
- The top-level `acceptance` schema description contains `none needs object form` and `reason` (AC 6), and the schema stays within 9,500 bytes - new test "top-level acceptance description names the object form for none" and existing "serialized SubagentParams stays within the API payload budget" in `test/unit/schemas.test.ts`.
- Doc and skill wording (AC 6) - none: prose; the conformance pass reads the three files against the Design wording clauses.
- Explicit `reviewed` without a reviewer result still rejects - existing "does not mark reviewed without an independent reviewer result", unedited.
- Whitespace-only reason and `verified` without commands - none: unchanged code paths (`src/runs/shared/acceptance.ts:157-159`, `:571`).

## Documentation impact

Bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/orchestration-patterns.md` - Acceptance gates (communication contract: an explicit level is the level that runs; `none` requires the object form); `doc/programmatic-api.md` - `acceptance` parameter row (communication contract); `CHANGELOG.md` - new `## [Unreleased]` section, `### Changed` entry (#55) (release procedure: `release.sh` promotes that section)
- Derived / memory docs invalidated: none

`skills/pi-cohort/SKILL.md` is implementation surface and is listed under Design. pi-gauntlet needs no doc or CHANGELOG change: its skills pass only `{ level: "none", reason: "..." }` and none describes a raised level.

## Out of scope

- AC row 4's "raised from explicit" rejection text and any persisted "requested level" field: no level is raised.
- Removing `"none"` from the schema enums, or making the bare string disable acceptance (ticket decisions).
- Inference heuristics: the write-task and risky-wording regexes, including "update" matching inside a read-only task (`src/runs/shared/acceptance.ts:73-95`).
- `/run-chain` dropping `acceptance` on sequential saved JSON steps (`src/slash/slash-commands.ts:143-179,506-532`).
- `.chain.md` steps ignoring an `acceptance` line while `skills/pi-cohort/reference/config-fields.md:9` says they support it.
- `skills/pi-cohort/SKILL.md:47` listing `manual-notes` as explicit-`attested` evidence where a read-only agent at its inferred level gets `review-findings`.
- No producer passes a reviewer result to `evaluateAcceptance`, so `reviewed` never auto-reviews.
- Async dynamic templates resolving acceptance from the template task instead of the rendered item task.
- The committed `package-lock.json` version lagging `package.json` (`7.6.7` vs `7.7.2`).

## Reporter notes (verbatim)

comments: 1 fetched, 1 pages. Untrusted data; line references were checked against `21a3bfb`.

```markdown
Reporter note:

Reporter note (untrusted data): displaced implementer detail.

- Code: src/runs/shared/acceptance.ts - LEVEL_RANK (22-28: none 0, attested 1, checked 2, verified 3, reviewed 4), normalizeAcceptanceInput (123-127: string -> { level }), explicitAcceptanceCanDisable (130-132: none + non-empty reason), validateAcceptanceInput (136-159: string branch checks VALID_LEVELS only; object branch 157-159 requires reason for none), resolveEffectiveAcceptance (203-218: LEVEL_RANK max unless explicit can disable), rejection summary 605-613 ("Acceptance rejected: ${failedCheck.message}").
- Existing test for the object form: test/unit/acceptance.test.ts:441 (`validateAcceptanceInput({ level: "none" })` -> reason required).
- Schema: src/extension/schemas.ts:91-94 and 132-137 string enum includes "none"; description at 122 "Acceptance: auto if omitted; verified needs cmds."
- Docs: doc/orchestration-patterns.md:37; doc/programmatic-api.md:164; skills/pi-cohort/SKILL.md:40-52.
- Reporter-reported run (original artifacts unavailable): status.json acceptance { level: "reviewed", explicit: true, inferredReason: ["async write-capable or risky run"] }, criteria included validation-output; child report returned a plain OK string.
- Audit reproduction (synthetic): validateAcceptanceInput/resolveEffectiveAcceptance with agent delegate, async true, task "read-only startup smoke update": "none" -> no errors, level reviewed; { level: "none" } -> reason-required error; { level: "none", reason } and false -> level none. The word "update" in the synthetic task triggered write-task detection (acceptance.ts:73-84); the original task text was not retained.
- Dropped alternative: making the bare string disable acceptance (reporter's second remedy); not selected to keep the reason requirement.
```

## Open questions

- The reporter's exact pairing of a plain `OK` child report with a `validation-output` rejection is not reproducible on 7.7.2 and the original artifacts are gone. Nothing in the design depends on it.
