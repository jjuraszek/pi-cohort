# Single registrant for the child `subagent` tool

**Goal:** A child persona with `tools: subagent` starts with or without inherited extensions, because exactly one extension file registers the child `subagent` tool.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#26
**Worktree:** `.worktrees/gh-26-fanout-child-double-registration`

## Problem

A child persona that lists `subagent` in `tools:` and omits `extensions` cannot start: pi aborts with `Tool "subagent" conflicts with .../pi-cohort/src/extension/fanout-child.ts`. The reporter's two-child gatekeep run returned 0 of 2 children.

Root cause: two extension files register the same tool in such a child.

| Registrant | Where | When |
|---|---|---|
| `src/extension/fanout-child.ts` passed as `--extension` | `buildPiArgs`, `src/runs/shared/pi-args.ts:128-140` | every fanout-authorized child, both the inherit branch and the `--no-extensions` branch |
| the inherited pi-cohort `index.ts` calling `registerFanoutChildSubagentExtension(pi)` | `src/extension/index.ts:243-247` | child mode (`PI_SUBAGENT_CHILD=1`) with `PI_SUBAGENT_FANOUT_CHILD=1`, only when pi discovers the installed pi-cohort package |

pi dedupes extension paths by canonical file only (`resource-loader.js:786-798`) and raises the conflict when one tool name has two owner paths (`:971-990`). The WeakSet guard in `fanout-child.ts:119-125` is keyed on each extension's own API object and cannot dedupe across two files.

Framing: pivoted from the reporter's idea (explicit `--extension` only on the `--no-extensions` branch, inherited `index.ts` registers in inherit mode) to deleting the `index.ts` child-mode registration. Reason: `deriveForwardedFlags` returns `[]` when the parent argv carries `-e`/`--extension`/`--no-extensions` (`src/runs/shared/forward-flags.ts:46`), so an inherit-mode child sees pi-cohort only through pi's package discovery; a parent loaded via `pi -e <checkout>/src/extension/index.ts` would get children with no `subagent` under the reporter's idea. The explicit `--extension` path is present in every branch regardless of how the parent was loaded. The ticket was repaired on 2026-10-23 to carry this decision (Idea line and AC rows 6-8); the original rows live in its Reporter-note comment.

Premises: the double registration is verified from source; the conflict error and 0-of-2 result are the reporter's observation, not re-run here; the gh-79 pi-gauntlet branch state is unverified and outside this repo.

## Acceptance criteria

Ticket #26, `## Acceptance Criteria`, rows verbatim:

- [ ] A persona with `tools: read, bash, subagent` and no `extensions` key, dispatched with `subagent({ agent })` from a depth-0 session, starts without the duplicate-tool error and its one nested `subagent({ agent: "worker" })` call returns the worker's reply.
  in-scope
- [ ] With an inherited extension (one the child receives without the persona naming it) that registers a tool `ping_fixture` returning `pong`, a persona with `tools: read, bash, subagent, ping_fixture` and no `extensions` key calls `ping_fixture` from inside the child and the child's reply contains `pong`.
  in-scope
- [ ] A persona with `tools: subagent` and an explicit `extensions:` allowlist, dispatched from depth 0, starts without the duplicate-tool error and its nested `worker` returns a reply.
  in-scope
- [ ] A persona with `tools: subagent` and an empty `extensions:` value (no extensions) still has the `subagent` tool in the child.
  in-scope
- [ ] A persona without `subagent` in `tools:` has no `subagent` tool in the child.
  in-scope
- [ ] `test/unit/pi-args.test.ts` asserts that for a fanout-authorized persona the `--extension` arguments contain the fanout-child path exactly once, both with `extensions` omitted and with `extensions` set.
  in-scope
- [ ] `test/unit/index-child-registration.test.ts` asserts that the pi-cohort extension loaded with `PI_SUBAGENT_CHILD=1` and `PI_SUBAGENT_FANOUT_CHILD=1` does not register the `subagent` tool.
  in-scope
- [ ] `CHANGELOG.md` `## [Unreleased]` (created above the current released section if absent) carries the entry with `(#26)`.
  in-scope
- [ ] The gh-79 branch's `package.json` peer floor and README floor name the pi-cohort version that carries this fix.
  elsewhere: pi-gauntlet
- [ ] The branch's two-child runtime smoke (one `pr-gatekeeper` child per scratch PR) returns 2 of 2 children with a result line (`REPORT` or `FAILED - head not pushable`), none with a load error.
  elsewhere: pi-gauntlet

Design clauses for in-scope rows: rows 1-5 are proven by the real-pi integration test below (venue: the repo's `test:integration` run against the installed pi); row 2's "inherited extension" is a project-scope extension at `.pi/extensions/ping-fixture.ts` in the test's temp project, discovered by pi without the persona naming it and without a `--extension` argument for it, which requires the disposable profile to trust the temp project (`<profile>/settings.json` carries `{"defaultProjectTrust":"always"}`; pi's default is `ask` and a headless `-p` child has no UI to answer, so `.pi/extensions/` is skipped otherwise); row 4's "empty `extensions:` value" is a bare `extensions:` line in persona frontmatter (the frontmatter parser is string-only, so a literal `extensions: []` becomes the path `"[]"` and `--extension []`); row 8's `## [Unreleased]` heading is created above `## [7.4.4]`.

## Design

### Owner

`src/extension/fanout-child.ts` is the only registrant of the child `subagent` tool. It keeps its `PI_SUBAGENT_CHILD=1` + `PI_SUBAGENT_FANOUT_CHILD=1` gate and its WeakSet guard unchanged.

`buildPiArgs` (`src/runs/shared/pi-args.ts:128-140`) is unchanged: for a fanout-authorized persona it passes `--extension <fanout-child.ts>` on both the inherit branch and the `--no-extensions` branch; for other personas it never does.

`src/extension/index.ts` `registerSubagentExtension` child-mode branch (`:243-247`) loses the `registerFanoutChildSubagentExtension(pi)` call (`:245`), the `registerFanoutChildSubagentExtension` import (`:38`), and the `SUBAGENT_FANOUT_CHILD_ENV` import (`:37`, read only on the deleted line). In child mode the function returns without registering anything, whatever `PI_SUBAGENT_FANOUT_CHILD` holds.

### Data flow after the change

| Persona | Child argv | `index.ts` loaded? | `subagent` registrants |
|---|---|---|---|
| `tools: subagent`, `extensions` omitted | `--extension fanout-child.ts` + inherited discovery | yes, returns in child mode | fanout-child only |
| `tools: subagent`, `extensions: [...]` | `--no-extensions --extension fanout-child.ts ...` | no | fanout-child only |
| `tools: subagent`, `extensions: []` (bare `extensions:` in frontmatter) | `--no-extensions --extension fanout-child.ts` | no | fanout-child only |
| no `subagent` in tools, any `extensions` | no fanout-child path; `PI_SUBAGENT_FANOUT_CHILD=0` | per branch; returns in child mode | none |

Nested control inbox, `cost:external` aggregation, depth cap (`PI_SUBAGENT_MAX_DEPTH`), `deriveForwardedFlags`, chains, parallel groups, worktree isolation, and SDK-hosted dispatch (#22) all go through `buildPiArgs` and `fanout-child.ts`, neither of which changes.

### Regression surface checked

Every pi-gauntlet persona (`pi-gauntlet/agents/*.md`, nine files) and every pi-cohort builtin omits `extensions` and does not list `subagent`; they run with `PI_SUBAGENT_FANOUT_CHILD=0`, where `index.ts` already returned without registering. The only `subagent` + inherit persona on the reporter's machine is `~/.pi/agent/agents/pr-gatekeeper.md` (gh-79), the broken case. The fanout + explicit `extensions:` case is `test/integration/fanout-child-own-subagent-history.test.ts`, unaffected.

### Files

| File | Change |
|---|---|
| `src/extension/index.ts` | delete the child-mode `registerFanoutChildSubagentExtension(pi)` call (`:245`) and the now-unused imports `registerFanoutChildSubagentExtension` (`:38`) and `SUBAGENT_FANOUT_CHILD_ENV` (`:37`) |
| `test/unit/index-child-registration.test.ts` | replace only the case `registers only the child-safe subagent tool for fanout children` (`:159`) with "child mode + `PI_SUBAGENT_FANOUT_CHILD=1` registers no tool and starts no listener"; the non-fanout child case stays; the case `lets fanout children call read-only list but blocks mutating management actions` (`:199`) already imports `src/extension/fanout-child.ts` directly, does not depend on `index.ts`, and stays in place unchanged |
| `test/unit/pi-args.test.ts` | two sites: `authorizes child fanout only from exact declared builtin subagent` (`:270`, `extensions` omitted) and `keeps child-safe fanout registration in explicit extensions mode` (`:404`, `extensions` set); each asserts the fanout-child path appears exactly once in the `--extension` arguments; an `extensions: []` (API-level empty array) case asserts `--no-extensions`, the fanout-child path once, and no `[]` extension path; absent for a non-fanout persona |
| `test/integration/fanout-child-inherit-extensions.test.ts` (new) | real-pi test, see Tests |
| `test/integration/fixtures/fanout-child-inherit-extensions/` (new) | `provider.ts` (scripted model provider, see Tests), `ping-fixture.ts` (registers `ping_fixture -> pong`), persona files `{lead-omitted,lead-allowlist,lead-empty,worker,plain}.md` copied into the temp project's `.pi/extensions/` and `.pi/agents/` |
| `CHANGELOG.md` | `## [Unreleased]` / `### Fixed` entry `(#26)` |

### Rejected alternatives

- Reporter's idea (explicit path only under `--no-extensions`): depends on package discovery of pi-cohort in the child; see Problem.
- Process-global once-flag letting whichever file loads second register nothing: keeps two owners and the owner flips silently with load order.
- Removing the now-unreachable WeakSet guard in `fanout-child.ts:119-125`: dead code, but outside the bug's surface; noted as a follow-up, not shipped here.

## Errors and edge cases

- Child with `subagent` and `extensions` omitted: fanout-child registers once; inherited `index.ts` returns silently. The observable is the absence of the conflict error.
- Child with `extensions: []` (bare `extensions:` in frontmatter): `index.ts` never loads; fanout-child alone (pinned by a test now). A literal `extensions: []` in frontmatter is not the empty case: it parses to the path `"[]"` and emits `--extension []`.
- Child without `subagent`: no fanout-child path, env `0`, inherited `index.ts` returns. No `subagent` tool.
- Depth cap reached: unchanged; `fanout-child.ts` and `buildPiArgs` authorization own it.
- Parent loaded via `pi -e <checkout>/src/extension/index.ts` with no package install: the explicit fanout-child path still arrives, so `subagent` works. Not covered by a test (needs an uninstalled pi-cohort); recorded as untested.
- A future second registrant: pi's conflict detection fails the child loudly at startup, as #26 reported. No once-flag masks it.
- `ping_fixture` reaches `lead-omitted` through pi's project-scope discovery of `.pi/extensions/` in the test's temp cwd, which pi performs only for a trusted project; the test's disposable profile sets `defaultProjectTrust: "always"` in `<profile>/settings.json`. The existing real-pi test (`fanout-child-own-subagent-history.test.ts`) does not rely on project discovery: each of its personas allowlists its provider through `extensions:`, which becomes a trust-exempt `--extension` argument.
- The inherited `index.ts` registrant reaches `lead-omitted` only when pi discovers pi-cohort as a package. The test's disposable profile lists `<checkout>/src/extension/index.ts` under `<profile>/settings.json#packages` (a file path loads one extension, user scope, trust-exempt), so the omitted-extensions child loads both original registrants: the explicit `--extension fanout-child.ts` and the discovered `index.ts`. On the pre-fix tree this child fails with the `conflicts with` error; after the deletion it starts.

## Tests

- `test/unit/index-child-registration.test.ts`: child mode + `PI_SUBAGENT_FANOUT_CHILD=1` registers no tool and no listener; child mode + `0` registers nothing; the read-only `list` / mutating `create` case stays as is.
- `test/unit/pi-args.test.ts`: fanout-child path exactly once in both existing sites (`:270` omitted, `:404` explicit); `extensions: []` at the API level emits `--no-extensions`, the fanout-child path once, and no `[]` path; absent for a non-fanout persona.
- `test/integration/fanout-child-inherit-extensions.test.ts` (real pi, skipped when no pi binary; same disposable-profile and in-process `fanout-child.ts` dispatch shape as `fanout-child-own-subagent-history.test.ts`, with two profile additions and one dispatch change):
  - Profile: `<profile>/settings.json` = `{"defaultProjectTrust":"always","packages":["<checkout>/src/extension/index.ts"]}` so the temp project's `.pi/extensions/` is discovered and the checkout's `index.ts` is the inherited pi-cohort registrant.
  - Dispatch: through the depth-0 parent entrypoint (the checkout's `index.ts` registered in-process with `PI_SUBAGENT_CHILD` unset), so each lead is a real depth-1 child spawned by `buildPiArgs`, as in the ticket. The observable per dispatch is the tool result: `result.isError` undefined and the joined `result.content` text; the harness captures no raw exit status or stderr, so a `conflicts with` check runs against the joined content text (pi's load error surfaces there).
  - Fixtures in the temp project: `.pi/extensions/ping-fixture.ts` (`ping_fixture -> pong`) and `.pi/extensions/provider.ts` (provider `fanout-fixture`, model `scripted`). Provider rule per turn: if `ping_fixture` is in the active tools and no `ping_fixture` toolResult is in context, call `ping_fixture`; else if `subagent` is in the active tools and no `subagent` toolResult is in context, call `subagent({ agent: "worker" })`; else finish with text `FIXTURE_DONE ping=<ping result or none> worker=<worker reply or none> tools=<comma-joined active tool names>`. `worker` has no `subagent` and finishes with the fixed token `WORKER_TOKEN`.
  - Personas (full frontmatter, `model: fanout-fixture/scripted` on each that completes a model turn):
    - `lead-omitted`: `tools: read, bash, subagent, ping_fixture`, no `extensions` line. Provider and `ping_fixture` arrive by project discovery under trust; `index.ts` arrives by package discovery. Assert reply matches `ping=pong` and `worker=WORKER_TOKEN`, and does not match `conflicts with`.
    - `lead-allowlist`: `tools: subagent`, `extensions: ./.pi/extensions/provider.ts`. Assert reply matches `worker=WORKER_TOKEN` and does not match `conflicts with`; no `ping_fixture` assertion (the ticket row is `tools: subagent`, so `--tools subagent` excludes it).
    - `lead-empty`: `tools: subagent`, bare `extensions:` line, no model turn required. `--no-extensions` excludes any extension-provided model, so row 4 is verified from real-pi startup: the test spawns the child argv that `buildPiArgs` produces for this persona against the installed pi and asserts `subagent` is in the child's configured tool inventory and the startup output does not match `conflicts with`.
    - `worker`: `tools: []`, `extensions: ./.pi/extensions/provider.ts`. Finishes with `WORKER_TOKEN`.
    - `plain`: `tools: read, bash`, no `extensions` line. Assert `subagent` is absent from the child's actual tool inventory (the provider's `tools=` echo, read from the active tool list) and the reply does not match `conflicts with`. A prose denial or an arbitrary nested-dispatch error is not a pass.
  - Record in the test file header that `lead-omitted` fails with the `conflicts with` error on the pre-fix tree and passes after the `index.ts` deletion.
- Verification command: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - `## [Unreleased]` fix entry `(#26)` (category: major procedures - the release skill promotes it)
- Derived / memory docs invalidated: none - `doc/orchestration-patterns.md:18`, `doc/agents-and-chains.md:202`, `doc/configuration.md:65` describe the child-safe `subagent` behavior, not the registrant, and stay true

The bar applied is `reference/documentation-impact.md`.

## Out of scope

- Releasing pi-cohort (`/skill:release patch` needs its own instruction).
- pi-gauntlet gh-79 floor bump and two-child smoke (`elsewhere` rows).
- Removing the dead WeakSet guard in `fanout-child.ts`.

## Open questions

none
