# Universal child stop handle Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop a child and its subtree by the id on its row without stopping siblings.

**Architecture:** Mint child UUIDs in owners and carry them through progress, results, full ancestry and separate nested child events. Resolve run and child ids through existing controls, async directories and authorized routes. Close admission before signalling and sweeping; native children watch their owner's pid while external attempts retain socket-based ownership.

**Tech Stack:** TypeScript, Node type stripping, node:test, TypeBox, Pi extension API and the local execution-backend testkit.

**Spec:** `doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md`
**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all`
**Ticket:** `#62`
**Baseline policy:** implement-local
Baseline jjuraszek/pi-cohort: f67a5af

---

## Provenance and conventions

Home is the supplied worktree of `jjuraszek/pi-cohort`, branch `gh-62-universal-child-stop-handle`; no companion is selected. Root `AGENTS.md` is the only walked AGENTS file; no CLAUDE file exists. All tasks inherit the spec's Rules list. The one-hop local documents and `.pi/gauntlet-overrides.md` were read; no extra directory rules or unresolved task paths remain. No Happy path table exists. Keep spec and plan home-owned.

Baseline provenance: HEAD `f67a5af` was initially clean. After the draft write the only status entry was `?? doc/plans/2026-11-11-gh-62-universal-child-stop-handle.md`. That path was admitted; the approved spec path was allowed but unchanged. Every measured command ran at the supplied home worktree. Before and after each run HEAD and this sole untracked entry were unchanged, with no staged files or generated repository artifacts. Original baseline exits/counts: Task 1 0/83, Task 2 0/127, Task 3 0/167, Task 4 0/182, Task 5 0/48, Task 6 0/75. For Tasks 2 and 5 the missing newly created test anchor was removed to derive the measured command. Task 4 requires a 300-second execution budget; its original baseline took about 214 seconds. Repair provenance: endpoint diff `f67a5af` to `f67a5af`, excluding `doc/specs/` and `doc/plans/`, exited 0; retained five unchanged command bullets at that same revision. Task 5's derived command was rerun after repairing its file declaration: exit 0, 48 tests, unchanged HEAD and sole untracked plan entry.

Implement-local amendment provenance: `jjuraszek/pi-cohort` home HEAD `c6214f3` had an empty initial status inventory and no staged files; parent In-flight: none. Read committed originals with home-relative `HEAD:doc/plans/2026-11-11-gh-62-universal-child-stop-handle.md` and `HEAD:doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md` before editing. Admit only those spec/plan paths for this maintenance. Retain all six unchanged Tests command bullets byte-for-byte at their measured `f67a5af` revision, including the two derived commands; no changed command or missing/invalid evidence requires execution. No tests rerun, no endpoint-tree equivalence or revision restamping. Task 1 gains the legacy projection boundary and regression obligations; other tasks change only shifted spec line anchors. Integrated tests, review and final verification remain mandatory.

The scoped commands below use the package's isolated node:test runner; integration loading adds `register-loader.mjs`. `package.json` defines the full-suite entrypoint and shared AGENTS check; no linter or formatter is configured. Each code task reviews its own imports, tabs and neighboring TypeScript style and runs a scoped whitespace check before committing. Do not install a style tool. The full suite remains a later verify-phase gate, not a task command. All tests are local: no paid provider or external service is authorized.

Rows and session names remain exactly six characters, including collisions, as the spec's approved default states. Completion alone extends to a shortest unique prefix. This is not a new unresolved decision. Task 7 follows the installed forge-skill authoring rules when editing the consumer skill: imperative voice and minimal targeted edits.

## Files

**Create:**
- `src/runs/shared/stop-control.ts` - shared admission and sweep primitives.
- `test/integration/owner-gone-exit.test.ts` - real prompt-runtime process harness.
- `test/integration/interrupt-id-errors.test.ts` - renamed lifecycle/error suite.

**Modify - records and execution:**
- `src/shared/types.ts`
- `src/extension/schemas.ts`
- `src/extension/index.ts`
- `src/extension/fanout-child.ts`
- `src/runs/shared/nested-path.ts`
- `src/runs/shared/nested-events.ts`
- `src/runs/shared/parallel-utils.ts`
- `src/runs/shared/pi-args.ts`
- `src/runs/shared/subagent-prompt-runtime.ts`
- `src/runs/foreground/attempt-finalization.ts`
- `src/runs/foreground/execution.ts`
- `src/runs/foreground/external-single-attempt.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- `src/runs/background/subagent-runner.ts`
- `src/runs/background/run-id-resolver.ts`
- `src/runs/background/async-job-tracker.ts`
- `src/slash/slash-commands.ts`

**Modify - display:**
- `src/tui/render.ts`
- `src/tui/render-helpers.ts`
- `src/runs/shared/nested-render.ts`
- `src/runs/background/run-status.ts`
- `src/runs/background/async-status.ts`

**Modify - tests:**
- `test/unit/fixtures/subagent-params.shape.json`
- `test/unit/schemas.test.ts`
- `test/unit/nested-events.test.ts`
- `test/unit/pi-args.test.ts`
- `test/unit/subagent-prompt-runtime.test.ts`
- `test/unit/nested-control.test.ts`
- `test/unit/parallel-utils.test.ts`
- `test/unit/run-id-resolver.test.ts`
- `test/unit/widget-nested-render.test.ts`
- `test/unit/render-helpers.test.ts`
- `test/unit/run-status.test.ts`
- `test/integration/child-session-name.test.ts`
- `test/integration/foreground-external-execution.test.ts`
- `test/integration/foreground-in-flight-control.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/integration/top-level-async.test.ts`
- `test/integration/async-execution.test.ts`
- `test/integration/background-external-execution.test.ts`
- `test/integration/detached-external-orchestration.test.ts`
- `test/integration/async-job-tracker.test.ts`
- `test/integration/slash-commands.test.ts`
- `test/integration/render-widget.test.ts`
- `test/integration/async-status.test.ts`

**Modify - documentation:**
- `README.md`
- `doc/commands.md`
- `doc/programmatic-api.md`
- `CHANGELOG.md`
- `skills/pi-cohort/SKILL.md`
- `skills/pi-cohort/reference/config-fields.md`

**Delete:**
- `test/integration/indexed-interrupt-errors.test.ts` - move its coverage to the new child-id suite.

No release, package bump, backend protocol redesign, sibling changes or predecessor-spec rewrite is part of this plan.

## Wave 1 - Durable identity and nested records

### Task 1: Carry child identity and live child records
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - run existing tests, add record regressions, implement, rerun.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L120, § "Inventory" L125-L127, § "Inventory" L133-L135, § "Inventory" L137, § "Inventory" L139-L141, § "Inventory" L147, § "Identity" L153-L157, § "Live records" L187-L198, § "Live records" L200, § "Tests" L311-L313, § "Acceptance criteria" L67-L72

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/extension/schemas.ts`
- Modify: `src/extension/index.ts`
- Modify: `src/extension/fanout-child.ts`
- Modify: `src/runs/shared/nested-path.ts`
- Modify: `src/runs/shared/nested-events.ts`
- Modify: `src/runs/foreground/attempt-finalization.ts`
- Modify: `src/runs/foreground/execution.ts`
- Modify: `src/runs/foreground/subagent-executor.ts`
- Modify: `src/runs/foreground/chain-execution.ts`
- Modify: `src/runs/background/async-execution.ts`
- Modify: `src/runs/background/subagent-runner.ts`
- Modify: `test/unit/fixtures/subagent-params.shape.json`
- Modify: `test/unit/schemas.test.ts`
- Modify: `test/unit/nested-events.test.ts`
- Test: `test/unit/schemas.test.ts`
- Test: `test/unit/nested-events.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/nested-events.test.ts test/unit/schemas.test.ts`
- baseline: f67a5af pass
- via: `sanitizeNestedPath`, `encodeNestedPathEnv`, `parseNestedPathEnv`, `sanitizeInternalSummary`, `writeNestedEvent`, `mergeSummary`, `SubagentParams`

Decision: UUID allocation belongs to dispatch record creation, not `initializeAttempt` (`src/runs/foreground/attempt-finalization.ts:103`); retries reuse the owner's value. Keep the unrelated backend child correlation untouched. Indices remain ordering/resume metadata.

- [ ] Run Tests unchanged; confirm green before editing.
- [ ] Add schema tests for top-level and task-item labels; update `test/unit/fixtures/subagent-params.shape.json` from the exact declared schema. Retain the index field, change its description to resume-only, and introduce no management-config field.
- [ ] Add six-entry child-bearing ancestry round-trip and unsafe-path rejection tests. Add live records past depth 3, 12 steps and 16 children, a settled ancestor with a live descendant and settled-only truncation.
- [ ] Add legacy-input regressions in `test/unit/nested-events.test.ts` through `sanitizeSummary` and `projectNestedEvents`: omit id-less pending, running and settled steps; mixed legacy/identified steps retain exactly the supplied child ids, enclosing run records and independently recorded descendants. Assert no run-id substitution, index-derived or minted identity, no deletion of stored legacy artifacts, and no projected tokenless child available for a row, completion or child-id target. Update the ordinary `child()` fixture at line 79 to supply an owner's child id; retain deliberately id-less fixtures only for legacy cases. Run Tests and confirm red.
- [ ] Add 17-child publication with maximum `sessionFile`/`currentPath`, identity-only oversized child fallback, child-before-run deferral, older-event rejection, terminal-state non-regression, replay and index ordering. Run Tests and confirm red.
- [ ] Add `id: string` and `label?: string` to `AgentProgress`, `SingleResult` and `NestedStepSummary`; add id to `AsyncStatus["steps"][number]`, preserving its label. Add `children?: NestedRunSummary[]` to progress and initialize `retainedNestedRoutes` on `SubagentState` in both extension entrypoints.
- [ ] Add `childId?: string` to `NestedPathEntry` and `NestedRunAddress.path`. Remove `MAX_NESTED_PATH_ENTRIES` slicing in `sanitizeNestedPath`; retain path-id validation. Preserve child id through encoding, parsing and `sanitizeInternalSummary`.
- [ ] Add the UUID-keyed owner shape `children: Map<string, { agent: string; label?: string; index: number; state: "pending" | "running" | "completed" | "failed" | "interrupted"; stopRequested?: true; interrupt?: () => boolean }>` and `stopping?: true`. Wire identity here; Tasks 3 and 4 remove old stop maps with their consumers.
- [ ] Mint `randomUUID()` before spawn: one per single call, `tasks[]` item after `count`, sequential step, static `parallel` item and materialized dynamic item. Give queued records ids immediately; move `pending` to `running` at launch, then `completed`, `failed` or `interrupted`. Copy owner ids/labels through `RunSyncOptions`, progress, results and background steps; never remint during fallback.
- [ ] Carry labels through all five shapes, retaining dynamic interpolation and separating group labels from child labels. Stop tokens use six characters of the full id, never index.
- [ ] Replace run-record embedded `steps` with `subagent.nested.child`. Run records retain `subagent.nested.started`, `.updated`, `.completed` and complete `path`; child records carry `runId`, `id`, `agent`, `label`, `status`, flat `index` and current step fields. Keep `MAX_EVENT_BYTES`; use `sanitizeStep` field caps and identity-only fallback, not a larger limit.
- [ ] At the `sanitizeStep` projection boundary (`src/runs/shared/nested-events.ts:210-234`, consumed at `:249-252`), require the supplied owner's child id before admitting a `NestedStepSummary`; omit only id-less legacy steps regardless of state. Never mint, derive or substitute identity, render a tokenless child, delete stored legacy artifacts, or infer missing identity. Preserve valid enclosing runs and independently recorded descendants. This explicit legacy compatibility break does not relax caps or universal row-prefix rules for valid live entries; upgraded owners still provide ids from creation.
- [ ] Merge by child id in index order: compare `ts`, preserve terminal state, make replay idempotent and leave children whose run is absent unprocessed for later projection. Retain the 1000-name `processedEvents` window.
- [ ] Keep live entries and ancestors with live descendants through every sanitize, registry merge and step-attach cap. Keep `MAX_DEPTH`, `MAX_STEPS`, `MAX_CHILDREN` effective for settled-only entries and retain the `agents` metadata cap. Task 6 owns rendering caps.
- [ ] Publish child creation/state changes from owners, not UI `onUpdate`: nested foreground children including dynamic items publish headlessly; background status writes publish changed children. Root foreground children remain available in process without redundant events.
- [ ] Rename nested request/result `targetRunId` to `targetId` in types, parsers, writers and immediate call sites. Preserve capability checks; Task 3 adds routing and owner-only answering.
- [ ] Rerun Tests; review producer call sites, manually match local TypeScript style, and run scoped `git diff --check` over the task's files. Stage their explicit paths and commit with `git commit -m "Add stable child identities and nested child records (#62)"`.

Source seams required by the anchored inventory: `src/runs/foreground/subagent-executor.ts`, `:2270-2276`, `resume`, `interrupt`, `src/tui/render.ts`, `formatNestedWidgetLines`, `:767-806`, `fitWidgetLineBudget`, `:900-912`, `src/runs/shared/nested-render.ts`, `maxDepth`, `maxLines`, `formatNestedRunLines`, `:70-106`, `src/runs/foreground/subagent-executor.ts:251`, `src/runs/background/run-status.ts:234, 240`, `src/runs/background/async-status.ts:354, 358`, `src/runs/shared/nested-events.ts`, `:170, 232, 262, 291`, `:251, 872`, `:232, 291, 384, 396, 804`, `:274`, `src/runs/shared/nested-path.ts:4, 26-37`, `src/runs/shared/nested-events.ts:249-252, 857-872`, `src/runs/foreground/subagent-executor.ts:2476-2533`, `### Live records`, `src/shared/types.ts`, `src/shared/types.ts:623`, `PI_SUBAGENT_PARENT_PATH`, `src/runs/shared/pi-args.ts:199-219`, `src/runs/foreground/external-single-attempt.ts:77`, `childInterrupts`, `src/runs/shared/nested-events.ts:57-77, 647-702, 741-754`, `src/runs/foreground/subagent-executor.ts:536-557`, `renderSubagentResult`, `### Rows`, `### Resolving a stop id`, `TaskItem`, `src/extension/schemas.ts:146-156, 255`, `src/runs/background/subagent-runner.ts:1428, 1447, 1459, 1985`, `src/runs/foreground/subagent-executor.ts:1462`, `## Errors and edge cases`, `src/runs/shared/nested-events.ts:296, 600-643`, `src/runs/shared/nested-events.ts:344-351`, `:614`, `maxSubagentDepth`, `:210-234`, `started`, `src/runs/foreground/subagent-executor.ts:2476-2554`, `updated`, `src/runs/background/subagent-runner.ts:1498-1553`, `children`, `test/unit/run-id-resolver.test.ts`, `test/unit/pi-args.test.ts`.

## Wave 2 - Spawn environment and native liveness

Depends on Wave 1: child identity exists before attempts are launched.

### Task 2: Propagate child ancestry and enforce owner liveness
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code plus a new real-process regression.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L129, § "Inventory" L133-L135, § "Inventory" L144, § "Identity" L159, § "No zombies" L253-L255, § "Errors and edge cases" L297-L299, § "Tests" L313, § "Tests" L325-L327, § "Out of scope" L348

**Files:**
- Modify: `src/runs/shared/pi-args.ts`
- Modify: `src/runs/shared/subagent-prompt-runtime.ts`
- Modify: `src/runs/foreground/execution.ts`
- Modify: `src/runs/foreground/external-single-attempt.ts`
- Modify: `src/runs/background/subagent-runner.ts`
- Modify: `test/unit/pi-args.test.ts`
- Modify: `test/unit/subagent-prompt-runtime.test.ts`
- Modify: `test/integration/child-session-name.test.ts`
- Modify: `test/integration/foreground-external-execution.test.ts`
- Create: `test/integration/owner-gone-exit.test.ts`
- Test: `test/unit/pi-args.test.ts`
- Test: `test/unit/subagent-prompt-runtime.test.ts`
- Test: `test/integration/child-session-name.test.ts`
- Test: `test/integration/foreground-external-execution.test.ts`
- Test: `test/integration/owner-gone-exit.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/pi-args.test.ts test/unit/subagent-prompt-runtime.test.ts test/integration/child-session-name.test.ts test/integration/foreground-external-execution.test.ts test/integration/owner-gone-exit.test.ts`
- baseline: f67a5af pass via `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/pi-args.test.ts test/unit/subagent-prompt-runtime.test.ts test/integration/child-session-name.test.ts test/integration/foreground-external-execution.test.ts`
- via: `buildPiArgs`, `registerSubagentPromptRuntime`, `checkPidLiveness`, `runChildHost`

Decision: reuse `checkPidLiveness` from `src/runs/background/stale-run-reconciler.ts:309-321`; permission errors are `unknown`, not death. Keep the backend protocol's `childId` unchanged. The mock child loads no extension, so a separate Node process must load the actual prompt runtime with a stub Pi API.

- [ ] Run existing anchors, then add native pid/ancestry/name assertions, six-entry path round-trip, and external env override with inherited nonempty owner pid. Run the tests and confirm red.
- [ ] Pass the minted id into `buildPiArgs` from native/external call sites. Append full ancestry with `childId`; preserve `PI_SUBAGENT_PARENT_PATH`. Session names use agent, six characters of child id and existing parent label, replacing run prefix/index: `scout 3f9a1c from parent`.
- [ ] Set `PI_SUBAGENT_OWNER_PID` to the spawning process pid for native attempts; set it empty for external attempts after merging `process.env`. Cover foreground/background callers. Detached runners themselves have no owner monitor.
- [ ] Add a once-per-runtime, unref'd 1000 ms poll in the prompt runtime. `alive`/`unknown` do nothing; `dead` sends self SIGTERM once and starts a 3000 ms fallback calling `process.exit(143)`. Empty values disable monitoring. Clear owned timers on shutdown.
- [ ] Add the real-process harness inside the new test: kill an actual owner and require child exit within 5000 ms, then its native child within 5000 ms of that exit. Exercise forced-exit fallback, unknown liveness and empty env without relying on `test/support/mock-pi-script.mjs`. Use test temp roots and tear down surviving processes.
- [ ] With the local testkit assert owner socket close terminates an external attempt and explicit attempt interruption still uses `abort` then `shutdown`. Retain `backend.close(handle, "explicit_cleanup")` fallback. Task 4 tests child-id background routing; do not redesign `runChildHost` or the execution protocol.
- [ ] Run Tests green; review imports/tabs and run `git diff --check -- src/runs/shared/pi-args.ts src/runs/shared/subagent-prompt-runtime.ts src/runs/foreground/execution.ts src/runs/foreground/external-single-attempt.ts src/runs/background/subagent-runner.ts test/unit/pi-args.test.ts test/unit/subagent-prompt-runtime.test.ts test/integration/child-session-name.test.ts test/integration/foreground-external-execution.test.ts test/integration/owner-gone-exit.test.ts`. Stage these paths and commit with `git commit -m "Exit native children when their owner disappears (#62)"`.

Contract seams: `src/runs/shared/pi-args.ts:89-90`, `id: string`, `AgentProgress`, `SingleResult`, `AsyncStatus["steps"][number]`, `NestedStepSummary`, `label?: string`, `src/shared/types.ts`, `label`, `src/shared/types.ts:623`, `childId?: string`, `NestedPathEntry`, `NestedRunAddress.path`, `sanitizeNestedPath`, `encodeNestedPathEnv`, `parseNestedPathEnv`, `sanitizeInternalSummary`, `src/runs/shared/pi-args.ts:199-219`, `src/runs/foreground/external-single-attempt.ts:77`, `children: Map<string, { agent: string; label?: string; index: number; state: "pending" | "running" | "completed" | "failed" | "interrupted"; stopRequested?: true; interrupt?: () => boolean }>`, `childInterrupts`, `stopping?: true`, `src/runs/shared/pi-args.ts:144-146`, `executionBackend`, `auto`, `doc/configuration.md:150-161`, `src/runs/foreground/external-single-attempt.ts:77-113`, `src/runs/background/subagent-runner.ts:804, 956`, `src/execution-backend/child-host-runtime.ts:64`, `interruptSignal`, `src/runs/shared/external-execution.ts:275-336`, `test/unit/nested-events.test.ts`, `test/integration/background-external-execution.test.ts`. Accepted risks: pid reuse can evade death detection; Windows self-SIGTERM exits without cleanup.

## Wave 3 - Foreground ownership and target resolution

Depends on Waves 1-2: records and spawn ancestry are available. Introduce the resolver here so child-id foreground tests can pass before slash/tracker integration.

### Task 3: Route stops through foreground owners and shared teardown
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - migrate stop scenarios from indices to child ids.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L120, § "Inventory" L122-L124, § "Inventory" L133-L135, § "Inventory" L136-L138, § "Inventory" L142-L143, § "Inventory" L145, § "Resolving a stop id" L204-L216, § "Resolving a stop id" L220, § "Stopping a target" L224-L245, § "No zombies" L251, § "No zombies" L257, § "Predecessor scope" L267, § "Paid or external actions" L271, § "Errors and edge cases" L275-L289, § "Errors and edge cases" L293, § "Errors and edge cases" L301-L302, § "Tests" L307-L310, § "Tests" L316-L318, § "Acceptance criteria" L80, § "Out of scope" L343

**Files:**
- Create: `src/runs/shared/stop-control.ts`
- Modify: `src/runs/shared/parallel-utils.ts`
- Modify: `src/runs/background/run-id-resolver.ts`
- Modify: `src/runs/foreground/subagent-executor.ts`
- Modify: `src/runs/foreground/chain-execution.ts`
- Modify: `src/runs/foreground/execution.ts`
- Modify: `src/extension/fanout-child.ts`
- Modify: `test/unit/nested-control.test.ts`
- Modify: `test/unit/parallel-utils.test.ts`
- Modify: `test/integration/foreground-in-flight-control.test.ts`
- Modify: `test/integration/chain-execution.test.ts`
- Test: `test/unit/nested-control.test.ts`
- Test: `test/unit/parallel-utils.test.ts`
- Test: `test/integration/foreground-in-flight-control.test.ts`
- Test: `test/integration/chain-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/nested-control.test.ts test/unit/parallel-utils.test.ts test/integration/foreground-in-flight-control.test.ts test/integration/chain-execution.test.ts`
- baseline: f67a5af pass
- via: `resolveSubagentRunId`, `startNestedControlInboxListener`, `interruptNestedRun`, `runSync`, `executeChain`, `mapConcurrent`

Decision: preserve descendant authorization and run-only default for status/resume. Add an interrupt-specific target option/result carrying kind, full id and owner route rather than changing status/resume callers. The shared stop module is necessary because both foreground and detached owners execute identical admission/sweep semantics; no second coordinator or unauthorized filesystem search is added.

- [ ] Run Tests; migrate parallel/chain/nested tests to ids. Add red cases for child/run/bare stop, three targeted stops versus whole-run stop, pre-callback acceptance, duplicate stop, queued concurrency and abort/control-policy teardown.
- [ ] Add two-listener nested tests: only owner answers; non-owner leaves request untouched; nested child 1 stops while 0/2 finish and the parent receives outputs. Test no owner, reply delayed beyond 1000 ms and failed reply-write; teardown/record must precede persistence.
- [ ] Add a real headless nested foreground dispatch with static/dynamic children: each id reaches the registry while running, resolves and can be individually stopped with no UI callback.
- [ ] Implement shared empty stop records under the root route's `stops/`, path-safe full ids only. Admission checks own run id and every ancestry `runId`/`childId`. Expose record/check/sweep operations for Task 4 without importing foreground owners into the runner. Sweep authorized projected background descendants only.
- [ ] Extend `resolveSubagentRunId` to one namespace of run/child ids across foreground maps, shared async directories and authorized nested routes. Exact full id wins, duplicates collapse, otherwise require one prefix match regardless of live/settled state. Minimum four applies only to interrupt; `status`/`resume` retain run-only lookup and no minimum. Keep `descendantOf` filtering.
- [ ] Add the directory inventory: directory names resolve runs without opening status; first sight reads child records; terminal runs are never reread; live runs reread only after `mtime` changes. Store state/id/agent/label/status and expose in-memory reads/tracker updates for Task 5. Route priority is local `foreground`, live-pid `async`, then `nested` inbox.
- [ ] Reject legacy `index` before side effects with `interrupt no longer takes an index; pass the id at the start of the child's row.` Keep resume and `Revive child` unchanged. Implement short/missing/ambiguous/pending/settled errors exactly; ambiguity names `run`/`child`, not route kinds.
- [ ] Replace `childInterrupts`, `stoppedByIndex` and `lastAssigned` fallback with owner maps. Explicit stop, waiting-call abort and policy kill execute record, signal, sweep, answer. Run stop sets `stopping`, calls every running callback and never sets `stopRequested`; child stop sets the flag and signals only itself. Duplicate stopping requests do not signal again.
- [ ] Apply an accepted running-child stop on late callback registration. Run stops block later launches and signal callbacks arriving during shutdown. Pending-child requests reject; run stops settle queued foreground items interrupted without spawning, whereas child stops let unrelated queued work start.
- [ ] Gate single/sequential/static/dynamic launch sites with admission; example refusal: `Subagent launch refused: 3f9a1c is stopping.` Revival gets a new run id and caller ancestry, not the stopped child's path.
- [ ] For async targets write only the full-target request and signal a live runner. For nested foreground send `targetId`; match both `requestId` and target in the wait. Timeout removes only this caller's request and sends no fallback signal. Delete `directNestedAsyncInterrupt` and old all/index filenames in caller code.
- [ ] Make `startNestedControlInboxListener` answer only when a local control owns the target. Teardown precedes result write; retry failed writes without repeating signals; foreign requests remain untouched with no refusal reply.
- [ ] Preserve targeted results: every interrupted result's child must have `stopRequested`; set `interrupted: true` and retain sibling outputs. Apply predecessor failed-group behavior to static/dynamic chain groups. Run stop remains whole-run behavior even when all children stop.
- [ ] Run Tests green; review style and run scoped `git diff --check` over declared files. Stage explicit paths and commit with `git commit -m "Stop foreground child targets and their subtrees by id (#62)"`.

Exact error examples: `Stop id 'abc' is too short; type at least 4 characters of the id at the start of the row.`; `No running subagent matches 'deadbe'.`; `No subagent is running.`; `Subagent 3f9a1c (scout) has not started; stop its run to keep it from starting.`; `Subagent 3f9a1c (scout) is no longer running: completed.`; `No running async run with an interrupt-capable pid was found`; `The owner of 3f9a1c did not confirm the stop within 1000 ms; the stop may still take effect.` Map `complete`/`completed` to completed, failed to `failed`, paused to `interrupted`. Pending is not a deferred cancellation request.

Anchored seams: `src/runs/foreground/subagent-executor.ts`, `:2270-2276`, `interrupt-request-all.json`, `src/runs/foreground/subagent-executor.ts:440, 552-575`, `src/runs/background/subagent-runner.ts:1837-1851`, `src/runs/foreground/subagent-executor.ts:558-585`, `src/shared/types.ts:753`, `src/runs/foreground/subagent-executor.ts:2457-2470`, `pendingStops`, `activeChildInterrupt`, `src/runs/background/subagent-runner.ts:1405-1406, 1821-1867`, `src/extension/fanout-child.ts:71-76, 99`, `id: string`, `AgentProgress`, `SingleResult`, `AsyncStatus["steps"][number]`, `NestedStepSummary`, `label?: string`, `src/shared/types.ts`, `src/shared/types.ts:623`, `childId?: string`, `NestedPathEntry`, `NestedRunAddress.path`, `sanitizeNestedPath`, `encodeNestedPathEnv`, `parseNestedPathEnv`, `sanitizeInternalSummary`, `PI_SUBAGENT_PARENT_PATH`, `src/runs/shared/pi-args.ts:199-219`, `src/runs/foreground/external-single-attempt.ts:77`, `children: Map<string, { agent: string; label?: string; index: number; state: "pending" | "running" | "completed" | "failed" | "interrupted"; stopRequested?: true; interrupt?: () => boolean }>`, `stopping?: true`, `targetRunId`, `src/runs/shared/nested-events.ts:57-77, 647-702, 741-754`, `src/runs/foreground/subagent-executor.ts:536-557`, `src/runs/background/run-id-resolver.ts`, `### Resolving a stop id`, `src/extension/fanout-child.ts:51-110`, `src/runs/background/async-execution.ts:279-326`, `### No zombies`, `### Stopping a target`, `/interrupt-child <id>`, `subagent({ action: "interrupt", id })`, `children`, `src/runs/background/run-id-resolver.ts:31-44`, `src/runs/foreground/subagent-executor.ts:211-220`, `status.json`, `state.asyncJobs`, `getForegroundControl`, `src/runs/foreground/subagent-executor.ts:178`, `tasks[]`, `src/runs/shared/parallel-utils.ts:79-98`, `pending`, `paused`, `src/extension/fanout-child.ts:93-98`, `src/runs/background/subagent-runner.ts:1826-1855`, `src/runs/foreground/subagent-executor.ts:2463-2468`, `src/runs/foreground/subagent-executor.ts:1865`, `src/runs/foreground/chain-execution.ts:759, 969`, `src/runs/foreground/subagent-executor.ts:664-671`, `path`, `queued`, `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`, `Foreground targeting`, `interrupt action`, `Background transport`, `Foreground result`, `src/execution-backend/testkit.ts`, `src/extension/fanout-child.ts:73-99`, `interrupt-request-*`, `onUpdate`, `parallel`, `concurrency`, `test/integration/indexed-interrupt-errors.test.ts`.

## Wave 4 - Background owners and detached descendant sweep

Depends on Wave 3: consume its shared stop module and full-target request transport. Do not modify the new shared module here; its contract is completed in Task 3 before this wave.

### Task 4: Stop background targets without detached survivors
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - update request transport tests and add race regressions.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L122-L124, § "Inventory" L133-L135, § "Inventory" L136-L138, § "Inventory" L142-L143, § "Inventory" L145, § "Stopping a target" L224-L245, § "No zombies" L251, § "No zombies" L255, § "No zombies" L257, § "Predecessor scope" L267, § "Paid or external actions" L271, § "Errors and edge cases" L300-L302, § "Tests" L314, § "Tests" L327-L329, § "Out of scope" L345-L346

**Files:**
- Modify: `src/runs/background/subagent-runner.ts`
- Modify: `src/runs/background/async-execution.ts`
- Modify: `test/integration/top-level-async.test.ts`
- Modify: `test/integration/async-execution.test.ts`
- Modify: `test/integration/background-external-execution.test.ts`
- Modify: `test/integration/detached-external-orchestration.test.ts`
- Test: `test/integration/top-level-async.test.ts`
- Test: `test/integration/async-execution.test.ts`
- Test: `test/integration/background-external-execution.test.ts`
- Test: `test/integration/detached-external-orchestration.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/top-level-async.test.ts test/integration/async-execution.test.ts test/integration/background-external-execution.test.ts test/integration/detached-external-orchestration.test.ts`
- baseline: f67a5af pass
- via: `interruptRunner`, `registerChildInterrupt`, `executeAsyncChain`, `resolveSubagentRunId`, `runChildHost`

Decision: keep `ASYNC_INTERRUPT_SIGNAL` and private request directories, but a signal without a valid target request does nothing. Detached survival after an ancestor crash remains intentional; explicit stops use admission/sweep, not a new runner parent-pid monitor.

- [ ] Run Tests; migrate ids and all old whole-run request filenames. Add red one-child/all-child/no-file-signal/late-callback/duplicate/pending/absent-id cases.
- [ ] Replace runner `childInterrupts`, `pendingStops` and `activeChildInterrupt` with the UUID owner map. Parse full-target filenames, validate membership before signalling and use record/signal/sweep/answer. Run stop sets `stopping` and signals all running children without targeted flags; child stop sets `stopRequested` only on itself.
- [ ] Apply accepted running-child stops on registration and suppress duplicate signals. Pending child requests reject; run stop leaves unstarted background steps `pending` and settles the run `paused`.
- [ ] Check admission at startup and immediately before every native/external spawn, including later/dynamic steps. Keep background registration publication before the launch check. A target run or ancestry match starts no process.
- [ ] Add barrier-controlled races: preexisting stop record, publication just before record creation, queued runner without live pid, matching live detached runner and unrelated sibling. Swept runs use their own run ids, not the ancestor's child id.
- [ ] Build five-ancestor/seventeen-sibling integration: target retains addressable row and resolves; stopping it ends its detached descendant; unrelated sibling completes. Assert actual process exits and owner state, not just paused status.
- [ ] Keep external attempts on the existing interrupt signal/host channel. Assert empty owner env overrides inheritance, child stop drives `abort`/`shutdown`, owner-socket close terminates and explicit cleanup remains. Preserve backend correlation ids.
- [ ] Test policy kill and abort use the same owner sequence, all three individually stopped children versus whole-run result and pending launch suppression. Preserve predecessor sibling outputs and group results.
- [ ] Run Tests green with 300 seconds available. Review style; run `git diff --check -- src/runs/background/subagent-runner.ts src/runs/background/async-execution.ts test/integration/top-level-async.test.ts test/integration/async-execution.test.ts test/integration/background-external-execution.test.ts test/integration/detached-external-orchestration.test.ts`. Stage these paths and commit with `git commit -m "Apply child-id stops and admission to background runners (#62)"`.

Anchored seams: `interrupt-request-all.json`, `src/runs/foreground/subagent-executor.ts:440, 552-575`, `src/runs/background/subagent-runner.ts:1837-1851`, `directNestedAsyncInterrupt`, `interruptNestedRun`, `src/runs/foreground/subagent-executor.ts:558-585`, `stoppedByIndex`, `lastAssigned`, `src/shared/types.ts:753`, `src/runs/foreground/subagent-executor.ts:2457-2470`, `src/runs/background/subagent-runner.ts:1405-1406, 1821-1867`, `src/extension/fanout-child.ts:71-76, 99`, `id: string`, `AgentProgress`, `SingleResult`, `AsyncStatus["steps"][number]`, `NestedStepSummary`, `label?: string`, `src/shared/types.ts`, `label`, `src/shared/types.ts:623`, `childId?: string`, `NestedPathEntry`, `NestedRunAddress.path`, `sanitizeNestedPath`, `encodeNestedPathEnv`, `parseNestedPathEnv`, `sanitizeInternalSummary`, `PI_SUBAGENT_PARENT_PATH`, `src/runs/shared/pi-args.ts:199-219`, `src/runs/foreground/external-single-attempt.ts:77`, `children: Map<string, { agent: string; label?: string; index: number; state: "pending" | "running" | "completed" | "failed" | "interrupted"; stopRequested?: true; interrupt?: () => boolean }>`, `stopping?: true`, `targetId`, `targetRunId`, `src/runs/shared/nested-events.ts:57-77, 647-702, 741-754`, `src/runs/foreground/subagent-executor.ts:536-557`, `src/runs/background/run-id-resolver.ts`, `### Resolving a stop id`, `startNestedControlInboxListener`, `src/extension/fanout-child.ts:51-110`, `src/runs/background/async-execution.ts:279-326`, `### No zombies`, `### Stopping a target`, `status.json`, `running`, `requestId`, `interrupt`, `tasks[]`, `src/runs/shared/parallel-utils.ts:79-98`, `interrupted`, `src/extension/fanout-child.ts:93-98`, `src/runs/background/subagent-runner.ts:1826-1855`, `src/runs/foreground/subagent-executor.ts:2463-2468`, `interrupted: true`, `src/runs/foreground/subagent-executor.ts:1865`, `src/runs/foreground/chain-execution.ts:759, 969`, `stops/`, `runId`, `childId`, `resume`, `src/runs/foreground/subagent-executor.ts:664-671`, `executionBackend`, `auto`, `doc/configuration.md:150-161`, `dead`, `PI_SUBAGENT_OWNER_PID`, `src/runs/foreground/external-single-attempt.ts:77-113`, `src/runs/background/subagent-runner.ts:804, 956`, `process.env`, `src/execution-backend/child-host-runtime.ts:64`, `interruptSignal`, `backend.close(handle, "explicit_cleanup")`, `src/runs/shared/external-execution.ts:275-336`, `queued`, `path`, `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`, `Foreground targeting`, `interrupt action`, `Background transport`, `Foreground result`, `src/execution-backend/testkit.ts`, `test/integration/foreground-external-execution.test.ts`.

## Wave 5 - Retained routes, cached completion and lifecycle errors

Depends on Waves 3-4: foreground/background targets share the resolver and stop contract.

### Task 5: Complete the stop-id namespace and slash command
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - retain authorization and run-only status/resume semantics.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L121, § "Inventory" L136-L138, § "Inventory" L139-L141, § "Inventory" L148, § "Resolving a stop id" L204-L216, § "Resolving a stop id" L218, § "`/interrupt-child <id>`" L261-L263, § "Errors and edge cases" L275-L289, § "Errors and edge cases" L301-L302, § "Tests" L306, § "Tests" L312, § "Tests" L315, § "Tests" L319, § "Tests" L330, § "Out of scope" L343

**Files:**
- Modify: `src/runs/background/run-id-resolver.ts`
- Modify: `src/runs/background/async-job-tracker.ts`
- Modify: `src/runs/foreground/subagent-executor.ts`
- Modify: `src/slash/slash-commands.ts`
- Modify: `test/unit/run-id-resolver.test.ts`
- Modify: `test/integration/async-job-tracker.test.ts`
- Modify: `test/integration/slash-commands.test.ts`
- Modify: `test/integration/indexed-interrupt-errors.test.ts`
- Create: `test/integration/interrupt-id-errors.test.ts`
- Test: `test/unit/run-id-resolver.test.ts`
- Test: `test/integration/async-job-tracker.test.ts`
- Test: `test/integration/slash-commands.test.ts`
- Test: `test/integration/interrupt-id-errors.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/run-id-resolver.test.ts test/integration/async-job-tracker.test.ts test/integration/slash-commands.test.ts test/integration/interrupt-id-errors.test.ts`
- baseline: f67a5af pass via `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/run-id-resolver.test.ts test/integration/async-job-tracker.test.ts test/integration/slash-commands.test.ts`
- via: `resolveSubagentRunId`, `hasLiveNestedDescendants`, `updateForegroundNestedProjection`, `/interrupt-child <id>`

Decision: existing async tracker owns retained-route polling; completion never starts its own poll or filesystem scan. Retain only routes created by this process, not arbitrary event directories. Reuse the slash bridge and `ctx.ui.notify`.

- [ ] Run existing anchors. Move indexed suite to the new path, delete old path and replace positional expectations with child-id lifecycle errors. Keep legacy index solely in rejection/resume cases.
- [ ] Add resolver tests: unique child/run prefix, exact winner, short/missing/ambiguous text, live/settled collisions, duplicate async/nested target selecting live async, all 17 ids from actual event projection, and run-only status/resume with no minimum.
- [ ] Add read counters: terminal status read once over two resolutions, unchanged live mtime not reread, changed live mtime refreshed, tracker-fed entries requiring no redundant read. Run red before integrating.
- [ ] Add no-signal/no-request-file errors for obsolete index, short, unknown, ambiguous, pending and all terminal states. Map background/nested `complete`/`completed`, `failed`, `paused` to completed/failed/interrupted; returned foreground child's removed record yields no-match. Duplicate stopping accepts only before settlement. Preserve `Revive child` and resume index.
- [ ] Before deleting a returning root foreground control retain its route if `hasLiveNestedDescendants`. At tracker cadence re-project and drop only after the last live descendant disappears. Feed tracked statuses into inventory. Expose retained routes to resolution/completion/sweep/widget without authorizing foreign routes.
- [ ] Test root return with nested background work: child still resolves/completes/stops; route eventually drops; foreign route never resolves. Keep routes through tracked-job cleanup while descendants remain live.
- [ ] Replace positional parsing with exactly one id, forwarded as `action: "interrupt"`. Zero/two arguments show `/interrupt-child <id>` and running stop ids. Notify without steering the waiting caller.
- [ ] Complete running children of this session's foreground/tracked async/authorized nested/retained routes using memory only. Typed other-session background children still resolve. Start values at six characters, lengthen against all known run/child ids including settled ones, never full UUID. Text contains token, agent and optional label.
- [ ] Test registered handler through slash bridge while caller waits: stop nested child 1, keep sibling outputs. Cover usage, labels, other-session exclusion, run/settled collisions and zero filesystem reads in completion.
- [ ] Run Tests green; review style and scoped `git diff --check` including old/new test paths. Stage explicitly and commit with `git commit -m "Expose retained child targets and stop-id completion (#62)"`.

Exact errors: `interrupt no longer takes an index; pass the id at the start of the child's row.`, `No subagent is running.`, `No running async run with an interrupt-capable pid was found`. Examples: `Subagent 3f9a1c (scout) has not started; stop its run to keep it from starting.`; `Subagent 3f9a1c (scout) is no longer running: interrupted.`; `Stop id 'abc' is too short; type at least 4 characters of the id at the start of the row.`; `No running subagent matches 'deadbe'.` Ambiguous rows use `run`/`child`, not `foreground`, `async` or `nested`.

Anchored seams: `src/slash/slash-commands.ts:560-595`, `targetId`, `targetRunId`, `src/runs/shared/nested-events.ts:57-77, 647-702, 741-754`, `src/runs/foreground/subagent-executor.ts:536-557`, `src/runs/background/run-id-resolver.ts`, `### Resolving a stop id`, `subagent.nested.child`, `### Live records`, `children?: NestedRunSummary[]`, `AgentProgress`, `renderSubagentResult`, `### Rows`, `retainedNestedRoutes`, `SubagentState`, `/interrupt-child`, `subagent({ action: "interrupt", id })`, `children`, `src/runs/background/run-id-resolver.ts:31-44`, `descendantOf`, `src/runs/foreground/subagent-executor.ts:211-220`, `status`, `resume`, `mtime`, `status.json`, `id`, `agent`, `label`, `state.asyncJobs`, `src/runs/foreground/subagent-executor.ts:2561-2568`, `src/runs/background/async-execution.ts:433`, `src/runs/background/async-job-tracker.ts:236-259`, `src/runs/shared/nested-events.ts:821-829`, `interrupt`, `index`, `stopRequested`, `stopping`, `sessionFile`, `currentPath`, `writeNestedEvent`, `test/unit/nested-events.test.ts`.

## Wave 6 - Stop-id rows without live-entry folds

Depends on Waves 1 and 5: stable identity, projected children and retained routes exist. Foreground projection changes share a file owned by earlier waves.

### Task 6: Render every live target with its stop id
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - row-level assertions before rendering changes.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L125-L127, § "Inventory" L128, § "Inventory" L139-L141, § "Inventory" L146, § "Rows" L163, § "Rows" L174-L177, § "Rows" L179, § "Rows" L181, § "Rows" L183, § "Resolving a stop id" L218, § "Tests" L320-L324, § "Acceptance criteria" L67-L72

**Files:**
- Modify: `src/tui/render.ts`
- Modify: `src/tui/render-helpers.ts`
- Modify: `src/runs/shared/nested-render.ts`
- Modify: `src/runs/background/run-status.ts`
- Modify: `src/runs/background/async-status.ts`
- Modify: `src/runs/foreground/subagent-executor.ts`
- Modify: `test/unit/widget-nested-render.test.ts`
- Modify: `test/unit/render-helpers.test.ts`
- Modify: `test/unit/run-status.test.ts`
- Modify: `test/integration/render-widget.test.ts`
- Modify: `test/integration/async-status.test.ts`
- Test: `test/unit/widget-nested-render.test.ts`
- Test: `test/unit/render-helpers.test.ts`
- Test: `test/unit/run-status.test.ts`
- Test: `test/integration/render-widget.test.ts`
- Test: `test/integration/async-status.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/widget-nested-render.test.ts test/unit/render-helpers.test.ts test/unit/run-status.test.ts test/integration/render-widget.test.ts test/integration/async-status.test.ts`
- baseline: f67a5af pass
- via: `renderSubagentResult`, `renderSingleCompact`, `renderMultiCompact`, `formatNestedWidgetLines`, `fitWidgetLineBudget`, `formatNestedRunLines`, `formatRunHeader`, `formatStepLine`, `stepLineLabel`

Decision: distinguish row metadata from detail text in builders, not regex-parsing rendered strings. Budgets may remove details and settled-only rows, not live rows. Exactly six characters applies even to settled/colliding ids.

- [ ] Run Tests. Add exact first-token assertions for single/tasks/chain outputs with one/two foreground runs, live/pending/settled rows, nested/widget/status surfaces and no full UUID. Title/detail lines receive no stop token.
- [ ] Add live/result label tests for all five shapes, dynamic interpolation and group-label separation. Cover deeper than two levels/twelve lines, detail-before-settled folding and more live rows than budget. Preserve collapsed counts.
- [ ] Add in-flight foreground `onUpdate` test, attachment by last ancestry child id, changes before settlement and no polling after return. Run new tests red.
- [ ] Add foreground `POLL_INTERVAL_MS` projection timer (250 ms), call `updateForegroundNestedProjection`, attach runs to `AgentProgress.children` by `childId`, call `onUpdate` on attached row addition/state change. Stop in finally and retain settle-point projection/final rows. Publication stays owner-driven.
- [ ] Prefix rows with six id characters then one space. List bullet `- ` is indentation; nested indentation precedes id and the existing `↳` visual marker follows it. Single-agent header is child row; multi-child header is run row. Keep `Agent n/m`/`Step n` as descriptive numbering only.
- [ ] Update `foregroundStyleWidgetStepLines`, compact rows, `buildSingleWidgetLines`, `widgetChainDetails`, nested run/step renderers and status labels. Title `async subagent ...` is not a row; glyph/mode status line is. Remove bracketed/full run ids and label-first status form; print agent then label, for example `scout - audit auth`.
- [ ] Builders pass rows/details apart instead of flat `string[]`. Fold details first then settled rows; retain settled ancestors with live descendants and all live rows even above budget. Keep metadata caps/collapsed counts. Expanded foreground draws nested rows; collapsed foreground does not.
- [ ] Render retained roots as run rows with live nested rows using Task 5 routes. Every row uses its own run/child id, not parent token.
- [ ] Run Tests green; review style and scoped `git diff --check` over owned paths. Stage explicitly and commit with `git commit -m "Show stop ids on every live and settled child row (#62)"`.

Anchored seams: `src/tui/render.ts`, `:767-806`, `:900-912`, `src/runs/shared/nested-render.ts`, `maxDepth`, `maxLines`, `:70-106`, `src/runs/foreground/subagent-executor.ts:251`, `src/runs/background/run-status.ts:234, 240`, `src/runs/background/async-status.ts:354, 358`, `src/runs/shared/nested-events.ts`, `MAX_DEPTH`, `:170, 232, 262, 291`, `MAX_STEPS`, `:251, 872`, `MAX_CHILDREN`, `:232, 291, 384, 396, 804`, `agents`, `:274`, `MAX_NESTED_PATH_ENTRIES`, `sanitizeNestedPath`, `src/runs/shared/nested-path.ts:4, 26-37`, `steps`, `src/runs/shared/nested-events.ts:249-252, 857-872`, `src/runs/foreground/subagent-executor.ts:2476-2533`, `### Live records`, `src/runs/shared/nested-render.ts:88`, `src/runs/background/async-status.ts:339-344`, `src/runs/background/async-status.ts:301`, `src/runs/background/run-status.ts:231`, `subagent.nested.child`, `children?: NestedRunSummary[]`, `AgentProgress`, `### Rows`, `retainedNestedRoutes`, `SubagentState`, `### Resolving a stop id`, `src/runs/background/run-status.ts:52-62`, `src/runs/background/async-status.ts`, `src/tui/render.ts:874-875`, `AsyncJobState`, `nestedChildren`, `status`, `src/runs/foreground/subagent-executor.ts:239, 1283, 1840, 1873, 2117, 2147`, `src/runs/shared/nested-events.ts:815-819`, `src/shared/types.ts:979`, `children`, `src/runs/foreground/subagent-executor.ts:2561-2568`, `src/runs/background/async-execution.ts:433`, `src/runs/background/async-job-tracker.ts:236-259`, `hasLiveNestedDescendants`, `src/runs/shared/nested-events.ts:821-829`, `tasks[]`, `parallel`, `label`, `test/unit/schemas.test.ts`.

## Wave 7 - Current documentation

Depends on Waves 1-6: describe delivered behavior. Dedicated doc-only wave, with no code ownership overlap.

### Task 7: Document the breaking stop-id contract
Leg: jjuraszek/pi-cohort

**TDD scenario:** Trivial change - doc contract review; no executable code.
**Spec:** doc/specs/2026-11-11-gh-62-universal-child-stop-handle.md § "Inventory" L149, § "Predecessor scope" L267, § "Documentation impact" L336

**Files:**
- Modify: `README.md`
- Modify: `doc/commands.md`
- Modify: `doc/programmatic-api.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/pi-cohort/SKILL.md`
- Modify: `skills/pi-cohort/reference/config-fields.md`

**Tests:**
- none: docs

- [ ] Read touched README blocks, Direct commands, both API stop sections and skill control text. Follow installed forge-skill authoring rules for the two skill files; keep edits imperative/scoped.
- [ ] Update README session naming/environment table: add `PI_SUBAGENT_OWNER_PID`, remove claim that `PI_SUBAGENT_RUN_ID` prefix appears in session name, show one-token stops and exactly six-character row/session ids.
- [ ] Replace slash grammar/completions in `doc/commands.md`; explain one argument, running id suggestions, notifications and background/nested reach while caller waits.
- [ ] Rename `Foreground stop by index`/`Background stop by index` to stop-by-id headings in API guide. Update all old-anchor links in README, commands and `skills/pi-cohort/SKILL.md:75`. Describe whole-run/targeted results, lifecycle errors and unchanged resume/Revive behavior.
- [ ] Document full-target requests, for example `interrupt-request-3f9a1c00-0000-4000-8000-000000000001.json`, stop records, native owner watch, external socket ownership and retained routes. Explain ancestry-specific suppression and sibling isolation, not cancellation of arbitrary tool processes/crash survivors.
- [ ] Add single-call and `tasks[]` label fields to API text and `skills/pi-cohort/reference/config-fields.md`; preserve dynamic interpolation/group-label distinction. Change skill control wording to id targeting.
- [ ] Add breaking `## [Unreleased]` entry: removal of interrupt index/old argument grammar, child session-name change and subtree stops, referencing #62. Preserve historical releases/predecessor spec; no version bump or removal of predecessor result semantics.
- [ ] Check touched links/anchors, commands and present tense. Run `git diff --check -- README.md doc/commands.md doc/programmatic-api.md CHANGELOG.md skills/pi-cohort/SKILL.md skills/pi-cohort/reference/config-fields.md`. Stage paths and commit with `git commit -m "Document universal child stop handles as a breaking change (#62)"`.

Anchored vocabulary: `label`, `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`, `Foreground targeting`, `interrupt action`, `Background transport`, `Foreground result`, `Direct commands`, `interrupt`, `index`. The predecessor's sibling-output/failed-group contract remains; only its positional stop address is superseded.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L67-L72 | Labels on live/result rows for all five shapes | Task 1, Task 6 |
| § "Acceptance criteria" L80 | Parent gets sibling outputs and interrupted child | Task 3 |
| § "Inventory" L120 | Remove interrupt index input; retain schema field for resume only | Task 1, Task 3 |
| § "Inventory" L121 | Remove positional slash grammar/completion | Task 5 |
| § "Inventory" L122-L124 | Remove old index/all request files and unanswered-inbox fallback | Task 3, Task 4 |
| § "Inventory" L122-L124 | Replace positional stop maps and fallback slots | Task 3, Task 4 |
| § "Inventory" L122-L124 | Remove non-owner refusal and deletion | Task 3 |
| § "Inventory" L125-L127 | Live entries bypass every cap; settled-only caps and agents metadata cap stay | Task 1, Task 6 |
| § "Inventory" L125-L127 | Full child-bearing ancestry never truncated | Task 1 |
| § "Inventory" L125-L127 | Replace run-embedded steps with child records | Task 1 |
| § "Inventory" L128 | Remove full UUID and label-first row forms | Task 6 |
| § "Inventory" L129 | Replace run/index session-name suffix | Task 2 |
| § "Inventory" L133-L135 | Required child id and optional labels on public/internal records | Task 1 |
| § "Inventory" L133-L135 | Preserve child id in ancestry and native/external env | Task 1, Task 2 |
| § "Inventory" L133-L135 | UUID-keyed owner entries and run stopping marker | Task 1, Task 3, Task 4 |
| § "Inventory" L136-L138 | Full-target request filename is sole background transport | Task 3, Task 4 |
| § "Inventory" L136-L138 | Target field rename in parsers, writers and matching wait | Task 3 |
| § "Inventory" L137 | Target field rename in shared records | Task 1 |
| § "Inventory" L136-L138 | Child namespace, target route and background inventory | Task 3, Task 5 |
| § "Inventory" L139-L141 | Child event, registry merge and foreground/background writers | Task 1 |
| § "Inventory" L139-L141 | Progress children, timer and expanded foreground rows | Task 1, Task 6 |
| § "Inventory" L139-L141 | Retained route state and lifetime | Task 1, Task 5 |
| § "Inventory" L142-L143 | Owner-only inbox answer | Task 3 |
| § "Inventory" L142-L143 | Stop records and foreground/background launch admission | Task 3, Task 4 |
| § "Inventory" L144 | Native owner-pid env, empty external env and runtime watch | Task 2 |
| § "Inventory" L145 | Every owner-stop path uses record, signal, sweep, answer; signal all running children on run stop | Task 3, Task 4 |
| § "Inventory" L146 | First stop token in every enumerated row renderer | Task 6 |
| § "Inventory" L147 | Single/task-item labels reach all five shapes | Task 1 |
| § "Inventory" L148 | Stop-id completion | Task 5 |
| § "Inventory" L149 | Skill stop wording, API anchor and label reference | Task 7 |
| § "Identity" L153-L157 | Mint before spawn once per expanded/materialized child; reuse across retries and records | Task 1 |
| § "Identity" L153-L157 | Pending records have ids; state transitions begin at launch; stop token is six characters | Task 1 |
| § "Identity" L159 | Agent, child stop token and parent in session name | Task 2 |
| § "Rows" L163 | First non-whitespace token, spacing and nested marker placement; settled rows retain ids | Task 6 |
| § "Rows" L174-L177 | Exact row/detail boundaries on foreground, widget, nested and status surfaces | Task 6 |
| § "Rows" L179 | Agent-label form on all shapes; dynamic interpolation and group-label separation | Task 6 |
| § "Rows" L181 | Details fold first, settled rows next, live rows never; collapsed counts unchanged | Task 6 |
| § "Rows" L183 | 250 ms projection, child-id attachment, changed-row updates, timer disposal and final projection | Task 6 |
| § "Rows" L183 | Expanded foreground nested rows only; collapsed foreground unchanged | Task 6 |
| § "Live records" L187-L198 | Per-record 64 KB bound, run fields/full path without embedded steps | Task 1 |
| § "Live records" L187-L198 | Child record fields and creation/state/status-write publication | Task 1 |
| § "Live records" L187-L198 | Id-keyed ordered merge, timestamp and terminal guards, replay and deferred children | Task 1 |
| § "Live records" L187-L198 | Settled-only caps and identity-only oversized child fallback | Task 1 |
| § "Live records" L187-L198 | Headless foreground publication including dynamic children; root uses local map | Task 1 |
| § "Live records" L200 | Omit id-less legacy steps in every state from projection and child surfaces; never fabricate identity or delete stored artifacts; preserve valid runs, identified steps and independent descendants with nested-events regressions | Task 1 |
| § "Resolving a stop id" L204-L216 | One authorized run/child namespace, minimum four only for interrupt | Task 3, Task 5 |
| § "Resolving a stop id" L204-L216 | Exact match, deduplication and live/settled ambiguity; status/resume run-only | Task 3, Task 5 |
| § "Resolving a stop id" L204-L216 | Target kind/full id/owner route; descendant restriction stays | Task 3, Task 5 |
| § "Resolving a stop id" L204-L216 | Directory-name runs, lazy mtime child inventory, terminal read once and tracker feed | Task 3, Task 5 |
| § "Resolving a stop id" L218 | Retain own live routes after root return, cadence reprojection and terminal cleanup | Task 5 |
| § "Resolving a stop id" L218 | Retained routes feed resolution/completion/sweep and widget rows | Task 5, Task 6 |
| § "Resolving a stop id" L220 | Bare interrupt selects current foreground or existing background run fallback | Task 3 |
| § "Stopping a target" L224-L245 | Owner route priority; background targets never use inbox | Task 3, Task 4 |
| § "Stopping a target" L224-L245 | Valid request required for runner signal; target/run identity determines scope | Task 3, Task 4 |
| § "Stopping a target" L224-L245 | Owner-only inbox request handling and caller-specific timeout cleanup | Task 3 |
| § "Stopping a target" L224-L245 | All owner stop causes close admission, signal, sweep then answer | Task 3, Task 4 |
| § "Stopping a target" L224-L245 | Run stop blocks queued/later work, foreground queued interruption versus background pending/paused | Task 3, Task 4 |
| § "Stopping a target" L224-L245 | Targeted flags, whole-run all-child signalling, pre-callback latch | Task 3, Task 4 |
| § "Stopping a target" L224-L245 | Reply failure/deadline never undoes teardown; retry reply without repeated signal | Task 3 |
| § "Stopping a target" L224-L245 | Sibling outputs and targeted results differ from run stop even after three child stops | Task 3, Task 4 |
| § "No zombies" L251 | Own-run/full-ancestry admission at launch and runner startup; refusal/paused behavior | Task 3, Task 4 |
| § "No zombies" L251 | Publish before launch check, prevent late launch races, isolate siblings and allow new-run revival | Task 3, Task 4 |
| § "No zombies" L253-L255 | Native owner watch, unref poll and forced exit; detached runners excluded | Task 2 |
| § "No zombies" L253-L255 | External empty env masks inheritance; socket ownership and native descendants in local namespace | Task 2 |
| § "No zombies" L255 | External interrupt channel and explicit cleanup; descendant sweep still applies | Task 4 |
| § "No zombies" L257 | One post-record sweep sees every queued/running matching detached descendant; queued startup handles no pid | Task 3, Task 4 |
| § "`/interrupt-child <id>`" L261-L263 | Exactly one token through slash bridge and notifications; no-foreground background reach | Task 5 |
| § "`/interrupt-child <id>`" L261-L263 | Session-only running completion from memory; global namespace uniqueness and no full UUID | Task 5 |
| § "Predecessor scope" L267 | Replace stop-address contract but retain sibling/group result contract | Task 3, Task 4, Task 7 |
| § "Paid or external actions" L271 | Local mock/process/testkit only; no paid or external action | Task 3, Task 4 |
| § "Errors and edge cases" L275-L289 | Reject before signalling; short/no-match errors preserve typed token and running alternatives | Task 3, Task 5 |
| § "Errors and edge cases" L275-L289 | Ambiguity lists distinct target kinds and discriminating prefixes, not route kinds | Task 3, Task 5 |
| § "Errors and edge cases" L275-L289 | Pending rejection, settled-state mappings, missing foreground record and unchanged resume | Task 3, Task 5 |
| § "Errors and edge cases" L275-L289 | Obsolete index rejection, slash usage and missing live runner error | Task 3, Task 5 |
| § "Errors and edge cases" L293 | Inbox deadline is unconfirmed, removes own request and never falls back to another signal | Task 3 |
| § "Errors and edge cases" L297-L299 | Unknown liveness lives; pid reuse accepted; Windows exits without cleanup | Task 2 |
| § "Errors and edge cases" L300-L302 | Crash-surviving background work stays; stop-time launch races do not | Task 4 |
| § "Errors and edge cases" L301-L302 | Repeated stopping request accepted without signal; after settlement terminal error | Task 3, Task 5 |
| § "Errors and edge cases" L300-L302 | Runner duplicate stop is idempotent | Task 4 |
| § "Errors and edge cases" L301-L302 | Full UUIDs distinct; shared six-character prefix remains ambiguous | Task 3, Task 5 |
| § "Tests" L306 | Resolver, mixed registry and terminal inventory read-count regressions | Task 5 |
| § "Tests" L307-L310 | Two-owner nested stop, parent outputs, late/failed reply and real headless publication tests | Task 3 |
| § "Tests" L311-L313 | Deep live records, 17 large children, ordering and complete ancestry round-trip | Task 1 |
| § "Tests" L312 | All 17 projected child ids resolve and target their own controls | Task 5 |
| § "Tests" L313 | Native env carries six ancestry entries intact | Task 2 |
| § "Tests" L314 | Five-level target and seventeen siblings with detached subtree isolation | Task 4 |
| § "Tests" L315 | Rename positional error suite and cover no-side-effect lifecycle errors | Task 5 |
| § "Tests" L316-L318 | Foreground target/run/bare/all-child stops, callback race, concurrency/abort and chain groups | Task 3 |
| § "Tests" L319 | Slash bridge blocked caller, usage and global-unique/session-local completion | Task 5 |
| § "Tests" L320-L324 | Row/label matrices, deep folding, in-flight foreground updates and status text | Task 6 |
| § "Tests" L325-L327 | Child env/name, real owner-death chain and external ownership regressions | Task 2 |
| § "Tests" L327-L329 | Background external channel, all-child signal, pending suppression, signal-without-file and admission races | Task 4 |
| § "Tests" L330 | Retained routes survive return and disappear only after no live descendants | Task 5 |
| § "Documentation impact" L336 | README environment/session/stops, commands, renamed API anchors, labels and breaking changelog | Task 7 |
| § "Out of scope" L343 | Preserve resume index and Revive child | Task 3, Task 5 |
| § "Out of scope" L344 | No new teardown of tool-spawned OS processes | waived: excluded by spec |
| § "Out of scope" L345-L346 | Crash survivors remain; pending child cannot be individually cancelled | Task 4 |
| § "Out of scope" L347 | Gauntlet labels and wave policy remain sibling follow-up | waived: excluded by spec |
| § "Out of scope" L348 | Backend child correlation unchanged | Task 2 |
| § "Out of scope" L349 | No positional stop follow-up; replaced by child-id rule | waived: obsolete address excluded by spec |
