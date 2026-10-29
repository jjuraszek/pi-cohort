# External child turn-open Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Keep an external async child's replayed tool-call turn open so ordinary idle silence does not falsely mark it as needing attention.

**Architecture:** Add the missing turn-open event at the external replay adapter, leaving lifecycle reduction and runner publication unchanged. Exercise the adapter through its existing fake execution owner, then compose captured events with the shared reducer using the runner's payload interpretation and activity timestamps.

**Tech Stack:** TypeScript, Node's built-in test runner with type stripping, existing fake ExternalExecution owner.

**Spec:** `doc/specs/2026-10-29-gh-37-external-child-turn-open.md`

**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all`

**Ticket:** `#37`

---

## Files

External replay:
- Modify: `src/runs/background/external-attempt.ts` - one assistant-branch emit.
- Modify: `test/unit/background-external-attempt.test.ts` - sequence assertions and adapter-to-lifecycle composition.

Release documentation:
- Modify: `CHANGELOG.md` - introduce the unreleased fix section.

Create: none. Delete: none.

## Recon and verification conventions

- `src/runs/background/external-attempt.ts:118-139` contains the private synthesizer; `:159-176` forwards the optional session callback to the owner. `SynthesizedChildEvent.type` at `:29-34` is already `type?: string`. No export or type declaration change is needed.
- `test/unit/background-external-attempt.test.ts:21-79` supplies `makeSurface`, `makeOwner`, `baseAttemptResult`, and `makeInput`. The assistant-sequence and tool-result cases are at `:347-398`; keep the tool-result assertion intact.
- `src/runs/shared/subagent-control.ts:14-23` defines defaults; `:87-112` defines `TurnLifecycleState` and `applyChildEventToLifecycle`; `:115-133` defines `deriveActivityState`. These are test imports, not files to modify.
- `src/runs/background/subagent-runner.ts:1682-1694` derives `hasToolCall` from the message payload and assigns `step.lastActivityAt = now`. `:1554-1590,1699-1765` owns calm-notice publication and sticky attention state. Read these seams without editing them.
- `package.json:40-46` supplies the full verification entrypoint: shared AGENTS-core consistency, unit tests, and integration tests. It bundles no lint or format checks. Neither package scripts, repository configuration, CONTRIBUTING, nor the overrides define scoped or repo-wide lint/format commands; use manual style review, not an invented formatter. Preserve tab indentation, semicolons, and surrounding TypeScript layout. Markdown has no configured formatter.
- The overrides have no Happy path table or deployment topology. One concern, one plan, no deployment-driven split. No live cmux or spawn-timing proof is claimed.

## Baseline provenance

BASE `946f919`. Initial inventory: `?? doc/plans/2026-10-29-gh-37-external-child-turn-open.md` only. Admitted exactly that dispatched plan path; the dispatched spec path was clean. Task 1's unchanged command executed with exit 0, 20 tests passed, 0 failed. Post-run HEAD remained `946f919` and the inventory was identical; no generated artifacts or tracked-source changes appeared. Task 2 has no executable tests.

## Wave 1 - External replay fix and regression coverage

### Task 1: Open assistant replay turns and prove lifecycle composition

**TDD scenario:** Modifying tested code - run existing tests first, add failing adapter and composition assertions, then make the one-event fix.

**Spec:** doc/specs/2026-10-29-gh-37-external-child-turn-open.md § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L31-L32, § "Design" L38-L38, § "Design" L40-L40, § "Design" L42-L42, § "Design" L44-L44, § "Design" L48-L48, § "Design" L50-L51, § "Errors and edge cases" L55-L55, § "Errors and edge cases" L56-L56, § "Errors and edge cases" L57-L57, § "Errors and edge cases" L58-L58, § "Errors and edge cases" L59-L59, § "Errors and edge cases" L60-L60, § "Tests" L64-L64, § "Tests" L65-L65, § "Tests" L66-L66, § "Tests" L67-L67, § "Tests" L68-L68, § "Tests" L69-L69, § "Tests" L70-L70, § "Tests" L71-L71, § "Tests" L72-L74, § "Tests" L76-L76, § "Out of scope" L88-L88, § "Out of scope" L89-L89, § "Out of scope" L90-L90, § "Out of scope" L92-L92

**Files:**
- Modify: `src/runs/background/external-attempt.ts:118-139`
- Modify: `test/unit/background-external-attempt.test.ts:1-398`
- Test: `test/unit/background-external-attempt.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts`
- baseline: 946f919 pass
- via: `runExternalBackgroundAttempt`, private `synthesizeChildEvents` through `request.onNewSessionMessage`, `applyChildEventToLifecycle`, `deriveActivityState`

Decision: capture the real callback and keep complete synthesized events, including `message`, instead of exporting the synthesizer or creating handwritten lifecycle events - the adapter's optional callback boundary at `external-attempt.ts:159-176` and the runner at `subagent-runner.ts:1682-1694` settle this contract. Derive `hasToolCall` inline exactly as the runner does, using only a test-local cast to expose the unknown payload's content. Reuse the file's fake `ExternalExecution` owner.

Decision: keep publication, defaults, native behavior, foreground behavior, and attention recovery unchanged - `subagent-control.ts:14-23,92-133` and `subagent-runner.ts:1554-1590,1699-1765` already implement the intended contract. `updateRunnerActivityState` routes the calm result through `maybeEmitActiveLongRunning`; its time trigger remains 240000 ms, not 60000 ms. The lifecycle state is `{ turnOpen, lastProductiveSignalAt }`. The test mirrors `step.lastActivityAt = now` at `subagent-runner.ts:1693`, retaining the distinction between activity and productive signals.

`SynthesizedChildEvent.type` at `external-attempt.ts:30` and the runner's `ChildEvent.type` already permit the event name. Do not introduce `turn_*` events. Keep `inFlightSilenceKillMs` foreground-only as documented in `doc/programmatic-api.md`. The approved spec records that `../pi-gauntlet` passes the `control` block on `subagent()` (its `scripts/brainstorming-contract.test.mjs:265`) and consumes no child event types. Leave it and the diagnostic "Likely wedged in a tool call" unchanged. Other runner consumers key on `tool_execution_*`, `tool_result_end`, and `message_end`; the new start event changes lifecycle/activity only.

- [ ] **Step 1: Run the existing adapter file**

  Run: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts`

  Expected: existing cases pass before changing their expectations. The header verification also includes the unit suite requested by the spec, equivalent to `env -u PI_CODING_AGENT_DIR npm run test:unit`; execution here remains scoped to this file.

- [ ] **Step 2: Extend the sequence assertions**

  In the existing "synthesizes tool_execution_start + message_end from assistant messages via onChildEvent" case, prepend `{ type: "message_start", toolName: undefined }` to the expected projected event array. Keep its fake owner and callback capture. Its resulting sequence is `message_start, tool_execution_start, message_end`.

  Add a neighboring final-answer case using `makeOwner`, `makeInput`, and a captured `request.onNewSessionMessage`. Assert the callback exists rather than silently skipping it. Bind `finalMessage` to `{ role: "assistant", content: [{ type: "text", text: "done" }] }`, forward it, and record full events. Expect exactly `[{ type: "message_start" }, { type: "message_end", message: finalMessage }]`, proving `message_start, message_end` and payload preservation.

  Add a several-tool-call case with bash and read tool calls: expect one `message_start`, two `tool_execution_start` events in input order with original names/arguments, and one `message_end` carrying the original assistant message. Leave the existing `toolResult` expectation of `tool_execution_end, tool_result_end` unchanged.

- [ ] **Step 3: Add real adapter-to-reducer composition coverage**

  Import `applyChildEventToLifecycle`, `deriveActivityState`, `resolveControlConfig`, and type `TurnLifecycleState` from `../../src/runs/shared/subagent-control.ts`. Add `describe("external replay composition")` after the existing describe. Use this complete test body inside it; `makeOwner`, `makeInput`, `baseAttemptResult`, and `OnSynthesizedChildEvent` already exist in the file:

  ```typescript
  it("keeps replayed tool turns calm until the ceiling and closes the final answer", async () => {
  	const events: Array<Parameters<OnSynthesizedChildEvent>[0]> = [];
  	let onNewSessionMessage: ExternalAttemptRequest["onNewSessionMessage"];
  	const { owner } = makeOwner((request) => {
  		onNewSessionMessage = request.onNewSessionMessage;
  		return baseAttemptResult();
  	});
  	await runExternalBackgroundAttempt(makeInput({
  		owner,
  		onChildEvent: (event) => events.push(event),
  	}));
  	assert.ok(onNewSessionMessage);
  	const config = resolveControlConfig();
  	const startedAt = 1_000;
  	let lastActivityAt = startedAt;
  	let lifecycle: TurnLifecycleState = {};
  	let reducedCount = 0;
  	const reduceCapturedEvents = () => {
  		for (const event of events.slice(reducedCount)) {
  			const now = lastActivityAt + 100;
  			const message = event.message as { content?: unknown[] } | undefined;
  			lifecycle = applyChildEventToLifecycle(lifecycle, {
  				type: event.type,
  				hasToolCall: event.type === "message_end" && Array.isArray(message?.content)
  					&& message.content.some((part) => (part as { type?: string }).type === "toolCall"),
  			}, now);
  			lastActivityAt = now;
  		}
  		reducedCount = events.length;
  	};
  	const activityAfter = (elapsed: number) => deriveActivityState({
  		config,
  		startedAt,
  		lastActivityAt,
  		now: lastActivityAt + elapsed,
  		inFlightTurn: lifecycle.turnOpen,
  		lastProductiveSignalAt: lifecycle.lastProductiveSignalAt,
  	});
  	onNewSessionMessage({
  		role: "assistant",
  		content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 90" } }],
  	});
  	reduceCapturedEvents();
  	assert.equal(lifecycle.turnOpen, true);
  	assert.equal(lifecycle.lastProductiveSignalAt, lastActivityAt);
  	assert.equal(activityAfter(config.needsAttentionAfterMs), undefined);
  	for (const elapsed of [config.needsAttentionAfterMs + 1, config.inFlightSilenceCeilingMs]) {
  		assert.equal(activityAfter(elapsed), "active_long_running");
  	}
  	assert.equal(activityAfter(config.inFlightSilenceCeilingMs + 1), "needs_attention");
  	const toolTurnLastActivityAt = lastActivityAt;
  	onNewSessionMessage({
  		role: "toolResult", toolCallId: "t1", toolName: "bash",
  		content: [{ type: "text", text: "done" }], isError: false,
  	});
  	reduceCapturedEvents();
  	assert.equal(lifecycle.turnOpen, true);
  	onNewSessionMessage({ role: "assistant", content: [{ type: "text", text: "finished" }] });
  	reduceCapturedEvents();
  	assert.equal(lifecycle.turnOpen, false);
  	assert.ok(lastActivityAt > toolTurnLastActivityAt);
  	assert.equal(lifecycle.lastProductiveSignalAt, lastActivityAt);
  	assert.equal(activityAfter(config.needsAttentionAfterMs + 1), "needs_attention");
  });
  ```

  Every elapsed interval is measured from the last reduced event, not `startedAt`. Test the interval `needsAttentionAfterMs < elapsed <= inFlightSilenceCeilingMs`, equivalently `(needsAttentionAfterMs, inFlightSilenceCeilingMs]`, with default values `(60000, 600000]`. A tool-call payload derives `hasToolCall: true`. The open-turn and calm-interval assertions guard against loss of the `message_end` payload: a bare `{ type: "message_end" }` derives `hasToolCall: false` and must fail them. Final-answer closure alone cannot detect that regression. There are no manually supplied child events; input objects are session messages delivered to the adapter.

- [ ] **Step 4: Assert unchanged adapter boundaries**

  Add focused cases alongside the sequence tests: without `onChildEvent`, the captured owner request's `onNewSessionMessage` is undefined; forwarding user, system, and custom roles emits nothing; a callback that throws a sentinel Error propagates that same Error synchronously when the captured session callback receives an assistant entry. Keep state local to each fake owner and event array. Do not introduce module-level lifecycle state or shared mutable fixtures; the emit remains per attempt, so parallel steps retain independent turns.

- [ ] **Step 5: Confirm the regression tests fail on the missing event**

  Run: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts`

  Expected: assistant sequence assertions lack the leading event, and the composition assertion sees a closed turn rather than `turnOpen: true`. Boundary cases unrelated to opening a turn still pass.

- [ ] **Step 6: Add the single missing emit**

  Insert `emit({ type: "message_start" })` as the first statement inside the existing assistant branch of `synthesizeChildEvents`, before the tool-call loop:

  ```typescript
  emit({ type: "message_start" });
  ```

  Preserve the existing per-tool `tool_execution_start` calls and trailing `message_end` with `message`. Emit no `turn_start`. Do not change `SynthesizedChildEvent`, export the private synthesizer, modify the reducer, or add a second `turnOpen` channel. `message_start` opens without a productive refresh; later tool events and the message end remain productive signals through the existing reducer.

  Keep `toolResult` and unrecognized-entry branches unchanged. Do not raise `control.needsAttentionAfterMs`, add a background in-flight silence kill, change sticky `needs_attention` recovery, or alter `claimControlNotification` deduplication. The first-turn blind spot remains; `async: false` and `runExternalSingleAttempt` in `src/runs/foreground/external-single-attempt.ts` stay untouched. No native stream, foreground control schema, sibling code, README, or API guide edits are needed. Task 2 supplies `## [Unreleased]` in `CHANGELOG.md` for the same implementation change.

- [ ] **Step 7: Confirm green**

  Run: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts`

  Expected: all adapter and composition cases pass, including the silence ceiling at 600000 ms and re-escalation at 600001 ms with default control. Tests use synthetic timestamps and do not wait for a real tool. No spawn-timing test or live `cmux` repro is required; the spec records `source: none` for the latter.

- [ ] **Step 8: Format and lint the task's files**

  No scoped lint/format command exists. Manually review only the two owned files for the surrounding tab/semicolon/import style, ASCII prose, and whitespace. Do not reformat neighboring code or add tooling.

- [ ] **Step 9: Commit**

  ```bash
  git add src/runs/background/external-attempt.ts test/unit/background-external-attempt.test.ts
  git commit -m "Fix external replay turn-open events" -m "Refs #37"
  ```

## Wave 2 - Release documentation

Depends on Wave 1: describe the implemented behavior and its scope in the changelog. This trailing doc-only task owns no code-task files.

### Task 2: Record the external long-tool fix in the changelog

**TDD scenario:** Trivial change - documentation review, no executable test.

**Spec:** doc/specs/2026-10-29-gh-37-external-child-turn-open.md § "Acceptance criteria" L33-L34, § "Design" L46-L46, § "Design" L51-L51, § "Documentation impact" L83-L83

**Files:**
- Modify: `CHANGELOG.md:1-7`

**Tests:**
- none: documentation-only changelog entry

This entry describes Task 1's `emit({ type: "message_start" })` in `synthesizeChildEvents` (`src/runs/background/external-attempt.ts`). Its proof in `test/unit/background-external-attempt.test.ts` includes `describe("external replay composition")`: `runExternalBackgroundAttempt` captures `onNewSessionMessage`, preserves the `hasToolCall` interpretation, and composes `applyChildEventToLifecycle` with `deriveActivityState` from `src/runs/shared/subagent-control.ts`. These are documentation context, not extra files owned by this task.

- [ ] **Step 1: Introduce the unreleased fix entry**

  Above `## [7.6.3]`, insert the following in the existing release-section format:

  ```markdown
  ## [Unreleased]

  ### Fixed
  - Async children on external execution backends no longer falsely need attention while a tool call runs past the idle threshold within an open turn; replay now opens the turn, preserving the silence ceiling and final-answer closure. (#37)
  ```

  This implements the `CHANGELOG.md` requirement in the implementation change rather than waiting for release. Do not bump a version, alter historical releases, or edit the approved spec.

- [ ] **Step 2: Review the documentation contract**

  Confirm `## [Unreleased]` appears once, above the latest release, and the new bullet ends in `(#37)`. Confirm the wording neither promises first-turn protection nor immediate calm-notice publication at the idle threshold. `doc/programmatic-api.md` and `README.md` retain their existing control contract; this fix restores it, rather than changing their API.

- [ ] **Step 3: Commit**

  ```bash
  git add CHANGELOG.md
  git commit -m "Document external replay idle-state fix" -m "Refs #37"
  ```

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L25-L26 | Emit `{ type: "message_start" }` first and extend the existing assistant sequence test | Task 1 |
| § "Acceptance criteria" L27-L28 | Synthesized tool turn yields `active_long_running` within the silence ceiling | Task 1 |
| § "Acceptance criteria" L29-L30 | Same open state yields `needs_attention` past the ceiling | Task 1 |
| § "Acceptance criteria" L31-L32 | Tool result plus final answer closes the turn and restores ordinary idle escalation | Task 1 |
| § "Acceptance criteria" L33-L34 | `CHANGELOG.md` has `## [Unreleased]` and a fix entry referencing `(#37)` | Task 2 |
| § "Design" L38-L38 | Fix the adapter, not the shared turn definition or event shape | Task 1 |
| § "Design" L40-L40 | Assistant branch starts with `emit({ type: "message_start" })` before existing tool calls and payload-bearing end | Task 1 |
| § "Design" L40-L40 | Keep `toolResult`, other entry kinds, and event types unchanged; emit no `turn_start` | Task 1 |
| § "Design" L42-L42 | Open without productive refresh, preserve tool productivity and `hasToolCall: true`, and close on final answer | Task 1 |
| § "Design" L42-L42 | Keep per-event activity timestamps, silence ceiling, and existing 240000 ms publication trigger | Task 1 |
| § "Design" L42-L42 | No background in-flight silence kill is introduced | Task 1 |
| § "Design" L44-L44 | Only the adapter changes production behavior; reducer and runner ownership stay intact | Task 1 |
| § "Design" L46-L46 | Introduce the unreleased fix section in the implementation change | Task 2 |
| § "Design" L48-L48 | Native, foreground, control schema, diagnostic, and pi-gauntlet paths stay untouched | Task 1 |
| § "Design" L50-L51 | No removal, one emit, existing assertion extended, no-tool case, composition block without synthesizer export | Task 1 |
| § "Design" L51-L51 | Add the unreleased changelog entry | Task 2 |
| § "Errors and edge cases" L55-L55 | Optional `onChildEvent` and synchronous callback error propagation stay unchanged | Task 1 |
| § "Errors and edge cases" L56-L56 | Final no-tool answer opens and closes in one batch; activity advances | Task 1 |
| § "Errors and edge cases" L57-L57 | Several tools receive one turn-open event and one end around N tool starts | Task 1 |
| § "Errors and edge cases" L58-L58 | Ignore entries other than assistant or tool result | Task 1 |
| § "Errors and edge cases" L59-L59 | Preserve latched `needs_attention` rather than adding recovery | Task 1 |
| § "Errors and edge cases" L60-L60 | Per-attempt events preserve independent `turnOpen` for parallel steps | Task 1 |
| § "Tests" L64-L64 | Assert `message_start, tool_execution_start, message_end` in the existing case | Task 1 |
| § "Tests" L65-L65 | Assert `message_start, message_end` for the no-tool case | Task 1 |
| § "Tests" L66-L66 | Retain `tool_execution_end, tool_result_end` expectation | Task 1 |
| § "Tests" L67-L67 | `describe("external replay composition")` captures full real adapter events and mirrors runner payload interpretation | Task 1 |
| § "Tests" L68-L68 | Every composition observation measures from the last reduced event's `lastActivityAt` | Task 1 |
| § "Tests" L69-L69 | Default-control calm interval is the payload-loss guard | Task 1 |
| § "Tests" L70-L70 | Open-turn silence past 600000 ms re-escalates | Task 1 |
| § "Tests" L71-L71 | Tool-result/final-answer continuation checks closure, not payload-loss sensitivity | Task 1 |
| § "Tests" L72-L74 | Proof is reducer/composition only; no spawn-timing, sibling, or live cmux test added | Task 1 |
| § "Tests" L76-L76 | Run scoped adapter tests; full verification includes the unit suite | Task 1 |
| § "Documentation impact" L83-L83 | Create `## [Unreleased]` above `## [7.6.3]`, reference `(#37)`, and leave API guides unchanged | Task 2 |
| § "Out of scope" L88-L88 | Preserve first-turn blind spot and its `needs_attention` result | Task 1 |
| § "Out of scope" L89-L89 | Keep `async: false` and `runExternalSingleAttempt` outside the change | Task 1 |
| § "Out of scope" L90-L90 | Preserve sticky `needs_attention` and `claimControlNotification` deduplication | Task 1 |
| § "Out of scope" L91-L91 | Background in-flight silence kill excluded | waived: explicitly out of scope |
| § "Out of scope" L92-L92 | Do not raise `control.needsAttentionAfterMs` | Task 1 |
