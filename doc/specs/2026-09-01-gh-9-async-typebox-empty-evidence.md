# Async runner typebox boot crash + empty-evidence acceptance rejection (gh-9)

Ticket: [jjuraszek/pi-cohort#9](https://github.com/jjuraszek/pi-cohort/issues/9). One ticket, two independent defects, one spec at the reporter's explicit request. Reported on pi-cohort 5.2.0; line pointers reference commit `f071e2a`.

Shared root-cause class: the detached async runner's process environment differs from pi's in-process extension environment, and 5.2.0 code assumed they match.

## Problem

**Defect 1 - boot crash.** Every async (detached-process) subagent dispatch on a standard consumer install crashes before the child agent starts; `runner.log` ends with `Error: Cannot find module 'typebox/compile'`.

- `src/runs/shared/structured-output.ts:4` has a static top-level `import { Compile } from "typebox/compile"`, reached at runner boot via `src/runs/background/subagent-runner.ts:49` (and transitively via `src/runs/shared/pi-args.ts:6`) - every async dispatch pays this cost even when no `outputSchema` is configured.
- `package.json` declares `typebox` only as an optional peer (`"*"`) + devDependency (`^1.1.24`); `jiti` is the sole `dependencies` entry. A consumer install therefore has no `typebox` on disk.
- The runner is spawned as plain `node <jiti-cli> <subagent-runner.ts> <config>` (`src/runs/background/async-execution.ts:233-260`) - standalone jiti, no pi aliases. Pi's own jiti aliases `typebox`/`typebox/compile` as virtual modules for in-process extensions and child pi processes; in binary/SEA pi installs there is no on-disk typebox copy at all, so resolving from pi's install root is not viable.

**Defect 2 - empty-evidence rejection.** `inferLevel` (`src/runs/shared/acceptance.ts:79`) classifies any run whose agent name matches `\bworker\b` as write-capable, requiring evidence including `changed-files` and `tests-added`. A task that legitimately changes nothing reports those lists present-but-empty, and `reportEvidencePresent` (`acceptance.ts:388-397`) counts `[]` the same as absent (`isStringArray(x) && x.length > 0`), so the run fails checks it could never pass. Observed: run `4c64e53b`, a pure-diagnostic task, exit 0, all criteria satisfied, rejected with `changed-files evidence missing from child report`.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Promote `typebox` to a real `dependencies` entry, `^1.3.11` | Fixes boot crash AND keeps structured-output validation working on consumer installs. Lazy-import alternative rejected: runner would boot, but structured output would stay permanently broken on consumer installs. Floor `1.3.11` because `src/extension/schemas.ts:8` explicitly relies on typebox 1.3.11 metadata behavior (non-enumerable `~kind`/`~unsafe`/`~optional` keys) - the only in-repo verifiable version constraint; it also replaces the stale `^1.1.24` dev floor. |
| 2 | Re-reverse the 2.0.0 peer-only decision, explicitly | 2.0.0's "match pi's bundled-core packages" rationale only holds for code running under pi's jiti aliases; the detached runner never sees them. `jiti`-as-real-dep is the exact precedent: runtime needs outside pi's alias world are real deps. Recorded in CHANGELOG so 2.0.0's mistake is not repeated. |
| 3 | Fix `reportEvidencePresent` to presence-only for all four length-checked list kinds (`changed-files`, `tests-added`, `commands-run`, `validation-output`) | One semantic across the switch: present (even empty) = reported; absent = structural failure. Only `changed-files` and `tests-added` are in the AC, but `commands-run` and `validation-output` have the identical trap - and `validation-output` is load-bearing for the motivating scenario: `inferLevel` classifies async worker runs as `reviewed`, whose required evidence includes `validation-output` (`acceptance.ts:59-61`), so fixing only the AC'd kinds would leave run `4c64e53b`-class tasks rejected on `validation-output` instead. `residual-risks` in the same switch is already presence-only - this is the consistent reading, not scope creep. |
| 4 | `inferLevel`'s `\bworker\b` regex: out of scope | Known coarse heuristic, recorded below. Changing level inference alters behavior for every dispatch and risks under-demanding evidence from real write tasks. With decision 3, misclassification no longer rejects no-op runs; the `no-staged-files` backstop (staged-index-only - see edge cases) is unchanged. |
| 5 | Verification is unit-level; no pack-and-install integration test | The crash is determined by "typebox resolvable from pi-cohort's package root"; a manifest test guards the regression that caused this, and a cheap in-repo resolution test (`require.resolve("typebox/compile", { paths: [<pkg root>] })`) proves the boot-graph property without any registry fetch. A full pack-and-install test stays out: registry-dependent, slow, marginal added proof. |

## Fix 1: dependency promotion

`package.json` only; no source-code change:

- `dependencies`: add `"typebox": "^1.3.11"`.
- `peerDependencies` + `peerDependenciesMeta`: remove the `typebox` entries entirely (real dep + optional peer is contradictory signaling).
- `devDependencies`: drop `"typebox": "^1.1.24"` (superseded by the runtime dep; one source of version truth).
- `package-lock.json`: regenerate locally via `npm install` (untracked - the repo gitignores `package-lock.json`, so the manifest is the delivered artifact; nothing lockfile-related lands in the diff).

`src/runs/shared/structured-output.ts` keeps its eager top-level import. Once typebox is a real dependency, standalone-jiti resolution in the detached runner succeeds from `pi-cohort/node_modules`. In-process paths are unaffected: pi's jiti alias intercepts `typebox` imports before Node resolution, so pi's bundled copy still wins there; the on-disk copy serves only the detached runner. No dual-instance hazard: schemas cross the process boundary as JSON in the run config file, never as live TypeBox instances.

## Fix 2: empty-evidence acceptance

In `reportEvidencePresent` (`src/runs/shared/acceptance.ts`, switch at ~388-397), four cases change from present-AND-non-empty to present-only (drop the `.length > 0` conjunct, keep each case's existing type guard):

| kind | after | element type |
|---|---|---|
| `changed-files` | `isStringArray(report.changedFiles)` | `string[]` |
| `tests-added` | `isStringArray(report.testsAddedOrUpdated)` | `string[]` |
| `commands-run` | `Array.isArray(report.commandsRun)` | `Array<{command, result, summary}>` (`src/shared/types.ts:322-326`) - NOT a string array; `isStringArray` here would reject every valid non-empty report |
| `validation-output` | `isStringArray(report.validationOutput)` | `string[]` |

Semantics: an empty array is a report ("I ran and touched nothing"); a missing field is a structural failure (agent didn't fill the acceptance block). No schema change - report types already allow empty arrays; only the evaluation predicate changes.

Resulting status for the motivating scenario: an inferred-`reviewed` no-op worker run with all criteria passing and empty evidence lists now passes structural checks, so `evaluateAcceptance` sets `ledger.status = "checked"` and attaches a `needs-parent-decision` review escalation (`acceptance.ts:582-597`) instead of `"rejected"`. (`"accepted"` is a `parentDecision.status`, never a `ledger.status` `evaluateAcceptance` produces.)

## Edge cases

- **Agent lies with `[]` after editing files**: the `no-staged-files` backstop (`acceptance.ts:399-410`) is **staged-index-only** - it filters `git status --short` to lines whose first column is neither space nor `?`, so it catches staged changes but silently passes unstaged tracked edits (`" M"`) and untracked files (`"??"`). Fix 2 does not weaken it, but it was never a full lie-detector; unstaged/untracked lying is a residual limitation, out of scope here (widening the check would be a separate behavior change for all runs).
- **`tests-added: []` on a run that should have added tests**: acceptance-level policy, not evidence structure - checked/verified criteria still evaluate; only the field-must-be-non-empty trap is removed.
- **Old-format reports lacking the fields entirely**: still fail, unchanged - the intended structural signal.
- **Known limitation (out of scope)**: `inferLevel` still classifies `worker`-named agents as write-capable regardless of task wording. Harmless for no-op runs once `[]` passes; revisit only if it under- or over-demands evidence in practice.

## Acceptance criteria (from #9)

Fix 1 (rewritten from #9's phrasing, which predates the fix - universal absence cannot hold once typebox is pi-cohort's own dependency):
- With `typebox` absent from the consumer's own package scopes and from pi's install root - i.e. resolvable only via pi-cohort's own `dependencies` (`pi-cohort/node_modules` on the runner's resolution walk, the install-layout assumption this fix relies on) - an async subagent dispatch reaches the child pi process: `runner.log` contains no `Cannot find module 'typebox/compile'` and the run writes a result file.
- An async run requesting structured output validates against its schema: schema-violating child output rejected, conforming output passes. (The issue's second conditional clause - a named typebox error on the lazy route - is moot: the lazy route was not taken.)

Fix 2:
- An async worker run whose criteria all pass and whose report carries `changedFiles: []`, `testsAddedOrUpdated: []`, `commandsRun: []`, `validationOutput: []` yields `ledger.status = "checked"` (not `"rejected"`), with the empty lists rendered as reported evidence and no `evidence missing` runtime check failure. (Issue #9 says "accepted"; that is the downstream `parentDecision.status`, out of `evaluateAcceptance`'s hands.)
- A child report omitting the evidence fields entirely still fails the structural check (absent stays distinct from empty).
- A run reporting empty change lists while `git status` shows **staged** changes in the run's working tree still fails acceptance.

## Testing

- `test/unit/package-manifest.test.ts`: assert `dependencies.typebox` is exactly `"^1.3.11"`; assert no `typebox` key in `peerDependencies`, `peerDependenciesMeta`, or `devDependencies`.
- Boot-graph resolution test (unit, no registry): `require.resolve("typebox/compile", { paths: [<repo root>] })` succeeds - proves the detached runner's import graph resolves from pi-cohort's own package root, catching any future regression of a boot-graph import to peer-only.
- `test/unit/acceptance.test.ts`: for each of `changed-files`, `tests-added`, `commands-run`, `validation-output` - `[]` passes evidence presence, `undefined` fails; a **non-empty object-array** `commandsRun` still passes (guards the `Array.isArray`-not-`isStringArray` distinction); one case confirming the staged-files backstop still rejects when staged files exist despite `changedFiles: []` - this test must run inside a real `git init` repo with a staged path, since `checkNoStagedFiles` returns `not-applicable` (non-failing) when `git status` fails. The existing case at `test/unit/acceptance.test.ts:103-122` ("checked mode rejects missing required evidence") uses `testsAddedOrUpdated: []` as its missing-evidence fixture and expects rejection - it must be rewritten to use `undefined` as the missing case.
- `test/unit/schemas.test.ts` currently skip-guards on typebox absence (`test/unit/schemas.test.ts:69-107`); with typebox always installed those guards become dead but harmless - removing them is optional cleanup, not required.
- Full suite green: `env -u PI_CODING_AGENT_DIR npm run test:all`. Existing structured-output and async-execution tests double as regression cover for the eager import continuing to work.
- No consumer-install integration test (decision 5).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: CHANGELOG.md (dependency re-reversal rationale + empty-evidence semantics)
- Derived / memory docs invalidated: none

README does not document typebox as a consumer-facing peer requirement, so no README change.

## Out of scope

- `inferLevel` agent-name classification (decision 4).
- Consumer-install / pack-and-publish integration testing (decision 5).
- Any change to `src/extension/schemas.ts` or in-process/child-pi typebox resolution - those paths work today via pi's aliases and are untouched.
