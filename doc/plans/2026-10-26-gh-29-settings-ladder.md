# Settings ladder Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Resolve every `ExtensionConfig` key from `settings.json#subagents` at each execution unit's effective cwd and retire the private configuration reader.

**Architecture:** Extend the existing project-only discovery ladder and expose a sparse user-plus-project resolver. Inject the resolver into executors, keep call-level policy separate from per-unit hooks and backend selection, and use a presence-only session-start migration warning. Detached runners resolve unit policy after cwd interpolation, retaining the existing serialized job-wide tuple only as a same-job-cwd fallback.

**Tech Stack:** TypeScript, Node's test runner and type stripping, jiti for detached runners, existing mock Pi runtime fixtures.

**Spec:** `doc/specs/2026-10-26-gh-29-settings-ladder.md`

**Verification:** `env -u PI_CODING_AGENT_DIR npm run test:all` - includes the shared AGENTS consistency check, unit tests, and integration tests. No lint or formatter is configured in package.json, repository config, or the overrides; review source style manually and check scoped whitespace in code tasks.

**Ticket:** `jjuraszek/pi-cohort#29`

---

## Baseline provenance

Initial inventory before the original commands: BASE `72a0035`; the sole status entry was `?? doc/plans/2026-10-26-gh-29-settings-ladder.md`. Admitted that exact plan path; the approved spec path `doc/specs/2026-10-26-gh-29-settings-ladder.md` was clean. No other in-flight paths were supplied or admitted. After each of four executed commands, HEAD remained `72a0035` and status remained exactly that single entry; no artifacts or contamination appeared.

Findings re-dispatch inventory: BASE `5abf596`; the sole status entry remains `?? doc/plans/2026-10-26-gh-29-settings-ladder.md`, admitted as the exact plan path. The spec path is clean; no other paths are admitted. `git diff --quiet 72a0035 HEAD -- . ':!doc/specs/' ':!doc/plans/'` exited 0 with HEAD read as `5abf596`. All command texts were unchanged on initial re-dispatch; retained 5 bullets: `72a0035` -> `5abf596`, tree-equivalent outside `doc/specs`, `doc/plans`.

- Task 1 command executed unchanged: exit 0, 64 tests passed, none skipped.
- Task 2 unit command executed with only its newly created anchor removed: exit 0, 38 tests passed, none skipped.
- Task 2 integration command executed unchanged: exit 0, 174 tests passed, none skipped.
- Task 3 command has only a created test anchor; baseline regenerated under the all-created rule after moving its Test entry before Delete so the checker parses it.
- Task 4's original selector covered 19 existing tests. Checker repair splits that same selection into two commands without shell separator characters. Both changed commands were executed at `5abf596`: `tree` passed 15 tests and `teardown` passed 4 tests, exit 0 and none skipped. After each run, HEAD remained `5abf596` and status remained exactly the admitted plan entry; no artifacts or contamination appeared. Their bullets are fresh execution evidence, not retained evidence.

## Files

### Settings and backend selection

**Modify:**
- `src/agents/agents.ts` - parse and merge all settings, export the resolver, remove the project-backend-only reader.
- `src/shared/types.ts` - retain `ExtensionConfig`, update its settings-source comment.
- `src/execution-backend/configured-selection.ts` - consume the already resolved preference only.
- `test/unit/execution-backend-project-settings.test.ts` - resolver ladder matrix.
- `test/unit/execution-backend-configured-selection.test.ts` - no internal reread.
- `test/unit/pi-coding-agent-dir.test.ts` - replace the private-file fixture.

### Executor and extension registration

**Create:**
- `test/unit/settings-executor.test.ts` - per-call and per-unit resolution regressions.
- `test/unit/settings-session-start.test.ts` - presence-only warning and roster policy.

**Modify:**
- `src/runs/foreground/subagent-executor.ts` - resolver dependency and scoped configuration transport.
- `src/runs/foreground/chain-execution.ts` - resolve step and group policy after cwd interpolation.
- `src/runs/foreground/execution.ts` - consume the supplied unit backend preference without loading settings.
- `src/extension/index.ts` - registration, session-start resolution and warning, current-contract header.
- `src/extension/fanout-child.ts` - resolver injection instead of a snapshot.
- `test/support/runtime-parent.mjs` - new executor dependency.
- `test/support/sdk-host-parent.mjs` - new executor dependency.
- `test/unit/executor-runtime-default.test.ts` - new executor dependency.
- `test/unit/nested-control.test.ts` - new dependency and nested/resume regressions.
- `test/integration/single-execution.test.ts` - new dependency.
- `test/integration/async-execution.test.ts` - new dependency and detached project-hook regressions.
- `test/integration/parallel-execution.test.ts` - new dependency and per-task cwd regression.
- `test/integration/fork-context-execution.test.ts` - new dependency.
- `test/integration/doctor-executor.test.ts` - call-scoped report config.

**Delete:**
- `src/extension/config.ts`

### Detached execution

**Modify:**
- `src/runs/background/async-execution.ts` - retain resolved call-level hooks and backend preference as the job-wide serialized tuple.
- `src/runs/background/subagent-runner.ts` - resolve per-unit settings after cwd interpolation and before backend or worktree group preparation; no new serialized fields.

### Current-contract documentation

**Modify:**
- `doc/configuration.md` - only settings source, complete examples, defaults and migration.
- `README.md` - configuration pointer.
- `doc/agents-and-chains.md` - settings merge contract.
- `CHANGELOG.md` - new `## [Unreleased]` breaking-change entry.

## Recon and execution conventions

- The overrides contain no Happy path table and no deployment topology. This is one change, not a deployment-driven split.
- `src/agents/agents.ts:117-123,449-531` owns extraction and the project merge; `291-314` owns the strict profile read; discovery at `1072-1073` depends on the project merge not reading user settings.
- `src/runs/foreground/subagent-executor.ts:2163` resolves request cwd; `580-740` handles resume; `2329-2350` applies async, control and session defaults. Do not cache config in the executor closure or mutate its dependencies between concurrent calls.
- `src/runs/foreground/chain-execution.ts:240-248,648-668,1088-1090` contains task/group cwd preparation. Resolve output references before group worktree setup, not just before leaf execution.
- `src/runs/background/async-execution.ts:455-462` preserves unresolved cwd templates; `src/runs/background/subagent-runner.ts:660-672,2106-2139` supplies the late-bound boundaries. The amended Design 3 authorizes runner-side reads at these boundaries rather than per-unit serialization.
- `test/support/mock-pi.ts:63-100` creates an isolated fake runtime and queue. Reuse it instead of invoking real model providers. Use fresh temp project/profile roots and restore environment overrides during test cleanup.
- File-addressable unit command: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/executor-runtime-default.test.ts`. Integration adds `--import ./test/support/register-loader.mjs` before `--test`. No tsc, lint, or formatter script exists. Scoped whitespace checking uses `git diff --check --` followed by exact task paths; it is not a typecheck or linter.

## Wave 1 - Settings foundation

### Task 1: Extend the ladder and make backend selection consume one preference

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-26-gh-29-settings-ladder.md § "Acceptance criteria" L23-L24, § "Acceptance criteria" L31-L32, § "Acceptance criteria" L34, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L44, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L46, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L48, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L50, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L52, § "2. Delete `src/extension/config.ts`" L56, § "Errors and edge cases" L95, § "Errors and edge cases" L96, § "Errors and edge cases" L97, § "Errors and edge cases" L98, § "Errors and edge cases" L99, § "Errors and edge cases" L101, § "Tests" L110, § "Tests" L113, § "Tests" L115

**Files:**
- Modify: `src/agents/agents.ts:117-123`
- Modify: `src/agents/agents.ts:449-531`
- Modify: `src/shared/types.ts:855-885`
- Modify: `src/execution-backend/configured-selection.ts:1-30`
- Modify: `test/unit/execution-backend-project-settings.test.ts`
- Modify: `test/unit/execution-backend-configured-selection.test.ts`
- Modify: `test/unit/pi-coding-agent-dir.test.ts:1-125`
- Test: `test/unit/execution-backend-project-settings.test.ts`
- Test: `test/unit/execution-backend-configured-selection.test.ts`
- Test: `test/unit/pi-coding-agent-dir.test.ts`
- Test: `test/unit/agent-overrides.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/execution-backend-project-settings.test.ts test/unit/execution-backend-configured-selection.test.ts test/unit/pi-coding-agent-dir.test.ts test/unit/agent-overrides.test.ts`
- baseline: 5abf596 pass
- via: `resolveExtensionConfig(cwd: string): ExtensionConfig`, `readSubagentSettings`, `readMergedProjectSubagentSettings(cwd)`, `selectConfiguredExecutionBackend`, `resolveCurrentMaxSubagentDepth`, `resolveTopLevelParallelMaxTasks`

Decision: Preserve the existing parser's distinction between a malformed persona entry and a non-object override container - `src/agents/agents.ts:333-447,480-488` throws for invalid entries but treats a non-object container as no overrides. The spec's instruction to keep the three existing keys' behavior controls; do not broaden validation while adding keys.

Contract names for the precedence table: `.pi/settings.json`, profile `settings.json`, `ExtensionConfig`, `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`. Retain `subagents`, `disableBuiltins`, `agentOverrides`, `InvalidExecutionBackendSettingError` and the legacy validation at `src/agents/agents.ts:460,465-475,508-511`.

Contract references for defaults and merge: `src/runs/shared/worktree.ts:205,272` owns `30000`; `src/shared/types.ts:987,1022` and the `!== false` / `=== true` checks own defaults, while `chain.dynamicFanout.maxItems` remains required. Preserve timeout validation at `src/runs/shared/worktree.ts:205-210,272-280` in `worktree.ts`. Keep `enumerateProjectLevels`, `agentScope: "project"`, `test/unit/agent-overrides.test.ts:141-164`, and whole-value replacement rather than `mergeGauntlet` dependency. Use `readSubagentSettings(getUserAgentSettingsPath())`. Keep project skip behavior at `agents.ts:505-516`, strict profile reads at `agents.ts:291-312,1072,1123`, and non-git `cwd` discovery via `.pi` or `.agents` at `agents.ts:248-252,273-284`. Test `.pi/settings.json#subagents.worktreeSetupHook` explicitly.

Contract references for the backend handoff: remove `readProjectExecutionBackend(input.cwd)` at `configured-selection.ts:16-17`; `userConfig` is already resolved. Task 2 adapts `src/runs/foreground/execution.ts:687-692`; Task 4 adapts `src/runs/background/subagent-runner.ts:668-672`, including `userPreference` from `detachedExecutionBackends` at `src/runs/background/async-execution.ts:91`. Preserve the `loadConfig()` removal boundary and `index.ts` re-export removal for Tasks 2-3. Replace only the `extensions/pi-cohort/config.json` fixture at `test/unit/pi-coding-agent-dir.test.ts:120-125`; preserve `config.json` in `test/unit/execution-reporting-protocol.test.ts`, `test/unit/external-foreground-execution.test.ts`, and `test/integration/detached-external-orchestration.test.ts`.

- [ ] **Step 1: Run the Tests command.** Expect passing resolver-adjacent, backend and discovery regressions before adding cases.
- [ ] **Step 2: Add a table for all 14 extension keys.** Set different profile, git-root and nearest-level values, remove nearer values in order, and assert nearest, root, profile and absence. Assert the result contains only extension keys, not `overrides` or `disableBuiltins`. Include a scalar, `parallel` and a hook in the replacement profile-directory fixture; import the resolver from agents rather than `loadConfig()` from the extension.
- [ ] **Step 3: Add parser and scope regressions.** Cover new boolean/string/object categories; negative/fractional/string depth; null and array object values; empty hook strings; both timeout keys retaining `0`, `-1`, `1.5` and a string verbatim; malformed project JSON with a valid farther value; malformed profile rejection; repeated per-read warning counts and file/key text; non-git marked ancestor; unmarked directory; and project-only discovery isolation. Verify nearer `control`, `parallel` and `chain` objects replace, not compose, and defaults remain consumer-owned.
- [ ] **Step 4: Change backend tests to one preference.** Put conflicting or invalid project backend settings on disk and supply `userConfig.executionBackend`; assert the supplied value alone wins without project parsing. Absence selects `"auto"`. Keep trimming and invalid-backend rejection in resolver tests.
- [ ] **Step 5: Run Tests red.** Expect the new resolver import or precedence assertions to fail, not fixture setup.
- [ ] **Step 6: Extend extraction and the project fold.** Add sparse extension fields to the internal settings record. Validate new booleans, strings, non-negative integer depth and plain objects at extraction; warn once per rejected file/key/read and retain other fields. Carry timeouts without coercion. Keep backend validation and persona merge rules. Copy only defined extension fields in the farthest-to-nearest project fold.
- [ ] **Step 7: Export the sparse resolver.** Implement `resolveExtensionConfig(cwd: string): ExtensionConfig` by strictly reading `getUserAgentSettingsPath()`, overlaying the project-only merge and projecting the 14 extension keys. Add no defaults, deep merges, schema version, or dependency on pi-gauntlet.
- [ ] **Step 8: Remove the backend reread.** Delete `readProjectExecutionBackend`, remove its import in configured selection, and use `userConfig.executionBackend ?? "auto"`. Retain cwd as backend preparation input. Update the `ExtensionConfig` source comment to `settings.json#subagents`.
- [ ] **Step 9: Run Tests green.** Require executed tests, zero failures, and the project-scope override test unchanged.
- [ ] **Step 10: Review format and lint scope.** No formatter/linter is configured; match neighboring tabs, imports and error style. Run: `git diff --check -- src/agents/agents.ts src/shared/types.ts src/execution-backend/configured-selection.ts test/unit/execution-backend-project-settings.test.ts test/unit/execution-backend-configured-selection.test.ts test/unit/pi-coding-agent-dir.test.ts`. Expect no whitespace errors.
- [ ] **Step 11: Commit.** Stage this task's modified files and run `git commit -m "Resolve extension settings through the project ladder (#29)"`.

## Wave 2 - Executor resolution

Depends on Wave 1: Task 2 consumes the resolver and the single-preference backend contract.

### Task 2: Resolve call and foreground unit policy without snapshots

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-26-gh-29-settings-ladder.md § "Acceptance criteria" L21-L22, § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L34, § "Acceptance criteria" L36, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L46, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L52, § "2. Delete `src/extension/config.ts`" L56, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L60, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L62, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L64, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L65, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L66, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L67, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L69, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L71, § "4. Extension entry points" L77, § "Errors and edge cases" L98, § "Errors and edge cases" L99, § "Errors and edge cases" L102, § "Errors and edge cases" L104, § "Tests" L111, § "Tests" L112, § "Tests" L113, § "Tests" L115, § "Tests" L116, § "Out of scope" L128, § "Out of scope" L132

**Files:**
- Create: `test/unit/settings-executor.test.ts`
- Modify: `src/runs/foreground/subagent-executor.ts:140-2518`
- Modify: `src/runs/foreground/chain-execution.ts:240-1275`
- Modify: `src/runs/foreground/execution.ts:687-692`
- Modify: `src/extension/index.ts:39-64`
- Modify: `src/extension/index.ts:253-300`
- Modify: `src/extension/fanout-child.ts:129-141`
- Modify: `test/support/runtime-parent.mjs:155-160`
- Modify: `test/support/sdk-host-parent.mjs:12-17`
- Modify: `test/unit/executor-runtime-default.test.ts`
- Modify: `test/unit/nested-control.test.ts`
- Modify: `test/integration/single-execution.test.ts`
- Modify: `test/integration/async-execution.test.ts`
- Modify: `test/integration/parallel-execution.test.ts`
- Modify: `test/integration/fork-context-execution.test.ts`
- Modify: `test/integration/doctor-executor.test.ts`
- Test: `test/unit/settings-executor.test.ts`
- Test: `test/unit/executor-runtime-default.test.ts`
- Test: `test/unit/nested-control.test.ts`
- Test: `test/integration/single-execution.test.ts`
- Test: `test/integration/parallel-execution.test.ts`
- Test: `test/integration/fork-context-execution.test.ts`
- Test: `test/integration/doctor-executor.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/settings-executor.test.ts test/unit/executor-runtime-default.test.ts test/unit/nested-control.test.ts`
- baseline: 5abf596 pass via `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/executor-runtime-default.test.ts test/unit/nested-control.test.ts`
- via: `createSubagentExecutor`, `execute()`, `createWorktrees`, `resolveConfig`, `target.cwd`, `deriveForwardedFlags(process.argv, config)`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/single-execution.test.ts test/integration/parallel-execution.test.ts test/integration/fork-context-execution.test.ts test/integration/doctor-executor.test.ts`
- baseline: 5abf596 pass
- via: `runSync`, `executeChain`, `resolveChildCwd`, `buildDoctorReport`

Decision: Carry call config and flags on execution-local data, never assign them onto shared `deps` - the closure at `subagent-executor.ts:2135-2163` services multiple calls. Pass a resolver into chain preparation and derive backend options immediately after cwd resolution.

Decision: Preserve disabled-hook behavior for empty strings - both hook resolvers return immediately with no hook config (`src/runs/shared/worktree.ts:214-217,247-250`), and `test/integration/async-execution.test.ts:1373-1374` pairs an empty hook with a negative unused timeout. Timeout rejection tests configure a nonempty existing hook to exercise pre-creation validation without changing this contract.

Contract names for the call/unit matrix: `.pi/settings.json`, `settings.json`, `settings.json#subagents`, `subagents`, `ExtensionConfig`, `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`; acceptance spells the hook `subagents.worktreeTeardownHook`, timeout family `*TimeoutMs`, and checkout request `worktree: true`. Retire `extensions/pi-cohort/config.json` reads even without `subagents.*`; Task 3 owns the warning. Preserve `src/shared/types.ts`, `index.ts`, `src/runs/shared/worktree.ts:205,272` (`30000`), `src/shared/types.ts:987,1022`, `resolveCurrentMaxSubagentDepth`, `resolveTopLevelParallelMaxTasks`, `!== false`, `=== true`, `"auto"` and required `chain.dynamicFanout.maxItems`. Keep validation in `src/runs/shared/worktree.ts:205-210,272-280` / `worktree.ts`.

Contract boundary references: use `requestCwd` and per-unit `cwd`; resume is `subagent-executor.ts:629`. Hook groups prepare at `src/runs/background/subagent-runner.ts:2106-2139` and `src/runs/foreground/chain-execution.ts:647-668`, with relative paths rooted as `doc/configuration.md:115` describes. Backend selection in `src/execution-backend/configured-selection.ts` no longer calls `readProjectExecutionBackend(input.cwd)` at `configured-selection.ts:16-17`; Task 1 deletes `readProjectExecutionBackend`, leaving `userConfig.executionBackend ?? "auto"` and resolved `userConfig`. Foreground caller is `src/runs/foreground/execution.ts:687-692`; detached caller is `src/runs/background/subagent-runner.ts:668-672`, with `userPreference` from `detachedExecutionBackends` at `src/runs/background/async-execution.ts:91`. Related contracts are tested in `test/unit/execution-backend-configured-selection.test.ts` and `test/unit/execution-backend-project-settings.test.ts`.

Contract boundary references for Task 4: `async-execution.ts` keeps `SubagentRunConfig` at `subagent-runner.ts:107-131`; `subagent-runner.ts` calls `resolveExtensionConfig(unitCwd)` after interpolation at `subagent-runner.ts:660-672`, with only same-job-cwd fallback. This task supplies the fanout resolver, replacing `fanout-child.ts:129-141`. `doctor` passes call config to `src/extension/doctor.ts:187`. Migrate `createSubagentExecutor({ config, asyncByDefault, forwardedFlags })` across `test/integration/{single,async,parallel,fork-context}-execution.test.ts` and the enumerated files above; no `tsc` catches a stale `config:` dependency. Only Task 1 replaces `test/unit/pi-coding-agent-dir.test.ts:120-125`; preserve `test/unit/execution-reporting-protocol.test.ts`, `test/unit/external-foreground-execution.test.ts`, and `test/integration/detached-external-orchestration.test.ts` job/reporter files.

- [ ] **Step 1: Run existing-file tests.** Before creating the new test, run the recorded base unit command and the integration Tests command. Expect existing executor, nested-control and integration cases to pass.
- [ ] **Step 2: Add per-call policy regressions.** Use a resolver spy returning different values for two absolute temp project roots; execute twice on one executor. Assert call cwd, async default, force-top-level override, depth, session fallback, control, parallel limits and dynamic fanout limits come from that call. Assert forwarded flags change with `forwardParentFlags` without changing flag parsing. Single execution reuses call config rather than reading twice.
- [ ] **Step 3: Add per-unit hook/backend regressions.** Use two temp projects with distinct settings and hook marker scripts. Cover parallel tasks with distinct cwd, a chain step in another project, a worktree group whose cwd is an earlier named output, and resume whose `target.cwd` differs from the request. Assert setup/teardown markers and timeouts belong to the selected group, once per checkout; assert the backend receives the matching unit preference. Configured-hook timeouts `-1`, `0`, `1.5` and nonnumeric values fail before checkout creation without fallback; an empty hook stays unset.
- [ ] **Step 4: Add fanout and doctor regressions.** Extend nested-control's child registration fixture with a nested `subagent()` using `params.cwd` in another marked project; prove resolution follows that cwd and management restrictions remain. Vary doctor cwd and assert its session directory follows call config while report shape and lack of settings provenance remain unchanged.
- [ ] **Step 5: Run Tests red.** Expect the resolver dependency to be unused or the second project's markers/preference to be wrong.
- [ ] **Step 6: Change dependencies and call policy.** Replace `ExecutorDeps.config: ExtensionConfig` with `resolveConfig: (cwd: string) => ExtensionConfig`; remove `asyncByDefault` and `forwardedFlags` deps. Immediately after `requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd)`, resolve once and derive flags with `deriveForwardedFlags(process.argv, config)`. Use this object for depth, `control`, `defaultSessionDir`, `forceTopLevelAsync`, `asyncByDefault`, `parallel` and `chain.dynamicFanout`; preserve consumer defaults and error handling.
- [ ] **Step 7: Wire single, parallel and resume.** Single reuses the request object. Resolve each non-worktree task at its effective cwd and each worktree group's hooks at its source group cwd before `createWorktrees`. Resolve resume hook/backend config at `effectiveCwd = target.cwd ?? requestCwd`. Supply the backend through the existing option consumed by `runSync`; do not re-read settings in backend selection or substitute generated checkout paths for group hook resolution.
- [ ] **Step 8: Wire foreground chains.** Pass the resolver through `executeChain` and its parallel helper. Resolve group cwd with `resolveOutputReferences` before `resolveChildCwd` and worktree creation. Resolve sequential and parallel leaf settings after `{outputs.` placeholders and `step.cwd` are filled; give each leaf its backend preference. Keep call limits/flags separate. Preserve group-repository-root relative hooks and worktree trust behavior.
- [ ] **Step 9: Migrate every constructor.** Index and fanout-child inject `resolveConfig: resolveExtensionConfig`; remove their `loadConfig()` imports/calls and dependency snapshots. Test/support callbacks return their existing fixture config; fold explicit async defaults into those callbacks. Preserve runtime-parent's input protocol `request.config`. Migrate all listed unit/integration callers, including async-execution before Task 4 changes behavior. Preserve reporter and detached job `config.json` fixtures.
- [ ] **Step 10: Run Tests green.** Confirm per-unit values, no stale dependency crash, unchanged fork context and doctor behavior. Task 4 owns detached mixed-cwd behavior; giving the whole chain request config is not sufficient.
- [ ] **Step 11: Review format and lint scope.** No formatter/linter is configured; inspect touched hunks against neighbors. Run: `git diff --check -- src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts src/runs/foreground/execution.ts src/extension/index.ts src/extension/fanout-child.ts test/unit/settings-executor.test.ts test/unit/executor-runtime-default.test.ts test/unit/nested-control.test.ts test/support/runtime-parent.mjs test/support/sdk-host-parent.mjs test/integration/single-execution.test.ts test/integration/async-execution.test.ts test/integration/parallel-execution.test.ts test/integration/fork-context-execution.test.ts test/integration/doctor-executor.test.ts`. Expect no whitespace errors.
- [ ] **Step 12: Commit.** Stage this task's created/modified files and run `git commit -m "Resolve executor policy at each effective cwd (#29)"`.

## Wave 3 - Startup migration and detached units

Depends on Waves 1-2: Task 3 uses resolver registration and Task 4 uses scoped executor values. Tasks 3 and 4 own disjoint files; tests use independent temporary profiles, runtimes and projects without shared services or fixed ports.

### Task 3: Delete the private reader and warn once at session start

**TDD scenario:** New feature - full TDD cycle.

**Spec:** doc/specs/2026-10-26-gh-29-settings-ladder.md § "Acceptance criteria" L23-L24, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L38, § "2. Delete `src/extension/config.ts`" L56, § "4. Extension entry points" L75, § "Errors and edge cases" L100, § "Tests" L114, § "Tests" L115, § "Documentation impact" L123

**Files:**
- Create: `test/unit/settings-session-start.test.ts`
- Modify: `src/extension/index.ts:1-64`
- Modify: `src/extension/index.ts:543-553`
- Test: `test/unit/settings-session-start.test.ts`
- Delete: `src/extension/config.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/settings-session-start.test.ts`
- baseline: 5abf596 skipped - test/unit/settings-session-start.test.ts created by this task
- via: `session_start`, `resolveExtensionConfig`, `ctx.ui.notify`, `console.warn`

Decision: Keep the warning in the real top-level `session_start` handler and check only existence - the child guard at `src/extension/index.ts:243` returns before top-level registration. Test captured event callbacks, not a second loader. Invoke shutdown callbacks to stop watcher/timer resources.

Contract names to keep in the namespaced header example: `.pi/settings.json`, `ExtensionConfig` in `src/shared/types.ts`, `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`. Remove `loadConfig()` and its `index.ts` re-export. Test ignored `extensions/pi-cohort/config.json` with no `subagents.*`, warning under `hasUI` and headless `pi -p`, and exclusion by `process.env[SUBAGENT_CHILD_ENV] === "1"` at `index.ts:243`.

Contract documentation boundary: Task 5 updates `doc/configuration.md`, `README.md`, `doc/agents-and-chains.md`, and `CHANGELOG.md` under `## [Unreleased]`; preserve `CHANGELOG.md:342,799` and `doc/specs/2026-09-06-gh-11-remove-pi-intercom.md:21`. This task updates only the extension header. Task 1 replaces `test/unit/pi-coding-agent-dir.test.ts:120-125`; keep `config.json` files in `test/unit/execution-reporting-protocol.test.ts`, `test/unit/external-foreground-execution.test.ts`, and `test/integration/detached-external-orchestration.test.ts`.

- [ ] **Step 1: Add session callback tests.** Register with a fake Pi capturing `on` handlers and supporting existing registration calls; seed minimal session manager/UI methods from index's reset path. Cover populated, empty and invalid legacy content with UI/headless contexts, absent path, settings alongside legacy values, child-only registration and a second session cwd with different roster config. Separate warnings from roster info messages.
- [ ] **Step 2: Run Tests red.** Assert exactly one warning per top-level session-start event, actual file path and both migration phrases. Before implementation the warning is absent or legacy values affect behavior.
- [ ] **Step 3: Implement presence-only migration.** Resolve once from `ctx.cwd` for `showRosterOnStart`. Construct the legacy path under dynamic `getAgentDir()`. On existence emit the path plus "pi-cohort no longer reads this file" and "move its keys under `subagents` in `settings.json`" using `ctx.hasUI ? ctx.ui.notify(message, "warning") : console.warn(message)`. Never open it for values; do not warn in fanout children or detached runners.
- [ ] **Step 4: Remove module and stale comments.** Delete `src/extension/config.ts` and the index re-export. Replace the header's private-file example with `settings.json#subagents` and a namespaced example. Keep only the migration warning's path reference. Preserve unrelated reporter/job config files and released history.
- [ ] **Step 5: Run Tests green.** Require warning count/channel/content and per-session roster assertions to pass, including invalid/empty legacy files without parse errors.
- [ ] **Step 6: Review format and lint scope.** No formatter/linter is configured. Run: `git diff --check -- src/extension/index.ts src/extension/config.ts test/unit/settings-session-start.test.ts`. Expect no whitespace errors; inspect imports and callback cleanup.
- [ ] **Step 7: Commit.** Stage this task's created/modified/deleted files and run `git commit -m "Retire private config and warn during migration (#29)"`.

### Task 4: Carry project hook and backend policy into detached execution

**TDD scenario:** Modifying tested code - run existing tests first.

**Spec:** doc/specs/2026-10-26-gh-29-settings-ladder.md § "Acceptance criteria" L21-L22, § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L36, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L46, § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L52, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L62, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L65, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L66, § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L69, § "Errors and edge cases" L98, § "Errors and edge cases" L102, § "Errors and edge cases" L103, § "Errors and edge cases" L104, § "Tests" L111, § "Tests" L113, § "Tests" L115, § "Tests" L118

**Files:**
- Modify: `src/runs/background/async-execution.ts:91-910`
- Modify: `src/runs/background/subagent-runner.ts:1-133`
- Modify: `src/runs/background/subagent-runner.ts:609-692`
- Modify: `src/runs/background/subagent-runner.ts:1337-1342`
- Modify: `src/runs/background/subagent-runner.ts:1963-1976`
- Modify: `src/runs/background/subagent-runner.ts:2106-2237`
- Modify: `src/runs/background/subagent-runner.ts:2402-2415`
- Modify: `test/integration/async-execution.test.ts:1032-1498`
- Test: `test/integration/async-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test --test-name-pattern tree test/integration/async-execution.test.ts`
- baseline: 5abf596 pass
- via: `executeAsyncSingle`, `executeAsyncChain`, `detachedExecutionBackends`, `SubagentRunConfig`, `runSingleStep`, `resolveExtensionConfig(unitCwd)`, `createWorktrees`, `resolveChildCwd`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test --test-name-pattern teardown test/integration/async-execution.test.ts`
- baseline: 5abf596 pass
- via: `executeAsyncSingle`, `executeAsyncChain`, `SubagentRunConfig`, `createWorktrees`

Decision: Apply the amended Design 3 L69 as the detached-specific rule over the older general parent-by-value language in L36/L52. Keep `SubagentRunConfig`'s four hook fields and `executionBackends.userPreference` as the job-wide tuple; resolve each unit in the runner. No new serialized fields, per-step snapshots or transport version changes.

Decision: A same-cwd fallback fills only absent unit keys, never overrides a defined unit value or catches a resolver error - the resolver is sparse (Design 1 L50), empty hooks remain defined but disabled (L46), and malformed profile/invalid backend errors still fail resolution (L96-L98). Different-cwd units get no job-tuple fallback, including when their settings are absent. Compare resolved absolute unit cwd with the original job cwd, not a generated checkout or the parent context of a leaf.

Decision: Carry original job cwd only in runner-local context - `SingleStepContext.cwd` is changed to a checkout by `prepareParallelTaskRun` at `subagent-runner.ts:1285-1296,2221-2224`. Add optional internal `jobCwd?: string` to `SingleStepContext`, pass the original `config.cwd` at all three runner call sites, and use `ctx.jobCwd ?? ctx.cwd` for direct `runSingleStep` callers. This adds no job-file field and preserves the existing exported test seam.

Contract names for job-wide versus unit policy: `.pi/settings.json`, profile `settings.json`, `settings.json#subagents`, `ExtensionConfig`, `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`. Test `subagents.worktreeTeardownHook`, `worktree: true`, both `*TimeoutMs` and invalid `-1`, `0`, `1.5` through existing `worktree.ts` validation at `src/runs/shared/worktree.ts:205-210,272-280`. Preserve call-level `execute()`, `requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd)`, `requestCwd`, `target.cwd`, `forwardedFlags`, `chain.dynamicFanout` and nested `subagent()` with its own `params.cwd` via `resolveConfig` from Task 2.

Contract preparation references: replace the stale backend reread in `src/execution-backend/configured-selection.ts`, `readProjectExecutionBackend(input.cwd)` at `configured-selection.ts:16-17`, already removed by Task 1 with `readProjectExecutionBackend`; the contract is `userConfig.executionBackend ?? "auto"` with resolved `userConfig`. Task 2 handles `src/runs/foreground/execution.ts:687-692`; this task handles `src/runs/background/subagent-runner.ts:668-672` and `src/runs/background/async-execution.ts:91`. Keep backend test contracts in `test/unit/execution-backend-configured-selection.test.ts` and `test/unit/execution-backend-project-settings.test.ts`. Group preparation sites are `src/runs/background/subagent-runner.ts:2106-2139` and `src/runs/foreground/chain-execution.ts:647-668`; leaf `cwd` and `step.cwd` resolve after `{outputs.` interpolation. Preserve committed-checkout behavior (`execution.ts:687`) and repository-root hook resolution (`doc/configuration.md:115`).

Contract serialization references: `async-execution.ts`, `subagent-runner.ts:107-131`, `subagent-runner.ts`, and `subagent-runner.ts:660-672` delimit publication and late resolution. Preserve unrelated `config.json` fixtures in `test/unit/execution-reporting-protocol.test.ts`, `test/unit/external-foreground-execution.test.ts`, and `test/integration/detached-external-orchestration.test.ts`; only Task 1 replaces the legacy `loadConfig()` fixture at `test/unit/pi-coding-agent-dir.test.ts:120-125`. The spec's `npm run test:integration` obligation is exercised here through the scoped async commands and later by the header verification entrypoint.

- [ ] **Step 1: Run Tests on existing async fixtures.** Require executed tests, not an all-skipped loader result.
- [ ] **Step 2: Extend the async worktree fixture with committed project settings.** Commit executable setup/teardown scripts and `.pi/settings.json` inside a fresh fixture project; call the resolver-backed executor without profile hooks. Assert one setup and teardown record per checkout, unchanged timeouts and best-effort teardown. Verify nested calls see committed settings but not uncommitted or gitignored source-checkout settings.
- [ ] **Step 3: Add detached multi-project regressions.** Give two worktree groups distinct projects, hook markers and backend preferences; make a later group's cwd an earlier output. Assert effective-project policy rather than request/profile policy and group-repository-root relative hooks. Add sequential and parallel leaves, including a dynamic leaf, with another project's cwd. Extend the existing `runSingleStep` coordinator probe at `test/integration/async-execution.test.ts:1306-1356` to assert the prepared preference after interpolation. New test names contain `worktree` so the scoped command runs them. Preserve existing job-file fixture format tests.
- [ ] **Step 4: Add same-cwd fallback regressions.** With an isolated empty profile, serialize hooks and `userPreference` but omit settings at the job cwd; assert the existing same-cwd hook and preference still apply. Add settings at that cwd and assert defined values, including an empty hook, win. Point a group and a leaf at another project with no settings and assert no inherited job hooks and backend `"auto"`; a configured invalid timeout there fails before checkout creation rather than using the valid job timeout. A malformed profile must fail, not invoke fallback. Assert serialized field names remain unchanged.
- [ ] **Step 5: Run Tests red.** Expect wrong group hooks/backend preference in multi-project/output-dependent cases, not a missing mock dependency.
- [ ] **Step 6: Preserve job-wide publication.** Keep `async-execution.ts` serializing call-level hook values into the existing fields and `detachedExecutionBackends` filling `userPreference` from the resolved call config's `executionBackend`. A single job's call config is its single-unit config. Retain unresolved output-dependent cwd strings and runtime, control, flags, nested route, registrations and model metadata. Do not serialize per-unit values or add fields to `SubagentRunConfig`.
- [ ] **Step 7: Resolve leaf backend policy in the runner.** Import Task 1's `resolveExtensionConfig`. In `runSingleStep`, call `resolveExtensionConfig(unitCwd)` with `unitCwd = childCwd` after `resolveOutputReferences` and `resolveChildCwd`, before selection. Prefer its `executionBackend`; use the serialized `userPreference` only for an absent preference at the original job cwd. Supply only this resolved preference to `selectConfiguredExecutionBackend`; keep the shared coordinator and registrations immutable. Add and propagate the internal `jobCwd` at sequential, static parallel and dynamic call sites. Keep failures on the existing failed-leaf/result path, without recovering a settings read failure through serialized values.
- [ ] **Step 8: Resolve group hook policy before preparation.** Replace the runner's deferred group-cwd string at L2108 with output-reference resolution followed by `resolveChildCwd`. Call `resolveExtensionConfig(unitCwd)` at that resolved source group cwd before conflict checks and `createWorktrees`; take all four hook keys from the result, filling absent keys from the serialized tuple only when group cwd equals job cwd. Route interpolation/settings failures through `markParallelGroupSetupFailure` before any checkout exists. Use the resolved group cwd for progress and task preparation, preserving task cwd precedence. Keep group hooks outside leaf execution so they run once per checkout, not once per backend attempt; leaf backend reads use their own effective cwd. Preserve relative-hook repository-root resolution and existing teardown cleanup.
- [ ] **Step 9: Run Tests green.** Require detached project-hook, two-project, output-dependent cwd, same-cwd-only fallback, committed-settings and timeout assertions to pass. Confirm every worktree is removed and wait for runner completion before fixture cleanup.
- [ ] **Step 10: Review format and lint scope.** No formatter/linter is configured. Run: `git diff --check -- src/runs/background/async-execution.ts src/runs/background/subagent-runner.ts test/integration/async-execution.test.ts`. Expect no whitespace errors; inspect serialized names and runner consumers together.
- [ ] **Step 11: Commit.** Stage the modified files and run `git commit -m "Apply project settings to detached execution units (#29)"`.

## Wave 4 - Documentation

Depends on Waves 1-3: document the implemented source, defaults and detached contract together. This trailing doc-only task owns every shared documentation hub.

### Task 5: Publish the settings source and migration contract

**TDD scenario:** Trivial change - documentation review.

**Spec:** doc/specs/2026-10-26-gh-29-settings-ladder.md § "Acceptance criteria" L23-L24, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L34, § "Acceptance criteria" L38, § "5. Migration" L81-L91, § "Errors and edge cases" L101, § "Errors and edge cases" L103, § "Errors and edge cases" L104, § "Documentation impact" L122, § "Documentation impact" L123, § "Out of scope" L128, § "Out of scope" L132

**Files:**
- Modify: `doc/configuration.md`
- Modify: `README.md:187-191`
- Modify: `doc/agents-and-chains.md:86-90`
- Modify: `CHANGELOG.md:1-9`

**Tests:**
- none: documentation; no Markdown formatter is configured

Contract key inventory: `ExtensionConfig` keys are `asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`. Defaults come from `src/runs/shared/worktree.ts:205,272` (`30000`), `resolveCurrentMaxSubagentDepth` and `resolveTopLevelParallelMaxTasks` in `src/shared/types.ts:987,1022`, `!== false`, `=== true`, and `"auto"`. No defaults layer belongs in the resolver.

Contract documentation references: migration is the only current-contract context for `extensions/pi-cohort/config.json`; preserve `CHANGELOG.md:342,799` and `doc/specs/2026-09-06-gh-11-remove-pi-intercom.md:21`. Task 3 updates `src/extension/index.ts`. Explain non-git `cwd` discovery through `enumerateProjectLevels`, `.pi` and `.agents` at `agents.ts:248-252,273-284`; a `worktree: true` child at `execution.ts:687` exposes only committed settings to nested `subagent()`. Relative hook resolution stays as `doc/configuration.md:115` describes. Preserve `doctor` output.

Use the approved project's migration example:

```json
{
  "subagents": {
    "worktreeSetupHook": "./scripts/setup-worktree.mjs",
    "worktreeTeardownHook": "./scripts/teardown-worktree.mjs",
    "maxSubagentDepth": 3
  }
}
```

- [ ] **Step 1: Rewrite source and ladder.** State `settings.json#subagents` as the only source, profile `settings.json` below marked project levels and nearest level winning. Explain non-git marked ancestors, strict profile errors and skipped malformed project levels. Explain whole-object replacement for `control`, `parallel` and `chain`.
- [ ] **Step 2: Complete namespaced examples and defaults.** Put all 14 extension keys under `subagents` in examples and link discovery-only keys to their guide. Add `control` and `chain.dynamicFanout.maxItems` sections. Preserve call-site boolean defaults, depth resolver, `parallel.maxTasks` 8 and concurrency 4, timeouts 30000 and backend `"auto"`; describe `defaultSessionDir` parent-session fallback and required dynamic fanout `maxItems`. Use `src/runs/shared/subagent-control.ts:14-83` for control fields and defaults rather than inventing values.
- [ ] **Step 3: Add migration and checkout caveats.** Show moving the old object from `config.json` into `~/.pi/agent/settings.json` or project `.pi/settings.json` under `"subagents"`, using `worktreeSetupHook`, `worktreeTeardownHook` and `maxSubagentDepth` verbatim. Explain the one session-start warning, ignored legacy file, committed-settings requirement for nested checkout calls and group-repository-root relative hooks. Keep trust and lifecycle semantics unchanged.
- [ ] **Step 4: Update documentation hubs.** Point README to the new source. Update the agents-and-chains merge bullet for all 16 keys while preserving project-only discovery scope and per-persona overrides. Create `## [Unreleased]` and record the breaking migration with `(#29)`; preserve released CHANGELOG sections and predecessor specs.
- [ ] **Step 5: Review examples and references.** Read every touched heading block; confirm valid JSON examples, resolving source links, and retired extension config paths only in migration notes in current docs/comments. Keep forwarded CLI flags, environment variables, trust, schema versioning and doctor output unchanged.
- [ ] **Step 6: Commit.** Stage the four documentation files and run `git commit -m "Document the settings ladder and breaking migration (#29)"`.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L21-L22 | Project setup/teardown hooks and timeout keys run once per created worktree | Task 2, Task 4 |
| § "Acceptance criteria" L23-L24 | All 14 keys use nearest/project/user precedence and consumer defaults | Task 1, Task 2, Task 3, Task 4, Task 5 |
| § "Acceptance criteria" L25-L26 | Detached, fanout and chain units use their effective projects | Task 2, Task 4 |
| § "Acceptance criteria" L27-L28 | Legacy file ignored, one session-start warning | Task 2, Task 3 |
| § "Acceptance criteria" L29-L30 | Namespaced examples/current comments; breaking Unreleased entry | Task 3, Task 5 |
| § "Acceptance criteria" L31-L32 | Replace private fixture with scalar, object and hook precedence tests | Task 1 |
| § "Acceptance criteria" L34 | Sparse config retains defaults and contextual fallback | Task 1, Task 2, Task 5 |
| § "Acceptance criteria" L36 | Effective cwd, fanout resolver; detached timing governed by amended Design 3 L69 | Task 2, Task 4 |
| § "Acceptance criteria" L38 | Current docs/comments migrate; released history and predecessor stay | Task 3, Task 5 |
| § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L44 | Typed new keys, warning per key/read, existing-key errors preserved | Task 1 |
| § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L46 | Timeouts carried verbatim; empty hook remains unset | Task 1, Task 2, Task 4 |
| § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L48 | Project-only ladder, nearest defined wins, whole object replacement | Task 1 |
| § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L50 | Sparse strict-profile-plus-project resolver | Task 1 |
| § "1. The ladder reads all 16 keys (`src/agents/agents.ts`)" L52 | Delete backend reread/reader, update both consumers and tests; runner preference follows amended L69 | Task 1, Task 2, Task 4 |
| § "2. Delete `src/extension/config.ts`" L56 | Delete loader/re-export; keep type and update source comment | Task 1, Task 2, Task 3 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L60 | Resolver dep replaces config, async default and flags snapshots | Task 2 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L62 | Immediate request config for call controls; unit hooks/backend | Task 2, Task 4 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L64 | Single reuses request config | Task 2 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L65 | Parallel task and worktree group cwd select config | Task 2, Task 4 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L66 | Chain cwd interpolation precedes settings resolution | Task 2, Task 4 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L67 | Resume uses target cwd | Task 2 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L69 | Runner calls `resolveExtensionConfig(unitCwd)` after interpolation for unit hooks/backend | Task 4 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L69 | Serialized `SubagentRunConfig` tuple stays job-wide, fallback only at job cwd, no new fields | Task 4 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L69 | Fanout receives `resolveConfig` rather than a snapshot | Task 2 |
| § "3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)" L71 | Call-scoped doctor config; output unchanged | Task 2 |
| § "4. Extension entry points" L75 | Roster resolution and existence-only UI/headless warning | Task 3 |
| § "4. Extension entry points" L77 | Fanout injects resolver | Task 2 |
| § "5. Migration" L81-L91 | Same key names moved under profile/project subagents object | Task 5 |
| § "Errors and edge cases" L95 | Warn and skip malformed project level | Task 1 |
| § "Errors and edge cases" L96 | Malformed profile throws | Task 1 |
| § "Errors and edge cases" L97 | Local new-key rejection, existing-key failure behavior | Task 1 |
| § "Errors and edge cases" L98 | Invalid configured timeout fails before creation, no fallback | Task 1, Task 2, Task 4 |
| § "Errors and edge cases" L99 | Missing settings use defaults without warnings | Task 1, Task 2 |
| § "Errors and edge cases" L100 | Legacy plus settings warns, no legacy values read | Task 3 |
| § "Errors and edge cases" L101 | Non-git nearest marked ancestor applies | Task 1, Task 5 |
| § "Errors and edge cases" L102 | Output-dependent group cwd precedes settings | Task 2, Task 4 |
| § "Errors and edge cases" L103 | Only committed settings transfer to nested checkout calls | Task 4, Task 5 |
| § "Errors and edge cases" L104 | Relative hooks resolve from group repository root | Task 2, Task 4, Task 5 |
| § "Tests" L110 | Ladder/type/object/default/non-git/profile tests | Task 1 |
| § "Tests" L111 | Timeout dispatch failure and empty hook tests | Task 2, Task 4 |
| § "Tests" L112 | Two calls, async default, cross-project chain, nested cwd and resume | Task 2 |
| § "Tests" L113 | Single foreground and detached backend preference | Task 1, Task 2, Task 4 |
| § "Tests" L114 | Warning presence/UI/headless/child matrix | Task 3 |
| § "Tests" L115 | Replace only legacy fixture; preserve reporter/job configs | Task 1, Task 2, Task 3, Task 4 |
| § "Tests" L116 | Switch every executor caller | Task 2 |
| § "Tests" L118 | Async project-hook integration fixture | Task 4 |
| § "Documentation impact" L122 | Complete configuration defaults/examples, README and Unreleased | Task 5 |
| § "Documentation impact" L123 | Extension header and discovery settings merge | Task 3, Task 5 |
| § "Out of scope" L127 | No project-hook trust prompt | waived: excluded by approved scope |
| § "Out of scope" L128 | Settings outside `ExtensionConfig` and flag semantics unchanged | Task 2, Task 5 |
| § "Out of scope" L129 | No gauntlet dependency or settings schema version | waived: excluded by approved scope |
| § "Out of scope" L130 | No per-leaf deep merge | waived: excluded by approved scope |
| § "Out of scope" L131 | No malformed-profile recovery | waived: excluded by approved scope |
| § "Out of scope" L132 | No settings provenance in `doctor` output | Task 2, Task 5 |
