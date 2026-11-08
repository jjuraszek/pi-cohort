# Fork context strips inherited calls that dispatched a subagent from inside a script

**Goal:** A forked child never inherits a parent tool call whose result dispatched a `subagent`, whether the parent called `subagent` directly or from inside a codemode script.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Ticket:** #47
**Framing:** kept (ticket #47 records the nestedCalls-primary decision; adopted)

## Problem

A forked child (`context: "fork"`) starts from a branched copy of the parent's session and `src/runs/shared/subagent-prompt-runtime.ts` strips the parent's earlier `subagent` tool calls and results from the model-visible context so the child does not see sibling reports. The capture walk (`collectSubagentToolCallIds`, lines 184-195) collects only assistant `toolCall` blocks named `subagent`, and both predicates (`isSubagentToolResultMessage` 136-140, `isInheritedSubagentToolCallBlock` 142-146) require the `subagent` name again. When the parent dispatched from inside a `codemode` script (`tools.subagent({...})` in `arguments.code`), the persisted block is named `codemode` and its result holds whatever the script printed - often the sibling's full report - so it passes the filter into every later forked child.

Corrected premise from the ticket: pi marks a nested-call record `complete: false` in three cases (`nested-tool-calls.js:16-76`): more than 256 calls (later records dropped), a call's arguments over 8 KiB or 32 KiB total (record kept, `arguments` omitted), or a call unfinished when the tool returned. Only the first drops the `subagent` record; the fallback matters only there.

Pi 1.5.0 (the repo's floor) persists two records on the result message that the runtime can read: `nestedCalls` (`pi-ai/dist/types.d.ts:408-436`, attached at `agent-session.js:727-733`, generic to every tool) and codemode's own `details.calls` (`codemode/tool.d.ts:77-81`, built uncapped at `codemode/execute.js:433-479`). `createBranchedSession` (`session-manager.js:1217`) copies entries wholesale, so both survive into the child's branch.

Decisions recorded during the questionary: the rule is generic to any inherited tool call (not only `codemode`) and ships on by default with no setting, env flag, or migration; the fallback for an incomplete record is codemode's `details.calls`, not a substring match on the script text, and applies to `codemode` results only; the decision is made once at the `session_start` capture, matching the file's capture-then-filter design.

## Acceptance criteria

Ticket #47, Acceptance criteria, rows verbatim:

- [ ] Given a branch with an assistant `codemode` toolCall whose toolResult `nestedCalls.calls` includes a call named `subagent`, fork-context filtering removes that toolCall block and its toolResult (unit test beside the existing subagent-prompt-runtime fork tests).
  in-scope
- [ ] Given a `codemode` toolCall whose toolResult `nestedCalls` is incomplete (`complete: false`, the dispatch beyond the recording limit) and whose `code` references `tools.subagent`, filtering removes the block and its result; the same incomplete record with no `tools.subagent` reference is kept (unit test).
  deviates: the user replaced the code-text signal with codemode's recorded `details.calls` invocation names (uncapped list of every tool the script invoked by name) as the incomplete-record fallback; the two signals differ - a comment that only mentions `tools.subagent` is kept now, a `tools["subagent"]()` call is stripped now - and Design restates the row with the `details.calls` signal
- [ ] A `codemode` toolCall with a complete record and no nested `subagent` is kept (unit test).
  in-scope
- [ ] The fork-context paragraph in `doc/orchestration-patterns.md` states that scripted dispatches are stripped by their recorded nested calls, with the code-text fallback for incomplete records.
  deviates: follows the row-2 decision - the paragraph names the `details.calls` fallback for incomplete records, since no code-text fallback exists; confirmed by the user at the spec gate (approval reply `5`)

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-47-fork-context-scripted-dispatch
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts` (targeted); `env -u PI_CODING_AGENT_DIR npm run test:all` (full) - run in the worktree
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4
design: owns `src/runs/shared/subagent-prompt-runtime.ts`, `test/unit/subagent-prompt-runtime.test.ts`, `doc/orchestration-patterns.md`, `CHANGELOG.md`; a forked child's model-visible context contains no inherited tool call that dispatched a subagent

## Design

All changes live in `src/runs/shared/subagent-prompt-runtime.ts`, the runtime loaded into every forked child; the `context` and `session_start` registrations remain unchanged while the capture walk and the two filtering predicates change. `src/shared/fork-context.ts` and the parent-side codemode extension are untouched.

**Capture.** `collectSubagentToolCallIds(entries)` keeps its assistant branch (direct `subagent` toolCall blocks) and gains a toolResult branch: for every `{ type: "message", message: { role: "toolResult" } }` entry with a string `toolCallId`, add the id when `resultDispatchedSubagent(message)` holds. The walk runs once at `session_start` over `ctx.sessionManager.getBranch()`, before the child runs, so the child's own later calls are never candidates (same boundary as today, lines 279-290).

**Predicate.** `resultDispatchedSubagent(message)` returns true when:

1. `message.nestedCalls` is an object whose `calls` is an array containing a record with `name === "subagent"` - regardless of `complete`, since the record survived; or
2. `message.toolName === "codemode"`, `message.nestedCalls.complete === false`, no record in `calls` is named `subagent`, and `message.details` is an object whose `calls` is an array containing a record with `name === "subagent"` (codemode's `CodemodeNestedCall`). Only codemode defines `details.calls` as its invocation history; a custom tool's `details` is `unknown` to pi, so clause 2 never reads another tool's `details`.

Any other shape - no `nestedCalls`, `nestedCalls` not an object, `calls` not an array, `details` missing or without an array `calls`, a non-codemode result in clause 2 - returns false and the result is kept. The predicate never throws. A result with no `nestedCalls` is a tool that made no nested calls (pi attaches the record only then), including every codemode script that dispatched nothing.

**Filter.** `isSubagentToolResultMessage` drops its `toolName === "subagent"` test and `isInheritedSubagentToolCallBlock` drops its `b.name === "subagent"` test; both check id-set membership alone, so an inherited `codemode` (or any other tool's) block and its result are stripped as a pair, like a direct dispatch. `stripParentOnlySubagentMessages` keeps its contract: mixed assistant messages lose only the matching blocks, an emptied assistant message is removed, unchanged input returns the same array.

**Ticket-row readings carried as clauses.** Row 2's observable: an inherited result with `complete: false` and no `subagent` record is stripped when `details.calls` names `subagent` and kept when it does not. Row 4: the child-safety paragraph in `doc/orchestration-patterns.md` (line 18) states that an inherited tool call is stripped when its recorded nested calls (`nestedCalls`) include a `subagent` dispatch, with codemode's `details.calls` as the fallback when the record is incomplete, and that the whole call and result go, including unrelated output the script printed.

**Rollout.** On by default for every fork with no setting, env flag, or migration; a user who updates pi-cohort gets the behavior on the next forked dispatch.

Remove:
- the `toolName === "subagent"` check in `isSubagentToolResultMessage`
- the `b.name === "subagent"` check in `isInheritedSubagentToolCallBlock`

Add:
- `resultDispatchedSubagent(message: unknown): boolean` beside the predicates in `src/runs/shared/subagent-prompt-runtime.ts`
- the toolResult branch in `collectSubagentToolCallIds`
- fixtures in `test/unit/subagent-prompt-runtime.test.ts` listed under Tests, using `arguments: { code }` on the assistant block and top-level `nestedCalls` / `details` on the result, matching pi's shipped types
- one sentence in the child-safety paragraph of `doc/orchestration-patterns.md`
- one bullet under the existing `### Fixed` heading of `## [Unreleased]` in `CHANGELOG.md` (no second `### Fixed` heading), ending `(#47)`

No paid or external action is needed for implementation or verification: the unit suite runs offline with fake messages. The loop treats any action not named here as unreachable; adding one requires separate explicit authorization.

## Errors and edge cases

- `nestedCalls` names `subagent` and `complete === false` (argument-size or unfinished case): stripped by clause 1; the fallback is not consulted.
- `complete === false`, no `subagent` record, `details.calls` names `subagent` (past the 256-call cap): stripped by clause 2.
- `complete === false`, no `subagent` record, `details.calls` names no `subagent`: kept.
- A non-codemode tool whose `nestedCalls` names `subagent`: stripped - the rule is generic.
- A non-codemode tool whose `nestedCalls` is `complete: false` with no `subagent` record and whose application-specific `details.calls` happens to name `subagent`: kept - clause 2 is codemode-only.
- A scripted (indirect) toolCall block with no matching result on the branch (interrupted script, result never persisted): block kept, because its id can only enter the set from a result. A dangling direct `subagent` block is still captured by the assistant branch and stripped, as today.
- A result whose `toolCallId` is in the set but whose block sits in an assistant message with other content: only the block and the result go; prose and unrelated blocks stay.
- The child's own codemode dispatch after `session_start`: kept across turns; the set is frozen at capture.
- Malformed metadata (`nestedCalls: "x"`, `details: { calls: 1 }`, `calls: [null]`): kept, no throw.
- Parent prose that summarizes a sibling's report in its own words is ordinary history and stays (unchanged today; outside the ticket).

## Tests

`test/unit/subagent-prompt-runtime.test.ts`, following the fixture style at lines 177-290 (stubbed `pi.on`, captured `session_start` and `context` handlers):

- codemode result with `nestedCalls.calls` naming `subagent` - block and result removed - `strips an inherited codemode call whose nested calls include subagent`
- codemode result with `complete: false`, no `subagent` record, `details.calls` naming `subagent` - removed - `strips an incomplete nested record when codemode details name subagent`
- same incomplete record with `details.calls` not naming `subagent` - kept - `keeps an incomplete nested record whose details name no subagent`
- complete codemode result with no nested `subagent` - kept - `keeps an inherited codemode call with no nested subagent dispatch`
- `nestedCalls` naming `subagent` with `complete: false` - removed - `strips when the subagent record survived an incomplete snapshot`
- non-codemode tool result whose `nestedCalls` names `subagent` - removed - `strips any inherited tool call whose nested calls include subagent`
- non-codemode tool result with `complete: false`, no `subagent` record, and `details.calls` naming `subagent` - kept - `keeps a non-codemode incomplete record whose details name subagent`
- `session_start` branch holding a codemode toolCall and its matching toolResult with a string `toolCallId` and no `nestedCalls` or `details` - both kept, the unchanged `context` handler returns `undefined` - `keeps an inherited codemode call whose result has no nested-call metadata`; the existing unrelated-tool fixture (lines 188-221) calls `stripParentOnlySubagentMessages` with a hand-built id set and a result without `toolCallId`, so it never exercises the capture branch and does not cover this case
- the new result-based fixtures place `nestedCalls` / `details` on the `{ type: "message", message }` toolResult entries returned by `getBranch()`, not only on the `context` event's messages, so the capture branch at `session_start` is what strips them
- child's own codemode dispatch after `session_start` - kept - `keeps the child's own scripted dispatch`
- malformed metadata - kept, no throw - `tolerates malformed nested-call metadata`
- codemode block in a mixed assistant message - block removed, siblings kept - `strips only the scripted dispatch block from a mixed assistant message`
- `doc/orchestration-patterns.md` sentence - none: prose, verified by the conformance read

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/orchestration-patterns.md` child-safety paragraph (communication contract - what a forked child does and does not inherit); `CHANGELOG.md` `## [Unreleased]` `### Fixed` (#47)
- Derived / memory docs invalidated: none (README line 168 and the `defaultContext` rows in `doc/agents-and-chains.md` describe fork as a branched session, which stays true)

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- A substring or parsed match on the script's `code` text (replaced by `details.calls` per the user's decision on row 2).
- `store()` / `load()` persistence: a parent script's `store()` writes land in `codemode-store` custom entries that a child script can `load()` regardless of message filtering (`codemode/tool.js:18-21`). A different, parent-chosen channel, not a transcript leak.
- Extracting unrelated output from a stripped codemode result; the whole call and result go.
- Removing parent prose that paraphrases a sibling's report.
- The still-running script's result at fork time (not yet persisted; the fork branches at the parent leaf captured when dispatch starts).
- Any setting or env flag to turn the rule off.

## Open questions

None.
