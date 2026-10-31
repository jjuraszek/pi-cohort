# Forked subagents run in the dispatch cwd - Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make every forked child's header cwd match its resolved launch cwd without changing fresh dispatch or the parent's session.

**Architecture:** Pass the resolved cwd through the fork resolver and every foreground callback. For detached leaves, keep provisional pre-created sessions and replace only their header cwd after backend selection, before attempts. Make the fake Pi honor session-header cwd so integration regressions observe the same precedence as Pi.

**Tech Stack:** TypeScript, Node's built-in test runner and type stripping, Pi SessionManager, JSONL session files.

**Spec:** `doc/specs/2026-10-31-gh-40-fork-cwd-override.md`

**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all`

**Ticket:** `jjuraszek/pi-cohort#40`

Baseline jjuraszek/pi-cohort: c59b3b4

Baseline provenance: jjuraszek/pi-cohort initial HEAD c59b3b4; status inventory empty before plan creation, then only ?? doc/plans/2026-10-31-gh-40-fork-cwd-override.md. Admitted paths: doc/specs/2026-10-31-gh-40-fork-cwd-override.md and doc/plans/2026-10-31-gh-40-fork-cwd-override.md. All six exact task commands executed at this leg's checkout root, exit 0: Task 1 unit 12 tests; Task 2 unit 54 tests and selected integration 1 test; Task 3 fork integration 31 tests and chain integration 95 tests; Task 4 async integration 119 tests. HEAD and status rechecked after each run: c59b3b4 and only the plan untracked throughout; no generated repository artifacts or source contamination. After header/anchor repair, provenance rechecked and git diff --quiet c59b3b4 c59b3b4 excluding doc/specs/ and doc/plans/ exited 0; retained all six unchanged-command bullets at the same measured revision.

---

## Files

**Resolver and foreground - Modify:**
- `src/shared/fork-context.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `test/unit/fork-context.test.ts`
- `test/integration/fork-context-execution.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/support/mock-pi-script.mjs`

**Detached runner - Modify:**
- `src/runs/background/subagent-runner.ts`
- `test/unit/async-execution.test.ts`
- `test/integration/async-execution.test.ts`

**Documentation - Modify:**
- `CHANGELOG.md`

Create and delete: none. Runtime test fixtures stay inside existing temporary-directory helpers, not new repository fixtures.

## Recon and execution constraints

- Home-only leg: jjuraszek/pi-cohort. The rules walk found no nested AGENTS.md or CLAUDE.md under task paths; the spec's eight Rules entries cover the combined list. No additional task Rules are needed. No Happy path table exists in the overrides.
- package.json:43-48 provides the bundled verification entrypoint, including agents-core consistency, unit tests and integration tests. No scoped or repo-wide lint/format script, formatter config, or typecheck command exists. Code tasks perform a manual format/style pass matching neighboring tabs, quotes and trailing commas; do not install tooling. CI's .github/workflows/test.yml:24-29 invokes the three constituent checks separately.
- Unit commands use test/support/isolate-test-env.mjs; integration commands also use test/support/register-loader.mjs. Unset PI_CODING_AGENT_DIR to avoid ambient profile discovery. Each invocation gets its own HOME and temporary root; Wave 1 tasks share no ports, fixtures, mock queues or mutable filesystem roots.
- Installed node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:378 defines the third cwdOverride parameter. Keep the existing >=1.3.0 peer floor and do not import Pi at runtime in the detached runner.
- The Design inventory at spec L84-L85 repeats the detailed obligations at L64-L82 and documentation L112; the coverage rows below own those obligations at their detailed clauses. Nothing is removed.

## Wave 1 - Independent resolver and runner mechanisms

### Task 1: Branch fork sessions with the requested child cwd
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-31-gh-40-fork-cwd-override.md § "Resolver: branch under the child cwd" L64-L64, § "Resolver: branch under the child cwd" L65-L65, § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L33-L34, § "Tests" L103-L103, § "Errors and edge cases" L93-L93

**Files:**
- Modify: `src/shared/fork-context.ts:7-90`
- Modify: `test/unit/fork-context.test.ts:25-265`
- Test: `test/unit/fork-context.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/fork-context.test.ts`
- baseline: c59b3b4 pass
- via: `createForkContextResolver`, `openSession`, `SessionManager`

Decision: use `(index: number, cwd: string)` and `(path: string, sessionDir: string | undefined, cwd: string)` for the resolver and opener hooks. All production callers already supply an index; requiring both values avoids an optional parameter preceding a required one. Preserve the existing small structural return type rather than requiring stubs to implement all of SessionManager (src/shared/fork-context.ts:7-20).

This mechanism serves `subagent({ context: "fork", cwd: "B" })`, parallel chains, detached `async: true`, and no-cwd `context: "fork"`. Store the supplied `cwd` so the child's `bash` observation `pwd -P` can match B or inherited A; Tasks 3 and 4 prove the dispatch-to-runtime paths.

- [ ] Run the Tests command; expect the existing resolver tests to pass.
- [ ] Extend the default-package-opener test at test/unit/fork-context.test.ts:99-132: create distinct A and B directories, persist the parent's user message under A, request B, and assert the child header `cwd` is B, the parent header and complete parent bytes stay unchanged, parent leaf identity stays unchanged, and the branch history is preserved.
- [ ] Extend the opener recorder to capture all three arguments for both `options.openSession` and `sessionManager.openSession`; assert the destination directory and B. Update every existing test invocation to supply cwd, preserving fresh-mode, cache, missing-file and no-silent-fallback cases. Repeat the same index with the same cwd and assert one branch operation.
- [ ] Run the Tests command; expect the new header and third-argument assertions to fail against the old implementation.
- [ ] Implement `ForkContextResolver.sessionFileForIndex(index, cwd)`. Update `ForkableSessionManager` (`:11`) and `options.openSession` (`fork-context.ts:16`) to the `(path, sessionDir, cwd)` hook shape, semantically `(path, sessionDir, cwd) => SessionManager`; the default calls `SessionManager.open(path, sessionDir, cwd)`. Pass cwd at the single open site before branching. Keep `getSessionFile()`, the captured leaf id, per-index cache and realpath containment check unchanged; never write the parent's file.
- [ ] Run the Tests command; expect every resolver test to pass, including the real SessionManager header assertion.
- [ ] Format and lint manually using neighboring source style; no formatter or lint command is configured. Check that the cwd argument is not canonicalized and existing error strings are unchanged.
- [ ] Commit: `git add src/shared/fork-context.ts test/unit/fork-context.test.ts && git commit -m "Branch fork sessions under the child cwd (ref #40)"`.

### Task 2: Stamp detached session headers once before launch
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-31-gh-40-fork-cwd-override.md § "Detached: stamp the header at launch" L74-L74, § "Detached: stamp the header at launch" L75-L75, § "Test fixture" L82-L82, § "Errors and edge cases" L89-L89, § "Errors and edge cases" L90-L90, § "Errors and edge cases" L93-L93, § "Tests" L104-L104, § "Tests" L105-L105, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L31-L32

**Files:**
- Modify: `src/runs/background/subagent-runner.ts:650-733`
- Modify: `test/unit/async-execution.test.ts:402-482`
- Modify: `test/integration/async-execution.test.ts:786-855`
- Test: `test/unit/async-execution.test.ts`
- Test: `test/integration/async-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/async-execution.test.ts`
- baseline: c59b3b4 pass
- via: `runSingleStep`, `stampSessionHeaderCwd(sessionFile, cwd)`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test --test-name-pattern "async chains expand dynamic fanout and persist collected output" test/integration/async-execution.test.ts`
- baseline: c59b3b4 pass
- via: `executeAsyncChain`, `runSingleStep`

Decision: surface a stamping exception as `Failed to stamp session header cwd: ${cause.message}` in both output and error, with `exitCode: 1` and the original sessionFile. This adopts runSingleStep's existing pre-launch failure shape at `:674`, not an uncaught exception; no exact stamping-error wording is imposed by the spec.

Decision: the existing external-startup test must use a valid header because external owner creation is after backend selection. Keep the selection-failure variant's non-header bytes unchanged, but give external-startup a valid already-correct header and unchanged history. Source: test/unit/async-execution.test.ts:402-434 and subagent-runner.ts:737-752. A backend launch failure is not a backend-selection failure.

For `async: true`, the stamp makes header `cwd` agree with the resolved step directory and `pwd -P` observation. Do not stamp a `context: "fresh"` leaf with `cwd: "B"`: its newly created session remains without `parentSession`.

- [ ] Run both Tests commands; expect the existing runner/session publication cases and selected dynamic-fanout integration case to pass.
- [ ] Add direct runSingleStep tests using a persisted header with parentSession and distinctive history bytes, an A header and B step cwd. Intercept fs.writeFileSync for only that file, restore mocks in finally, and assert one stamp per invocation before mock Pi is called. Assert all header fields except cwd remain equal and the original history suffix remains byte-identical before child appends; run the same step again to prove idempotence. Include LF, CRLF and no trailing newline variants without reserializing history.
- [ ] Add invalid-session cases for missing file, unreadable file (inject EACCES on that exact read, avoiding platform permission differences), empty file, malformed JSON, null and non-session JSON. Assert an explicit error, exitCode 1 and zero mock calls. Exercise model fallback with a valid reused file and assert one stamping write across attempts. Keep a fresh leaf with no sessionFile launching without stamping or parentSession.
- [ ] Update reuse/external-reuse fixtures at `test/unit/async-execution.test.ts:443-470` and the dynamic-fanout fixture at `test/integration/async-execution.test.ts:794-827` to a `type: "session"` header followed by valid history JSONL. Preserve history-byte checks after the first newline. Keep the selection-failure case at `test/unit/async-execution.test.ts:403-434` non-header and byte-identical; adjust only the external-startup variant as decided above.
- [ ] Run both Tests commands; expect the new header/zero-launch assertions to fail before the runner change.
- [ ] Add private `stampSessionHeaderCwd(sessionFile, cwd)` in `src/runs/background/subagent-runner.ts`. Read a Buffer, locate the first LF, parse only the first line as UTF-8 JSON, require a non-null object with `type === "session"`, assign cwd and concatenate the serialized header with the original newline and untouched suffix Buffer. Preserve CRLF when present; preserve absent final newline for a header-only file. Reading, parsing or writing errors must reach the caller. Do not export the helper or import SessionManager.
- [ ] Inside `runSingleStep`, call the helper only when `step.sessionFile` exists as a value, after `childCwd` resolution (`:668-671`) and successful backend selection (`:676-699`), immediately before `const candidates = ...` (`:721`). Catch stamping errors with the decided failure shape. Place it outside both external `buildPiArgs` (`:780`) and native `buildPiArgs` (`:932`) attempt loops, so literal, group and `{outputs.` cwds share one path. Fresh leaves have no pre-created `sessionFile` and keep no `parentSession`.
- [ ] Run both Tests commands; expect passing stamp, fallback, external reuse, untouched selection-failure and dynamic-fanout history assertions.
- [ ] Format and lint manually using neighboring source style; no configured lint/format command. Confirm the suffix is copied as bytes and no parent file is opened for writing.
- [ ] Commit: `git add src/runs/background/subagent-runner.ts test/unit/async-execution.test.ts test/integration/async-execution.test.ts && git commit -m "Stamp detached fork cwd before launching attempts (ref #40)"`.

## Wave 2 - Foreground wiring and realistic fixture

Depends on Wave 1: Task 3 consumes the required resolver cwd argument; the strengthened mock also runs detached cases against the stamping mechanism.

### Task 3: Forward resolved cwd through every dispatch callback
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - run existing tests first, then strengthen the fixture before production wiring.

**Spec:** doc/specs/2026-10-31-gh-40-fork-cwd-override.md § "Resolver: branch under the child cwd" L66-L66, § "Resolver: branch under the child cwd" L67-L67, § "Resolver: branch under the child cwd" L68-L68, § "Resolver: branch under the child cwd" L69-L69, § "Detached: stamp the header at launch" L73-L73, § "Detached: stamp the header at launch" L76-L76, § "Test fixture" L80-L80, § "Test fixture" L81-L81, § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L31-L32, § "Errors and edge cases" L91-L91, § "Errors and edge cases" L92-L92, § "Errors and edge cases" L93-L93, § "Errors and edge cases" L94-L94, § "Tests" L98-L98, § "Tests" L99-L99, § "Tests" L101-L101, § "Tests" L102-L102, § "Tests" L106-L106, § "Tests" L107-L107, § "Tests" L108-L108, § "Out of scope" L119-L119, § "Out of scope" L120-L120, § "Out of scope" L121-L121

**Files:**
- Modify: `src/runs/foreground/subagent-executor.ts:164-2398`
- Modify: `src/runs/foreground/chain-execution.ts:111-1151`
- Modify: `test/support/mock-pi-script.mjs:125-260`
- Modify: `test/integration/fork-context-execution.test.ts:54-1049`
- Modify: `test/integration/chain-execution.test.ts:1240-1375`
- Test: `test/integration/fork-context-execution.test.ts`
- Test: `test/integration/chain-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/fork-context-execution.test.ts`
- baseline: c59b3b4 pass
- via: `createSubagentExecutor`, `sessionManager.openSession`, `runSync`, `echoCwd`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/chain-execution.test.ts`
- baseline: c59b3b4 pass
- via: `executeChain`, `sessionFileForIndex`, `resolveParallelTaskCwd`

Decision: carry the already-resolved lexical absolute value into the header; do not replace it with realpath. `resolveChildCwd` at `src/shared/utils.ts:27-30` owns resolution, while `pwd -P` owns physical-path observation. A missing cwd still fails spawn with ENOENT, without new validation.

- [ ] Run both Tests commands and record their existing behavior before strengthening assertions.
- [ ] Add a standalone fake-Pi precedence case to test/integration/fork-context-execution.test.ts: create launch A and target B with a directory symlink spelling of B, seed a session header pointing to the symlink, spawn the mock runtime with `--session` and an echoCwd response, and assert `realpath(B)` rather than A. Use a directory junction on Windows. The test should fail before the fixture change; no live-pi smoke test is added.
- [ ] In `test/support/mock-pi-script.mjs`, select the existing `--session` header's nonempty string cwd when line 1 is a session header; otherwise select `process.cwd()`. Pass the selected value into sessionWriter so newly emitted headers (`:158`) use lexical cwd. Make `echoCwd` (`:248`) report `fs.realpathSync.native(selected)`. Keep other fake behavior unchanged, including echoFiles; this change models the specific header/observation contract rather than adding production path logic.
- [ ] Update the stub interface and `sessionManager.openSession` implementation at `test/integration/fork-context-execution.test.ts:59, :206` to accept and record the third argument, replacing hardcoded `cwd: "/tmp"` in child headers. Seed a parent cwd A under the test temp root and parentSession provenance for forked headers. Add single-fork `cwd: B`, no-cwd fork, fresh `cwd: B`, plain parallel task-override, and worktree-parallel cases. For the ticket's `subagent({ context: "fork", cwd: "B" })`, assert both lexical header cwd B and the fake's `bash`/`pwd -P` equivalent. For `context: "fork"` with no cwd assert `realpath(A)`; for `context: "fresh"` and `cwd: "B"` assert B and no `parentSession`. Preserve parent file bytes in every fork case.
- [ ] Extend the existing chain tree-output setup at test/integration/chain-execution.test.ts:1270-1375 with a persisted real SessionManager parent and createForkContextResolver callback. Produce a patch-backed output tree, then pass its output reference as each parallel task's cwd, not only the group cwd; add a sequential consumer. Read each child's --session header and assert it equals the resolved output tree, with runtime observation equal to realpath while the tree exists. Retain the cleanup assertions. Add a worktree fork assertion that the producer header names its agent worktree, not the group cwd.
- [ ] Run both Tests commands; expect new fork cwd assertions to fail until the forwarding sites are changed, while the standalone fake precedence case now passes.
- [ ] Update `childSessionFileForIndex` / `sessionFileHintForIndex` at `src/runs/foreground/subagent-executor.ts:2378-2379` to `(idx, cwd)` and forward `sessionFileForIndex(idx, cwd)`, retaining `?? path.join(sessionDirForIndex(idx), "session.jsonl")`. Update `sessionFileForIndex` and `sessionFileHintForIndex` types at `subagent-executor.ts:164-165`, the parallel input at `:1282`, and chain callbacks at `chain-execution.ts:111` and `:400` to `(idx: number, cwd: string) => string | undefined`.
- [ ] Forward the exact launch-local value at all foreground sites: `effectiveCwd` at `subagent-executor.ts:2054`; `taskCwd` after `resolveParallelTaskCwd` at `:1493`; `taskCwd` at `chain-execution.ts:307`; `stepCwd` at `:1151` (assigned at `:1099`). Preserve `effectiveCwd = effectiveParams.cwd ?? ctx.cwd` at `:2318`. Pass effectiveCwd at both executeAsyncSingle branches, `subagent-executor.ts:1150` and `:1976`.
- [ ] For `async: true`, keep `collectChainSessionFiles` at `subagent-executor.ts:938-956` index-only by wrapping its callback at callers to bind effectiveCwd. Pass provisional effectiveCwd at pre-creation sites `:1079, :1109, :1251` and `:1715`. Do not resolve output templates early. Keep the dynamic-fanout skip at `:952`; detached dynamic leaves still get no pre-created fork file. Do not change project-agent/settings discovery, the `status: BLOCKED` parent guard, or pi-gauntlet #36's `context: "fresh"` workaround.
- [ ] Run both Tests commands; expect all foreground header/observation and existing chain lifecycle assertions to pass. The worktree header deliberately remains its launch directory after `cleanupWorktrees`; reopening with `--session` can still hit Pi's missing-cwd check (`dist/main.js:556-569`, `process.exit(1)`). Do not stamp a group cwd after cleanup.
- [ ] Format and lint manually using neighboring style; no configured command. Search all resolver/callback call sites and ensure each now supplies cwd, without changing unrelated sessionDir callbacks.
- [ ] Commit: `git add src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts test/support/mock-pi-script.mjs test/integration/fork-context-execution.test.ts test/integration/chain-execution.test.ts && git commit -m "Forward resolved child cwd on every fork dispatch (ref #40)"`.

## Wave 3 - Detached end-to-end regression

Depends on Waves 1 and 2: Task 4 requires both launch-time stamping and mock header precedence; it reopens the integration file whose reused fixture Task 2 repaired.

### Task 4: Prove detached forks use late-resolved cwd
Leg: jjuraszek/pi-cohort

**TDD scenario:** Modifying tested code - run existing tests first; this test-only task covers the mechanisms whose red/green cycles ran in Tasks 1-3.

**Spec:** doc/specs/2026-10-31-gh-40-fork-cwd-override.md § "Acceptance criteria" L27-L28, § "Tests" L100-L100, § "Errors and edge cases" L93-L93, § "Errors and edge cases" L94-L94

**Files:**
- Modify: `test/integration/async-execution.test.ts:1060-1235`
- Test: `test/integration/async-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts`
- baseline: c59b3b4 pass
- via: `createSubagentExecutor`, `executeAsyncChain`, `runSingleStep`, `echoCwd`

Decision: use the existing executor harness and actual persisted SessionManager parent, not a hand-authored final B header. This proves dispatch pre-creation, serialization of `{outputs.` templates, and runner replacement together. Existing tree fixtures at test/integration/async-execution.test.ts:1087-1201 provide patch setup and cleanup; read recorded session paths before removing the test root.

- [ ] Run the Tests command; expect existing detached tests to pass after prior waves.
- [ ] Add a context-fork `async: true` executor chain with parent cwd A, a worktree producer that emits a patch-backed output, and a sequential second step whose cwd uses the producer's treePath reference. Capture the serialized config as the existing tree test does; assert the template remains unresolved there and the pre-created session header initially names A. Queue echoCwd observations for consumers.
- [ ] Add assertions that the second step's final header `cwd` equals the lexical resolved tree path and its `pwd -P` equivalent equals the observed realpath. Assert parent bytes unchanged and parentSession retained. Record physical tree paths while they exist, because cleanup removes them before the completed result is published. Add parallel consumers covering a group output-derived cwd and a literal per-task override, and a detached single fork with explicit cwd B.
- [ ] Run the Tests command; expect all detached tests and the new final-header/runtime comparisons to pass, including the dynamic-fanout fixture history check from Task 2. Require the captured provisional A header to differ from final B so the assertions cannot pass by seeding the correct final cwd.
- [ ] Format and lint manually using existing test style; no configured lint/format command. Keep new fixtures temporary and retain platform guards for shell-hook worktrees.
- [ ] Commit: `git add test/integration/async-execution.test.ts && git commit -m "Cover late-resolved cwd in detached fork sessions (ref #40)"`.

## Wave 4 - Release documentation

Depends on Waves 1-3: document the implemented and tested behavior without changing public API documentation.

### Task 5: Record the fork cwd fix in the changelog
Leg: jjuraszek/pi-cohort

**TDD scenario:** Trivial change - documentation only.

**Spec:** doc/specs/2026-10-31-gh-40-fork-cwd-override.md § "Documentation impact" L112-L112

**Files:**
- Modify: `CHANGELOG.md:1-5`

**Tests:**
- none: docs

- [ ] Add `## [Unreleased]` and a Fixed bullet to `CHANGELOG.md`: "Forked subagents use their resolved child cwd, including per-task and output-derived cwd in foreground and detached runs, instead of inheriting the parent session directory. (#40)" Preserve released entries.
- [ ] Read the touched heading block for present-tense behavior and compact Markdown. README Architecture and `doc/agents-and-chains.md` Chain variables already state this contract; neither needs a new section or contract edit. Do not bump package versions or add a live-Pi smoke guide.
- [ ] Commit: `git add CHANGELOG.md && git commit -m "Document fork cwd correction (ref #40)"`.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L23-L24 | Single fork header and physical cwd use B | Task 1, Task 3 |
| § "Acceptance criteria" L25-L26 | Foreground parallel chain uses producer-derived per-task cwd | Task 1, Task 3 |
| § "Acceptance criteria" L27-L28 | Detached second step uses producer-derived cwd | Task 1, Task 2, Task 3, Task 4 |
| § "Acceptance criteria" L29-L30 | No-cwd fork inherits A | Task 1, Task 3 |
| § "Acceptance criteria" L31-L32 | Fresh B has no parent provenance | Task 2, Task 3 |
| § "Acceptance criteria" L33-L34 | Real resolver branches with B header | Task 1 |
| § "Resolver: branch under the child cwd" L64-L64 | Required cwd on resolver and both opener hooks | Task 1 |
| § "Resolver: branch under the child cwd" L65-L65 | Preserve cache, snapshot and containment | Task 1 |
| § "Resolver: branch under the child cwd" L66-L66 | Forward through branching wrapper, retain fresh filename fallback | Task 3 |
| § "Resolver: branch under the child cwd" L67-L67 | Update every callback type | Task 3 |
| § "Resolver: branch under the child cwd" L68-L68 | Forward launch-local cwd on foreground and async single surfaces | Task 3 |
| § "Resolver: branch under the child cwd" L69-L69 | Store lexical resolved paths, observe physical paths | Task 3 |
| § "Detached: stamp the header at launch" L73-L73 | Keep provisional pre-creation using request cwd | Task 3 |
| § "Detached: stamp the header at launch" L74-L74 | Stamp header once after selection before attempts | Task 2 |
| § "Detached: stamp the header at launch" L75-L75 | Leave fresh leaves without pre-created session untouched | Task 2 |
| § "Detached: stamp the header at launch" L76-L76 | Preserve dynamic-fanout skip | Task 3 |
| § "Test fixture" L80-L80 | Fake header precedence and physical cwd observation | Task 3 |
| § "Test fixture" L81-L81 | Stub writes received opener cwd | Task 3 |
| § "Test fixture" L82-L82 | Valid reuse fixtures and untouched selection-failure sentinel | Task 2 |
| § "Errors and edge cases" L89-L89 | One idempotent stamp across model/backend attempts | Task 2 |
| § "Errors and edge cases" L90-L90 | Explicit failure before launch; selection error wins | Task 2 |
| § "Errors and edge cases" L91-L91 | Worktree header retains removed launch directory | Task 3 |
| § "Errors and edge cases" L92-L92 | Leave nonexistent-cwd spawn behavior unchanged | Task 3 |
| § "Errors and edge cases" L93-L93 | Never write parent session | Task 1, Task 2, Task 3, Task 4 |
| § "Errors and edge cases" L94-L94 | Lexical symlink header and physical observation | Task 3, Task 4 |
| § "Tests" L98-L98 | Single fork B integration case | Task 3 |
| § "Tests" L99-L99 | Parallel chain output-derived B integration case | Task 3 |
| § "Tests" L100-L100 | Detached late-resolution integration case | Task 4 |
| § "Tests" L101-L101 | Parent-cwd inheritance integration case | Task 3 |
| § "Tests" L102-L102 | Fresh-context compatibility integration case | Task 3 |
| § "Tests" L103-L103 | Third opener argument and real branched header unit case | Task 1 |
| § "Tests" L104-L104 | Stamp behavior through the runner, not helper export | Task 2 |
| § "Tests" L105-L105 | Valid reused sessions retain history and error ordering | Task 2 |
| § "Tests" L106-L106 | Worktree-parallel header regression | Task 3 |
| § "Tests" L107-L107 | Fake precedence with symlink header cwd | Task 3 |
| § "Tests" L108-L108 | Preserve existing spawn-ENOENT behavior | Task 3 |
| § "Documentation impact" L112-L112 | Changelog entry; existing guides retain contract | Task 5 |
| § "Out of scope" L119-L119 | Do not change the `status: BLOCKED` parent guard | Task 3 |
| § "Out of scope" L120-L120 | No detached dynamic-fanout fork pre-creation | Task 3 |
| § "Out of scope" L121-L121 | No pi-gauntlet guard or `context: "fresh"` workaround edit | Task 3 |
| § "Out of scope" L122-L122 | Live-Pi smoke suite excluded in favor of fake precedence | waived: out of scope per spec |
| § "Out of scope" L123-L123 | Request-level agent/settings discovery excluded | waived: out of scope per spec |
