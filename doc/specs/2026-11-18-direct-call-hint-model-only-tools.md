# Tell the model in each direct-only tool's description that scripts cannot call it

**Goal:** The descriptions of pi-cohort's three direct-only tool registrations (parent `subagent`, child-safe `subagent`, `structured_output`) end with a `Codemode:` line saying the tool is not callable from scripts and is called directly, so a model reads the rule before it writes a codemode script pi will refuse. No tool changes exposure, parameters, or behavior.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** none
**Date:** 2026-11-18
**Source bases:** pi-cohort `f1e5ef5` (8.4.0 + 1); installed pi `@earendil-works/pi-coding-agent` 1.5.2; sibling checkouts `pi-gauntlet`, `pi-quiver`, `pi-condense`, read-only.
**Predecessor:** `doc/specs/2026-11-08-gh-49-subagent-model-only-exposure.md`, the Design clause "Tool descriptions stay as they are" and the Out of scope item "Tool-description hint telling the model to call directly" only. `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`, the Design clause "Keep the description unchanged" and the Out of scope item "rewording the tool description to demand a lone direct call" only.

## Problem

Request (verbatim, two messages): "model keeps trying to use codemode for this repo skills and siblings as well before they use direct execution. is there a way to mitigate that? [session file] shows that. scan other session this problem is also visible heavyly on ../pi-gauntlet/" and "make sure to check if its really a case for all tools that they shouldn't be called from code mode. check each tool in this repo and in sibling repo. we don't want to regress on valid codemode usage".

Success as the user states it (answer to question 1): "no regression, less failed codemode retries".

A model writes a codemode script that calls a direct-only tool, pi refuses it with `TypeError: tools.<name> does not exist. Available: ...`, and the model repeats the call directly. The refused turn is wasted, and when the script batched other calls, some of them already ran.

Measured cost (scan of `~/.pi/agent/sessions`, 18453 session files, 2138 with codemode results, run 2026-11-18): 199 scripts refused on a model-only tool - `plan_tracker` 85, `subagent` 71, `plan_check` 20, `phase_tracker` 15, `structured_output` 11. The five per-tool counts sum to 202 because three scripts were refused on two tools each (`phase_tracker` with `structured_output` twice, `phase_tracker` with `subagent` once). 82 distinct scripts name `subagent` or `structured_output`. The scan's unit is one codemode `toolResult` message whose text matches `tools\.(\w+) does not exist`, whatever its `isError` flag, with no deduplication across files; 164 of the 199 carry `isError: true` and 35 are refusals the script caught and printed. The last match is at 2026-11-18T08:13:33Z. 100 of the 199 batched the barred call with other tools; 47 had already run other calls before the refusal. First refusals 2026-11-08T12:40:52 (`plan_tracker`) and 2026-11-08T21:06:11 (`subagent`). In the session the user named, one refused `tools.subagent` script cost $0.27 before the direct call.

Why the model takes the scripted path: pi's codemode guideline tells it to batch independent calls in scripts (`dist/extensions/codemode/tool.js:41-45`), and pi appends `Codemode: tools.x(args) resolves to ...` to the description of every declared script-callable tool in mode `on` (`dist/extensions/codemode/tool.js:241-290`, `describeScriptCall`, `prepareCodemodeLoadout`). A model-only tool gets no such line in either mode, so its description is silent about scripts.

### Tool inventory (the "check each tool" request)

Five tool names are barred from scripts across the four repos; twelve tools are script-callable. Every bar has a live reason, so no exposure changes.

| Repo | Tool | Exposure | Reason the exposure stands |
|---|---|---|---|
| pi-cohort | `subagent` (parent, `src/extension/index.ts:409-478`) | model-only | A scripted call loses per-child progress and leaves no transcript result of its own; fork filtering and replay read top-level results (`CHANGELOG.md:85`, #49 spec). |
| pi-cohort | `subagent` (child-safe, `src/extension/fanout-child.ts:121-160`) | model-only | Same contract as the parent registration. |
| pi-cohort | `structured_output` (`src/runs/shared/subagent-prompt-runtime.ts:200-238`) | model-only | A script receives only `structuredContent` or text; the `terminate: true` request is dropped (`dist/extensions/codemode/execute.js:412-424,455-462`; `CHANGELOG.md:90`, #48 spec). |
| pi-gauntlet | `plan_tracker`, `phase_tracker`, `plan_check` | model-only | State is rebuilt after a reload from each tool's own `toolResult` messages (`extensions/plan-tracker.ts:206-217`, `extensions/phase-tracker.ts:535-604`); a nested call leaves only a `nestedCalls` summary on the parent result (`dist/core/agent-session.js:442-468,769-778`). |
| pi-gauntlet | `gauntlet_setting` | default | Reads settings only; documented as script-callable (`doc/configuration.md:216-220`). Stays callable. |
| pi-quiver | `fetch`, `doc_to_md`, `slack_search`, `slack_thread`, `slack_post`, `slack_update`, `slack_delete`, `slack_pin`, `slack_upload` | default | Typed script results are intended (`CHANGELOG.md:25-27`). Stay callable. |
| pi-quiver | `slack_cache_refresh` | codemode | Script-only by design. Stays. |
| pi-condense | `context_tree_query` | default | Stays callable. |

pi-cohort registers no script-callable tool, so a change confined to this repo cannot regress a valid script.

### Checked claims

- held - both `subagent` registrations and `structured_output` carry `exposure: "model-only"` - read `src/extension/index.ts:411`, `src/extension/fanout-child.ts:147`, `src/runs/shared/subagent-prompt-runtime.ts:221`.
- held - the three descriptions say nothing about scripts - parent: template literal at `src/extension/index.ts:413-434`, ending at the DIAGNOSTICS bullet; child-safe: three strings joined with `\n` at `src/extension/fanout-child.ts:149-153`; `structured_output`: `Submit the required final structured output for this subagent step. This terminates the step.` at `src/runs/shared/subagent-prompt-runtime.ts:222`.
- held - a line written into a model-only tool's description reaches the model in mode `on` and mode `only`, and pi 1.5.2 adds no second `Codemode:` line - `prepareCodemodeLoadout` rewrites descriptions only for callable tools and `hiddenDeclarations` covers only callable `direct` tools (`dist/extensions/codemode/tool.js:258-290`). Checked on 1.5.2 only; the peer range `>=1.5.0` (`package.json:66`) admits later runtimes (Errors and edge cases).
- held - a `promptGuidelines` bullet would not reach every declaration site - the rules section is built only without a custom replacement prompt (`dist/core/system-prompt.js:79-87`). pi-cohort starts replace-mode children with `--system-prompt` (`src/runs/shared/pi-args.ts:193`; replace is the default for every agent but `delegate`, `src/agents/agents.ts:39-41`), so they skip the rules section; append-mode children (`--append-system-prompt`) and parent sessions without a custom replacement prompt get it. The tool description always travels with the declaration. No `promptGuidelines` or `promptSnippet` use exists in `src/`.
- held - nothing reads these descriptions back - `grep -rn "Delegate to subagents\|Submit the required final structured output\|read-only report for runtime paths\|blocked in this mode"` over this worktree returns the three definitions and the #48 spec's quote; over the three siblings it returns only `pi-gauntlet/eval/brainstorming/replay/drive.mjs:21`, a stub with its own description. `test/unit/schemas.test.ts` asserts parameter descriptions, not tool descriptions.
- held - the existing exposure checks sit at `test/unit/index-child-registration.test.ts:111` (parent) and `:225` (child-safe), both `throw new Error` inside a spawned script, and `test/unit/subagent-prompt-runtime.test.ts:116-121` (`assert.equal(tool.exposure, "model-only")`).
- held - human-facing docs already state the direct-only rule - `README.md:186`, `doc/agents-and-chains.md:274`, `doc/orchestration-patterns.md:18`.
- held - the earlier specs rejected a description change - `doc/specs/2026-11-08-gh-49-subagent-model-only-exposure.md:83,124` ("a prose hint would guard the boundary a second time"), `doc/specs/2026-11-08-gh-48-structured-output-model-only.md:79,156`. This spec reverses those clauses: the line is the signal the model is missing before it chooses a route, not a second check of the boundary, and the new fact is the recurring cost above.
- held - pi is another party's project (`repository: git+https://github.com/earendil-works/pi.git`), so pi stating the rule itself for every model-only tool can only be requested upstream.
- held - this repo declares no sibling for coordinated work (`.pi/gauntlet-overrides.md` has no `## shape-ticket` section), so pi-gauntlet's tools change through pi-gauntlet's own tracker.
- not checked - whether the line reduces scripted first attempts - no model run with and without it exists; see Open questions.
- not checked - `context_tree_query` called from a script returns text only and may miss pi-condense's recovery grace (`pi-condense/src/recovery-grace.ts:36`) - read from source, not reproduced; out of scope.

Implicit dependencies: installed pi 1.5.2 runtime - read - found. Real-child fixtures `test/integration/fixtures/{subagent-model-only,structured-output-model-only}` - listed - found.

Framing: kept - the scout's objection (a generic line in pi's own loadout for every model-only tool) names an alternative this repo cannot ship; it is recorded as an upstream request, not a pivot.

Decisions from the questionary: every direct-only tool stays direct-only (question 1, answer "A, what is design as direct stay as such. no regression, less failed codemode retries"); description line only, no system-prompt rule (question 2, answer "A"); both design rounds approved as presented.

## Acceptance criteria

Drafted from the design, no ticket rows:

- [ ] The parent `subagent` tool, as registered, has a description that ends with a blank line followed by ``Codemode: not callable from scripts - call `subagent` directly, as its own tool call.``
  in-scope
- [ ] The child-safe fanout `subagent` tool, as registered, has a description that ends with a blank line followed by ``Codemode: not callable from scripts - call `subagent` directly, as its own tool call.``
  in-scope
- [ ] The `structured_output` tool, as registered, has a description that ends with a blank line followed by ``Codemode: not callable from scripts - call `structured_output` directly, as its own tool call.``
  in-scope
- [ ] A codemode script that calls `tools.subagent` in a real child is still rejected, under codemode `on` and `only`.
  in-scope
- [ ] `structured_output` is still absent from a real child's script namespace.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: direct-call-tools-in-codemode
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
design: owns `src/extension/index.ts`, `src/extension/fanout-child.ts`, `src/runs/shared/subagent-prompt-runtime.ts`, `test/unit/index-child-registration.test.ts`, `test/unit/subagent-prompt-runtime.test.ts`, `CHANGELOG.md`; the three registered descriptions end with the closing line and every registration stays model-only.

## Design

supersedes `doc/specs/2026-11-08-gh-49-subagent-model-only-exposure.md`, the Design clause "Tool descriptions stay as they are" and the Out of scope item "Tool-description hint telling the model to call directly" only; supersedes `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`, the Design clause "Keep the description unchanged" and the Out of scope item "rewording the tool description to demand a lone direct call" only. Everything else in both specs stands.

### The closing line

Each registered description ends with its existing text, one blank line, and one sentence, in the position where pi writes `Codemode: tools.x(args) resolves to ...` on script-callable tools:

| Registration | Closing line (exact registered text) |
|---|---|
| parent `subagent` | ``Codemode: not callable from scripts - call `subagent` directly, as its own tool call.`` |
| child-safe `subagent` | ``Codemode: not callable from scripts - call `subagent` directly, as its own tool call.`` |
| `structured_output` | ``Codemode: not callable from scripts - call `structured_output` directly, as its own tool call.`` |

The backticks around the tool name are part of the registered string. The sentence does not contain the `tools.<name>(` form, so it does not show the model the call it must not write. "As its own tool call" addresses the scripts that batched a barred call with other tools: it means a top-level tool call instead of a call nested in a script. It does not ask for the call to be alone in the turn; direct calls that are valid side by side today stay valid.

The existing description text before the blank line is unchanged, byte for byte.

Remove: none.

Add:

- `src/extension/index.ts`: append `\n\n` and the `subagent` closing line to the parent description template literal, after the DIAGNOSTICS bullet. The two backticks are written escaped inside the template literal.
- `src/extension/fanout-child.ts`: append two elements to the description array, `""` and the `subagent` closing line, so the `\n` join yields the blank line.
- `src/runs/shared/subagent-prompt-runtime.ts`: append `\n\n` and the `structured_output` closing line to the description string.
- `test/unit/index-child-registration.test.ts`: one description check beside the parent exposure check and one beside the child-safe exposure check, in the file's `throw new Error` style. Both checks sit inside `String.raw` templates run by a spawned node process: write the expected suffix as a double-quoted string inside the script, escape its two backticks as `` \` `` so they do not end the outer template (the child reads `` \` `` as a backtick), and write `\n\n` as is - `String.raw` passes the escape through and the child reads two newlines.
- `test/unit/subagent-prompt-runtime.test.ts`: one description assertion in "registered structured_output tool is declared model-only".
- `CHANGELOG.md`: one bullet under `## [Unreleased]`, in a `### Changed` section, stating that the `subagent` and `structured_output` tool descriptions end with a `Codemode:` line saying the tool is not callable from scripts and is called directly, so a model is told before it writes a script pi refuses.
- Supersession banners on the two predecessor specs (part of the spec commit).

The three closing lines are written as literals at their sites. No shared constant or helper: three strings pinned by three tests is less machinery than a function, and the two tool names differ.

No change to `exposure`, parameters, `execute`, the child instruction constants, the allowlist, the rejected-script recovery in `src/shared/utils.ts`, or any integration fixture. No `promptGuidelines` or `promptSnippet`.

### Where the line reaches

The description is the text pi sends the model for a declared tool. It is shown in the parent session, in child agents in either prompt mode (replaced or appended), and under codemode `on` and `only` (model-only tools stay declared in `only`).

### Paid or external actions

None for implementation or verification: the unit and integration suites run offline. Approving this spec authorizes every action named in this spec for the whole flow, across seed, rows, repairs and finish, without per-step permission prompts. An action this spec does not name is unreachable and needs separate explicit authorization. The release is not covered by that grant: `/skill:release` runs `release.sh <level>` only after the user's instruction names the level, and approving this spec names none.

**Post-deployment housekeeping.** After the release carrying this change has been installed for a week of normal use, the user (or an agent the user asks) counts refused `subagent` and `structured_output` scripts with the procedure below, for the baseline window and for the post-install window, and compares the two daily rates per tool. Refusals not falling is the signal to add a system-prompt rule on the parent `subagent` in a follow-up change. The user decides when to file the pi-gauntlet ticket for `plan_tracker`, `phase_tracker` and `plan_check` (through `/skill:shape-ticket`) and the upstream request to pi.

Counting procedure. Read-only. Record shapes are read from pi 1.5.2 (`dist/core/session-manager.js:839-846,813`, `ToolResultMessage` at `pi-ai/dist/types.d.ts:434-449`, `dist/extensions/codemode/execute.js:569-577`, the refusal message in `pi-codemode/dist/runtime/prelude-source.js`); the procedure has not been run against the session files.

1. Input: every session file under `~/.pi/agent/sessions`, one JSON entry per line.
2. A refused script is one entry with `type: "message"` whose `message` has `role: "toolResult"`, `toolName: "codemode"`, and text content that matches `tools\.(subagent|structured_output) does not exist`, whatever its `isError` flag: a refusal the script caught (for example inside `Promise.allSettled`) is still a refused attempt. Report how many matches carry `isError: true`.
3. One entry is one script, however many matches its text holds. The same `message.toolCallId` found in more than one file counts once.
4. A script belongs to the `subagent` category when its text matches `tools\.subagent does not exist` and to the `structured_output` category when it matches `tools\.structured_output does not exist`. A script that matches both belongs to both, so the two category counts can sum to more than the number of scripts.
5. Time is the entry's `timestamp` (ISO 8601, UTC). Baseline window: from `2026-11-08T00:00:00Z` up to but not including `2026-11-18T00:00:00Z`, 10 days. Post-install window: from the time the release was installed to the time of the scan, at least 7 days; its length in days is the elapsed hours divided by 24.
6. Per tool and per window: daily rate = scripts in the window / days in the window. Report the count, the days and the rate for both windows.

The baseline window is recounted with this procedure in the same run as the post-install window, so both rates come from one method. The 71 and 11 in the Problem section are the original scan's totals up to 2026-11-18T08:13:33Z, counted without deduplication across files; the recount replaces them for the comparison. "Not falling" is read per tool: the post-install daily rate is at or above the baseline daily rate. The comparison is descriptive: it sets no reduction target, and one week of counts is an observation, not a statistical result.

## Errors and edge cases

- The model ignores the line and scripts the call: pi refuses it exactly as today and the direct retry works. The line warns the model before it chooses a route; it enforces nothing.
- A child scripts `structured_output`, is refused, then calls it directly: the existing recovery in `detectSubagentError` applies unchanged.
- Codemode `only`: the three tools stay declared, so the line is shown and stays true.
- Codemode is not among a session's active tools (for example a child whose tool allowlist leaves it out): the line is a static string and is still shown; it stays true and has no effect. No conditional registration.
- A later change makes one of these tools script-callable: in mode `on` pi would append its own `Codemode:` line under this one and the two would contradict. Each description check sits beside its exposure check in the same test, so the exposure change fails next to the wording that must change with it.
- A later pi states the rule itself for every model-only tool (the upstream request): each description would carry two `Codemode:` lines and no test here notices. The change that raises the supported pi floor to a version that guarantees pi's own hint removes the three literals and their description checks. No runtime detection.
- Declaration size: each description grows by one line, about twenty tokens.

## Tests

Each new check compares the end of the registered description with `"\n\n"` plus the exact closing line (`endsWith`), so a reworded, moved, or missing line fails.

- Parent `subagent` description ends with the closing line (AC 1) - `test/unit/index-child-registration.test.ts`, "does not show async badge for explicit foreground clarify chain calls", beside the parent exposure check.
- Child-safe `subagent` description ends with the closing line (AC 2) - `test/unit/index-child-registration.test.ts`, "lets fanout children call read-only list but blocks mutating management actions", beside the child-safe exposure check.
- `structured_output` description ends with the closing line (AC 3) - `test/unit/subagent-prompt-runtime.test.ts`, "registered structured_output tool is declared model-only".
- A scripted `tools.subagent` call is still rejected under `on` and `only` (AC 4) - `test/integration/subagent-model-only.test.ts`, "rejects scripted dispatch and preserves direct progress in codemode <mode> mode", unchanged.
- `structured_output` is still absent from a child's script namespace (AC 5) - `test/integration/structured-output-model-only.test.ts`, "excludes structured_output from a real child's script namespace but captures its direct call", unchanged.
- All three registrations stay model-only - the three existing exposure checks, unchanged.
- Existing description text before the blank line is unchanged - none: the diff shows only appended text, and no test pins the full description.
- The model ignores the line - none: pi's refusal is pi's behavior, covered by the AC 4 and AC 5 tests.
- Rejected scripted `structured_output` followed by a direct call recovers - `test/integration/detect-error.test.ts`, unchanged.
- Codemode `only` shows the line - none: pi owns which declarations are sent; the AC 4 test runs the real child in `only` mode with the tool declared.
- Codemode not active in a session - none: the description is a static string, pinned by the three description checks.
- A later pi states the rule itself - none: no test here observes pi's loadout text; handled in the change that raises the pi floor.
- A future exposure flip fails beside the wording - the description checks sit in the same tests as the exposure checks.
- Scripted first attempts become rarer - none: no test observes a model's choice; measured after release (Post-deployment housekeeping).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` (one Unreleased entry; clears "Communication contracts / integrations": the model-visible tool description is the contract with the model)
- Derived / memory docs invalidated: none

Materiality bar: `reference/documentation-impact.md`. `README.md:186`, `doc/agents-and-chains.md:274` and `doc/orchestration-patterns.md:18` already state the direct-only rule and stay correct.

## Out of scope

- Any exposure change, in this repo or a sibling.
- pi-gauntlet's `plan_tracker`, `phase_tracker` and `plan_check` descriptions: same line, through a pi-gauntlet ticket.
- A generic line from pi for every model-only tool: an upstream request.
- A system-prompt rule (`promptGuidelines`) or a change to the child instruction constants: the follow-up if the post-release scan shows no drop.
- Rewording skill examples that show `subagent({...})`.
- `context_tree_query`'s text-only script result in pi-condense.
- README or guide edits.

## Open questions

- Effect size: whether the closing line reduces scripted first attempts is unmeasured. The spec commits to the line and to the post-release scan, not to a reduction target.
