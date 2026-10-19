# Re-ask a child once when it ends without calling structured_output

**Goal:** Give a child dispatched with `outputSchema` exactly one in-process follow-up after a normal prose-only completion; a valid follow-up succeeds without re-dispatching the child.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#25
**Worktree:** `.worktrees/gh-25-structured-output-reask`

## Problem

The ticket reports 2 of 16 implementer children finishing their work and report without the required `structured_output` call. The parent fails the step and pi-gauntlet re-dispatches work. This observation comes from the ticket, not a reproduced miss-rate measurement. The existing final-action instruction did not prevent these misses.

Pi's `agent_before_settle` boundary supports appending a custom message and requesting another provider call within the same `session.prompt()`. The child extension already owns the structured-output tool. Native runner shutdown must wait for settlement so it does not kill this continuation after the first prose stop.

Framing: kept on redraw - preserve every acceptance criterion and distinguish failed attempts from successful output in the capture contract. Recording rejected arguments as `args.value ?? null` is unsafe: a rejected call with `{}` becomes a schema-valid capture for `{ "type": "null" }`. The user selected one success/error envelope in the existing capture file, unwrapped by the shared reader. Public dispatch schemas and downstream values remain unchanged. No predecessor spec is superseded; this redraw replaces the earlier design in this file.

## Acceptance criteria

Ticket jjuraszek/pi-cohort#25, Acceptance criteria, rows verbatim:

- [ ] Given a chain step with `outputSchema` and a child whose turn completes normally without a `structured_output` call, pi-cohort sends that child one follow-up turn naming the schema; a valid `structured_output` call in that turn makes the child succeed with the value available to `stopOn` and `{outputs.<as>}` as if it had been called on the first turn.
  in-scope
- [ ] A child that still makes no call after the one follow-up fails with the existing "Missing structured_output call" error, and a follow-up call that fails schema validation fails with the existing validation error; neither case sends another turn.
  in-scope
- [ ] A child whose first turn ended by cancellation, timeout, provider failure, or an exhausted limit is not re-asked and fails as it does today.
  in-scope
- [ ] A `structured_output` value that fails schema validation on the first turn is not re-asked for; it fails as today.
  in-scope
- [ ] `doc/agents-and-chains.md` states the one-follow-up behavior next to its `outputSchema` description.
  in-scope

The mechanism applies to single, parallel, and chain dispatches carrying `outputSchema`. Invalid first-turn calls include Pi argument rejection before `execute` runs. A model may correct an invalid call during its existing turn; settling after an uncorrected invalid call does not trigger the missing-call follow-up.

## Design

### Ownership and configuration

`src/runs/shared/subagent-prompt-runtime.ts` owns tool registration and the re-ask. `src/runs/shared/structured-output.ts` owns decoding the capture and returning `{ value?, error? }` to existing callers. The two native runners change final-drain timing and clean-completion classification, and parent error detection narrowly recognizes corrected structured-output validation failures. The mock child follows the revised capture contract. Add no setting, environment variable, agent field, dispatch field, extra process, or separate error file. `outputSchema` remains the only switch.

### Capture contract

Use the existing capture path for exactly one of these JSON envelopes:

```json
{"status":"success","value":null}
```

```json
{"status":"error","message":"validation diagnostic"}
```

A successful `structured_output.execute` validates its `value` against the configured schema before writing a success envelope with file mode `0600`. A later successful correction overwrites an error envelope. The tool retains `terminate: true` and its existing tool-visible validation behavior.

Record only schema or parameter-validation rejection from a structured-output `tool_execution_end` error event, including Pi rejection before `execute`. Do not persist truncation, abort, or other non-validation tool failures as validation envelopes; preserve their existing failure behavior. Store a nonempty inner validation diagnostic, never raw failed arguments or a substitute value. Remove received-argument dumps and any existing outer `Structured output validation failed:` prefix; if safe extraction is unavailable, use the fixed diagnostic `Invalid structured_output arguments`. Every capture write, including best-effort error recording, uses file mode `0600`. Do not overwrite an existing successful capture with a later failure. Error recording is best-effort and must not throw; no directory creation or new persistence channel is introduced. Remove raw-argument bookkeeping when no longer needed by this design.

The shared `readStructuredOutput` reads the envelope, distinguishes success from failure, and returns only the unwrapped success value after validating it against the requested schema. An error envelope returns `Structured output validation failed: <message>` with exactly one outer prefix, independently of whether any value would satisfy the schema. Missing files retain the existing `Missing structured_output call` error. Malformed JSON, non-object envelopes, unknown statuses, success without an own `value` property, and error without a nonempty string message fail closed with a structured-output validation error. `null` is a legitimate success value when the schema allows it. A user value shaped like an envelope remains nested under `value` and is returned intact; unwrap only once.

Use the envelope consistently across real and mock child writers and direct capture fixtures. Do not accept legacy bare values as success: the parent and its injected child extension ship together, and interpreting both formats would reintroduce ambiguity. No changes to the three reader call sites, `stopOn`, or output-reference resolution are needed. Gauntlet continues receiving values such as `{"status":"DONE"}`, never the internal envelope.

Parent error detection (`detectSubagentError`) must narrowly supersede an earlier structured-output validation failure when a later valid `structured_output` call corrects it, even without intervening assistant prose. Both native finalizers must allow that corrected success to reach capture reading; unrelated failures remain failures. This does not change the reader call sites or downstream handling.

### One-time re-ask

Register `agent_before_settle` only when both existing schema and capture environment variables are set. Reuse the extension's `onRuntimeEvent` accessor. Keep a process-local `reasked` flag. Return nothing when the flag is set, the outcome is not `completed`, the last assistant message's stop reason is `length`, or the capture exists. Track attempted calls locally as needed so a failed capture write does not turn a known failed attempt into a missing-call re-ask. A failed write remains failure, never success.

Otherwise set the flag and return `{ entries: [...event.entries, reaskMessage(schema)], continue: true }`. Preserve all prior drafts and do not mutate the incoming entries. The custom draft has type `custom_message`, customType `pi-cohort:structured-output-reask`, display `true`, and this content followed by the schema JSON indented with two spaces:

```
You finished without calling `structured_output`. Call `structured_output` now with a `value` matching this schema, and send no other text:
```

Do not guard on the pre-draft `context.canContinue`: Pi's preview is false after an assistant prose stop and is recomputed after the custom message is committed. Scan backward for the last assistant message in `context.contextMessages` to check `stopReason`; token exhaustion can have outcome `completed` with stop reason `length`.

A second miss ends without another continuation. A failed follow-up records failure and gets no third request; a correction during the same turn can succeed. Runner retries and model fallback start a new child process and therefore a fresh flag. This feature does not add such retries.

### Final drain

In `src/runs/foreground/execution.ts` and `src/runs/background/subagent-runner.ts`, structured runs continue recording a clean terminal assistant stop but do not start final drain on that prose `message_end`. Instead, start final drain when the child stream reports `agent_settled`. This event occurs after any continuation. For structured runs, non-aborted settlement with no assistant error counts as clean completion for drain cleanup, including first-turn tool-only success with `terminate: true`; cancellation and provider-error failures remain failures. Retain the existing grace and hard-kill intervals. While awaiting structured settlement, preserve a bounded, activity-aware wait using the existing silence ceiling even after a prose stop closes the turn. Continued child activity refreshes that wait; if settlement never arrives and the silence ceiling expires, enter the existing drain. An ordinary structured prose stop alone must not start final drain. Unstructured runs retain their current prose-stop shutdown trigger. External backends retain their lifecycle ownership.

### Data flow and limits

The model stops in prose without an attempt; the child appends the re-ask; Pi makes one more provider request in the same session; a valid tool call writes a success envelope; settlement occurs; the shared reader validates and unwraps the capture. Existing call sites expose the value to downstream consumers. Cost accounting and limits remain the child's existing accounting and limits. Aborted/error outcomes and token exhaustion never trigger recovery. Parent cancellation or timeout kills retain their existing failure behavior.

### Peer floor and report behavior

Require `@earendil-works/pi-coding-agent >=1.3.0` in peers and `^1.3.0` for the four existing `@earendil-works/*` development dependencies. Refresh `package-lock.json` to the 1.3.0 packages and update manifest assertions. Reconcile README's existing execution-backend Pi >=0.85.0 sentence with the package-wide >=1.3.0 floor by raising that sentence to >=1.3.0. No runtime version check. Hosts outside the peer range are unsupported; make no promise about whether individual older hosts emit the boundary.

Keep acceptance-report-before-structured-output ordering, `completionGuard`, cost aggregation, and `getFinalOutput` unchanged. The re-ask requests no prose. If the model nevertheless adds prose, the last nonempty assistant text may replace the earlier report in `output:`; the user accepted this edge. Document it in one sentence.

## Errors and edge cases

- Missing either schema or capture environment variable registers no structured-output recovery listeners.
- Error-event recording and settlement handlers do not throw on capture I/O failures. Successful tool writes retain their existing failure behavior.
- A rejected `{}` call with a null schema is failure; a valid `{ "value": null }` call is success.
- A later valid call replaces a prior failure. A later error must not erase an existing success.
- Malformed captures never become values. No arbitrary fallback value can convert failed execution to success.
- Session events already expose the custom re-ask; add no parent-visible marker or separate report field.

## Tests

Extend `test/unit/subagent-prompt-runtime.test.ts` with temporary schema/capture paths and event-handler mocks. Cover the normal prose miss with `canContinue: false`, preserved nonempty drafts, exact custom message and schema, one continuation per process, second miss, existing capture, aborted/error outcomes, length stop with later non-assistant entries, and absent environment variables.

Cover Pi argument rejection before execute and execute-time rejection, failure-envelope diagnostics, invalid-then-valid correction, preservation of success after later error, invalid follow-up then prose, and nonthrowing failed-record writes without re-asking a known attempted call. Assert exact reader error messages with one validation prefix and absence of rejected argument dumps for both Pi parameter rejection and execute-time rejection, including the fixed safe-extraction fallback. Cover a length-truncated tool call with no recovery and unchanged exhausted-limit failure behavior, not a validation envelope. Specifically distinguish rejected `{}` from valid `{ "value": null }` under a null schema.

Add shared-reader tests using existing test conventions: valid null, an envelope-shaped user value returned intact, valid error envelope, malformed JSON, non-object envelope, unknown status, success missing value, invalid error message, and success whose value violates the requested schema. Exercise the rejected-empty-arguments/null-schema case through the real writer and shared reader so it cannot regress behind separately mocked contracts.

Update `test/support/mock-pi.ts`, `test/support/mock-pi-script.mjs`, and `test/unit/mock-pi.test.ts` with `steps[].structuredOutput` for success values (including null) and `steps[].structuredOutputError: string` for error diagnostics. These step-level fields write envelopes after the step delay and before its JSONL events, with no synthetic tool events. Preserve legacy top-level mock response behavior and its synthetic tool events, but encode its captures using envelopes. Failed-capture fixtures must not pretend a tool error is successful. Fixtures explicitly include `{"type":"agent_settled","aborted":false}` in step `jsonl`; do not automatically emit settlement.

In both `test/integration/single-execution.test.ts` and `test/integration/async-execution.test.ts`, emit a prose `message_end` first, wait 1500 ms, write the capture envelope, then explicitly emit `agent_settled` while keeping the child alive. Assert no early SIGTERM, successful unwrapped value, and no forcing-termination output. Cover first-turn tool-only success that stays alive after settlement: existing drain cleans it up with exit zero, the unwrapped value, and no forcing-termination error. Cover missing settlement reaching the bounded silence backstop and a valid delayed continuation surviving the wait. Preserve cancellation/provider-error failures and existing unstructured keep-alive cleanup tests.

In both native finalization paths, cover invalid-then-valid correction with actual failed and successful structured-output tool-result messages and no intervening assistant text. Assert successful unwrapped output while unrelated tool failures are not suppressed.

Exercise invalid-call-then-prose and settlement through the foreground integration path: report the validation failure, not a missing-call error or false success. Preserve valid/missing/invalid chain coverage in `test/integration/chain-execution.test.ts`, including value availability to `stopOn` and output references without envelope leakage. Update direct capture fixtures to the internal format. `test/unit/package-manifest.test.ts` asserts peer/development ranges and lock resolutions.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (one-time recovery, suppressed cases, and the accepted report edge next to `outputSchema`, a communication contract); `README.md` (Pi >=1.3.0 install requirement, including reconciliation of the existing execution-backend >=0.85.0 sentence); `CHANGELOG.md` (Unreleased Added recovery and Changed Pi floor entries, both referencing #25)
- Derived / memory docs invalidated: none

Apply `reference/documentation-impact.md`. Keep product docs focused on observable behavior; the internal envelope requires no new user guide. No pi-gauntlet code or documentation change is required because its dispatch and result contracts remain unchanged.

## Out of scope

- Additional processes, retry settings, opt-out fields, separate error files, and runtime version checks.
- Changes to the three reader call sites, output-reference resolution, `stopOn`, `completionGuard`, cost aggregation, or `getFinalOutput`.
- Lifecycle changes beyond structured-run settlement-triggered drain, clean-completion classification, and bounded activity-aware settlement wait; parent error-detection changes beyond recognizing corrected structured-output validation failures.
- pi-gauntlet implementation changes or a sibling minimum-version bump.
- Retrying failures other than a missing call.
