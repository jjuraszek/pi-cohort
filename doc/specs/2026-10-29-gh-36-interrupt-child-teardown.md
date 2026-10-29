# External child interrupt teardown and review completion

**Goal:** Bound external-child interruption and cleanup, report uncertainty honestly, and prevent an interrupted child from satisfying pi-gauntlet's completed-review checks without changing existing dispatch patterns.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Ticket:** [pi-cohort #36](https://github.com/jjuraszek/pi-cohort/issues/36)
**Date:** 2026-10-29
**Repositories:** pi-cohort; pi-gauntlet
**Source bases:** pi-cohort `562fcf2b482f69670ad1401a533d1b43c3f230ae` (7.6.3); pi-gauntlet `c322049b462b4cfcb34d40c7f169868ade08a505` (7.40.0).
**Execution checkouts:** pi-cohort uses its existing `gh-36-interrupt-child-teardown` worktree. By explicit user choice, pi-gauntlet uses the sibling primary checkout `../pi-gauntlet/` on `main`, initially clean at `7535fc4d24b12ac50f1598ddfb584f39e80d9a2f` (7.40.1); resolve the sibling path relative to the pi-cohort primary checkout, not its worktree. The completion predicates, their tests, telemetry implementation/tests, and configuration guide are unchanged from the audited sibling base. Do not create a sibling feature worktree or switch its branch; preserve unrelated changes if they appear.
**Predecessor:** `doc/specs/2026-09-06-mux-execution-backends.md`, `Lifecycle, fallback, and retention` interrupted row only. Sibling predecessor scopes are recorded in Design.

## Problem

A user stopping a child running in an external terminal can receive a paused result while the child and its host remain running. The reporter used pi-cohort 7.6.1 with a cmux companion and reported more than 50 minutes of idle survival followed by manual force-close. That duration describes the reported input; it is not a new timeout target. The reported final assistant message is `stopReason: "error"`, `errorMessage: "This operation was aborted"`.

The current source supports the failure mechanism, not an independently reproduced live incident. `src/execution-backend/reporting-extension.ts` classifies only `stopReason === "aborted"` as interrupted. `src/runs/shared/external-execution.ts` rejects a different post-abort terminal before sending shutdown. Its local active flag clears, but the host controller may still have an active attempt; retained finish then rejects as busy. A deadline race alone does not stop the underlying process or asynchronous operation.

An existing compatibility defect makes a lifecycle-only repair insufficient. Foreground interruption uses `exitCode: 0, interrupted: true`, and compact results preserve both fields. In pi-gauntlet, `qualifiesAsClosureDispatch` and `completedCadenceAgents` currently count zero-exit children without checking interruption. A repaired external interrupt can therefore satisfy a review-completion predicate with unfinished work. An unchanged schema is not a semantic compatibility guarantee.

Framing: pivoted to an interrupt-contract repair spanning pi-cohort teardown and pi-gauntlet completion predicates. The user chose this boundary, then chose the reuse-only owner/backend approach and explicitly required preservation of current pi-gauntlet usage patterns. The architecture round was approved with `yes`; the errors, tests, and documentation round was approved with `approve`. All five ticket rows remain in scope. Sibling requirements belong to Design, not invented ticket rows.

The existing core owns control, durable reporting, replay, and lifecycle orchestration; the companion owns launch and physical surface closure. `close(handle, reason): Promise<void>`, `shutdown_ack`, and socket closure do not independently prove OS termination. The backend lease already supports an `exited` fact, but production core does not consume it. The child host separately reports direct child exit through `attempt_exited`.

Implicit dependencies checked:

- Installed Pi 1.4.0 and its `@earendil-works` declarations, selected jiti loader, and typebox aliases exist. `abort()` and `shutdown()` request control and return void; `agent_settled` supplies an aborted flag. These facts do not reproduce the reporter's mid-tool error shape. Tests must exercise durable applied-abort evidence rather than infer causation from an error string.
- The fake-host and actual-process test harnesses exist. Their finalizer SIGKILL must not be credited as teardown performed by the implementation.
- `command -v cmux` and the inspected application/binary locations found no live cmux installation. The expected local companion checkout was absent, and the reporter's installed adapter version remains unknown.
- Fetched companion source at `nertzy/pi-cohort-mux@2bd3cf91f0406787c934ed82a4ef0fc9d524591d` closes its surface in the launcher EXIT trap, ignores the close reason, and translates closure to `surface_closed`, not host `exited`. Reconciliation checks surface presence, not PID death. This limits what core can claim; it does not establish the reporter's installed behavior.
- The sibling checkout, its branch-replay harness, and its live result consumers exist. A paired runtime compatibility check has not run. Both repositories' verification is required before claiming compatibility.

The ticket's [Reporter note](https://github.com/jjuraszek/pi-cohort/issues/36#issuecomment-6490690501) supplies the abort-classification, unconditional teardown, and `explicit_cleanup` sketches. This design retains those requirements but does not adopt its unsupported assumption that surface closure proves child death. Its TTL/session-end reaper sketch is excluded by the ticket body and the user's selected approach. The claim that nothing can resume a paused run was corrected: explicit resume starts a new process from the stored session.

## Acceptance criteria

Ticket #36, Acceptance Criteria, rows verbatim:

- [ ] With an execution backend registered, aborting a child while its tool call is running (unit harness: the fake child host resolves the post-abort terminal with a final assistant message of `stopReason: "error"`, `errorMessage: "This operation was aborted"`) yields a durable result with outcome `interrupted`, and `runAttempt()` resolves instead of rejecting with "abort did not produce an interrupted durable result".
  in-scope
- [ ] In the same fake-child-host harness, when the host answers shutdown normally, the parent sends the `shutdown` control request after the abort whatever shape the post-abort result has, and the host exit is observed within the control deadline; the attempt ends with the host no longer counting it as active.
  in-scope
- [ ] In the fake-child-host harness, when the post-abort terminal deadline expires or the host rejects shutdown as busy, the attempt still ends within a bounded fallback deadline with the child host exit observed and the attempt inactive; if the fallback closes the surface, the test backend additionally records `close(handle, "explicit_cleanup")`, and a recorded close alone does not satisfy this criterion. `finish("retained")` then resolves without "External execution finish failed".
  in-scope
- [ ] A child whose final message is an error when no abort was requested still produces outcome `failed`, so a requested abort never masks a genuine failure.
  in-scope
- [ ] In a background-runner test using the test backend and the error-shaped post-abort terminal from the first criterion, interrupting the run leaves its status `paused`, its error carries neither "External execution attempt failed" nor "External execution finish failed", and the fake host shutdown/exit is observed.
  in-scope

## Design

### Ownership and removal/addition inventory

Reuse the existing reporter, execution owner, host controller, lease event channel, and result fields. Keep backend protocol version 1, the child-host wire messages, public subagent arguments/results, and persisted session/report schemas unchanged. Do not add a supervisor, timer-driven reaper, new backend capability, or host-owned forced-drain stage.

Remove:

- The rejection-before-shutdown path in `src/runs/shared/external-execution.ts` and interruption-related re-entry into a busy host during retained finish.
- Post-readiness forwarding of launch cancellation that destroys the host's control socket or lets the backend force-close the surface before orderly interruption.
- Exit-code-only completed-child predicates in pi-gauntlet's existing closure and cadence observers.

Add or amend only these implementation parts:

| Repository / file | Responsibility |
|---|---|
| pi-cohort `src/execution-backend/reporting-extension.ts` | Classify a new durable result using correlated applied-abort provenance and preserve existing terminal immutability. |
| pi-cohort `src/execution-backend/child-host-controller.ts` | Separate pre-ready launch cancellation from active control; observe matching lease exit facts; expose host-exit observation through the existing controller; dispose local resources after confirmed teardown or exhaustion of the applicable observation budgets. Reuse `ChildHostExit` for status/signal data. |
| pi-cohort `src/runs/shared/external-execution.ts` | Complete bounded child/host teardown, exit observation and any backend fallback inside the interrupted `runAttempt()` before it settles. Own one-shot cleanup and the stored finish outcome; carry cleanup diagnostics through the existing internal attempt interface, extending it only as needed. |
| pi-cohort `src/runs/foreground/external-single-attempt.ts`, `src/runs/foreground/execution.ts` | Preserve cancellation, the optional `interrupted` flag and diagnostics through external result normalization, the attempt-rejection handler, `attemptSucceeded` and model-fallback checks, and finish. Accepted interruption stays zero-exit/paused; diagnostic `error` is not failure input, and interruption stops fallback. Preserve non-interrupted failure handling; do not change native finalization globally. |
| pi-cohort `src/runs/background/external-attempt.ts`, `src/runs/background/subagent-runner.ts` | Apply the same interrupted owner outcome through `mapExitCode`, error-bearing-zero-exit promotion, model-attempt success/retry checks, step/fail-fast decisions, final status and surface metadata. Preserve the existing optional `interrupted: true` field in public/status and persisted child-result projection; retain non-interrupted failure handling and existing schemas. |
| pi-cohort `src/shared/formatters.ts` | Add one shared interrupted-cleanup formatter over existing result fields; no persistence or lifecycle decisions. It returns labeled diagnostics for every affected interrupted child. |
| pi-cohort `src/runs/foreground/subagent-executor.ts`, `src/runs/foreground/chain-execution.ts` | Append that formatter's diagnostics to existing single, parallel, sequential-chain and parallel/dynamic-chain pause text, without changing clean pause text or result shapes. |
| pi-gauntlet `extensions/phase-tracker.ts` | Amend the two existing per-child completion predicates, shared by live handling and branch reconstruction. |

Add regression cases only in the existing test files enumerated in Tests. Amend the existing product documents enumerated in Documentation impact and the approved predecessor banner. Keep test scaffolding in those suites; add no new helper file, schema, configuration setting, dependency, copied execution path, or persisted state. Unlisted implementation parts require an amendment, not silent scope growth.

### Durable interruption and races

The reporter is the sole writer of the durable terminal result. Correlated abort control already records `requested` and `applied`; use that provenance when settlement produces a new result. An abort applied before settlement yields outcome `interrupted`, including the reported assistant error shape. Do not globally match or reinterpret `This operation was aborted`. Without abort provenance, ordinary errors remain failed; native `stopReason: "aborted"` remains interrupted.

Once a terminal result exists, do not append, replace, or rewrite it. An already-written success/failure wins that durable race. The owner's existing in-memory `interrupted` flag can still express a subsequently accepted user cancellation; external callers must not equate that flag with rewriting the durable outcome. Preserve the distinction through foreground and background adapters. Accepted interruption ends external model fallback regardless of the durable outcome or retained diagnostic, including a retryable rate-limit/timeout failure written before cancellation. Neither adapter may start another model attempt against the cleaned-up owner. Non-interrupted fallback remains unchanged.

Regardless of a post-abort terminal's outcome, attempt child shutdown and observe its exit. Classification, timeout, missing result, and protocol errors must not short-circuit teardown. Do not manufacture a durable result to make replay succeed. When no valid terminal can be read, `runAttempt()` rejects with the existing result-missing/protocol diagnostic error after bounded cleanup, rather than resolving a partial durable result. For accepted interrupted external attempts, both adapters preserve that diagnostic and any existing code in the caller's zero-exit, `interrupted: true`, paused result instead of substituting generic attempt failure. Preserve the cleanup warning alongside the diagnostic when termination is unconfirmed. Non-interrupted rejection handling remains unchanged.

### Bounded cleanup and exit evidence

Use `controlTimeoutMs`, whose current default is 30,000 ms, for each of two absolute budgets:

1. Graceful budget: starts when the owner accepts interruption; covers abort request, terminal observation, child shutdown/exit, and host shutdown/exit.
2. Fallback budget: at most one additional budget of the same length; covers forced surface cleanup when necessary, remaining exit observation, and observer/resource disposal.

The default upper bound on coordinator waiting after accepted interruption is therefore 60,000 ms. Pass remaining time to operations; a new await, result, or `finish()` call does not reset a window. Bound control requests and uncooperative backend close/release promises, not only terminal and child-exit waits. A timed-out promise can continue underneath; issue close at most once for this interruption, and do not let its late completion rewrite settled results or restart cleanup. Existing pre-ready launch cancellation/readiness handling remains distinct.

The interrupted `runAttempt()` owns child shutdown, host shutdown, exit observation and any fallback, completing this bounded cleanup before resolving or rejecting; host teardown must not wait for callers' post-attempt work or `finish()`. Carry cleanup diagnostics to both adapters through the existing internal attempt interface: resolved attempts use `ExternalAttemptResult.error`, and diagnostic rejections retain any cleanup warning alongside the original diagnostic. Do not alter the durable terminal to carry cleanup state.

Send the child shutdown control request even when terminal classification disagrees with the abort. After child exit, request host shutdown. On a stalled or rejected graceful shutdown, invoke the existing `backend.close(handle, "explicit_cleanup")` within the fallback budget. Reuse the backend's physical cleanup boundary; do not add PID killing or a second forced-drain protocol to core.

Consume the existing lease event stream before teardown can emit exit. Confirmed teardown requires both a correlated child `attempt_exited` for the interrupted attempt and a lease `exited` fact for the launched host/surface, observed within the applicable interruption budgets. Keep these as separate observations; anything less leaves termination unconfirmed and requires the cleanup warning. Do not claim both processes died from a successful close, `surface_closed`, socket closure, or `shutdown_ack`. Do not infer child death merely because the host exited while an attempt was active. Clear controller/owner bookkeeping without presenting that bookkeeping as OS-exit evidence.

If shutdown responds normally but the backend supplies no host-exit evidence, finish bounded observation and report uncertainty; do not close a diagnostic surface solely to obtain proof. Backends that emit genuine exit facts can satisfy confirmed cleanup. The inspected cmux adapter cannot supply the required launched-host lease `exited` proof, so interruption through that inspected adapter remains unconfirmed and carries the warning even if its process actually exited. This does not establish the behavior of the reporter's unknown installed adapter version.

Keep cleanup one-shot across duplicate interrupts, late signals, and repeated same-disposition finish. After an interrupted `runAttempt()` settles, `finish("retained")` returns the stored `{handle, retained}` surface outcome without contacting the host, whether teardown was confirmed or observation ended with uncertainty. Repeated retained finish does not restart cleanup. An interruption-cleaned owner accepts only retained finish: a first `finish("delivered")` rejects without host contact, another backend close, or a claim that paused work was delivered. Both adapters select retained finish for any accepted interruption, even with zero exit and regardless of diagnostics or the durable outcome. Preserve rejection of conflicting finish dispositions and repeated attempt IDs; normal successful execution and host reuse for non-interrupted fallback remain unchanged.

Keep the control channel, lease observer and controller available until teardown is confirmed or the applicable exit-observation budgets are exhausted. Then dispose control/watcher/controller resources and clear owned active state on every cleanup outcome, including an intermediate rejection; asynchronous observer release uses only remaining time, never a new wait window. Controller disposal destroys the control socket, and `src/execution-backend/child-host-runtime.ts` already sends SIGTERM to its active direct child on socket close. This side effect is why disposal must not preempt exit observation; it is not proof that either process exited.

### Visible state and retained surfaces

Preserve public `paused`, `interrupted: true`, and existing zero-exit interrupt semantics. Cleanup uncertainty is not a successful review and is not a new failed-run state. Report this exact error through result/status error fields and visible paused output:

`Process termination could not be confirmed; manual cleanup may be required.`

For accepted interrupted external results, treat `error` as diagnostic rather than failure input. Foreground `attemptSucceeded` and background error-bearing-zero-exit promotion/model-attempt checks must not turn the paused cancellation into a failed attempt or trigger fail-fast because of that diagnostic. Normalize caller-facing state to zero exit with `interrupted: true` without rewriting an already-written durable failure; carry the existing optional flag through public/status and persisted child results so replay cannot lose interruption and earn completion credit. Preserve ordinary non-interrupted failure handling and existing schemas.

Preserve the warning after foreground interruption normalization, which currently clears `result.error`, without changing native finalization semantics. Keep missing-result/protocol diagnostics distinguishable, and do not replace the warning with generic `External execution attempt failed` or `External execution finish failed` text. Clean confirmed interrupts retain their existing output and carry no cleanup error. For a mixed batch, show each affected interrupted child's warning, not only the first interrupted child.

`ExecutionSurfaceResult.retained` remains the existing boolean: false after a completed explicit-close request, true when core has not confirmed a close. It records the last known core retention/close outcome, not proof of process liveness or of an inspectable surface. Unresolved close includes the warning. Normal interruption does not request routine surface closure; forced cleanup may sacrifice the surface. The adapter's independent EXIT-trap behavior is outside core's promise.

Preserve successful external delivery's close-after-delivery order, host reuse across sequential fallback attempts, native execution, and explicit resume. Resume launches a new child from the stored session; it does not restart or control the old OS process. No automatic reaping is introduced.

### pi-gauntlet compatibility boundary

Change only the qualifying-child checks in `qualifiesAsClosureDispatch` and `completedCadenceAgents`: require the existing exact agent match, `exitCode === 0`, and `interrupted !== true`. Absence of the optional flag remains legacy success. Keep the predicates shared between the live `tool_result` observer and `reconstructState()`.

Preserve these current patterns:

- Single, parallel, and sequential/parallel/dynamic-chain results qualify per child. A completed reviewer in a mixed batch still qualifies even if another child paused. A successful earlier child in an errored chain still qualifies. Do not add a blanket top-level `isError` filter.
- Interrupted conformance reviewers do not satisfy closure; interrupted spec/code reviewers and implementers do not count as completed cadence observations. Failed/nonzero-exit and wrong-agent results retain their existing exclusions.
- Same-dispatch cadence ordering, session start/switch/fork/tree reconstruction, reset/start-implement windows, cold/disabled behavior, and exact agent matching remain unchanged.
- Empty async launch and management results do not create completion credit. Child-resume and persisted branch results use the same predicates and retain their existing shapes and selection rules.
- `isImplementerWave` still measures attempted work, including interrupted implementers under its existing top-level error rule. Preserve fix-round spending, granted-credit spending, and open-task nudges. Do not reinterpret those as successful-completion counters.
- Telemetry still counts dispatches and token/cost usage. Do not filter interrupted results in `extensions/telemetry.ts` or redesign partial-council-artifact handling in this repair.

Ship the guard and teardown as a paired logical change, with tests and CHANGELOG entries in both repositories. The schema is backward compatible, but the old sibling can still credit an interrupted review; coordinated delivery is required before claiming the full safety improvement. No dependency/version change is prescribed by this spec.

### Predecessor scope

Supersedes `doc/specs/2026-09-06-mux-execution-backends.md`, `Lifecycle, fallback, and retention` interrupted row only: retain normally, permit forced cleanup, and report unconfirmed exit honestly. Keep its core/backend ownership and all other lifecycle rows.

Also supersedes these sibling definitions only:

- pi-gauntlet `doc/specs/2026-06-11-closure-review-verify-gate.md`, `Qualifying dispatch` success predicate: zero exit also requires no explicit interruption.
- pi-gauntlet `doc/specs/2026-08-12-execution-fidelity-hardening.md`, advisory review-cadence completed-agent predicate: exclude interruption while retaining attempted-wave accounting and tie ordering. Follow its existing supersession notices for unrelated scope.

Reconcile the named sibling predecessor scopes with the approved sibling code/documentation changes in its user-selected primary `main` checkout. Keep the core spec and local predecessor in the existing pi-cohort worktree; do not copy the core spec into the sibling or modify unrelated predecessor scopes.

## Errors and edge cases

| Case | Required observation/behavior |
|---|---|
| Error-shaped terminal after applied abort | One durable interrupted result; owner resolves after bounded cleanup when valid evidence is available. |
| Terminal already written before abort | Durable terminal stays unchanged; accepted user cancellation still completes shutdown and stops model fallback, even for a retryable failure. |
| No terminal or corrupt/cross-correlated report | `runAttempt()` rejects with the existing diagnostic after bounded cleanup; both external adapters preserve it in a zero-exit interrupted paused result, with the cleanup warning if exit is unconfirmed. Never invent valid session evidence. |
| Child/host shutdown stalls or rejects as busy | Bounded explicit cleanup and exit observation; no rejection-before-teardown or repeated busy finish. |
| Close succeeds but exit is unobserved | Paused plus cleanup warning; close is not proof of death. |
| Only a different surface's exit, socket close, surface close, or shutdown ack is observed | Do not credit termination; retain bounded uncertainty handling. |
| Responsive shutdown but backend omits exit | Warn after bounded observation without destructive close merely to prove death. |
| Close/release rejects, never settles, or finishes late | Honor the absolute bound, retain diagnostics, dispose owned resources, do not issue duplicate close or mutate settled results. |
| Abort before readiness versus after readiness | Preserve launch cancellation before readiness; keep the ready control connection available for orderly interruption, including the signal passed to backend launch. |
| Duplicate abort, settled notification, or same-disposition finish | No duplicate terminal or cleanup; reuse the outcome. Conflicting disposition and reused attempt ID retain their current errors. |
| External warning reaches generic interruption normalization | Preserve diagnostic `error`, zero exit and the optional interruption flag through public/persisted child results; no failure promotion, fail-fast or model fallback. Clean/native pause semantics remain unchanged. |
| Parallel/chain mixture of completed and interrupted children | Render each cleanup warning; let gauntlet credit only individually qualifying completed children. |
| Native execution, successful delivery, sequential fallback, explicit resume | Preserve current behavior and result shapes; no broader lifecycle rewrite. |

## Tests

These are required pre-delivery proofs, not executed results. Paths are relative to the named repository. Use existing harnesses, injected deadlines and process fixtures, not a new test framework. Assert process exit before fixture-finalizer cleanup; an emergency test SIGKILL cannot make the assertion pass.

Amend the in-suite fixture backends in `test/integration/foreground-external-execution.test.ts` and `test/integration/background-external-execution.test.ts`: replace empty lease event streams with correlated lease `exited` facts emitted from the spawned host's process `exit` event, and make `close(handle, "explicit_cleanup")` physically terminate its owned process fixture rather than only increment a counter. Independently observe child exit before finalizer cleanup; do not infer it from host exit or close. These actual-process fixtures, not the recording-only conformance backend in `src/execution-backend/testkit.ts`, supply the AC2/AC3/AC5 process-exit proof.

### pi-cohort

- AC1: applied abort plus the reported error-shaped assistant message writes exactly one durable interrupted result and resolves the owner - `test/integration/execution-reporting-extension.test.ts`; `test/unit/external-foreground-execution.test.ts`.
- AC2: success/error/interrupted post-abort shapes receive shutdown, responsive child and host exits are observed within the graceful budget, and active bookkeeping clears - `test/unit/external-foreground-execution.test.ts`; `test/integration/foreground-external-execution.test.ts`.
- AC3: terminal timeout and busy shutdown reach bounded fallback, real fixture child/host exits precede assertions, invoked close records `explicit_cleanup`, and repeated retained finish resolves - `test/unit/external-foreground-execution.test.ts`; `test/integration/foreground-external-execution.test.ts`.
- AC4: error without applied abort stays failed - `test/integration/execution-reporting-extension.test.ts`.
- AC5: background interruption with the reported error shape stays paused without generic attempt/finish failures and observes host shutdown/exit - `test/integration/background-external-execution.test.ts`.
- Terminal-before-abort remains immutable; applied-abort-before-settlement overrides the error shape; duplicate abort/settlement adds no second result - `test/integration/execution-reporting-extension.test.ts`; `test/unit/external-foreground-execution.test.ts`.
- With two configured models, a retryable rate-limit/timeout terminal written before accepted interruption stays durably failed, but cancellation ends paused with zero exit and `interrupted: true`; assert exactly one model attempt and no generic attempt/finish error in both orchestration paths. Preserve non-interrupted model fallback - `test/integration/foreground-external-execution.test.ts`; `test/integration/background-external-execution.test.ts`.
- Missing terminal or protocol corruption makes the owner reject with the existing diagnostic only after bounded cleanup; both external adapters retain that diagnostic and any existing code in a zero-exit interrupted paused result, plus the cleanup warning when termination is unconfirmed. Never fabricate durable evidence - `test/unit/external-foreground-execution.test.ts`; `test/unit/external-single-attempt.test.ts`; `test/unit/background-external-attempt.test.ts`.
- Absent/unrelated host exit, surface/socket closure, shutdown acknowledgement, close rejection, and non-settling close/release do not prove death or cause unbounded waiting - `test/unit/external-foreground-execution.test.ts`; `test/unit/execution-child-host-controller.test.ts`.
- Responsive shutdown without backend exit evidence warns without forced closure; explicit close success/failure retains the documented boolean semantics - `test/unit/external-foreground-execution.test.ts`; `test/unit/external-single-attempt.test.ts`; `test/unit/background-external-attempt.test.ts`.
- Pre-ready cancellation still aborts launch; active interruption keeps the control channel and backend surface available for orderly teardown - `test/integration/execution-child-host.test.ts`; `test/integration/foreground-external-execution.test.ts`.
- Interrupted `runAttempt()` finishes bounded child/host teardown and observation before settling; controller disposal follows confirmed teardown or exhaustion of the applicable observation budgets. Duplicate interruption/finish and late promise completion preserve one-shot cleanup and absolute budgets; retained finish returns the stored surface outcome without host contact after confirmation or uncertainty. Repeated attempt ID/conflicting disposition retain their errors - `test/unit/external-foreground-execution.test.ts`; `test/unit/execution-child-host-controller.test.ts`.
- Cleanup warning survives normalization and renders for every affected interrupted child; assert zero-exit paused semantics, no warning-induced attempt failure/fail-fast, and preservation of the optional interruption flag in public/status and persisted background child results. Clean paused text and ordinary non-interrupted failures remain unchanged - `test/unit/external-single-attempt.test.ts`; `test/unit/background-external-attempt.test.ts`; `test/unit/formatters.test.ts`; `test/integration/single-execution.test.ts`; `test/integration/parallel-execution.test.ts`; `test/integration/chain-execution.test.ts`; `test/integration/background-external-execution.test.ts`.
- Successful external delivery closes only after delivery, fallback attempts reuse the host, and normal retained interruption requests no close - `test/integration/foreground-external-execution.test.ts`; `test/integration/background-external-execution.test.ts`.
- Native soft interruption, native success/failure and dynamic-chain result shapes remain unchanged - `test/integration/single-execution.test.ts`; `test/integration/parallel-execution.test.ts`; `test/integration/chain-execution.test.ts`.
- Explicit resume starts a new child from its stored session with unchanged selection/error rules - `test/unit/async-resume.test.ts`; `test/integration/async-execution.test.ts`.
- Actual-process exit assertions complete before fixture-finalizer kills - `test/integration/foreground-external-execution.test.ts`; `test/integration/background-external-execution.test.ts`.

### pi-gauntlet

- Interrupted zero-exit conformance/spec/code reviewers and implementers do not qualify as completed observations, live or after session start/switch/fork/tree reconstruction - `extensions/phase-tracker.test.ts`.
- Absent/false interruption flags retain legacy zero-exit success; genuine nonzero exits and wrong-agent results retain their exclusions - `extensions/phase-tracker.test.ts`.
- Successful children in mixed parallel results and errored chains still qualify per child; same-dispatch cadence ties preserve ordering - `extensions/phase-tracker.test.ts`.
- Empty async/management results, child-resume shapes, exact agent matching, reset/start-implement windows, and cold/disabled behavior retain their current meaning - `extensions/phase-tracker.test.ts`.
- Interrupted implementer waves retain attempted-work fix-round/credit spending and open-task nudges while not counting as completed cadence observations - `extensions/phase-tracker.test.ts`.
- Dispatch and token/cost telemetry keep counting attempted work - existing `extensions/telemetry.test.ts` coverage; no production telemetry change.

### Verification boundary

- Require pi-cohort `env -u PI_CODING_AGENT_DIR npm run test:all` in its existing worktree and pi-gauntlet `npm test` in its user-selected primary `main` checkout. Both must pass before claiming compatibility; no proposed-change test ran during brainstorming.
- The exact reporter cmux/adapter-version incident - none: the live runtime and reporter's installed adapter version are unavailable. Actual-process fake-backend tests prove core behavior only, not live cmux reproduction or companion retention compliance.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: pi-cohort `doc/observability.md` (communication contract: durable interruption and exit-evidence boundaries), `doc/programmatic-api.md` (communication/recovery contract: paused cleanup errors and interrupted-result semantics), `CHANGELOG.md` (paired release record); pi-gauntlet `doc/configuration.md` (completion and attempted-work definitions), `CHANGELOG.md` (paired release record)
- Derived / memory docs invalidated: none

Apply pi-gauntlet's `reference/documentation-impact.md` materiality guideline. The scout's `doc/observability.md` candidate and the independently verified API/configuration guides own these contracts; amend them rather than add a parallel guide. No README/AGENTS route, setting or procedure changes. Predecessor banners are spec workflow artifacts, not new product documentation.

## Out of scope

- TTL/session-end reaping, automatic resume, and routine core closure of normally interrupted surfaces.
- Companion launch/EXIT-trap changes, a new close capability, descendant-process supervision, or guarantees that an unobserved process died.
- A new public result/status shape, settings path, backend protocol, reporting schema, or native execution rewrite.
- Reinterpreting attempted-work fix budgets, nudge policy, telemetry counters, or partial council artifacts as completed-review accounting.
- Declaring the live cmux report reproduced or the companion's retention behavior compliant without that runtime and version evidence.

## Open questions

No product-policy decision remains open. The user chose paused-with-warning for unconfirmed termination and kept companion behavior separate.

External validation limits: the live cmux runtime and reporter's installed adapter version remain unavailable. This is nonblocking for the explicit fake-backend acceptance rows; retain the limitation in delivery evidence.

Execution location is resolved by the user's instruction `current main ../pi-gauntlet/ (main checkout)`: sibling edits, tests, and scoped commits use that primary checkout on its current `main`; pi-cohort work remains in its existing feature worktree. This changes checkout placement, not components, acceptance criteria, or the paired compatibility requirement.
