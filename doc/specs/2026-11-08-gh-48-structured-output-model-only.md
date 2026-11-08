# Register child structured output as model-only and recover rejected script submissions

**Ticket:** [#48](https://github.com/jjuraszek/pi-cohort/issues/48)
**Goal:** A schema-bound child submits structured output only directly; a rejected scripted submission followed by successful direct capture returns a successful parent result without concealing unrelated failures.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop

## Problem

At the original worktree base `b5a9ba2`, `registerSubagentPromptRuntime` in `src/runs/shared/subagent-prompt-runtime.ts` registers `structured_output` without an exposure field. Pi defaults it to `direct`, making it callable from codemode. A script can save the capture and continue because Pi's `toScriptValue` discards the nested result's `terminate` flag. Pi 1.5.0's `ToolExposure` contract defines `model-only` as declared while active but never callable; its callable filter excludes such tools from the script namespace.

The registration fix and real-child fixture already committed on this branch expose a second failure: the script rejects with `tools.structured_output does not exist`, then a direct call saves the value, but the parent reports exit 1. `detectSubagentError` in `src/shared/utils.ts` already recognizes later successful structured-output results and forgives earlier structured-output validation errors. It does not forgive this namespace rejection. Native and external foreground attempts share `src/runs/foreground/attempt-finalization.ts`, which promotes the detected error before reading the capture. Both background paths in `src/runs/background/subagent-runner.ts` also use the detector before reading their captures. Existing detector tests deliberately preserve unrelated read/bash failures and capture-write errors after structured success.

Framing: kept on redraw - retain model-only registration and extend the existing shared detector's recovery rule, without a new caller option or finalization policy. The user authorized expanding this component boundary to preserve the successful parent-result requirement, selected recovery of only the rejected script submission alongside existing validation recovery, selected approach 1, and approved both revised design rounds. Existing implementation commits remain; the prior execution ledger is removed for redraw. No further implementation runs before the revised full approval gate.

Corrected premises:

- Capture does not guarantee run termination. Pi's `shouldTerminateToolBatch` requires every finalized result to carry `terminate: true`; steering and follow-up messages can continue the run. Preserve direct-call semantics, not an unconditional termination promise.
- The Pi floor is already `>=1.5.0` at `b5a9ba2`: `package.json`'s peer range is `>=1.5.0`, covered by `test/unit/package-manifest.test.ts`; README says `Requires Pi >=1.5.0.`, checked by reading it. AC 4 needs no edit. Conditional exposure for a retained 1.3.0 floor is therefore unnecessary.
- Pi's codemode result separates its `Script failed` header from the diagnostic output. `dist/extensions/codemode/execute.js` appends `Script error:\n` plus `formatError(...)`, and records nested calls in `details.calls`. Inspect diagnostic text, not just the first text block used by generic error reporting. Optional available-tool/suggestion hints are not contractual.

Predecessor: none. This redraw replaces this spec in place, not a separate predecessor spec. The real-child fixture supplies the local reproduction; no external dependency is missing.

## Acceptance criteria

Ticket #48, `## Acceptance Criteria`, rows verbatim:

- [ ] The child-side `structured_output` tool is registered with `exposure: "model-only"` (unit test over the registration object).
  in-scope
- [ ] In a child run with an output schema on pi >= 1.5.0, a script calling `tools.structured_output(...)` fails because the tool is not in the script's `tools` namespace, while a direct `structured_output` call from the same child saves the value (child-run test on the local pi install).
  in-scope
- [ ] A direct `structured_output` call still saves the value and its result carries `terminate: true` (existing tests unchanged).
  in-scope
- [ ] `package.json`'s pi peer range and the README's pi floor both read `>= 1.5.0`.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-48-structured-output-model-only
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
scope: AC 1, AC 2, AC 3, AC 4
design: owns the runtime registration, shared error detector, registration and detector tests, real-child integration test and persona/provider fixtures, structured-output guide, and changelog listed in Design. Script submission is unavailable; a later direct capture recovers only the narrow rejection and returns the structured value successfully to the caller.

## Design

Remove: no production code. Remove the prior execution ledger for this authorized redraw; preserve existing implementation commits.

Add:

- Retain `exposure: "model-only"` on the `structured_output` registration in `src/runs/shared/subagent-prompt-runtime.ts`, the narrowed registration type's `exposure?: ToolExposure` member, and the `ToolExposure` type import from `@earendil-works/pi-coding-agent`.
- Retain `registered structured_output tool is declared model-only` and the registration mock's exposure type in `test/unit/subagent-prompt-runtime.test.ts`.
- Retain `test/integration/structured-output-model-only.test.ts` and its fixtures `test/integration/fixtures/structured-output-model-only/worker.md` and `test/integration/fixtures/structured-output-model-only/provider.ts`. Keep the flat source layout and existing harness, which copies the fixtures into the temporary profile's `.pi/agents` and `.pi/extensions`, respectively.
- Extend the existing recovery condition inside `detectSubagentError` in `src/shared/utils.ts`. Keep its signature, reverse-scan boundary, existing validation recovery, and generic error-reporting behavior. Add no caller option, shared abstraction, public type, setting, or finalization branch.
- Add positive and negative recovery cases in `test/integration/detect-error.test.ts`.
- Amend the structured-output paragraph in `doc/agents-and-chains.md` and the existing `[Unreleased]` change entry in `CHANGELOG.md` to cover direct-only submission and narrow recovery.

### Registration and child proof

The child allowlist continues to append `structured_output` in `src/runs/shared/pi-args.ts`. Pi declares this active model-only tool but excludes it from its callable set. `tools.structured_output(...)` therefore throws inside codemode before a structured-output tool event or capture write. The runtime's `attempted` flag remains false; its existing one-time settlement re-ask still applies if the child settles without submitting directly. A direct call validates, writes `{ status: "success", value }` with mode `0o600`, and returns `terminate: true`.

Keep the description unchanged: "Submit the required final structured output for this subagent step. This terminates the step." Keep the runtime listeners, re-ask, validation, and allowlist responsibilities unchanged. Under `codemode.mode: "only"`, Pi hides callable direct declarations, not model-only declarations, so direct submission remains available.

The integration harness uses the existing real-child pattern: isolated HOME/profile, local package bin resolution (including `PI_TEST_PI_BIN_DIR`), a persona with `tools: codemode`, and a scripted-provider extension. Dispatch through the registered subagent tool as `chain: [{ agent: <fixture persona>, task: <fixture task>, outputSchema: <schema> }]`; do not add `tools` or `outputSchema` to single-mode dispatch. The provider first emits a codemode script calling `tools.structured_output({ value })`, then a direct submission of the same schema-valid value after observing `does not exist`. Unexpected first-turn output yields `FIXTURE_UNEXPECTED` rather than silently taking the successful path.

Read the child's retained `sessionFile`: require an errored codemode result containing the namespace rejection and zero nested calls, followed by exactly one direct structured-output call and a successful result. Require its capture file to contain the expected success envelope, the child exit code to be 0, the parent result not to be an error, and returned structured output to equal the submitted value. Parent-visible messages are compacted away; exit 0 and value equality alone cannot distinguish a broken exposure fix. The session sequence proves that the direct call, not the script, wrote the capture.

### Narrow shared recovery

Use the existing reverse scan's `hasLaterStructuredOutputSuccess` state. A mere assistant tool-call request is not success; the later non-error structured-output tool result is the existing success signal. The detector never declares immediate success when it skips a recovered error: continue scanning so another failure remains visible.

Skip an earlier errored codemode result only when all these facts hold:

1. A later successful direct structured-output result exists within the detector's existing scan window.
2. The result belongs to `codemode`, and `details.calls` is present as an empty array. Missing, malformed, or nonempty call metadata does not qualify.
3. No text block contains `Warning: truncated output`; reject recovery on that warning even if the diagnostic tail is intact, irrespective of `details.fullOutputPath`. Otherwise join all text blocks with newlines, find the last `Script error:\n` marker, and require the first line immediately following it to start with `TypeError: tools.structured_output does not exist`. A missing marker or nonmatching exception head fails closed. Match that terminal diagnostic, not an arbitrary phrase in script-printed output or the first `Script failed` text block. Optional suggestions and available-tool lists are not part of the match. Incomplete/truncated diagnostics and unfamiliar error formats fail closed.

Repeated qualifying rejections before that success may each be skipped. Existing recovery of structured-output validation errors stays intact. The policy is message-driven, shared by foreground and background callers without caller edits. Finalizers retain process, interruption, blocked-result, completion-guard, and capture-reading responsibilities; this detector change does not bypass those checks.

### Action authorization

Paid or external implementation/verification actions: none. The runner is the local integration harness, using its schema, persona, scripted-provider fixture, and temporary session/capture paths; its subprocesses make no model-service calls or network requests. Local test repetitions and session-file reads are permitted. Across seed, row attempts, repairs, and finish, the bound for paid/external implementation or verification actions is zero. The loop treats an unnamed action as unreachable; adding one requires separate explicit authorization.

## Errors and edge cases

- A rejected script submission without later direct success remains a failure. A success before the rejection, or an assistant tool call without a successful result, does not recover it.
- An unrelated codemode error, the same phrase on another tool's error, or a phrase only printed by a script remains a failure. Missing/nonempty call metadata, truncated diagnostics, and unfamiliar formats remain failures.
- A script that performed nested work before rejecting does not meet the empty-call requirement, even if a later capture succeeds.
- Other read/bash errors and capture-write failures remain visible under existing detector rules. Success is not proof that unrelated work succeeded; errors after submission are not forgiven.
- Preserve the existing last-assistant-text scan boundary. This change does not reinterpret errors outside that window or tighten unrelated recovery rules.
- Missing/corrupt/schema-invalid captures remain failures through the existing reader. Nonzero process exit, cancellation, and other finalization guards retain their current precedence.
- Direct validation failures remain recoverable by a later successful direct submission as before. Direct capture permissions and `terminate: true` stay unchanged.
- The allowlist makes model-only structured output active and declared, never script-callable, under both normal codemode and codemode-only mode.
- A batch terminates only when every finalized result carries `terminate: true`; no stronger guarantee follows from capture. Pi versions below 1.5.0 remain unsupported.

## Tests

In `test/integration/detect-error.test.ts`, extend the existing `toolResult` helper to accept `details`. Use one canonical qualifying codemode result with a `Script failed` header text block, a separate diagnostic output block, and empty nested-call metadata. Its relevant fields are:

```json
{
  "toolName": "codemode",
  "isError": true,
  "content": [
    { "type": "text", "text": "Script failed\n" },
    { "type": "text", "text": "Script error:\nTypeError: tools.structured_output does not exist.\n\nNo tool calls were made." }
  ],
  "details": { "calls": [] }
}
```

Derive positive and negative detector cases from this fixture, including mixed sequences. Pair qualifying cases with a later successful direct structured-output result within the existing scan window. For the truncation negative case, include `Warning: truncated output` in a text block while retaining the intact diagnostic tail, `details.calls: []`, and later direct success; recovery must fail even without `details.fullOutputPath`.

- registration carries `exposure: "model-only"` (AC 1) - `registered structured_output tool is declared model-only` in `test/unit/subagent-prompt-runtime.test.ts`
- scripted submission rejects, makes zero nested calls, and precedes the only direct capture; parent receives the expected value with exit 0 (AC 2) - `test/integration/structured-output-model-only.test.ts`, including retained session and capture-envelope assertions
- direct capture saves the value and returns `terminate: true` (AC 3) - existing `registered structured_output tool accepts valid schema output and writes the capture file` in `test/unit/subagent-prompt-runtime.test.ts`, unchanged
- peer range remains `>=1.5.0` (AC 4) - existing `test/unit/package-manifest.test.ts`
- README says `Requires Pi >=1.5.0.` (AC 4) - none automated: read-only README check; no edit
- exact rejection then success, including repeated qualifying rejections, recovers - new cases in `test/integration/detect-error.test.ts`
- absent success, reversed ordering, and an assistant call without a successful result do not recover - new cases in `test/integration/detect-error.test.ts`
- unrelated codemode errors, another tool's matching error, and matching script-printed text do not recover - new cases in `test/integration/detect-error.test.ts`
- missing/malformed/nonempty call metadata, truncated diagnostics (including the warning with an otherwise qualifying intact tail, empty calls, and later direct success), and unfamiliar formats do not recover - new cases in `test/integration/detect-error.test.ts`
- unrelated read/bash failures, capture-write failures, and errors after submission remain visible even beside a recoverable rejection - existing cases plus mixed-sequence cases in `test/integration/detect-error.test.ts`
- validation-error recovery and last-assistant-text scan boundaries stay unchanged - existing cases in `test/integration/detect-error.test.ts`
- missing/invalid captures remain rejected - existing structured-output reader tests in `test/unit/structured-output.test.ts`; no reader change
- re-ask still applies to an unattempted submission - existing re-ask cases in `test/unit/subagent-prompt-runtime.test.ts`; the real-child session's zero nested calls shows the rejected script did not invoke structured output
- model-only remains declared under codemode-only mode and allowlist activation - none: Pi behavior, `dist/extensions/codemode/tool.js` hidden-declaration filter and `dist/core/agent-session.js` exposure filters; no local branch changes
- process/cancellation/completion guards and batch termination retain their existing behavior - none new: no caller or guard edits; Pi's batch rule is outside this change

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (structured-output communication contract: call directly; only the narrow rejected-script case recovers after successful direct submission); `CHANGELOG.md` - `[Unreleased]`
- Derived / memory docs invalidated: none

Apply `reference/documentation-impact.md` from pi-gauntlet's brainstorming skill. Amend the canonical guide rather than add documentation. README Installation is excluded because its floor is already correct; `doc/programmatic-api.md` and `doc/orchestration-patterns.md` are excluded because their described contracts do not change.

## Out of scope

- Unconditional child-run termination, or rewording the tool description to demand a lone direct call.
- Forgiving arbitrary codemode/tool errors after capture, broadening the detector's scan boundary, or overriding capture validation/process/completion failures.
- Caller-controlled recovery options, new finalization paths, or edits to foreground/background finalizers.
- A nested-call blocking handler as a substitute for Pi exposure.
- Conditional exposure on older Pi; changes to the floor, package manifest, or README.
- Companion #47's fork-context work.

## Reporter notes (verbatim)

Reporter note (displaced detail, verbatim):

Mechanism inventory from the ask: src/runs/shared/subagent-prompt-runtime.ts ~line 225-240 returns `terminate: true`; STRUCTURED_OUTPUT_TOOL_NAME in src/runs/shared/structured-output.ts; the nested result is converted to a script value (dist/extensions/codemode/execute.js toScriptValue); the tool_execution_end handler tracks `attempted`; the tool is registered without `exposure`, so codemode lists it as callable.

Reporter's proposed approach: register structured_output with exposure: "model-only" so it is never callable from a script (pi >= 1.5.0 supports the field; pi-gauntlet did the same for its trackers in v8.4.1). Alternative considered: set the field only when the running pi supports it, keeping the 1.3.0 floor.

The ask describes this as ticket 2 of 2 from a pi 1.5.0 codemode compatibility review of pi-cohort; the companion is the fork-context ticket linked in Context.

Audit corrections folded into the body: "a captured value always ends the child turn" was contradicted - pi ends the turn only when every finalized call in the batch has terminate: true, and steering messages can continue the run (pi-agent-core agent-loop.js:160-200, 471-472); pi-cohort declares pi >=1.3.0 (package.json:64-69; README.md:34-36) while `exposure` is a 1.5.0 field.

Removed AC (roast over-spec cut): "`CHANGELOG.md` `## Unreleased` carries the entry."

## Open questions

none
