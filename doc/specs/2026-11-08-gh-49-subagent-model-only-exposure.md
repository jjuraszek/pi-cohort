# Register `subagent` as model-only so children are dispatched only by a direct tool call

**Goal:** Both `subagent` registrations (depth-0 parent and child-safe fanout) carry `exposure: "model-only"`, so a codemode script or an `ctx.executeTool` caller can never dispatch a child; the model dispatches by a direct tool call, which keeps pi-cohort's per-child progress channel and transcript record intact. A released pi-cohort carrying this is the upstream contract pi-gauntlet#135 bumps its floor to.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** jjuraszek/pi-cohort#49 (base for jjuraszek/pi-gauntlet#135)
**Worktree:** `.worktrees/gh-49-subagent-model-only`, branch `gh-49-subagent-model-only`, rebased onto `61ccb03` on `main` (the #47 merge)
**Predecessor:** none

## Problem

pi 1.5.0 lets a model call any `direct` tool from inside a `codemode` script (`tools.<name>(...)`). pi-cohort registers its `subagent` tool twice - the parent registration in `src/extension/index.ts` (around line 404, with `renderCall`/`renderResult`) and the child-safe fanout registration in `src/extension/fanout-child.ts` (around line 139) - and neither sets `exposure`, so pi defaults both to `direct`. A script-wrapped dispatch runs the child, but the parent sees only what the script prints: the per-child progress view, the direct-call rendering, and the transcript record of a `subagent` toolCall are lost, and downstream state rebuilt from direct toolResults (pi-gauntlet's fix-round cap, closure latch, fork-context filter) never sees the dispatch. The reporter observed scripted councils losing the per-child view across several sessions on 2026-11-08; no transcripts were supplied, so that observation is unverified, but the mechanism is read from pi's source and reproduced live in this session (`TypeError: tools.phase_tracker does not exist` for a model-only tool, no call made).

Verified from the installed pi 1.5.0: `ToolExposure` `model-only` is "declared to the model while active, never callable through `ctx.executeTool()`" (`dist/core/extensions/types.d.ts:399-414`); `_getCallableTools` admits only `codemode`, `deferred`, and active `direct` tools (`dist/core/agent-session.js:1176-1179`); in codemode `only` mode `hiddenDeclarations` hides only active `direct` tools, so a model-only tool stays declared (`dist/extensions/codemode/tool.js:262-264`); pi registers its own `codemode` tool model-only (`tool.js:289`); `createCodemodeExtension({ mode })` selects the mode per extension instance (`dist/extensions/codemode/index.js:17-25`). The Pi floor is already `>=1.5.0` (`package.json:66`, `README.md:36`), so no floor change is needed. `rg executeTool src` finds no in-repo caller of `ctx.executeTool("subagent", ...)`.

Framing: kept - checked both registrations and pi's exposure filter, the codemode `on`/`only` loadout, the sibling #47 (fork-context filter, merged to `main` in #50 at `61ccb03`; it touches `src/runs/shared/subagent-prompt-runtime.ts` and the same `doc/orchestration-patterns.md` paragraph, not either registration), the in-flight #48 (`structured_output` model-only with its real-child harness) and the landed #26 single-registration design, `doc/orchestration-patterns.md`, and pi-gauntlet#135's body, which blocks only on a released pi-cohort with both registrations verified. The scout's lead that a failed script followed by a successful direct dispatch could be reported as a failed child was traced to `detectSubagentError` (`src/shared/utils.ts:283-323`): it scans only toolResults after the last assistant text, so a child that ends with a text reply promotes no error; a child ending on a tool error with no trailing text is pre-existing behavior for every tool. No alternative implied; it is an edge case, not a framing concern.

Assumptions recorded during questionary: the `ctx.executeTool("subagent", ...)` channel closes for every caller, not only scripts, and the CHANGELOG says so; #48 stays an independent ticket (#47 has landed); the release level is chosen at ship time.

## Acceptance criteria

Ticket #49, `## Acceptance Criteria`, rows verbatim:

- [ ] Given the parent extension registered under pi 1.5.0, the `subagent` tool definition carries `exposure: "model-only"` (assertion in `test/unit/index-child-registration.test.ts` beside the existing registration capture).
  in-scope
- [ ] Given a child whose resolved `tools` include `subagent`, the child-safe `subagent` tool definition carries `exposure: "model-only"` (same test file).
  in-scope
- [ ] In a child-run test under pi 1.5.0, with `subagent` active and codemode in `on` mode, the script's `tools` namespace has no `subagent` member and attempting `tools.subagent(...)` fails without starting a child; a direct `subagent` call in the same session starts a child and shows pi-cohort's per-child progress rendering.
  in-scope
- [ ] Repeat the child-run test with codemode in `only` mode: the model's declared tool list includes the active `subagent` tool, the script's `tools` namespace has no `subagent` member, and a direct `subagent` call starts a child and shows pi-cohort's per-child progress rendering.
  in-scope
- [ ] `doc/orchestration-patterns.md` states that `subagent` is reachable only as a direct tool call and never from a codemode script, with the reason (per-child progress and transcript record).
  in-scope

Reading of "shows pi-cohort's per-child progress rendering" (rows 3 and 4), chosen at the questionary: a headless test cannot see the TUI, so the observable is the data the per-child view is drawn from - the parent-side `onUpdate` progress channel (the lead's live tool line), the nested-events projection the status tree renders from, and the session-file record. The Design clause "Progress observable" below binds it.

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-49-subagent-model-only
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
design: owns `src/extension/index.ts`, `src/extension/fanout-child.ts`, `test/unit/index-child-registration.test.ts`, `test/integration/subagent-model-only.test.ts`, `test/integration/fixtures/subagent-model-only/`, `README.md`, `doc/orchestration-patterns.md`, `CHANGELOG.md`; observable outcomes are the five acceptance rows above

## Design

The change is one field on each registration. Nothing in the dispatch path moves: the executor, foreground and background runners, acceptance, progress rendering, the persona `tools: subagent` allowlist, and the `maxSubagentDepth` cap stay as they are. Pi does the rest once the field is set.

Remove: none.

Add:
- `exposure: "model-only"` on the parent `subagent` `ToolDefinition` in `src/extension/index.ts` (the object registered around line 404-472).
- `exposure: "model-only"` on the child-safe `subagent` `ToolDefinition` in `src/extension/fanout-child.ts` (the object registered around line 139-153). The field goes on both definitions, not on the child-mode early-return branch of `index.ts`.
- Assertions in `test/unit/index-child-registration.test.ts`: the captured parent registration and the captured fanout registration each have `exposure === "model-only"`. The two existing child-mode no-registration tests stay.
- `test/integration/subagent-model-only.test.ts` with fixtures `test/integration/fixtures/subagent-model-only/{provider.ts,lead.md,leaf.md}` (shape below).
- README.md Architecture section: one sentence that `subagent` is a direct-call tool (`exposure: "model-only"`), not reachable from codemode scripts or `ctx.executeTool`, and stays declared in codemode `only` mode.
- `doc/orchestration-patterns.md` child-safety paragraph (the one that, since #47, says an inherited call with a nested `subagent` dispatch is stripped, and that children do not register `subagent` by default): `subagent` - both the parent tool and the child-safe fanout tool - is reachable only as a direct tool call and never from a codemode script or `ctx.executeTool`, because a direct call is what carries the per-child progress view and the transcript record of the dispatch; in codemode `only` mode the tool stays declared. The #47 sentence about stripping inherited scripted dispatches stays: it covers transcripts recorded before this change and by other runtimes; the new wording does not claim those are repaired.
- `CHANGELOG.md` `## [Unreleased]`: an entry under `### Changed` (beside the Pi-floor entry; `### Fixed` already holds #47's) naming both registrations, that `ctx.executeTool("subagent", ...)` is refused for every caller (pi-cohort has no in-repo caller), and `(#49)`.

Data flow after the change: the model emits a direct `subagent` toolCall -> pi routes it to the registered `execute` -> pi-cohort dispatches the child, emits `onUpdate` progress snapshots (`details.results[0]` as a `SingleResult` plus `details.progress[0]` as the child's own `AgentProgress`, `src/runs/foreground/execution.ts:386-399`) and returns the result record (`details.results[]`, each a `SingleResult` with `agent`, `exitCode`, optional `interrupted`, and `sessionFile` - `src/shared/types.ts:420-432`; there is no `status` field, and finalization drops the per-result `progress` object). A model that tries the script path gets pi's `TypeError: tools.subagent does not exist. Available: ...` as an errored codemode toolResult with `details.calls: []`, no run id minted, no session file, no progress entry; on its next turn it calls the tool directly.

Integration test shape (in-repo model: `test/integration/fanout-child-own-subagent-history.test.ts`; `test/integration/structured-output-model-only.test.ts` on the unmerged #48 branch is illustrative only - it is not in this worktree, and the description here is the contract): a real pi child (`node_modules/.bin/pi`, `PI_OFFLINE=1`, isolated trusted profile under a temp `PI_CODING_AGENT_DIR`, `PI_SUBAGENT_*` env cleared), dispatched at depth 0 through `registerSubagentExtension` with `makeMinimalCtx` and a fake `registerTool` capture. The fixture provider registers a scripted model (`registerProvider` with `streamSimple`, unreachable `baseUrl`) and calls `createCodemodeExtension({ mode })` itself because the persona allowlist disables CLI built-ins; `mode` comes from one env var, `SUBAGENT_FIXTURE_CODEMODE_MODE`, which the harness sets to `on` for the first run and `only` for the second (one provider file; child env propagation is the same path the fanout fixture's `FANOUT_FIXTURE_LOG` uses). Personas: `lead` with `tools: subagent, codemode`, `extensions: ./.pi/extensions/provider.ts`, `model: subagent-model-only-fixture/scripted`; `leaf` with the same model and no tools. The scripted model, keyed on the conversation it sees: for the lead, turn 1 emits a `codemode` call whose script runs `tools.subagent({ agent: "leaf", task: ... })`; on a codemode result containing `does not exist` it emits a direct `subagent` toolCall for `leaf`; after that toolResult it emits a text reply `FIXTURE_DONE`; anything else emits `FIXTURE_UNEXPECTED: <reason>`. For the leaf it emits one text reply `LEAF_DONE`. The provider also records, per request, whether the declared tool list carried a tool named `subagent` (a fixture log file in the temp profile, as the fanout test's `decision` rows do). Under pi 1.5.0 the `streamSimple` `TranscriptContext` carries no `tools` array - declarations ride in the messages as `toolsAdded`/`toolsRemoved`, which is also where codemode `only` mode's `hiddenDeclarations` is applied - so the provider resolves the declared list with `getCurrentTools(context.messages)` (exported by `@earendil-works/pi-ai`, `dist/utils/transcript.d.ts:26`, re-exported from `dist/index.d.ts:32`) and logs whether the resolved names include `subagent` for each lead request; reading `context.tools` would log "absent" in both modes. The test runs the lead twice - once with `SUBAGENT_FIXTURE_CODEMODE_MODE=on` and once with `only` - and reads the lead's session file and the parent's `onUpdate` snapshots. Isolation per mode: each mode gets its own temp profile (one `it` per mode), the leaf-session count is taken under the parent directory of the lead's `details.results[0].sessionFile` for that mode only, and the test deletes `process.env.PI_CODING_AGENT_DIR` before its dynamic import of `src/extension/index.ts` and sets it to the mode's profile before each dispatch - `PINNED_AGENT_DIR` and `PINNED_AGENT_DIR_OVERRIDE` are resolved once at module load (`src/shared/agent-dir.ts:11-12`) and the override, when present, replaces `PI_CODING_AGENT_DIR` in every spawned child's env (`src/runs/foreground/execution.ts:178`), so an inherited shell value would send the nested-event registry (`RUN_STATE_ROOT_DIR`, `src/shared/types.ts:962`) to the real agent dir instead of the test profile; `test/support/isolate-test-env.mjs` isolates `HOME` and `TMPDIR` but not `PI_CODING_AGENT_DIR`.

Progress observable (binding reading for AC rows 3 and 4), built only from observables that exist today - the `onUpdate` payload carries only the lead's own `SingleResult` and `AgentProgress` (`execution.ts:386-399`) and grandchild nesting lives in `foregroundControl.nestedChildren`, filled from `projectNestedEvents` after the run (`src/runs/foreground/subagent-executor.ts:238,2092`), never in `onUpdate`: (a) the parent-side `onUpdate` callback (4th argument of `tool.execute`, emitted from `src/runs/foreground/execution.ts:386-405`) receives at least one snapshot whose `details.progress[0].currentTool === "subagent"` and whose `currentToolArgs` names `leaf` (`execution.ts:449`, the lead's live tool line the per-child widget draws); (b) after the run, `projectNestedEvents` over the lead's nested route under `NESTED_EVENTS_DIR` (`src/runs/shared/nested-events.ts:33`, keyed by `details.runId`) yields a child with `agent: "leaf"` and `parentRunId === details.runId` (the data the status tree renders from); (c) the lead's direct `subagent` toolResult carries `details.results[0]` with `agent === "leaf"`, `exitCode === 0`, `interrupted !== true`, and a `sessionFile` path, on a toolResult that is not an error. No progress plumbing changes. The TUI itself is not observed.

Tool descriptions stay as they are: pi's error names the available tools, and the fixture shows recovery in one turn; a prose hint would guard the boundary a second time (AGENTS.md "no belt-and-suspenders").

Paid or external actions: none for implementation or verification - every test runs against the scripted fixture provider offline. The one external action is the release at ship time, run by the user via `release.sh <level>`; the level is theirs. The loop treats any action not named here as unreachable; adding one needs separate explicit authorization.

Release handoff for pi-gauntlet#135: the CHANGELOG entry under the release that promotes it names both registrations and cites this spec and the integration test as the upstream verification; #135's floor is that released version. No version is named here. The "no in-repo caller" statement covers pi-cohort only; a grep of pi-gauntlet's `extensions/` and `src/` for `executeTool` with `subagent` found no caller (run at brainstorm time, not re-verified at release); the compatibility check at floor adoption belongs to #135 - this spec adds no sibling work.

## Errors and edge cases

- Script attempt: `tools.subagent(...)` fails with pi's `TypeError: tools.subagent does not exist. Available: ...` inside the script; the codemode toolResult `isError` with `details.calls: []`. pi-cohort adds no wrapper and no custom message - the runtime owns that boundary.
- No phantom child: the failed script dispatches nothing - no run id, no session file, no progress entry, no entry in the parent's results.
- Child ending on the error: if a child's last turn is the failed codemode call with no trailing text, `detectSubagentError` promotes it as a failed child exactly as it does today for any unrecovered tool error. Pre-existing behavior, unchanged; named so a reviewer does not read it as a regression. A child that calls directly and ends with text is finalized normally.
- `ctx.executeTool("subagent", ...)` from another extension: refused by pi's `_getCallableTools`; no in-repo caller; the CHANGELOG entry states the channel is closed.
- Codemode `only` mode: the tool stays declared because pi hides only `direct` tools; the fixture provider's request log proves `subagent` is in the declared list.
- Persona without `tools: subagent`: no fanout registration at all, as today; exposure changes nothing for it.
- No toggle: no setting or env var re-opens the script path; one would reintroduce the bug.
- `PI_SUBAGENT_*` env and both settings paths: unaffected.

## Tests

- Parent registration carries `exposure: "model-only"` (AC 1) - `test/unit/index-child-registration.test.ts`, assertion on the captured parent registration.
- Child-safe fanout registration carries `exposure: "model-only"` (AC 2) - `test/unit/index-child-registration.test.ts`, assertion on the captured fanout registration.
- `on` mode: scripted call fails before dispatch (codemode toolResult `isError`, text contains `tools.subagent does not exist`, `details.calls` deep-equals `[]`, no `subagent` toolCall precedes it); exactly one direct `subagent` toolCall follows, its toolResult is not an error and carries `details.results[0]` with `agent === "leaf"`, `exitCode === 0`, `interrupted !== true`, and a `sessionFile`; the parent `onUpdate` received a snapshot with `details.progress[0].currentTool === "subagent"` and `currentToolArgs` naming `leaf`; `projectNestedEvents` over the lead's route yields a child with `agent === "leaf"` and `parentRunId === details.runId`; lead output matches `FIXTURE_DONE`; parent result not an error (AC 3) - `test/integration/subagent-model-only.test.ts`.
- `only` mode: the fixture request log (`getCurrentTools(context.messages)` names) shows `subagent` declared for every lead request; the same script-fail / direct-dispatch / `currentTool` snapshot / `projectNestedEvents` child / `FIXTURE_DONE` assertions (AC 4) - same test, second `it`, own temp profile.
- Exactly one leaf session file exists under the parent directory of the lead's `details.results[0].sessionFile` after each mode's run - no phantom child from the script attempt - same test.
- `doc/orchestration-patterns.md` carries the direct-only statement with the reason (AC 5) - none: doc content; verified by the conformance read at the finish gate.
- `executeTool` refusal from another extension - none: pi behavior cited at `agent-session.js:1176-1179`; no in-repo caller to exercise.
- `only`-mode declaration survival in pi's loadout - covered by the AC 4 request-log assertion; pi's `prepareCodemodeLoadout` is not re-tested beyond that.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` Architecture section (communication contract: `subagent` is direct-call only, the cross-component boundary pi-gauntlet#135 relies on); `doc/orchestration-patterns.md` child-safety paragraph (same contract for the fanout child, with the reason); `CHANGELOG.md` `## [Unreleased]` (closed `executeTool` channel for every caller)
- Derived / memory docs invalidated: none - `doc/observability.md` describes where children show up, which does not change

Materiality bar: `reference/documentation-impact.md` (pi-gauntlet brainstorming reference).

## Out of scope

- #47 fork-context stripping of scripted dispatches: merged to `main` (#50, `61ccb03`) and this branch is rebased onto it. Its `nestedCalls` filter stays as-is; after this change it only ever matches transcripts recorded before it or by other runtimes. Nothing in #47 is removed or re-touched.
- #48 `structured_output` model-only: a different tool, in motion on `gh-48-structured-output-model-only`; shares the registration pattern and harness shape only.
- pi-gauntlet#135 (floor bump, `doc/configuration.md` wording), #132 (flow-scoped guard; conflicts with direct-only-in-`only`-mode and is not a #49 obligation), #134 repair: downstream, not edited here.
- A pi-gauntlet test asserting the installed pi-cohort's exposure: #135 states validation lives once at this boundary.
- Tool-description hint telling the model to call directly: rejected at round 2.
- A setting to re-open script dispatch.
- Observing the TUI itself.

## Open questions

- Settled under the standing grant (progress observable for AC rows 3 and 4): the gate's Q1 premise that `onUpdate` snapshots nest the grandchild was contradicted by `execution.ts:386-399` and `subagent-executor.ts:238,2092`; the Design clause "Progress observable" now binds the existing observables (live `currentTool === "subagent"` snapshot, `projectNestedEvents` child with `parentRunId === details.runId`, session-file record) and no progress plumbing changes.
- Not blocking: the reporter's multi-session progress-loss observation stays unverified (no transcripts); the mechanism is verified from pi's source and the live error in this session.
