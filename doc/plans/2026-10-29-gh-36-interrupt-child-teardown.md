# Interrupt Child Teardown Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Complete bounded interrupted child/host cleanup before settling, preserve paused diagnostics, and exclude interrupted children from gauntlet completion credit.

**Architecture:** Keep durable terminal outcome, accepted cancellation and process-exit evidence separate. Reuse the reporter, execution owner, host controller, lease events and existing result fields; the interrupted owner completes teardown before returning, and both adapters preserve its diagnostics. Amend only the sibling's two completed-child predicates, not attempted-work accounting.

**Tech Stack:** TypeScript, Node's test runner and type stripping, Unix sockets, existing fake-host and actual-process fixtures.

**Spec:** `doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md`

**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all && git diff --check && (cd /Users/jacek/repos/pi-gauntlet && npm test && git diff --check)` - sibling verification runs on its existing main.

**Ticket:** `#36`

---

## Execution boundary and recon

- Pi-cohort stays in `/Users/jacek/repos/pi-cohort/.worktrees/gh-36-interrupt-child-teardown`. The user answered `current main ../pi-gauntlet/ (main checkout)`: sibling edits, tests and commits use `/Users/jacek/repos/pi-gauntlet` directly on existing `main`, not a new or nested feature worktree. Task 3 and the sibling half of Task 8 execute there. Absolute sibling file anchors below prevent interpreting `../pi-gauntlet` relative to pi-cohort's nested worktree.
- One plan covers the paired producer/consumer contract. Neither overrides file documents separate deployment topology or a Happy path table. Both repositories must verify before compatibility is claimed; no release, version bump or dependency change is part of these tasks.
- Pi-cohort `package.json:20-26` supplies file-addressable Node tests; use `test/support/isolate-test-env.mjs` and unset `PI_CODING_AGENT_DIR`. Its full entrypoint includes agents-core checking, unit tests and integration tests. Pi-gauntlet `package.json` and `scripts/ci.mjs:556-603` supply the stub-loader command for extension tests; its full entrypoint additionally runs repository validators, agents-core, gate/eval checks and packed-install checks. Neither checkout configures a general-purpose lint/format command or formatter. Preserve local formatting and use scoped `git diff --check -- <owned paths>` in each code task; header verification includes repository-wide whitespace checks. Do not install a style tool.
- Current owner: `src/runs/shared/external-execution.ts:123-215` races terminal/exit/abort, rejects an unexpected abort outcome before shutdown, and only shuts down the host in finish. Controller: `src/execution-backend/child-host-controller.ts:59-167` forwards the original signal into backend launch, resolves child exit from a correlated frame, and disposes on shutdown acknowledgement without consuming lease exit facts.
- Foreground adapter: `src/runs/foreground/external-single-attempt.ts:127-154` derives interruption from durable outcome, then `src/runs/foreground/attempt-finalization.ts:162-169` clears the error on interruption. Preserve that native finalizer; repair only its external caller. `src/runs/foreground/execution.ts:743-855` owns external rejection and fallback; `:875-974` owns post-loop finish and delivery.
- Background adapter: `src/runs/background/external-attempt.ts:80-142` maps interrupted outcome to nonzero exit today. `src/runs/background/subagent-runner.ts:808-934` promotes errors and selects fallback; `:1062-1200` finishes and projects child results; later sequential/parallel/dynamic branches and `:2550-2715` publish final paused state.
- Sibling: `extensions/phase-tracker.ts:91-103,142-159` defines the two predicates, consumed by reconstruction at `:466-641` and live results at `:849-855`. `extensions/telemetry.ts:690-705` counts each dispatch and its usage independently of interruption. No production telemetry edit is authorized.

## Baseline provenance

Initial inventory for this amendment before commands: pi-cohort BASE `9113ee5`; `M  doc/plans/2026-10-29-gh-36-interrupt-child-teardown.md` and `M  doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md`. These exact paths are the parent-admitted workflow edits; no source edits were present. Sibling HEAD `44ddbbbee99860c0986858354c2b4f14687ec489`, branch `main`, clean, includes the approved Task 3 commit. Its user-selected primary checkout remains the execution location. Tasks 1-5 are complete. The user-authorized rebase onto main 7.6.4 and accepted owner disposal fix are integrated in BASE; the initial recon above records the pre-implementation behavior, not the completed Tasks 1-5 state.

Endpoint-tree proof from recorded `2b6bfa0` to BASE returned exit 1 for `git diff --quiet 2b6bfa0 HEAD -- . ':!doc/specs/' ':!doc/plans/'`. The amendment also explicitly requires fresh execution of every baseline. No evidence was retained: all seven unchanged task commands ran from the pi-cohort worktree, including the full Task 6/7 test scope. Task 3 addresses the sibling tests and stub loader by absolute path. Baseline bullets use the plan checkout BASE; sibling source provenance is the full SHA above, not an assertion that the two repositories share HEAD. After each command, both HEADs and both per-file inventories were re-read and unchanged. No new artifacts or source edits appeared. Each command exited 0 with executed tests: Task 1 = 16, Task 2 = 33, Task 3 = 258, Task 4 = 260, Task 5 = 55, Task 6 = 20, Task 7 = 195. Both formerly hanging command groups completed with runner summaries; no timed-out evidence was copied. Header verification was not run during planning. No implementation was executed.

## Files

**Create:** none. **Delete:** none.

**Modify - durable reporting and lifecycle:**
- `src/execution-backend/reporting-extension.ts`
- `src/execution-backend/child-host-controller.ts`
- `src/runs/shared/external-execution.ts`
- `test/integration/execution-reporting-extension.test.ts`
- `test/unit/execution-child-host-controller.test.ts`
- `test/integration/execution-child-host.test.ts`
- `test/unit/external-foreground-execution.test.ts`

**Modify - foreground propagation and output:**
- `src/runs/foreground/external-single-attempt.ts`
- `src/runs/foreground/execution.ts`
- `src/shared/formatters.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `test/unit/external-single-attempt.test.ts`
- `test/integration/foreground-external-execution.test.ts`
- `test/unit/formatters.test.ts`
- `test/integration/single-execution.test.ts`
- `test/integration/parallel-execution.test.ts`
- `test/integration/chain-execution.test.ts`

**Modify - background propagation:**
- `src/runs/background/external-attempt.ts`
- `src/runs/background/subagent-runner.ts`
- `test/unit/background-external-attempt.test.ts`
- `test/integration/background-external-execution.test.ts`

**Modify - sibling completion guards:**
- `/Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.ts`
- `/Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.test.ts`

**Modify - product docs and sibling predecessor banners:**
- `doc/observability.md`
- `doc/programmatic-api.md`
- `CHANGELOG.md`
- `/Users/jacek/repos/pi-gauntlet/doc/configuration.md`
- `/Users/jacek/repos/pi-gauntlet/CHANGELOG.md`
- `/Users/jacek/repos/pi-gauntlet/doc/specs/2026-06-11-closure-review-verify-gate.md`
- `/Users/jacek/repos/pi-gauntlet/doc/specs/2026-08-12-execution-fidelity-hardening.md`

Read-only regression anchors: `test/unit/async-resume.test.ts`, `test/integration/async-execution.test.ts`, `/Users/jacek/repos/pi-gauntlet/extensions/telemetry.test.ts`. The local predecessor already has the approved supersession banner; retain it without another edit. Do not edit this approved spec, the native finalizer, child-host runtime, protocol/types schemas, testkit, dependency manifests or telemetry implementation.

## Wave 1 - Independent boundary contracts

Tasks 1-4 own disjoint files. Their tests run in separate Node processes and use suite-local temporary roots, fake sockets or per-fixture Unix sockets; no shared port, process fixture or mutable backend registration crosses tasks. The sibling task uses only its authorized primary checkout.

### Task 1: Classify applied aborts without rewriting terminal history

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Acceptance criteria" L39, § "Acceptance criteria" L45, § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L66, § "Ownership and removal/addition inventory" L75, § "Durable interruption and races" L79, § "Durable interruption and races" L81, § "Errors and edge cases" L150, § "Errors and edge cases" L151, § "Errors and edge cases" L159, § "pi-cohort" L172, § "pi-cohort" L175, § "pi-cohort" L177

**Files:**
- Modify: `src/execution-backend/reporting-extension.ts:54-137`
- Modify: `test/integration/execution-reporting-extension.test.ts`
- Test: `test/integration/execution-reporting-extension.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/integration/execution-reporting-extension.test.ts`
- baseline: 9113ee5 pass
- via: `createExecutionReportingExtension`, `agent_settled`, `applyControl`

Decision: use correlated persisted control provenance, not the settlement event's flag or an error-string heuristic - `reports()` already filters run/child/attempt identity and `applyControl()` records `requested` then `applied` (`reporting-extension.ts:27-33,76-93`). Keep the reporter as the sole durable terminal writer and keep the existing malformed-message/result-missing handling.

- [ ] Run the scoped command above to establish the existing seven cases.
- [ ] Extend the in-suite socket harness to feed real encoded abort control, then settle a final assistant with `stopReason: "error"`, `errorMessage: "This operation was aborted"`. Assert one result with outcome `interrupted`, correlated applied provenance, and no second terminal after duplicate control or settlement.
- [ ] Add table rows for error without abort (outcome `failed`), requested-but-not-applied abort, another attempt's abort, native `stopReason: "aborted"`, applied abort before success/error settlement, and success/failure terminal written before abort. Assert existing terminal bytes and result count stay unchanged in the latter cases. Do not globally reinterpret `This operation was aborted`.
- [ ] Run the scoped command; expect the new applied-abort/error case to fail because current classification returns failed.
- [ ] Pass an applied-abort boolean derived from the existing correlated reports into `result()`. Apply it only when producing a new terminal with a valid assistant; preserve the early existing-result return in `agent_settled`. Keep `requested` distinct from `applied` and preserve no-final-assistant and malformed-report diagnostics.
- [ ] Run the scoped command; expect every classification and immutability row green. The companion owner proof of `runAttempt()` resolving after teardown belongs to `test/unit/external-foreground-execution.test.ts` in Task 5; do not copy that lifecycle into the reporter.
- [ ] Preserve surrounding formatting. Run: `git diff --check -- src/execution-backend/reporting-extension.ts test/integration/execution-reporting-extension.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/execution-backend/reporting-extension.ts test/integration/execution-reporting-extension.test.ts && git commit -m "Classify correlated applied aborts as interrupted (ref #36)"`.

### Task 2: Separate launch cancellation and observe genuine host exits

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L59, § "Ownership and removal/addition inventory" L67, § "Ownership and removal/addition inventory" L75, § "Bounded cleanup and exit evidence" L98, § "Bounded cleanup and exit evidence" L104, § "Errors and edge cases" L155, § "Errors and edge cases" L158, § "pi-cohort" L180, § "pi-cohort" L182, § "pi-cohort" L183

**Files:**
- Modify: `src/execution-backend/child-host-controller.ts`
- Modify: `test/unit/execution-child-host-controller.test.ts`
- Modify: `test/integration/execution-child-host.test.ts`
- Test: `test/unit/execution-child-host-controller.test.ts`
- Test: `test/integration/execution-child-host.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/execution-child-host-controller.test.ts test/integration/execution-child-host.test.ts`
- baseline: 9113ee5 pass
- via: `createChildHostController`, `ChildHostExit`, `startAttempt`, `shutdown`, `releaseObserver`

Decision: add only `readonly hostExit: Promise<ChildHostExit>` and synchronous idempotent `dispose(): void` to the existing internal controller interface. `startAttempt()` remains the separate source of correlated child exit; `ChildHostExit` already carries nullable status/signal (`child-host-controller.ts:12-15`). `ExecutionBackendLease.events` already provides correlated `exited` facts (`src/execution-backend/types.ts`); do not add a backend capability or new exit schema.

- [ ] Run the scoped command before changing the controller.
- [ ] Extend existing fake leases with controllable event streams. Assert only `exited` for the launched handle's backendId/surfaceId resolves `hostExit`; another surface, `surface_closed`, `shutdown_ack`, socket closure and stream exhaustion do not. Assert a host exit cannot resolve the active child attempt without its matching `attempt_exited`.
- [ ] Add launch-signal tests: abort before ready reaches backend launch and rejects readiness; abort after `host_ready` neither destroys the control socket nor aborts the signal supplied to the backend. Cover readiness arriving before the launch promise resolves. Extend actual-host tests to keep a ready connection usable for orderly shutdown after the original signal is aborted.
- [ ] Add disposal tests: shutdown acknowledgement alone does not dispose the socket/observer; disconnect after readiness rejects pending control work but does not discard the lease observer; `dispose()` clears local active/pending state once. Preserve existing concurrent release sharing and retry-after-release-error tests. Expect these new assertions to fail against current forwarding/early cleanup.
- [ ] Forward the original signal into a dedicated launch AbortController only until readiness. Remove that forwarding listener on `host_ready`; pass the dedicated signal to `backend.launch`, including the early-ready race. Start consuming the lease event stream immediately when launch returns, before exposing the controller. Match genuine exit identity and retain the resulting `hostExit` promise.
- [ ] Separate post-ready disconnect/ack bookkeeping from final resource disposal. Leave observations alive until the owner calls `dispose()` after confirmation or budget exhaustion. Make disposal clear state, destroy the socket, close the server and remove private setup files idempotently. Keep pre-ready failures' immediate cleanup and existing readiness/protocol errors. Preserve bounded-caller control of `releaseObserver()` rather than waiting for a nonsettling stream iterator return.
- [ ] Run the scoped command green. In `test/unit/external-foreground-execution.test.ts`, Task 5 owns when disposal follows interrupted `runAttempt()` and when `finish("retained")` returns stored `{handle, retained}`. In `test/integration/foreground-external-execution.test.ts`, Task 6 checks the same signal boundary with the whole owner. Do not edit those files here. `src/execution-backend/child-host-runtime.ts` sends SIGTERM on socket close; leave it untouched and never treat that side effect as observed process death.
- [ ] Preserve local formatting. Run: `git diff --check -- src/execution-backend/child-host-controller.ts test/unit/execution-child-host-controller.test.ts test/integration/execution-child-host.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/execution-backend/child-host-controller.ts test/unit/execution-child-host-controller.test.ts test/integration/execution-child-host.test.ts && git commit -m "Separate launch cancellation from host exit observation (ref #36)"`.

### Task 3: Exclude interrupted children from completion credit

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L60, § "Ownership and removal/addition inventory" L73, § "Ownership and removal/addition inventory" L75, § "pi-gauntlet compatibility boundary" L122, § "pi-gauntlet compatibility boundary" L126, § "pi-gauntlet compatibility boundary" L127, § "pi-gauntlet compatibility boundary" L128, § "pi-gauntlet compatibility boundary" L129, § "pi-gauntlet compatibility boundary" L130, § "pi-gauntlet compatibility boundary" L131, § "pi-gauntlet compatibility boundary" L133, § "Errors and edge cases" L161, § "pi-gauntlet" L192, § "pi-gauntlet" L193, § "pi-gauntlet" L194, § "pi-gauntlet" L195, § "pi-gauntlet" L196, § "pi-gauntlet" L197

**Files:**
- Modify: `/Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.ts:91-159`
- Modify: `/Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.test.ts`
- Test: `/Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.test.ts`
- Test: `/Users/jacek/repos/pi-gauntlet/extensions/telemetry.test.ts`

**Tests:**
- `node --experimental-loader /Users/jacek/repos/pi-gauntlet/extensions/test-support/pi-stubs.mjs --test /Users/jacek/repos/pi-gauntlet/extensions/phase-tracker.test.ts /Users/jacek/repos/pi-gauntlet/extensions/telemetry.test.ts`
- baseline: 9113ee5 pass
- via: `qualifiesAsClosureDispatch`, `completedCadenceAgents`, `reconstructState()`, `tool_result`, `isImplementerWave`

Decision: the user-selected execution checkout is `/Users/jacek/repos/pi-gauntlet` on `main`. The existing `extensions/phase-tracker.ts` consumers share both predicates in live `tool_result` and `reconstructState()`; changing those predicates alone fixes replay and live credit. Keep `isImplementerWave` as attempted work, including its current top-level `isError` exclusion. Keep `extensions/telemetry.ts` unchanged; read-only `extensions/telemetry.test.ts` protects dispatch and token/cost accounting.

- [ ] Run the scoped command from the plan or sibling checkout; all paths are absolute.
- [ ] Extend `extensions/phase-tracker.test.ts`'s `harness`, `phaseResult` and `resumedBranch` tables (`:41-133,603-803`) with interruption absent, false and true across zero/nonzero exits and exact/wrong agents. Cover conformance, spec, code reviewers and implementers. Drive the live event and each session start/switch/fork/tree reconstruction event, not a new copied predicate.
- [ ] Add mixed single/parallel/sequential/parallel-chain/dynamic-chain and resumed-child result shapes: interrupted reviewer alone never qualifies, a completed reviewer beside a paused child does, and successful earlier children in an errored chain still qualify. Preserve empty async/management no-credit results, same-dispatch cadence ties, reset/start-implement windows and cold/disabled behavior.
- [ ] Extend existing cap/grant/open-task cases (`:1484-1930`) so an interrupted implementer still spends attempted-work fix rounds and eligible granted credits and still triggers the existing nudge, but cannot advance completed cadence. Run the scoped command red; expect current predicates to wrongly credit an interrupted zero-exit child.
- [ ] Change only qualifying-child checks and their local structural types: closure requires `r?.agent === "conformance-reviewer" && r?.exitCode === 0 && r?.interrupted !== true`; cadence adds `r?.interrupted !== true` beside its current `r?.exitCode === 0` and exact CADENCE_AGENTS membership. The contract is `exitCode === 0` and `interrupted !== true`; absence remains legacy success. Add no top-level error filter to these two predicates.
- [ ] Run the scoped command green, including telemetry regression coverage. Do not change fix budgets, grant selection, nudge policy, partial council artifacts, persisted shapes, settings or dependencies. Delivery remains paired with the producer and both CHANGELOG entries, not an independently complete safety claim.
- [ ] In the sibling primary checkout, preserve existing formatting and run: `git diff --check -- extensions/phase-tracker.ts extensions/phase-tracker.test.ts`. Expected: no whitespace errors.
- [ ] In that same checkout, commit: `git add extensions/phase-tracker.ts extensions/phase-tracker.test.ts && git commit -m "Exclude interrupted children from completion credit (ref jjuraszek/pi-cohort#36)"`.

### Task 4: Render every interrupted child's cleanup diagnostics

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L71-L72, § "Ownership and removal/addition inventory" L75, § "Visible state and retained surfaces" L108, § "Visible state and retained surfaces" L110, § "Visible state and retained surfaces" L114, § "Errors and edge cases" L161, § "Errors and edge cases" L162, § "pi-cohort" L184, § "pi-cohort" L186

**Files:**
- Modify: `src/shared/formatters.ts`
- Modify: `src/runs/foreground/subagent-executor.ts:1810-1855`
- Modify: `src/runs/foreground/subagent-executor.ts:2100-2150`
- Modify: `src/runs/foreground/chain-execution.ts`
- Modify: `test/unit/formatters.test.ts`
- Modify: `test/integration/single-execution.test.ts`
- Modify: `test/integration/parallel-execution.test.ts`
- Modify: `test/integration/chain-execution.test.ts`
- Test: `test/unit/formatters.test.ts`
- Test: `test/integration/single-execution.test.ts`
- Test: `test/integration/parallel-execution.test.ts`
- Test: `test/integration/chain-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/formatters.test.ts test/integration/single-execution.test.ts test/integration/parallel-execution.test.ts test/integration/chain-execution.test.ts`
- baseline: 9113ee5 pass
- via: `formatInterruptedCleanup`, `createSubagentExecutor`, `executeChain`, `appendChainSections`

Decision: output reads existing `agent`, `interrupted` and `error` fields; it does not decide lifecycle or persistence. Add one shared exported `formatInterruptedCleanup(results: readonly SingleResult[]): string` in `src/shared/formatters.ts`. Its empty result is the empty string; otherwise each interrupted child with a nonempty diagnostic yields a labeled line containing its input-order index, agent and original diagnostic. Prefix the joined block with two newlines so appending the empty result preserves clean text exactly.

- [ ] Run the scoped command first.
- [ ] Add formatter rows for no children, clean interrupted children, ordinary failures, one uncertain interruption and a batch with completed children plus two interrupted children (including repeated agent names). Assert every warning exactly once, distinguishable labels and deterministic order. The exact warning is `Process termination could not be confirmed; manual cleanup may be required.`
- [ ] Extend existing single/parallel executor fixtures to return interrupted diagnostic children and extend sequential, static parallel and dynamic-chain fixtures to pause after such results. Reuse the existing mock Pi/temp-root harnesses, not a new helper file. Assert public `paused`, zero exit and `interrupted: true`, unchanged result shapes, all affected children visible, unchanged clean pause strings, no extra section on native success/failure and no lost dynamic children.
- [ ] Run the scoped command red; the new output cases should currently omit the diagnostics.
- [ ] Implement the formatter and append its output at the single and parallel pause returns in `src/runs/foreground/subagent-executor.ts:1846,2127` and all three pause paths in `src/runs/foreground/chain-execution.ts:751,960,1231`. Pass all accumulated/materialized results, not only the first interrupted child. Keep existing chain sections, stop records, paused metadata and clean wording.
- [ ] Run the scoped command green. The formatter preserves `result.error` verbatim; it never substitutes `External execution attempt failed` or `External execution finish failed`. Failure suppression in foreground `attemptSucceeded` and background error promotion belongs to Tasks 6-7, proved in `test/unit/external-single-attempt.test.ts`, `test/unit/background-external-attempt.test.ts` and `test/integration/background-external-execution.test.ts`; do not add failure-state decisions here.
- [ ] Preserve local formatting. Run: `git diff --check -- src/shared/formatters.ts src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts test/unit/formatters.test.ts test/integration/single-execution.test.ts test/integration/parallel-execution.test.ts test/integration/chain-execution.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/shared/formatters.ts src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts test/unit/formatters.test.ts test/integration/single-execution.test.ts test/integration/parallel-execution.test.ts test/integration/chain-execution.test.ts && git commit -m "Show cleanup diagnostics for every paused child (ref #36)"`.

## Wave 2 - Interrupted owner lifecycle

Depends on Wave 1: the owner consumes the reporter's immutable terminal semantics and the controller's separate host-exit promise and disposal boundary. Task 5 owns the controller mock changes in its own test suite.

### Task 5: Settle interruption only after bounded one-shot teardown

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Acceptance criteria" L39, § "Acceptance criteria" L41, § "Acceptance criteria" L43, § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L58, § "Ownership and removal/addition inventory" L68, § "Ownership and removal/addition inventory" L75, § "Durable interruption and races" L81, § "Durable interruption and races" L83, § "Bounded cleanup and exit evidence" L87-L90, § "Bounded cleanup and exit evidence" L92, § "Bounded cleanup and exit evidence" L94, § "Bounded cleanup and exit evidence" L96, § "Bounded cleanup and exit evidence" L98, § "Bounded cleanup and exit evidence" L100, § "Bounded cleanup and exit evidence" L102, § "Bounded cleanup and exit evidence" L104, § "Visible state and retained surfaces" L110, § "Visible state and retained surfaces" L116, § "Visible state and retained surfaces" L118, § "Errors and edge cases" L150, § "Errors and edge cases" L151, § "Errors and edge cases" L152, § "Errors and edge cases" L153, § "Errors and edge cases" L154, § "Errors and edge cases" L155, § "Errors and edge cases" L156, § "Errors and edge cases" L157, § "Errors and edge cases" L159, § "Tests" L166, § "pi-cohort" L172, § "pi-cohort" L173, § "pi-cohort" L174, § "pi-cohort" L177, § "pi-cohort" L179, § "pi-cohort" L180, § "pi-cohort" L181, § "pi-cohort" L183

**Files:**
- Modify: `src/runs/shared/external-execution.ts`
- Modify: `test/unit/external-foreground-execution.test.ts`
- Test: `test/unit/external-foreground-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/external-foreground-execution.test.ts`
- baseline: 9113ee5 pass
- via: `createExternalExecution`, `runAttempt()`, `finish()`, `ExternalAttemptResult.error`, `withControlDeadline`

Decision: preserve `ExternalAttemptResult.outcome` as the immutable durable outcome and use its existing `interrupted` boolean for accepted cancellation (also true for a durable interrupted terminal). On accepted-interruption rejection, annotate the original Error with internal `interrupted: true` and append any cleanup diagnostic to its message while preserving its class/code. Export `isInterruptedExternalAttemptError(error: unknown): error is Error & { interrupted: true }` from this existing module for both adapters. This extends only the internal error contract; `ExternalExecutionDiagnosticError` and `externalExecutionDiagnosticCode()` already own `result_missing`. Never return a fabricated replay or partial durable result to avoid rejecting.

Decision: interruption cleanup fixes the owner's finish disposition to retained before `runAttempt()` settles, including diagnostic rejection. The accepted implementation in `src/runs/shared/external-execution.ts:436-471` rejects a first `finish("delivered")` before assigning its finish disposition, while retaining the existing conflicting-disposition Error contract. `finish("retained")` remains available after that rejection and returns stored `{handle, retained}`. Preserve this retained-only boundary and the integrated non-interrupted finish disposal fix; Task 5 is complete, and Tasks 6-7 consume it rather than reopening its accepted implementation.

- [ ] Run the scoped command first. Extend `harness()`, `ownerFrom`, `sessionContent()` and the fake controller (`test/unit/external-foreground-execution.test.ts:20-126`) with separate deferred child exit, `hostExit`, `dispose` and controllable close/release promises.
- [ ] Replace the obsolete rejection expectation with a matrix of success/error/interrupted post-abort terminals, including `stopReason: "error"`, `errorMessage: "This operation was aborted"`. Assert `shutdown` is attempted for every shape, durable outcome never changes, accepted interruption remains true, and `runAttempt()` does not settle until cleanup concludes. Retain no-abort success-conflicting-with-exit, malformed-report and ordinary failure tests.
- [ ] Add race/error rows: success/failure already durable before cancellation; missing terminal; cross-correlated or corrupt reports; abort request stalls/rejects; terminal timeout; child shutdown busy; absent child exit; responsive shutdown without host exit. Assert diagnostic rejection happens after cleanup, no terminal is manufactured, normal response with missing host evidence never triggers a destructive close just for proof, and bookkeeping is not exit evidence.
- [ ] Add fallback rows: close resolves/rejects/never settles/resolves late; release rejects/never settles; only another surface exits; only socket close, `surface_closed` or `shutdown_ack` occurs. Observe child `attempt_exited` and host `exited` separately. Assert both within the budgets are necessary for confirmed teardown; host-only evidence never proves child death.
- [ ] Add one-shot/budget rows with injected clock/deadlines: duplicate interrupts, terminal-plus-abort race, repeated `finish("retained")`, conflicting dispositions, repeated attempt IDs and late completion. Assert every operation receives decreasing remaining time, maximum two budgets, close once, disposal after confirmation or observation exhaustion, and no host contact or mutable result rewrite after settlement.
- [ ] Add retained-only finish rows after confirmed and unconfirmed interrupted teardown, covering both resolved attempts and diagnostic rejections, with retained surface true/false. Call `finish("delivered")` first and assert rejection, unchanged host/control/backend close/release counters and no delivery claim; then call `finish("retained")` twice and assert the stored `{handle, retained}` outcome with no new contact or wait budget. Also assert retained-then-delivered conflicts still reject. A late close must not change either the stored outcome or disposition. Run the scoped command red.
- [ ] Implement one interrupted finalization path inside `runAttempt()`. Latch accepted interruption once and its monotonic start time while an attempt remains active; a durable interrupted terminal also takes this path. Use `controlTimeoutMs` (default 30,000 ms) to compute absolute graceful and fallback endpoints. At most 60,000 ms of coordinator waiting is allowed by default. Reuse the existing deadline dependency with remaining milliseconds and add a monotonic clock dependency in this file for deterministic arithmetic tests. Never reset a window for a new await or `finish()`.
- [ ] Attempt abort, observe terminal, and always attempt child shutdown despite classification, missing result, protocol failure or an earlier timeout. Bound control requests as well as terminal/exit waits; when no time remains, issue the required shutdown request without starting another wait window and attach rejection handling. After genuine child exit request host shutdown. Observe the controller's already-armed `hostExit`; `shutdown_ack` only acknowledges control.
- [ ] On stalled/rejected graceful shutdown or terminal timeout, enter at most one fallback budget and invoke `backend.close(handle, "explicit_cleanup")` at most once. Continue independent child/host exit observation within the remaining time. A responsive shutdown missing only a host `exited` fact gets bounded observation and uncertainty, not forced close solely for proof. Keep control, watcher and controller alive throughout applicable observation; do not infer both deaths from close or socket state.
- [ ] Finalize diagnostics and resource ownership even after an intermediate rejection. Dispose control/watcher/controller only after confirmed teardown or applicable observation exhaustion, clear active state, and bound `releaseObserver()` by remaining time. `src/execution-backend/child-host-runtime.ts` already sends SIGTERM on socket disposal; never cite this as observed death or edit the runtime. Dispose synchronously before an uncooperative release can strand local resources; catch late promises without allowing them to mutate settled state.
- [ ] Store `{handle, retained}` before settling. `ExecutionSurfaceResult.retained` is false only if an explicit-close request completed before settlement; rejection, timeout or no close leaves true. Close success is not process proof. Add `Process termination could not be confirmed; manual cleanup may be required.` whenever child/host exit is unconfirmed or close remains unresolved; preserve other cleanup diagnostics and the original durable diagnostic. Resolved attempts carry it via `ExternalAttemptResult.error`; invalid terminal evidence rejects with the original annotated diagnostic. A valid terminal with no observed child exit may carry nullable status/signal, but that value must never be treated as observed exit.
- [ ] Make `finish("retained")` return the stored promise/outcome after interruption, confirmed or uncertain, with no host command or second close/release. Fix the interrupted owner's disposition to retained before settlement and reject `finish("delivered")` before any host/backend operation, even when delivered is the first finish call. Do not let that rejected call poison later retained finish. Preserve conflicting-disposition and reused-ID errors, forbid another attempt against an interruption-cleaned owner, and preserve non-interrupted host reuse, successful close-after-delivery and existing AggregateError behavior. Ensure non-interrupted finish also disposes its controller in cleanup after its existing shutdown/release path.
- [ ] Run the scoped command green. Reporter classification proof stays in `test/integration/execution-reporting-extension.test.ts`; controller correlation/disposal proof stays in `test/unit/execution-child-host-controller.test.ts`. Real process proof of `close(handle, "explicit_cleanup")` and `explicit_cleanup` recording belongs to `test/integration/foreground-external-execution.test.ts`; adapter diagnostic/retention proofs belong to `test/unit/external-single-attempt.test.ts` and `test/unit/background-external-attempt.test.ts`. Do not replace either `External execution attempt failed` or `External execution finish failed` with a cleanup success claim.
- [ ] Preserve local formatting. Run: `git diff --check -- src/runs/shared/external-execution.ts test/unit/external-foreground-execution.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/runs/shared/external-execution.ts test/unit/external-foreground-execution.test.ts && git commit -m "Complete bounded interrupted teardown before settling (ref #36)"`.

## Wave 3 - External caller propagation

Depends on Wave 2: both adapters consume `ExternalAttemptResult.interrupted`, the annotated diagnostic error predicate and the stored retained finish outcome. They own disjoint files; their process tests use separate per-suite temporary roots, registered backends and sockets in separate Node processes. Do not factor either suite's fixture into a new shared file.

### Task 6: Preserve foreground cancellation through normalization and fallback

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Acceptance criteria" L41, § "Acceptance criteria" L43, § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L69, § "Ownership and removal/addition inventory" L75, § "Durable interruption and races" L81, § "Durable interruption and races" L83, § "Bounded cleanup and exit evidence" L94, § "Bounded cleanup and exit evidence" L102, § "Visible state and retained surfaces" L108, § "Visible state and retained surfaces" L110, § "Visible state and retained surfaces" L112, § "Visible state and retained surfaces" L114, § "Visible state and retained surfaces" L116, § "Visible state and retained surfaces" L118, § "Errors and edge cases" L151, § "Errors and edge cases" L152, § "Errors and edge cases" L158, § "Errors and edge cases" L160, § "Errors and edge cases" L162, § "Tests" L166, § "Tests" L168, § "pi-cohort" L173, § "pi-cohort" L174, § "pi-cohort" L178, § "pi-cohort" L179, § "pi-cohort" L181, § "pi-cohort" L182, § "pi-cohort" L184, § "pi-cohort" L185, § "pi-cohort" L188

**Files:**
- Modify: `src/runs/foreground/external-single-attempt.ts`
- Modify: `src/runs/foreground/execution.ts`
- Modify: `test/unit/external-single-attempt.test.ts`
- Modify: `test/integration/foreground-external-execution.test.ts`
- Test: `test/unit/external-single-attempt.test.ts`
- Test: `test/integration/foreground-external-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/external-single-attempt.test.ts test/integration/foreground-external-execution.test.ts`
- baseline: 9113ee5 pass
- via: `runExternalSingleAttempt`, `runSync`, `runAttempt()`, `finish()`, `attemptSucceeded`

Decision: use the owner boolean, not `outcome === "interrupted"`, to normalize cancellation. Preserve the existing native finalizer in `attempt-finalization.ts:162-169`; restore the external diagnostic immediately after that finalizer runs. Use Task 5's `isInterruptedExternalAttemptError` for invalid terminal evidence and preserve `externalExecutionDiagnosticCode()` rather than recognizing cancellation from a generic abort signal or an error string. The attempt record must not label a paused diagnostic as failure: compute `attemptSucceeded` as `result.exitCode === 0 && (result.interrupted || !result.error)` and stop cancellation independently before retry/acceptance logic. The optional flag, not this local success boolean, prevents review-completion credit.

Decision: retain the existing foreground delivery exclusion `!result.interrupted` in `src/runs/foreground/execution.ts:954-958`. Every accepted interruption selects `finish("retained")`, never `finish("delivered")`, after normalization or diagnostic rejection, independent of durable outcome and diagnostic presence. Task 5's retained-only owner already rejects delivered before host/backend contact and stores `{handle, retained}`; project that stored outcome unchanged, including retained false after explicit cleanup, rather than synthesizing a new finish result.

- [ ] Run the scoped command first.
- [ ] Extend `baseAttemptResult`/`makeOwner` rows in the unit suite with immutable durable success and retryable failed outcomes carrying accepted interruption, confirmed versus uncertain cleanup, explicit-close success/failure retention and annotated result-missing/protocol rejection. Assert `exitCode: 0`, `interrupted: true`, diagnostic `error` and any existing code survive. Ordinary unannotated rejection must retain its old behavior. The warning is `Process termination could not be confirmed; manual cleanup may be required.`
- [ ] Upgrade the in-suite backend in `test/integration/foreground-external-execution.test.ts:48-104`: yield correlated lease `exited` facts from the spawned host's process `exit` event, and make `close(handle, "explicit_cleanup")` physically terminate its own fixture. Independently observe direct child exit before fixture finalization; for forced cases record child PID and an independent exit/liveness observation rather than inferring it from host exit. Retain emergency finalizer kills strictly after assertions. Do not use recording-only `src/execution-backend/testkit.ts` as process proof.
- [ ] Add actual-process cases for error-shaped post-abort settlement, success/error/interrupted terminal variants, responsive child/host exit, terminal timeout and busy shutdown forced cleanup, and before-ready versus after-ready cancellation. Assert shutdown/exit before owner settlement and before finalizer cleanup, recorded `explicit_cleanup`, inactive owner, and repeated `finish("retained")` without `External execution finish failed`. Inject small deadlines in existing dependency seams; no test should wait the production budget.
- [ ] Add two-model orchestration rows for rate-limit and timeout failures written before accepted cancellation. Assert exactly one child/model attempt, immutable durable failed result, zero-exit `paused` with `interrupted: true`, and no `External execution attempt failed` or `External execution finish failed`. Add non-interrupted fallback through two attempts on the same host, and retain success delivery ordering.
- [ ] Add foreground finish-selection rows for clean confirmed interruption and warning-bearing uncertainty across durable success/failed/interrupted outcomes, plus annotated diagnostic rejection. Observe the selected disposition around the real owner: only `finish("retained")` is called, and its stored `{handle, retained}` is preserved for both retained true and false. Assert no host/control/close/release counter changes after attempt settlement, no delivered close and no generic finish error. Repeated retained finish must return the same outcome; Task 5's rejection of a first `finish("delivered")` exposes any incorrect caller selection. Retain non-interrupted delivered-after-persistence controls. Run the scoped command red.
- [ ] In `src/runs/foreground/external-single-attempt.ts`, preserve accepted interruption through finalization and restore `result.error` from `ExternalAttemptResult.error` afterward. For annotated diagnostic rejection from `runAttempt()`, let the typed error reach the orchestration catch unchanged; unit tests verify that identity/code contract and prompt-directory cleanup.
- [ ] In the external attempt catch of `src/runs/foreground/execution.ts:743-760`, map only annotated interruption to the existing zero-exit paused result with its original diagnostic and code. Preserve ordinary startup/attempt sanitization. Apply the diagnostic-exempt `attemptSucceeded` predicate and break the fallback loop immediately on `result.interrupted` before retryability checks; diagnostics are not failure input. Keep interrupted delivery false so finish remains retained, preserve stored `ExecutionSurfaceResult.retained`, and do not turn the stored finish outcome into generic failure. Do not bypass the owner's retained-only contract or mask its delivered rejection by treating it as a successful retained finish.
- [ ] Run the scoped command green. `test/unit/external-foreground-execution.test.ts` owns the invalid-session diagnostic timing; `test/integration/execution-child-host.test.ts` owns the controller-level pre-ready/active boundary. `test/unit/background-external-attempt.test.ts` and `test/integration/background-external-execution.test.ts` prove the parallel background contract. Visible mixed-child warnings and native/chain shapes are covered by `test/unit/formatters.test.ts`, `test/integration/single-execution.test.ts`, `test/integration/parallel-execution.test.ts`, and `test/integration/chain-execution.test.ts` in Task 4. Explicit resume remains a new child from the stored session, not a restart of the old OS process.
- [ ] Preserve local formatting. Run: `git diff --check -- src/runs/foreground/external-single-attempt.ts src/runs/foreground/execution.ts test/unit/external-single-attempt.test.ts test/integration/foreground-external-execution.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/runs/foreground/external-single-attempt.ts src/runs/foreground/execution.ts test/unit/external-single-attempt.test.ts test/integration/foreground-external-execution.test.ts && git commit -m "Preserve foreground interrupted cleanup diagnostics (ref #36)"`.

### Task 7: Preserve background paused state and prove real teardown

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Acceptance criteria" L47, § "Ownership and removal/addition inventory" L54, § "Ownership and removal/addition inventory" L70, § "Ownership and removal/addition inventory" L75, § "Durable interruption and races" L81, § "Durable interruption and races" L83, § "Bounded cleanup and exit evidence" L94, § "Bounded cleanup and exit evidence" L102, § "Visible state and retained surfaces" L108, § "Visible state and retained surfaces" L110, § "Visible state and retained surfaces" L112, § "Visible state and retained surfaces" L114, § "Visible state and retained surfaces" L116, § "Visible state and retained surfaces" L118, § "Errors and edge cases" L151, § "Errors and edge cases" L152, § "Errors and edge cases" L160, § "Errors and edge cases" L162, § "Tests" L166, § "Tests" L168, § "pi-cohort" L176, § "pi-cohort" L178, § "pi-cohort" L179, § "pi-cohort" L181, § "pi-cohort" L184, § "pi-cohort" L185, § "pi-cohort" L187, § "pi-cohort" L188

**Files:**
- Modify: `src/runs/background/external-attempt.ts`
- Modify: `src/runs/background/subagent-runner.ts`
- Modify: `test/unit/background-external-attempt.test.ts`
- Modify: `test/integration/background-external-execution.test.ts`
- Test: `test/unit/background-external-attempt.test.ts`
- Test: `test/integration/background-external-execution.test.ts`
- Test: `test/unit/async-resume.test.ts`
- Test: `test/integration/async-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/background-external-attempt.test.ts test/integration/background-external-execution.test.ts test/unit/async-resume.test.ts test/integration/async-execution.test.ts`
- baseline: 9113ee5 pass
- via: `runExternalBackgroundAttempt`, `mapExitCode`, `runSingleStep`, `runAttempt()`, `finish()`, background status/result publication, explicit resume

Decision: the existing optional flag in background result/status projections is sufficient; do not add a schema. Task 5's owner boolean and annotated diagnostic error represent accepted cancellation even when the durable terminal remains failed. `mapExitCode` must check that boolean before the durable outcome; interruption is zero exit. Exempt its diagnostic in the existing attempt-success boolean while stopping cancellation independently, rather than recording a failed attempt or treating it as completed review work. Background has no dedicated diagnostic-code field: preserve `result_missing` through the existing error text and original internal Error, not a new public field (`external-execution.ts:69-80`, `subagent-runner.ts:242-256`).

Decision: zero exit is not delivery for an interrupted external child. The existing finish selector in `src/runs/background/subagent-runner.ts:1146-1158` uses only final exit and acceptance; add `!finalResult?.interrupted` to that selector. Every accepted interruption calls `finish("retained")`, never `finish("delivered")`, and projects the stored `{handle, retained}` without new cleanup. This consumes Task 5's retained-only owner contract and Spec L102 without relying on an error being present or on the durable outcome.

Decision: preserve main's replay event contract in `src/runs/background/external-attempt.ts:117-140`: an assistant message emits one `message_start`, then tool-start events, then `message_end`; tool results keep their existing end events. The exact ordering and lifecycle composition regressions in `test/unit/background-external-attempt.test.ts:352-535` remain in the full scoped command. Interruption mapping does not remove this event or rewrite replay synthesis.

- [ ] Run the scoped command first, including read-only resume/native regressions.
- [ ] Replace the obsolete interrupted-to-exit-1 unit expectation with a table for interrupted success/failed/interrupted durable outcomes, cleanup warning, absent warning, retained surface true/false, and original typed diagnostic rejection. Check zero exit, `interrupted: true`, original `error`/code and no ordinary failure promotion. Preserve non-interrupted failed-to-nonzero mapping and launch-error behavior. Keep assistant `message_start` ordering and the external replay composition assertions intact while extending the existing suite.
- [ ] Upgrade `makeBackend` and process fixtures inside `test/integration/background-external-execution.test.ts:35-157`: emit matching host lease `exited` facts from process `exit`; implement physical `close(handle, "explicit_cleanup")`; observe direct child exit independently before finalizer kills. Assert both process exits before accepting graceful or forced cleanup, never from the close counter alone. `src/execution-backend/testkit.ts` stays recording-only and unchanged. The sibling foreground suite `test/integration/foreground-external-execution.test.ts` independently supplies the other actual-process proof.
- [ ] Extend existing `runSingleStep` fixtures (`:321-648`) and the in-suite runner invocation to cover reported error-shaped interruption, warning-bearing uncertainty, missing terminal/protocol rejection and two configured models with a durable retryable rate-limit/timeout failure preceding cancellation. Assert exactly one attempt, shutdown/exit before paused publication, no generic `External execution attempt failed` or `External execution finish failed`, and unchanged durable evidence. Add non-interrupted two-attempt host reuse and close-after-delivery controls.
- [ ] Add runner finish-selection cases for clean confirmed zero-exit interruption and unconfirmed zero-exit interruption with diagnostics, across durable success/failed/interrupted outcomes and annotated diagnostic rejection. Assert the runner selects `finish("retained")`, never `finish("delivered")`, and preserves the stored `{handle, retained}` with retained true/false. Use the real owner's retained-only rejection plus the in-suite lifecycle counters to expose an erroneous delivered call: the result must stay zero-exit/paused with no generic finish error, no delivered close and no extra shutdown/release after attempt settlement. Repeated retained finish returns the same stored outcome. Keep a non-interrupted zero-exit success case selecting delivered after output persistence. Run the scoped command red.
- [ ] In `src/runs/background/external-attempt.ts`, make `mapExitCode` return zero for `attemptResult.interrupted`, preserve that flag and `ExternalAttemptResult.error`, and otherwise retain current success/failure rules. Propagate annotated rejection unchanged to the existing runner catch; use Task 5's predicate there to preserve the diagnostic and existing code in zero-exit paused state. Leave `synthesizeChildEvents` and its `message_start` replay event unchanged.
- [ ] In `src/runs/background/subagent-runner.ts:808-934`, exclude interrupted results from error-bearing-zero-exit promotion, compute existing attempt success as `effectiveExitCode === 0 && (run.interrupted || !error)`, and stop fallback immediately on accepted interruption before retry checks. Preserve non-interrupted blocked/completion-guard/failure behavior. In finish, compute `isDelivered` as `effectiveFinalExitCode === 0 && !acceptanceCanFailRun && !finalResult?.interrupted`; select retained for every accepted interruption regardless of diagnostic or durable outcome, and carry the stored `ExecutionSurfaceResult.retained` outcome without generic finish substitution for interruption. Do not mask a rejected delivered call with a fabricated successful retained result.
- [ ] Audit and adjust the existing sequential, static-parallel and dynamic-chain result/status projections in the same runner: keep `interrupted: true` in public/status and persisted child results, preserve diagnostic `error`, publish `paused`, prevent warning-induced fail-fast or next model attempts, and retain completed siblings. Cover these projections with in-suite process/runner tests, including mixed children and persisted result reload. Keep optional-field absence for ordinary results; no new public fields or persisted state. Preserve the exact warning `Process termination could not be confirmed; manual cleanup may be required.` and distinct missing-result/protocol diagnostics.
- [ ] Run the scoped command green. The read-only `test/unit/async-resume.test.ts` and `test/integration/async-execution.test.ts` protect unchanged selection/error rules and launching a new child from its stored session. `test/unit/external-foreground-execution.test.ts` owns diagnostic-after-cleanup timing; `test/unit/external-single-attempt.test.ts` owns foreground `attemptSucceeded`/normalization counterparts. Rendering is covered by `test/unit/formatters.test.ts`, `test/integration/single-execution.test.ts`, `test/integration/parallel-execution.test.ts` and `test/integration/chain-execution.test.ts`. Preserve `result.error` and ordinary native pause text rather than globally editing native finalization.
- [ ] Preserve local formatting. Run: `git diff --check -- src/runs/background/external-attempt.ts src/runs/background/subagent-runner.ts test/unit/background-external-attempt.test.ts test/integration/background-external-execution.test.ts`. Expected: no whitespace errors.
- [ ] Commit: `git add src/runs/background/external-attempt.ts src/runs/background/subagent-runner.ts test/unit/background-external-attempt.test.ts test/integration/background-external-execution.test.ts && git commit -m "Keep interrupted background results paused with diagnostics (ref #36)"`.

## Wave 4 - Paired contract documentation

Depends on Waves 1-3: document the implemented producer/consumer contract, with no remaining implementation edits. One task owns both CHANGELOGs and guide updates to avoid hub-document collisions.

### Task 8: Document paused cleanup and paired completion semantics

**TDD scenario:** Trivial change - documentation review against implemented behavior.

**Spec:** doc/specs/2026-10-29-gh-36-interrupt-child-teardown.md § "Ownership and removal/addition inventory" L75, § "pi-gauntlet compatibility boundary" L133, § "Predecessor scope" L137, § "Predecessor scope" L141, § "Predecessor scope" L142, § "Predecessor scope" L144, § "Documentation impact" L206, § "Documentation impact" L209, § "Verification boundary" L202

**Files:**
- Modify: `doc/observability.md`
- Modify: `doc/programmatic-api.md`
- Modify: `CHANGELOG.md`
- Modify: `/Users/jacek/repos/pi-gauntlet/doc/configuration.md`
- Modify: `/Users/jacek/repos/pi-gauntlet/CHANGELOG.md`
- Modify: `/Users/jacek/repos/pi-gauntlet/doc/specs/2026-06-11-closure-review-verify-gate.md`
- Modify: `/Users/jacek/repos/pi-gauntlet/doc/specs/2026-08-12-execution-fidelity-hardening.md`

**Tests:**
- none: documentation

Decision: amend the existing communication/recovery guides under the materiality rule in `reference/documentation-impact.md`, not README/AGENTS routes or a parallel guide. The existing banner in local `doc/specs/2026-09-06-mux-execution-backends.md:3` already supersedes only the `Lifecycle, fallback, and retention` interrupted row; retain it. Sibling predecessor banners need the matching targeted notices. Use sibling primary `main` directly, per `current main ../pi-gauntlet/ (main checkout)`, with no copied core spec.

- [ ] Amend `doc/observability.md`'s reporting/host protocol section: durable applied-abort classification, immutable prior terminal, child and host exit evidence, two absolute budgets, one-shot cleanup before settlement, warning on unconfirmed exit, and retained boolean as last known close outcome rather than proof of life or inspectability. Distinguish genuine exit from shutdown acknowledgement, socket closure and surface closure.
- [ ] Amend `doc/programmatic-api.md`'s interrupted-result/recovery contract: zero-exit paused diagnostics, optional interruption flag in public/persisted child results, exact manual-cleanup warning, no warning-induced fallback/fail-fast, normal retention versus forced cleanup and explicit resume as a new child. Keep clean pause behavior and ordinary failures unchanged.
- [ ] In the sibling `doc/configuration.md`, amend completion definitions near closure/cadence: exact agent, zero exit and no explicit interruption; per-child mixed-batch/errored-chain credit; shared live/replay semantics; attempted-work fix budgets, grants, nudges and telemetry unchanged. Add no setting, schema, dependency or version requirement.
- [ ] Add narrowly scoped supersession notices to sibling `doc/specs/2026-06-11-closure-review-verify-gate.md` for `Qualifying dispatch` and `doc/specs/2026-08-12-execution-fidelity-hardening.md` for completed cadence only. Link to the coordinated core spec in pi-cohort; preserve existing supersession notices and all unrelated predecessor scopes. Do not change the approved core spec or local predecessor body.
- [ ] Add unreleased entries to both `CHANGELOG.md` files using each repository's convention. Name both sides of the paired contract and reference the ticket; do not bump a version. Record the boundary in product wording: fake-backend actual-process tests prove core behavior only; the live cmux runtime and reporter's installed adapter version remain unavailable, so neither live reproduction nor companion retention compliance is claimed. Carry this limitation into delivery evidence after verification.
- [ ] Review links and smallest touched documentation units against the implemented code. Preserve Markdown style; run scoped whitespace checks in each checkout: `git diff --check -- doc/observability.md doc/programmatic-api.md CHANGELOG.md` and, in the sibling, `git diff --check -- doc/configuration.md CHANGELOG.md doc/specs/2026-06-11-closure-review-verify-gate.md doc/specs/2026-08-12-execution-fidelity-hardening.md`. Expected: no whitespace errors. No Markdown formatter is configured.
- [ ] In pi-cohort, commit: `git add doc/observability.md doc/programmatic-api.md CHANGELOG.md && git commit -m "Document interrupted cleanup and paired guard semantics (ref #36)"`.
- [ ] In sibling primary main, commit: `git add doc/configuration.md CHANGELOG.md doc/specs/2026-06-11-closure-review-verify-gate.md doc/specs/2026-08-12-execution-fidelity-hardening.md && git commit -m "Document interrupted completion exclusions (ref jjuraszek/pi-cohort#36)"`.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L39 | AC1: applied abort/error shape writes one interrupted terminal and owner resolves | Task 1, Task 5 |
| § "Acceptance criteria" L41 | AC2: unconditional child shutdown, host exit and inactive attempt | Task 5, Task 6 |
| § "Acceptance criteria" L43 | AC3: bounded fallback with actual exit, explicit cleanup and retained finish | Task 5, Task 6 |
| § "Acceptance criteria" L45 | AC4: error without abort remains failed | Task 1 |
| § "Acceptance criteria" L47 | AC5: background status paused without generic lifecycle failures, host exits | Task 7 |
| § "Ownership and removal/addition inventory" L54 | Reuse existing mechanisms; no schema/protocol/supervisor expansion | Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7 |
| § "Ownership and removal/addition inventory" L58 | Remove rejection-before-shutdown and busy retained re-entry | Task 5 |
| § "Ownership and removal/addition inventory" L59 | Remove post-ready launch cancellation forwarding | Task 2 |
| § "Ownership and removal/addition inventory" L60 | Remove exit-only completion predicates | Task 3 |
| § "Ownership and removal/addition inventory" L66 | Reporter alone classifies new durable terminals | Task 1 |
| § "Ownership and removal/addition inventory" L67 | Controller separates launch/control, observes exits and disposes resources | Task 2 |
| § "Ownership and removal/addition inventory" L68 | Owner completes bounded cleanup before settling | Task 5 |
| § "Ownership and removal/addition inventory" L69 | Foreground normalization/rejection/fallback preserve interruption | Task 6 |
| § "Ownership and removal/addition inventory" L70 | Background mapping, promotion, retries, projections and status | Task 7 |
| § "Ownership and removal/addition inventory" L71-L72 | Shared formatter and every existing pause-text caller | Task 4 |
| § "Ownership and removal/addition inventory" L73 | Sibling predicates shared by live handling and reconstruction | Task 3 |
| § "Ownership and removal/addition inventory" L75 | Existing suites/docs only, no helpers/state/settings/dependencies | Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8 |
| § "Durable interruption and races" L79 | Applied correlated abort drives classification; error text alone does not | Task 1 |
| § "Durable interruption and races" L81 | Immutable terminal versus accepted cancellation; stop external fallback | Task 1, Task 5, Task 6, Task 7 |
| § "Durable interruption and races" L83 | Cleanup precedes original diagnostic rejection; adapters preserve paused diagnostic | Task 5, Task 6, Task 7 |
| § "Bounded cleanup and exit evidence" L87-L90 | Two absolute budgets from accepted interruption | Task 5 |
| § "Bounded cleanup and exit evidence" L92 | Bound every await, close once, no late mutation or reset | Task 5 |
| § "Bounded cleanup and exit evidence" L94 | Teardown inside attempt; existing error channel, not durable cleanup state | Task 5, Task 6, Task 7 |
| § "Bounded cleanup and exit evidence" L96 | Child shutdown regardless of outcome, then host, then physical fallback | Task 5 |
| § "Bounded cleanup and exit evidence" L98 | Correlated child and host exit facts, never closure/ack inference | Task 2, Task 5 |
| § "Bounded cleanup and exit evidence" L100 | Responsive no-host-proof shutdown warns without destructive close | Task 5 |
| § "Bounded cleanup and exit evidence" L102 | One-shot cleanup and stored `{handle, retained}` via `finish("retained")` after confirmation or uncertainty; first `finish("delivered")` rejects without host/backend contact; conflict/ID errors remain | Task 5 |
| § "Bounded cleanup and exit evidence" L102 | Both adapters select `finish("retained")`, never `finish("delivered")`, for every accepted interruption, even zero exit and regardless of diagnostics or durable outcome; preserve stored `{handle, retained}` | Task 6, Task 7 |
| § "Bounded cleanup and exit evidence" L104 | Observe before disposing; bound release; socket SIGTERM is not proof | Task 2, Task 5 |
| § "Visible state and retained surfaces" L108 | Paused zero-exit optional interruption survives cleanup uncertainty | Task 4, Task 6, Task 7 |
| § "Visible state and retained surfaces" L110 | Exact manual-cleanup warning in owner, results and visible output | Task 4, Task 5, Task 6, Task 7 |
| § "Visible state and retained surfaces" L112 | Diagnostic is not failure input; preserve flag through public/persisted projections | Task 6, Task 7 |
| § "Visible state and retained surfaces" L114 | Preserve diagnostics through normalization and show each affected child | Task 4, Task 6, Task 7 |
| § "Visible state and retained surfaces" L116 | Retained boolean is last known close outcome, not process proof | Task 5, Task 6, Task 7 |
| § "Visible state and retained surfaces" L118 | Preserve delivery/fallback/native/resume; no automatic reaper | Task 5, Task 6, Task 7 |
| § "pi-gauntlet compatibility boundary" L122 | Exact agent plus zero exit plus no explicit interruption, live and replay | Task 3 |
| § "pi-gauntlet compatibility boundary" L126 | Per-child mixed batches and earlier successes in errored chains | Task 3 |
| § "pi-gauntlet compatibility boundary" L127 | Interrupted reviewers/implementers get no completion credit | Task 3 |
| § "pi-gauntlet compatibility boundary" L128 | Preserve tie ordering, reconstruction, windows and disabled behavior | Task 3 |
| § "pi-gauntlet compatibility boundary" L129 | Empty management has no credit; resume/persisted shapes unchanged | Task 3 |
| § "pi-gauntlet compatibility boundary" L130 | Attempted work still spends fix rounds/credits and nudges | Task 3 |
| § "pi-gauntlet compatibility boundary" L131 | Telemetry still counts attempts/usage; partial council unchanged | Task 3 |
| § "pi-gauntlet compatibility boundary" L133 | Paired code/tests/docs before compatibility claim, no version change | Task 3, Task 8 |
| § "Predecessor scope" L137 | Local interrupted-row banner already records narrow supersession | Task 8 |
| § "Predecessor scope" L141 | Sibling closure predecessor notice scoped to qualifying dispatch | Task 8 |
| § "Predecessor scope" L142 | Sibling cadence notice preserves attempted work and other notices | Task 8 |
| § "Predecessor scope" L144 | Sibling uses selected primary main; no copied core spec | Task 8 |
| § "Errors and edge cases" L150 | Error-shaped applied-abort terminal resolves after cleanup | Task 1, Task 5 |
| § "Errors and edge cases" L151 | Prior terminal immutable; retryable failure cannot restart fallback | Task 1, Task 5, Task 6, Task 7 |
| § "Errors and edge cases" L152 | Invalid terminal rejects after cleanup, adapters retain diagnostics | Task 5, Task 6, Task 7 |
| § "Errors and edge cases" L153 | Busy/stalled shutdown reaches bounded physical cleanup | Task 5 |
| § "Errors and edge cases" L154 | Close without exit still warns | Task 5 |
| § "Errors and edge cases" L155 | Wrong exit identity or closure/ack is not proof | Task 2, Task 5 |
| § "Errors and edge cases" L156 | Missing host fact after responsive shutdown is non-destructive uncertainty | Task 5 |
| § "Errors and edge cases" L157 | Rejecting/nonsettling/late close and release stay bounded | Task 5 |
| § "Errors and edge cases" L158 | Launch cancellation before readiness differs from active control | Task 2, Task 6 |
| § "Errors and edge cases" L159 | Duplicate signals/settlement/finish are one-shot; conflicts remain errors | Task 1, Task 5 |
| § "Errors and edge cases" L160 | Public/persisted paused diagnostics do not promote failure or retry | Task 6, Task 7 |
| § "Errors and edge cases" L161 | Mixed-child warnings rendered; only completed children credited | Task 3, Task 4 |
| § "Errors and edge cases" L162 | Native/delivery/fallback/resume regression protection | Task 4, Task 6, Task 7 |
| § "Tests" L166 | Existing harnesses and deadlines; exit assertions before finalizer kills | Task 5, Task 6, Task 7 |
| § "Tests" L168 | Actual-process fixtures emit real host exits and physically close owned processes | Task 6, Task 7 |
| § "pi-cohort" L172 | AC1 reporter and owner regression seams | Task 1, Task 5 |
| § "pi-cohort" L173 | AC2 unconditional shutdown and genuine graceful exit proofs | Task 5, Task 6 |
| § "pi-cohort" L174 | AC3 timeout/busy fallback, explicit cleanup and stored finish proof | Task 5, Task 6 |
| § "pi-cohort" L175 | AC4 ordinary error classification regression | Task 1 |
| § "pi-cohort" L176 | AC5 background pause and host-exit proof | Task 7 |
| § "pi-cohort" L177 | Terminal immutability and duplicate control/settlement regressions | Task 1, Task 5 |
| § "pi-cohort" L178 | Two-model pre-cancel failure stops retry in both orchestration paths | Task 6, Task 7 |
| § "pi-cohort" L179 | Owner diagnostic timing and both adapter diagnostic propagation tests | Task 5, Task 6, Task 7 |
| § "pi-cohort" L180 | Wrong/missing exits and nonsettling operations do not prove death | Task 2, Task 5 |
| § "pi-cohort" L181 | Non-destructive uncertainty and retained boolean tests | Task 5, Task 6, Task 7 |
| § "pi-cohort" L182 | Pre-ready/active cancellation process regression | Task 2, Task 6 |
| § "pi-cohort" L183 | Owner/controller observation, disposal and one-shot timing tests | Task 2, Task 5 |
| § "pi-cohort" L184 | Diagnostics survive normalization, every visible child and persisted projection | Task 4, Task 6, Task 7 |
| § "pi-cohort" L185 | Successful delivery ordering, same-host fallback and retained interruption | Task 6, Task 7 |
| § "pi-cohort" L186 | Native and dynamic-chain shape regression coverage | Task 4 |
| § "pi-cohort" L187 | Explicit resume regression coverage | Task 7 |
| § "pi-cohort" L188 | Real process exit assertions precede emergency fixture cleanup | Task 6, Task 7 |
| § "pi-gauntlet" L192 | Live and all reconstruction event interruption tests | Task 3 |
| § "pi-gauntlet" L193 | Absent/false flag legacy success, nonzero/wrong agent exclusion | Task 3 |
| § "pi-gauntlet" L194 | Per-child mixed/errored-chain qualification and cadence ties | Task 3 |
| § "pi-gauntlet" L195 | Management/resume/exact-match/window/disabled regressions | Task 3 |
| § "pi-gauntlet" L196 | Interrupted attempted work retains spending and nudges | Task 3 |
| § "pi-gauntlet" L197 | Existing telemetry tests remain a read-only regression boundary | Task 3 |
| § "Verification boundary" L201 | Both repository verification entrypoints pass in authorized checkouts | Verification |
| § "Verification boundary" L202 | Fake-backend evidence is not a live cmux/companion claim | Task 8 |
| § "Documentation impact" L206 | Amend existing observability, API, configuration and both CHANGELOGs | Task 8 |
| § "Documentation impact" L209 | Material amendments in existing guides; no new routes/settings/procedure | Task 8 |
| § "Out of scope" L213 | TTL/session-end reaping, automatic resume and routine interrupt closure | waived: excluded by approved scope |
| § "Out of scope" L214 | Companion changes, new close capability, descendants and unobserved-death guarantees | waived: excluded by approved scope |
| § "Out of scope" L215 | New shapes/settings/protocol/schema and native rewrite | waived: excluded by approved scope |
| § "Out of scope" L216 | Reinterpreting attempted-work budgets/nudges/telemetry/partial council | waived: excluded by approved scope |
| § "Out of scope" L217 | Unsupported live reproduction or companion compliance claims | waived: excluded by approved scope |
