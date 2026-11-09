# Recover a rejected scripted structured_output call by tool identity, not pi's wording

**Ticket:** [#53](https://github.com/jjuraszek/pi-cohort/issues/53)
**Goal:** `detectSubagentError` recovers a rejected scripted `structured_output` call when the script's terminal diagnostic names `tools.structured_output`, whatever error class or verb pi prints, while a codemode error whose first diagnostic line lacks that token still fails.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

## Problem

Since 7.6.9 (#48, delivered in #51 at `14ddcee`) the child `structured_output` tool is `model-only`: a codemode script that reads `tools.structured_output` throws inside pi's Proxy `get` trap before any callable runs, the child then calls the tool directly, and `detectSubagentError` in `src/shared/utils.ts` forgives the earlier script error when a later direct capture succeeded. That forgiveness keys on pi's exact text: after the last `Script error:\n` marker the diagnostic must begin `TypeError: tools.structured_output does not exist` (`src/shared/utils.ts:323`). Pi owns that text (installed pi 1.5.0 `dist/bundle/chunks/codemode-worker.js:193-198` builds it as `label + "." + property + " does not exist."`), pi-cohort's peer floor is `>=1.5.0` (`package.json:66`), and users upgrade pi ahead of pi-cohort, so a pi release that rewords the verb or the error class turns every such recovered run into a reported failure with the value already on disk. The real-child test checks only the `tools.structured_output does not exist` substring against the installed pi (`test/integration/structured-output-model-only.test.ts:73`), so it would not catch the mismatch either.

The ticket proposes dropping the diagnostic match entirely and keying recovery on the remaining shape (empty `details.calls`, no truncation warning, a later direct success). Framing: pivoted to a tool-identity match - that shape alone also fits `Script error:\nError: unrelated failure` (today a required failure at `test/integration/detect-error.test.ts:306-318`) and pi's worker-admission failure, which returns `isError` with `calls: []`, no nested call, and a `Script error:\n` marker whose first line is `Script aborted: ...`, `Script timed out: ...`, or `No codemode worker became free ...` (`execute.js:488-502`); forgiving those reverses the boundary #48 chose and `doc/agents-and-chains.md:261` publishes. The reporter note rejected a structural marker because pi records none, but the message already carries one: the `tools.structured_output` token on the first diagnostic line, independent of pi's verb or error class. That token is usually the script's own property-access path, but the match does not require it: pi's worker appends ` Did you mean tools.<name>?` hints to the same first line (`codemode-worker.js:192-194`), and although installed pi 1.5.0 builds those hints only from callable tools, which excludes the model-only `structured_output` (`dist/core/agent-session.js:1176-1180`), a synthetic first line such as `TypeError: tools.output does not exist. Did you mean tools.structured_output?` also recovers under the approved first-line contains-match when the other gates hold. The boundary this spec promises is therefore "first line lacks the token fails", not "every unrelated codemode error fails". Premises checked from source: the literal, marker, empty-calls and truncation gates at `src/shared/utils.ts:314-323`; nested calls recorded only inside callable execution (`execute.js:462`); the `Script error:\n` marker and the `details.calls` shape are pi-owned too (`execute.js:557`, `:444`), so wording independence is partial by nature. Unverified: no pi release prints `tools.structured_output is not available`; the alternate wording is a fixture, not an observed regression.

This spec replaces only the diagnostic-matching sentence of the predecessor `doc/specs/2026-11-08-gh-48-structured-output-model-only.md` (`### Narrow shared recovery`, item 3: "require the first line immediately following it to start with `TypeError: tools.structured_output does not exist` ... Incomplete/truncated diagnostics and unfamiliar error formats fail closed"). The predecessor's other gates stay in force; the predecessor file stays unedited as history and is not a second live contract for the match.

## Acceptance criteria

Ticket #53, Acceptance Criteria, rows verbatim:

- [ ] A child transcript whose codemode script error carries different wording (for example `TypeError: tools.structured_output is not available`) but otherwise matches today's recovered shape (zero nested calls, no truncation warning, a later successful direct `structured_output` result) is detected as recovered by `detectSubagentError` (a test beside the existing case at `test/integration/detect-error.test.ts:228`).
  in-scope
- [ ] A script error with a truncation warning, with recorded nested calls, or without a later successful direct capture still reports the error. Any existing test that expects unfamiliar wording alone to cause failure is updated to expect recovery when the other recovery conditions hold.
  in-scope
- [ ] `detectSubagentError` reports recovery for both `TypeError: tools.structured_output does not exist` and `TypeError: tools.structured_output is not available` when the other recovery conditions hold. Regression fixtures may contain either diagnostic; the real-child integration test (`test/integration/structured-output-model-only.test.ts`) may still assert the installed pi's current wording.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-53-structured-output-recovery-wording
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
scope: AC 1, AC 2, AC 3
design: owns the shared error detector, its integration tests, the chain guide paragraph on rejected scripted submissions, and the changelog. A rejected scripted `structured_output` call whose terminal diagnostic names the tool on its first line recovers after a later direct capture; a codemode error whose first diagnostic line lacks that token still fails.

## Design

1. **Detector change** (`src/shared/utils.ts`). `detectSubagentError` keeps every recovery gate #48 built: the failing result is a `codemode` tool result with `isError`, `details.calls` is an array with zero entries, the joined output contains no `Warning: truncated output`, a later `structured_output` tool result in the scan window is a non-error, and the output contains a `Script error:\n` marker. Remove the final condition, `startsWith("TypeError: tools.structured_output does not exist")` on the text after the last marker. Add in its place: the first line after the last `Script error:\n` marker contains the whole token `tools.structured_output`, where `structured_output` is `STRUCTURED_OUTPUT_TOOL_NAME` (`src/runs/shared/structured-output.ts:11`) and the token is bounded on both sides - no identifier character (`[A-Za-z0-9_$]`) directly before `tools` or directly after the tool name - so `tools.structured_outputs` and `mytools.structured_output` do not match. The first line is the text from the end of the marker through the next `\n` or the end of the joined output (pi's `formatError` puts the thrown message or stack head there and separates later lines with `\n`, `execute.js:322-331`). The match is contains, not anchored: trailing same-line text is permitted (pi 1.5.0 appends ` Available: ...` or ` Did you mean ...?` hints and a ` Check for a member ...` sentence to the same line, `codemode-worker.js:193-197`), and a same-line suggestion that carries the bounded token (`TypeError: tools.output does not exist. Did you mean tools.structured_output?`) qualifies. The error class (`TypeError`, `ReferenceError`, none) and the verb (`does not exist`, `is not available`, anything else) are not inspected. The regex is built once at module scope from the constant, with the constant regex-escaped when interpolated; a tool rename moves the detector with it. Nothing else in the detector, its callers (`src/runs/foreground/attempt-finalization.ts`, `src/runs/background/subagent-runner.ts`), the tool registration, the `exposure: "model-only"` flag, or the child instruction text changes.

2. **Reading of AC row 2's second sentence.** "Unfamiliar wording alone" means a terminal diagnostic whose first line names `tools.structured_output` with a different error class or verb; those existing rows flip to recovery. A row whose first line lacks the bounded token (another tool, no tool, token only on a later line, token not bounded), or whose output lacks the marker, fails because the identity or the marker is absent, not the wording; those rows keep their failure expectation.

3. **Guide contract** (`doc/agents-and-chains.md`, the paragraph beginning "A rejected scripted submission can recover"; line 261 at the time of writing - locate it by that anchor, not the line number). Replace the paragraph's first two sentences - the one naming the literal ("must begin with `TypeError: tools.structured_output does not exist`") and the one ending "or an unfamiliar diagnostic prevents this recovery" - with: "A rejected scripted submission can recover after a later successful direct `structured_output` result: the codemode result must record an empty `details.calls` array and the first line of its last `Script error:` diagnostic must name `tools.structured_output`, with any error class or verb. A `Warning: truncated output` notice, missing or malformed call metadata, nested calls, or a first diagnostic line that lacks that token prevents this recovery." The text from "The shared foreground/background error detector" onward stays unchanged.

4. **Changelog** (`CHANGELOG.md`). Add a `## [Unreleased]` `### Fixed` bullet ending `(#53)` stating that recovery of a rejected scripted `structured_output` call now keys on the tool name in the script's terminal diagnostic rather than pi's exact `TypeError: ... does not exist` text, and that codemode errors whose first diagnostic line lacks that token still fail.

5. **Paid or external actions.** None. Implementation and verification are offline node tests; the only real-child test (`test/integration/structured-output-model-only.test.ts`) is existing, runs under `npm run test:integration` with the installed pi, and is not changed. The loop treats any action not named here as unreachable; adding one needs separate explicit authorization.

## Errors and edge cases

Each case below is a plain "report the error" outcome with the detector's existing error text; no new error message is introduced.

1. First line after the last marker names another tool (`TypeError: tools.read does not exist`) - failure.
2. First line names no tool (`Error: unrelated failure`) - failure.
3. The token appears only on a second or later line of the diagnostic (`Error: boom\nTypeError: tools.structured_output does not exist`) - failure; pi puts the thrown message on the first line, a later mention is a stack.
4. `tools.structured_outputs` or `mytools.structured_output` on the first line - failure; the token is bounded.
5. The phrase printed by the script without a `Script error:\n` marker - failure.
6. Output ends at the marker (empty first line) - failure.
7. First line is `tools.structured_output does not exist` with no error class, or `ReferenceError: tools.structured_output does not exist`, or `Error: TypeError: tools.structured_output does not exist`, or `TypeError: tools.structured_output` cut mid-phrase, or `TypeError: tools.structured_output is not available` - recovery, given the other gates.
8. `Warning: truncated output` anywhere in the output; `details.calls` missing, non-array, or non-empty; no later non-error `structured_output` result in the scan window; a `codemode` result that is not `isError` - failure or no-recovery exactly as today.
9. Pi's worker-admission failure (`execute.js:498`: `isError`, `calls: []`, `Script error:\n` marker present, first line `Script aborted: ...`, `Script timed out: ...`, or `No codemode worker became free ...`) - failure through case 2; the marker is there, the first line lacks the token.
10. Unrelated read/bash errors and capture-write failures before, between, or after the rejection and the capture - failures, as today; the detector continues scanning after skipping the rejection.
11. First line names another member with a same-line suggestion carrying the token (`TypeError: tools.output does not exist. Did you mean tools.structured_output?`, a synthetic fixture in pi's hint shape; installed pi 1.5.0 never suggests the model-only tool) - recovery, given the other gates; the approved first-line contains-match does not distinguish the access path from the hint.

## Tests

All rows live in `test/integration/detect-error.test.ts` beside the existing recovery case at `:228` unless named otherwise.

- AC 1 / edge 7: `TypeError: tools.structured_output is not available` recovers - new row `recovers alternate verb`.
- AC 3 / edge 7: `TypeError: tools.structured_output does not exist` recovers - existing row `script rejection then direct success` (`:254`, unchanged); the existing recovery rows `no optional hints`, `optional hints`, and `last diagnostic qualifies` (`:266-268`) stay recovery.
- AC 2 / edge 7: `ReferenceError: tools.structured_output does not exist` recovers - existing row `unfamiliar exception format` flips to recovery.
- AC 2 / edge 7: `Error: TypeError: tools.structured_output does not exist` on the first line recovers - existing row `phrase not at exception head` flips to recovery.
- AC 2 / edge 7: `TypeError: tools.structured_output` cut mid-phrase recovers - existing row `incomplete diagnostic` flips to recovery.
- Edge 7: `tools.structured_output does not exist` with no error class recovers - new row `recovers without an error class`.
- Edge 1: `tools.read does not exist` fails - existing row `unrelated codemode error` (unchanged).
- Edge 2 / edge 10: `Error: unrelated failure` before, between, and after the capture fails - existing mixed-sequence rows at `:306-318` (unchanged); `${scriptDiagnostic}\nScript error:\nError: boom` fails - existing row `printed phrase before different terminal error` (`:275`, unchanged; the last marker's first line lacks the token).
- Edge 3: token only on a later line fails - existing row `phrase on later diagnostic line` (unchanged).
- Edge 4: `tools.structured_outputs does not exist` fails - new row `bounded token suffix`; `mytools.structured_output does not exist` fails - new row `bounded token prefix`.
- Edge 5: printed phrase without the marker fails - existing row `printed phrase without marker` (`:274`, unchanged); `Script error: TypeError: ...` with a space instead of `\n` fails - existing row `unfamiliar marker format` (`:281`, unchanged; marker absent).
- Edge 6: output ends at the marker fails - existing row `missing exception head` (`:279`, fixture `Script error:\n`, unchanged); no new row.
- Edge 8: no later direct success - existing rows `:257-260` and `:263` (unchanged); truncation warning - existing rows `truncation warning with intact tail` (`:282`) and the `fullOutputPath` pair (`:297-305`) (unchanged); missing/non-array/non-empty `details.calls` - existing metadata rows `:286-293` (unchanged). Only the three rows named above as flipping (`phrase not at exception head`, `incomplete diagnostic`, `unfamiliar exception format`) change expectation; every other existing row keeps its expectation.
- Edge 9: worker-admission failure fails - covered by edge 2's marker-present, no-token rows (`printed phrase before different terminal error`, the `Error: unrelated failure` mixed-sequence rows); no separate fixture, the recovery boundary is the same (marker present, first line without the token).
- Edge 11: `TypeError: tools.output does not exist. Did you mean tools.structured_output?` recovers - new row `recovers same-line suggestion`.
- AC 3, real-child wording assertion stays: `test/integration/structured-output-model-only.test.ts:73` (unchanged).
- Design 3 guide text: none - documentation, verified by the conformance pass against this spec.
- Design 4 changelog bullet: none - documentation, verified by the conformance pass against this spec.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (communication contract - the paragraph beginning "A rejected scripted submission can recover", line 261, names the literal and the unfamiliar-diagnostic prohibition; its first two sentences are rewritten to the token rule per Design 3); `CHANGELOG.md` (`[Unreleased]` `### Fixed` bullet per Design 4)
- Derived / memory docs invalidated: none - `README.md` names neither the literal nor the recovery rule; `doc/specs/2026-11-08-gh-48-structured-output-model-only.md` is a historical record and is not edited

## Out of scope

- Keying recovery on the empty-calls shape alone (the ticket's as-framed proposal) - rejected at the framing question; it forgives unrelated script errors and worker-admission timeouts.
- Matching the token anywhere in the diagnostic rather than on its first line - rejected at approach selection; it forgives a layout no pi release has produced and the `phrase on later diagnostic line` boundary with it.
- Changing the real-child fixture (`test/integration/fixtures/structured-output-model-only/provider.ts`) or its test to a pi-independent wording; AC row 3 permits the installed-pi assertion to stand.
- Any change to tool exposure, capture semantics, termination behavior, the child allowlist, or the pi peer floor.
- Removing the dependence on pi's `Script error:\n` marker or `details.calls` shape; both are pi-owned and both stay as gates.

## Reporter notes (verbatim)

Source: https://github.com/jjuraszek/pi-cohort/issues/53#issuecomment-6728301138

> Reporter note: original framing from the ask, superseded by the repo audit - "replace the literal string match with a structural signal (recorded nestedCalls entry / error code) or centralize the marker next to the tool name constant". Audit: pi 1.5.0's codemode worker throws on property access before any callable runs (bundle/chunks/codemode-worker.js:183-210), nested calls are recorded only inside callable execution (extensions/codemode/execute.js:433-444, 448-462), and the integration test expects `details.calls` to be `[]` - so no nested-call record exists for the rejection and no error code is exposed. A tool-name constant already exists at src/runs/shared/structured-output.ts:11; centralizing the literal beside it would still depend on pi's wording.

Carried as: no nested-call marker or error code is required (none exists); the token match is built from the existing constant at `src/runs/shared/structured-output.ts:11`, and depends on pi naming the accessed property, not on pi's verb.

## Open questions

- None blocking. If a later pi release is observed to put the thrown message on a line other than the first after the marker, the first-line rule in Design 1 is the clause to revisit.
