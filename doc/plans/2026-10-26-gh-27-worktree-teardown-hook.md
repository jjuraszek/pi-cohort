# Worktree teardown hook implementation plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Run a consumer-configured teardown hook once before each successfully created task checkout is removed, without changing task results when teardown fails.

**Architecture:** Add an inline sibling resolver and synchronous runner in the worktree helper. Construct one shared setup/teardown payload per checkout, retain it and the resolved teardown config on its record, and invoke teardown first in the existing rollback and ordinary removal paths. Forward the new settings beside the setup pair through foreground and detached dispatch; keep cleanup callers and output-reference trees unchanged.

**Tech Stack:** TypeScript with Node type stripping, node:test, node:child_process, node:fs, temporary Git repositories, existing mock Pi integration harness.

**Spec:** `doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md`

**Verification:** `npm run check:agents-core && env -u PI_CODING_AGENT_DIR npm run test:unit && env -u PI_CODING_AGENT_DIR npm run test:integration && git diff --check`

**Ticket:** `#27`

---

## Baseline provenance

Initial attempt BASE: `ea41b23`. Initial per-file status inventory: ` M package-lock.json`; `?? doc/plans/2026-10-26-gh-27-worktree-teardown-hook.md`. Admitted exact paths: `doc/plans/2026-10-26-gh-27-worktree-teardown-hook.md` and the clean approved spec `doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md`. No parent-supplied in-flight paths or prior artifact evidence. The tracked lockfile modification was outside the admitted set, so no task command ran in that attempt and no passing baseline evidence was recorded.

Rerun requested by `Findings: rerun baseline`: BASE `ea41b23`; initial inventory only `?? doc/plans/2026-10-26-gh-27-worktree-teardown-hook.md`. Admitted exact paths remain the plan and approved spec above; no in-flight paths or recorded artifacts. All four Tests commands ran unchanged, in task order: unit worktree 28 tests passed; parallel integration 34 passed; chain integration 85 passed; async integration 96 passed. Each command exited 0 with zero failures and zero skipped tests. Status and BASE were reread after each command: the same sole untracked plan entry and `ea41b23`, with no contamination or new artifacts. No evidence was retained or re-stamped instead of that requested rerun. The plan writer did not edit or restore source files. During checker repair, the four unchanged commands retain this execution evidence at the same BASE; `git diff --quiet ea41b23 ea41b23 -- . ':!doc/specs/' ':!doc/plans/'` exited 0. No SHA changed.

## Files

**Modify - lifecycle and unit coverage:**
- `src/runs/shared/worktree.ts`
- `test/unit/worktree.test.ts`

**Modify - settings and dispatch:**
- `src/shared/types.ts`
- `src/runs/foreground/subagent-executor.ts`
- `src/runs/foreground/chain-execution.ts`
- `src/runs/background/async-execution.ts`
- `src/runs/background/subagent-runner.ts`
- `test/integration/parallel-execution.test.ts`
- `test/integration/chain-execution.test.ts`
- `test/integration/async-execution.test.ts`

**Modify - user documentation:**
- `doc/configuration.md`
- `doc/orchestration-patterns.md`
- `CHANGELOG.md`

No repository files are created or deleted. Hook scripts and recording files are generated under each test's unique temporary directory, outside the checkout under test.

## Recon and verification conventions

- `package.json:40-46` defines the full verification entrypoint, unit runner and integration runner. The full entrypoint includes the shared AGENTS consistency check and both test suites, but no lint or formatter. The header lists those component commands with the environment override removed for both suites. Neither package scripts, root configuration nor the overrides file defines lint/format commands. Do not install or introduce a formatter; preserve the surrounding tabs/quotes and use scoped whitespace checks in each task. There is no Markdown formatter configured.
- Scoped unit command: `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/worktree.test.ts`.
- Integration files need both `test/support/isolate-test-env.mjs` and `test/support/register-loader.mjs`. Use the exact file-addressed commands in Task 2.
- The environment preload (`test/support/isolate-test-env.mjs:1-14`) isolates HOME and temp paths. Unset `PI_CODING_AGENT_DIR` for these commands as AGENTS.md requires. The overrides file has no Happy path table.
- Existing unit fixtures are `createRepo`, `createHookScript`, and `hookScriptSkip` at `test/unit/worktree.test.ts:29-56`; existing setup tests at lines 319-480 are append-only neighbors, not rewrite targets. The integration fixture `MockPiResponse` at `test/support/mock-pi.ts:8-28` supports `delay`, `exitCode`, `stderr`, and `structuredOutput`; `MockPi.callCount()` provides a startup observation for abort tests.
- Keep existing no-hook and setup-hook test bodies and assertions unchanged. Add new cases to existing files. Do not edit README, consuming repositories, release tooling, or the setup resolver/runner.

## Wave 1 - Worktree lifecycle

### Task 1: Add teardown resolution, payload retention, and best-effort removal hooks

**TDD scenario:** Modifying tested code - run existing tests first, then add red cases in small behavior groups before each implementation step.

**Spec:** doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L31-L32, § "Acceptance criteria" L38, § "Acceptance criteria" L39, § "Acceptance criteria" L40, § "Acceptance criteria" L41, § "Configuration" L47-L52, § "Configuration" L54, § "Configuration" L56, § "Payload" L62, § "Payload" L64, § "Invocation" L68-L71, § "Invocation" L73, § "Invocation" L75, § "Failure semantics" L79, § "Failure semantics" L81, § "Failure semantics" L83, § "Failure semantics" L85, § "Not changed" L89, § "Not changed" L90, § "Not changed" L91, § "Errors and edge cases" L97, § "Errors and edge cases" L98, § "Errors and edge cases" L99, § "Errors and edge cases" L100, § "Errors and edge cases" L101, § "Errors and edge cases" L102, § "Errors and edge cases" L103, § "Errors and edge cases" L105, § "Errors and edge cases" L106, § "Errors and edge cases" L109, § "Tests" L113, § "Tests" L115, § "Tests" L116, § "Tests" L117, § "Tests" L118, § "Tests" L119, § "Tests" L120, § "Tests" L121, § "Tests" L122, § "Out of scope" L137, § "Out of scope" L139, § "Out of scope" L140, § "Out of scope" L141

**Files:**
- Modify: `src/runs/shared/worktree.ts:1-599`
- Modify: `test/unit/worktree.test.ts:1-652`
- Test: `test/unit/worktree.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/worktree.test.ts`
- baseline: ea41b23 pass
- via: `createWorktrees`, `cleanupWorktrees`, `createSingleWorktree`, `cleanupSingleWorktree`, `runWorktreeSetupHook`

Decision: Store `hookInput: WorktreeSetupHookInput` and optional `teardownHook: ResolvedWorktreeTeardownHook` on `WorktreeInfo`, constructing the input after a successful add and before the existing setup try/catch - `createSingleWorktree` at worktree.ts:316-370 owns these values, and `cleanupWorktrees` at 592-599 already consumes the records. Do not change its signature or rebuild the payload later.

Decision: Add separate `WorktreeTeardownHookConfig`, `ResolvedWorktreeTeardownHook`, `resolveWorktreeTeardownHook`, and `runWorktreeTeardownHook` siblings. Duplicate the small validation rules rather than edit `parseHookTimeout` or `resolveWorktreeSetupHook`; the spec explicitly preserves the setup resolver and error strings.

Decision: Use `killSignal: "SIGKILL"` with `spawnSync`, and `stdio: ["pipe", "ignore", "pipe"]` - node_modules/@types/node/child_process.d.ts:1140-1154,1228-1232 documents sync spawn options and the SIGTERM waiting hazard. This is synchronous hook execution, not a new asynchronous runner.

Decision: Emit warnings through one callback-based `fs.write(2, message + "\n", () => {})` inside a try/catch; do not await, retry, drain, flush, or invoke UI code. The fd is stderr in foreground and the existing append-open runner.log in `async-execution.ts:148-165`. The installed Node declaration at node_modules/@types/node/fs.d.ts:2820-2829 specifies an asynchronous write callback. This avoids console's potentially synchronous file-backed write. Callback errors and submission errors are ignored; logging completion never gates cleanup. Use the mutable default fs object for this sink so new tests can stub `write` without exporting a production injection API.

Boundary contract: Task 2 relays `worktreeTeardownHook` and `worktreeTeardownHookTimeoutMs` from `ExtensionConfig` beside `worktreeSetupHook` and `worktreeSetupHookTimeoutMs` at `src/shared/types.ts:870-871`. This task owns their resolver and cleanup behavior for `worktree: true`, including the lifecycle later exercised through `stopOn`. Public `worktreeTeardownHook: ""` mirrors `worktreeSetupHook: ""`; direct resolver inputs still reject empty paths. Assert the `worktree teardown hook ...` error family with the concrete strings in Step 4, not a literal ellipsis.

Source boundaries: copy the validation rules from `worktree.ts:199-230` and `worktree.ts:191-197`; retain the payload at `worktree.ts:54-64`. Insert teardown first at `worktree.ts:361-369` and `worktree.ts:479-486`; preserve the setup runner at `worktree.ts:271-314`. The information in the existing `console.warn` at `worktree.ts:582` guides new warnings, but its sink does not satisfy the nonwaiting policy. Leave output-reference helpers at `worktree.ts:562-590` unchanged and keep `git worktree prune` silent. Append tests beside existing `319-480`, without editing those cases.

- [ ] **Step 1: Run the existing unit file.** Run the Task 1 Tests command. Expected: existing tests pass before adding cases.

- [ ] **Step 2: Add resolver and independent-configuration tests.** Append a teardown describe block using unique runIds and existing temp repo helpers. Table-test bare name, missing file, directory, empty/whitespace path, and timeout values 0, -1, 1.5, NaN, Infinity. For each rejection assert the teardown-shaped message, no task checkout in `git worktree list`, and no temporary branch. Add valid absolute, repo-relative from a nested cwd, and `~/` path cases using isolated HOME. Add a timeout-without-hook case proving it is ignored. Keep shebang execution cases under `hookScriptSkip`, but run pure resolver cases on every platform.

- [ ] **Step 3: Run the unit file and confirm red.** Run the Task 1 Tests command. Expected: invalid teardown options currently do not reject, and teardown-only cases do not invoke a script.

- [ ] **Step 4: Implement the sibling resolver.** Add `teardownHook?: WorktreeTeardownHookConfig` to `CreateWorktreesOptions`. Use `{ hookPath: string; timeoutMs?: number }` for raw config and `{ hookPath: string; timeoutMs: number }` for resolved config. Resolve once in `createWorktrees` after repo/setup resolution and before its loop. Mirror trim, tilde expansion, absolute/separator-containing repo-relative path resolution, existence and directory checks; validate `Number.isInteger(timeoutMs) && timeoutMs > 0`, defaulting undefined to 30000. Return undefined immediately for absent config. Error strings are `worktree teardown hook path cannot be empty`, `worktree teardown hook must be an absolute path or a repo-relative path`, `worktree teardown hook not found: ${resolvedPath}`, `worktree teardown hook must be a file, got directory: ${resolvedPath}`, and `worktree teardown hook timeout must be an integer greater than 0`. Do not normalize public empty strings here; Task 2 owns that boundary.

- [ ] **Step 5: Add payload/order and rollback tests.** Generate setup and teardown Node scripts with `createHookScript`. Each records raw parsed stdin to its own external JSONL file; setup prints a valid JSON object, teardown asserts the checkout exists and its cwd equals `worktreePath`. Assert exactly one matching payload per index after two-checkout cleanup, including nested `agentCwd`, `version: 1`, `repoRoot`, `worktreePath`, `branch`, `index`, `runId`, `baseCommit`, and optional `agent`. Add teardown-only and no-agent cases. For setup failure on index 1, assert teardown records indices 1 then 0 exactly once, both paths existed during invocation, both disappear, both branches disappear, and the original setup failure message remains unchanged. Add an add-failure case using a pre-existing conflicting branch: only previously successful checkouts get teardown, never the index whose `git worktree add` failed. Avoid calling cleanup a second time in test finally after successful explicit cleanup.

- [ ] **Step 6: Run the unit file and confirm lifecycle red.** Run the Task 1 Tests command. Expected: recording files/invocations are missing until the lifecycle is implemented.

- [ ] **Step 7: Retain the shared payload and add the runner.** Pass the resolved teardown option into `createSingleWorktree` beside setup config. Build the `WorktreeSetupHookInput` once after `agentCwd` is known; pass that object to the existing setup runner and store it with `teardownHook` on the returned record. Keep its JSON shape unchanged and do not add `phase`. Give the new runner signature `runWorktreeTeardownHook(hook: ResolvedWorktreeTeardownHook | undefined, input: WorktreeSetupHookInput): void`; return immediately when hook is absent. Invoke `spawnSync(hook.hookPath, [], { cwd: input.worktreePath, encoding: "utf-8", input: JSON.stringify(input), timeout: hook.timeoutMs, killSignal: "SIGKILL", shell: false, stdio: ["pipe", "ignore", "pipe"] })`. Wrap the invocation/error handling so the runner cannot throw. Inspect `result.error` before status: ETIMEDOUT reports configured ms; another spawn error reports its message; nonzero status reports exit code (signal termination can report the signal). Append trimmed `(result.stderr ?? "")` when present. Emit one warning per failed invocation, none on success; never parse stdout.

- [ ] **Step 8: Hook both removal paths and add isolated warnings.** Make the runner call the first statement of the setup catch and of `cleanupSingleWorktree`, using the retained input/config. Keep the two removal paths separate and the existing `git worktree remove --force` then `git branch -D` order. Replace only their four silent catch bodies with calls to a small `warnWorktreeCleanup(message: string): void` helper using the nonwaiting sink decision above. Removal warnings identify checkout, operation and git error; branch deletion warnings also identify branch. Rollback still throws its original caught error after both attempts. Leave prune silent, and do not touch `materializeTree`, `removeTrees`, or synthetic-path diff handling.

- [ ] **Step 9: Add teardown failure and timeout tests.** Table-test exit 7 with padded stderr, ENOENT by deleting the hook after successful validation, and EACCES by removing execute permission after creation on POSIX. Capture the new fs sink and assert exactly one hook warning with checkout path and the cause plus trimmed stderr where present. Assert cleanup returns undefined, task checkouts/branches are gone, and later records are cleaned. Add a SIGTERM-ignoring Node hook that writes a startup marker, then keeps running; use a 1000 ms hook timeout and a generous 5000 ms elapsed bound, verify the marker and timeout ms, and assert removal completed. Run that regression in a child test process with a larger outer kill deadline so a broken implementation cannot hang the suite. Add a default-timeout assertion by observing the runner spawn options in an isolated built-in mock or child harness; do not wait 30 seconds. Add a hook writing several MiB to stdout that exits zero, asserting no warning and successful removal.

- [ ] **Step 10: Add git-failure and sink-isolation tests.** Cover both normal cleanup and rollback warnings. For a missing checkout, remove its directory and prune its registration before cleanup so the remove operation deterministically fails; assert path, operation and git message. Delete its checked-out branch ref using `git update-ref -d` rather than a branch-delete command Git forbids, then assert branch-deletion warning includes branch. Exercise a teardown hook that removes its checkout, and a two-record cleanup that still reaches the remaining record and prune. For rollback, induce setup failure and the cleanup failure, then compare the thrown setup error message with its setup-only counterpart. Stub the new sink's `fs.write` to throw, to callback with an error, and to retain its callback without invoking it; each case must leave cleanup's return, remaining removals and original setup error unchanged. Restore stubs in finally. Keep warnings independent of whether a teardown hook exists; also assert no warning is added for prune alone.

- [ ] **Step 11: Run the unit file, confirm red for new failure cases, and repair only those cases.** Run the Task 1 Tests command before any needed failure-handler adjustment, then again afterward. Expected green: new lifecycle, failure-field, timeout, large-stdout, and sink cases pass, and all existing setup/no-hook/output-reference cases still pass without edits. Keep timeout and logging policy in the sibling runner/helper, not the setup runner.

- [ ] **Step 12: Check task style.** Preserve neighboring TypeScript formatting and run `git diff --check -- src/runs/shared/worktree.ts test/unit/worktree.test.ts`. Expected: exit 0, no whitespace diagnostics. No configured lint/formatter command exists.

- [ ] **Step 13: Commit.** Run `git add src/runs/shared/worktree.ts test/unit/worktree.test.ts` then `git commit -m "Add best-effort worktree teardown lifecycle (ref #27)"`.

## Wave 2 - Configuration relay and executor coverage

Depends on Wave 1: all executors consume Task 1's `CreateWorktreesOptions.teardownHook` and retained cleanup behavior. Keep all configuration relay edits in one task because the foreground executor forwards into both the chain API and detached config API; splitting those definitions and callers would introduce ordering dependencies.

### Task 2: Forward teardown settings through all executors and prove terminal paths

**TDD scenario:** Modifying tested code - run existing integration files first, then append dedicated teardown scenarios.

**Spec:** doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md § "Acceptance criteria" L23-L24, § "Acceptance criteria" L25-L26, § "Acceptance criteria" L27-L28, § "Acceptance criteria" L29-L30, § "Acceptance criteria" L31-L32, § "Acceptance criteria" L40, § "Acceptance criteria" L41, § "Configuration" L47-L52, § "Configuration" L54, § "Configuration" L58, § "Invocation" L75, § "Failure semantics" L79, § "Failure semantics" L85, § "Errors and edge cases" L97, § "Errors and edge cases" L98, § "Errors and edge cases" L99, § "Errors and edge cases" L104, § "Errors and edge cases" L105, § "Errors and edge cases" L107, § "Tests" L118, § "Tests" L122, § "Tests" L124

**Files:**
- Modify: `src/shared/types.ts:863-872`
- Modify: `src/runs/foreground/subagent-executor.ts:645-1955`
- Modify: `src/runs/foreground/chain-execution.ts:421-422`
- Modify: `src/runs/foreground/chain-execution.ts:658-663`
- Modify: `src/runs/background/async-execution.ts:81-842`
- Modify: `src/runs/background/subagent-runner.ts:121-122`
- Modify: `src/runs/background/subagent-runner.ts:2131-2136`
- Modify: `test/integration/parallel-execution.test.ts:565-860`
- Modify: `test/integration/chain-execution.test.ts:1-2070`
- Modify: `test/integration/async-execution.test.ts:1-2929`
- Test: `test/integration/parallel-execution.test.ts`
- Test: `test/integration/chain-execution.test.ts`
- Test: `test/integration/async-execution.test.ts`

**Tests:**
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts`
- baseline: ea41b23 pass
- via: `createSubagentExecutor`, `createParallelWorktreeSetup`, `createWorktrees`, `cleanupWorktrees`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/chain-execution.test.ts`
- baseline: ea41b23 pass
- via: `executeChain`, `createWorktrees`, `cleanupWorktrees`
- `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts`
- baseline: ea41b23 pass
- via: `executeAsyncChain`, `executeAsyncSingle`, `createWorktrees`, `cleanupWorktrees`

Decision: Forward raw optional strings/numbers at every existing setup-pair relay, but form `teardownHook` only under the same truthiness guard as setup at the three creation sites - subagent-executor.ts:1296-1318, chain-execution.ts:658-663, subagent-runner.ts:2131-2136. Thus `worktreeTeardownHook: ""` is unset, while whitespace reaches the resolver and is rejected. A timeout without a hook is not validated. `src/extension/config.ts:6-18` already loads arbitrary ExtensionConfig JSON; no additional config parsing or defaults layer is needed.

Decision: Preserve existing finally blocks and result construction. The three callers at chain-execution.ts:806-807, subagent-executor.ts:1844-1845, and subagent-runner.ts:2370-2372 already call `cleanupWorktrees(setup)` on their terminal paths; Task 1 supplies the behavior without changing their signatures. Task error scenarios use the harness's `exitCode`/`stderr`, and abort scenarios cancel the actual supplied `AbortSignal`, not a different interrupt interface.

Decision: Use `stopOn: { path: "/verdict", in: ["FAIL"] }` on the worktree-bearing group - `src/runs/shared/stop-conditions.ts:18-22,77-79` requires a JSON Pointer and evaluates each leaf's structured output, not the named-output registry; the existing parallel stopOn case in `test/integration/chain-execution.test.ts:1921-1946` uses that shape.

Boundary contract: Add the twins next to `worktreeSetupHook` and `worktreeSetupHookTimeoutMs` at `src/shared/types.ts:870-871`. Forward through `src/runs/foreground/subagent-executor.ts:1296-1318`, `src/runs/foreground/chain-execution.ts:658-662`, `src/runs/background/subagent-runner.ts:2131-2135`, and `src/runs/background/async-execution.ts`. Preserve absolute, `~/`, and repo-relative forms for Task 1's resolver; mirror `worktreeSetupHook: ""` at the public boundary. Invalid configuration must fail before `git worktree add`, with the `worktree teardown hook ...` family, including `worktree teardown hook timeout must be an integer greater than 0` for invalid configured timeouts. The ellipsis denotes the family, not an assertion string.

Integration assertions: compare recorded `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`, with `version: 1` and optional `agent`. Preserve no-hook successful results; the only no-hook change is Task 1's warning for failed `git worktree remove --force` or `git branch -D`. Observe detached warning delivery via `async-execution.ts:148-165` and runner.log, without requiring a synchronous `console.warn` or waiting for a sink before removal.

- [ ] **Step 1: Run all three scoped integration commands.** Expected: existing cases pass before editing. Keep the existing no-hook worktree tests unchanged; new scenarios must not replace them.

- [ ] **Step 2: Add foreground normal and error scenarios.** In parallel-execution.test.ts append teardown cases beside lines 632-860, using a new local executor factory that accepts config rather than changing existing helper behavior. Generate executable Node recording scripts in a unique external temp directory; assert `worktreePath` exists in the script before appending stdin JSON. For normal completion create two task checkouts and assert two distinct indices recorded once, correct payload fields, absent checkout paths/branches afterward, unchanged successful task output, and durable diff artifacts. For task error use `mockPi.onCall({ exitCode: 1, stderr: "teardown-task-error" })`; assert the task error is retained and its created checkout was recorded and removed.

- [ ] **Step 3: Add the supplied-signal abort scenario.** Queue a delayed mock response, pass a fresh controller's signal into `executor.execute`, and wait with a deadline until `mockPi.callCount() > 0` and a task checkout exists. Abort that controller only then. Assert the dispatch has the existing canceled/error result, the recording file has exactly one entry for that created checkout, and the checkout is absent. Always settle the pending execution in finally before deleting its temp repository. Do not count a pre-aborted dispatch as coverage.

- [ ] **Step 4: Add foreground parity and hook-failure scenarios.** Add empty-string with invalid timeout and teardown-only cases. Add nonzero and bounded-timeout teardown cases on otherwise successful worktree tasks; assert successful child output and task result remain successful. Assert invalid nonempty path produces the same up-front dispatch error shape as the setup pair and starts no mock child. Use the existing win32 hook execution skip convention; empty-string and validation-only cases need no script execution.

- [ ] **Step 5: Add chain stopOn coverage on the owning group.** Append a dedicated chain test with a real temp git repo, a parallel worktree-bearing group, group `stopOn`, and a later sentinel task. Use the existing structured-output pattern at chain-execution.test.ts:1812-1961: one leaf with `as: "gate"`, a verdict schema, and `structuredOutput: { verdict: "FAIL" }`; group condition is `{ path: "/verdict", in: ["FAIL"] }`. Configure the recording hook on the same dispatch. Assert stopped semantics, sentinel never spawned, exactly one teardown record for the group checkout while it existed, and removal afterward. Add a chain empty-string/invalid-timeout parity case. Leave the existing stopOn and no-hook scenarios unchanged.

- [ ] **Step 6: Add detached relay and lifecycle tests.** Append new async-execution.test.ts cases using `executeAsyncChain`, the real temp-repo helper and `waitForAsyncResultFile` (existing patterns at 1361-1418). Configure a recording teardown hook and a nondefault timeout on a `worktree: true` parallel group. Assert the serialized runner config preserves both values; wait for the finished result and checkout removal, then verify exact invocation count/payload and successful result. Add a hook that records before failing, asserting result unchanged and runner.log eventually contains checkout path and exit cause. Add a default-disabled/empty-string case with an invalid timeout that still succeeds. For `executeAsyncSingle`, inspect its generated runner config for the forwarded twin, since single mode does not itself create worktrees. Use bounded polling for asynchronous log arrival rather than requiring logs to be flushed before completion.

- [ ] **Step 7: Run all three scoped commands and confirm red.** Expected: new settings are not relayed yet, so recorder assertions fail or detached config lacks the fields. Existing cases remain green.

- [ ] **Step 8: Add the public and parameter types.** Add `worktreeTeardownHook?: string` and `worktreeTeardownHookTimeoutMs?: number` immediately beside the setup pair in ExtensionConfig (types.ts:870-871), ChainExecutionParams (chain-execution.ts:421-422), both AsyncChainParams/AsyncSingleParams (async-execution.ts:81-82,116-117), and SubagentRunConfig (subagent-runner.ts:121-122). Do not add a new settings loader, default materialization, or mandatory property.

- [ ] **Step 9: Forward every foreground relay and construct options.** In subagent-executor.ts add teardown twins beside the setup pair at 666-667,1074-1075,1103-1104,1145-1146,1205-1206,1238-1239,1692-1693,1953-1954; these include revive, async tasks/chain/single, foreground chain and async conversions. Append teardown path/timeout parameters to `createParallelWorktreeSetup` at 1296-1318 and its call at 1705-1712, preserving setup's arguments. Construct `teardownHook: teardownHook ? { hookPath: teardownHook, timeoutMs: teardownHookTimeoutMs } : undefined`. Add the analogous params-based construction next to setup in chain-execution.ts:658-663.

- [ ] **Step 10: Forward detached config and runner options.** In async-execution.ts add the twins to both destructurings (377-378,749-750) and both serialized config objects (631-632,841-842). In subagent-runner.ts:2131-2136 add the config-based truthiness-guarded `teardownHook` option. Keep file-backed stderr spawning and existing finally blocks unchanged. Review every setup-pair occurrence listed above for its teardown twin, without changing the setup logic.

- [ ] **Step 11: Run all three scoped integration commands and confirm green.** Expected: all newly added terminal scenarios actually create a checkout, record once per created checkout while it exists, then remove it. Confirm normal, owning-group stopOn, supplied-signal abort and task-error paths independently; setup rollback is Task 1's unit case. New failure cases leave result semantics unchanged and existing tests pass without rewritten expectations.

- [ ] **Step 12: Check task style.** Run `git diff --check -- src/shared/types.ts src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts src/runs/background/async-execution.ts src/runs/background/subagent-runner.ts test/integration/parallel-execution.test.ts test/integration/chain-execution.test.ts test/integration/async-execution.test.ts`. Expected: exit 0, no whitespace diagnostics. Preserve the neighboring formatting; no configured lint/formatter exists.

- [ ] **Step 13: Commit.** Run `git add src/shared/types.ts src/runs/foreground/subagent-executor.ts src/runs/foreground/chain-execution.ts src/runs/background/async-execution.ts src/runs/background/subagent-runner.ts test/integration/parallel-execution.test.ts test/integration/chain-execution.test.ts test/integration/async-execution.test.ts` then `git commit -m "Forward teardown hooks through worktree dispatch (ref #27)"`.

## Wave 3 - User documentation

Depends on Waves 1 and 2: describe the implemented resolver, lifecycle, logging and relay behavior. This dedicated trailing task owns the shared documentation hubs.

### Task 3: Document teardown settings and cleanup guarantees

**TDD scenario:** Trivial change - documentation review against implemented behavior.

**Spec:** doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md § "Acceptance criteria" L33-L34, § "Documentation impact" L130, § "Errors and edge cases" L108, § "Errors and edge cases" L109

**Files:**
- Modify: `doc/configuration.md:102-119`
- Modify: `doc/orchestration-patterns.md:56-75`
- Modify: `CHANGELOG.md:1-5`

**Tests:**
- none: documentation only; no Markdown formatter configured

- [ ] **Step 1: Amend the configuration section.** Extend `## worktreeSetupHook` in doc/configuration.md with the teardown pair beside setup. Include `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, default 30000, positive integer validation, absolute/`~/`/separator-containing repo-relative paths, invalid-path rejection before creation, and empty-string-unset behavior. Explain setup-only and teardown-only independence. Document the identical shared stdin object with `version: 1`, all seven ticket fields and optional `agent`, no `phase`, checkout cwd, discarded stdout, trimmed stderr on failure, and synchronous per-checkout timeout with `spawnSync`.

- [ ] **Step 2: Amend the lifecycle section.** In `## Worktree isolation` of doc/orchestration-patterns.md, place teardown before task checkout removal including setup rollback. Document exactly-once per successfully created checkout through existing finally cleanup, best-effort nonwaiting failure warnings, unchanged task results, and warnings for failed worktree removal/branch deletion even without a hook. Keep output-reference trees separate, prune silence, and the no-guarantee case when the host process is killed. Do not promise asynchronous hook execution or delivery of best-effort logs before process exit.

- [ ] **Step 3: Add the changelog entry.** Create `## [Unreleased]` before 7.4.5, with `### Added` and an entry naming both teardown keys and `(#27)`. Describe consumer cleanup before task checkout removal and best-effort failure handling in present tense. Do not bump the package version or promote the section to a release heading.

- [ ] **Step 4: Review and check whitespace.** Compare each changed unit with the implemented field names and source behavior; keep README's existing route to configuration unchanged. Run `git diff --check -- doc/configuration.md doc/orchestration-patterns.md CHANGELOG.md`. Expected: exit 0 and no whitespace diagnostics.

- [ ] **Step 5: Commit.** Run `git add doc/configuration.md doc/orchestration-patterns.md CHANGELOG.md` then `git commit -m "Document worktree teardown configuration (ref #27)"`.

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Acceptance criteria" L23-L24 | AC1: configured recording hook receives checkout payload once while checkout exists | Task 1, Task 2 |
| § "Acceptance criteria" L25-L26 | AC2: normal, owning-group stopOn, abort, task error and setup rollback | Task 1, Task 2 |
| § "Acceptance criteria" L27-L28 | AC3: nonzero/timeout warnings, ignored stdout, removal and results preserved | Task 1, Task 2 |
| § "Acceptance criteria" L29-L30 | AC4: existing no-hook behavior and tests preserved | Task 1, Task 2 |
| § "Acceptance criteria" L31-L32 | AC5: setup-equivalent path/rejection behavior at both boundaries | Task 1, Task 2 |
| § "Acceptance criteria" L33-L34 | AC6: configuration, orchestration and changelog documentation | Task 3 |
| § "Acceptance criteria" L38 | Only successful git adds count; no new rollback condition | Task 1 |
| § "Acceptance criteria" L39 | New cleanup warning site carries path/cause, not exact wording | Task 1 |
| § "Acceptance criteria" L40 | No-hook behavior preserved except remove/branch failure warnings | Task 1, Task 2 |
| § "Acceptance criteria" L41 | Executor truthiness guard and pre-create resolver validation | Task 1, Task 2 |
| § "Configuration" L47-L52 | Optional public teardown keys; accepted paths; positive timeout default 30000 | Task 1, Task 2 |
| § "Configuration" L54 | Independent hooks; absent hook skips teardown validation/invocation | Task 1, Task 2 |
| § "Configuration" L56 | Sibling resolver before any add; teardown-shaped messages; separate runners | Task 1 |
| § "Configuration" L58 | All three executors and detached config relay carry the twin | Task 2 |
| § "Payload" L62 | Identical WorktreeSetupHookInput, version and optional agent, no phase field | Task 1 |
| § "Payload" L64 | Build once, retain for rollback and ordinary cleanup; unchanged cleanup signature | Task 1 |
| § "Invocation" L68-L71 | Teardown runner first in both existing removal paths | Task 1 |
| § "Invocation" L73 | Skip absent config; synchronous shell-free spawn in checkout with stdin and timeout | Task 1 |
| § "Invocation" L75 | Exactly one removal path and invocation per created checkout | Task 1, Task 2 |
| § "Failure semantics" L79 | Runner never throws; one warning per failure with path/cause/trimmed stderr | Task 1, Task 2 |
| § "Failure semantics" L81 | Hard timeout despite SIGTERM handler; stdout discarded without buffering | Task 1 |
| § "Failure semantics" L83 | Both operations at both sites warn with path/operation/git error and branch | Task 1 |
| § "Failure semantics" L85 | Nonwaiting best-effort sink; no UI/backpressure/error propagation; original setup error | Task 1, Task 2 |
| § "Not changed" L89 | materializeTree and removeTrees remain hook-free and unchanged | Task 1 |
| § "Not changed" L90 | Cleanup prune remains silent on failure | Task 1 |
| § "Not changed" L91 | Setup resolver, runner, messages, payload and test cases preserved | Task 1 |
| § "Errors and edge cases" L97 | Invalid teardown configuration fails before creation | Task 1, Task 2 |
| § "Errors and edge cases" L98 | Nonzero hook reports fields and preserves removal/result | Task 1, Task 2 |
| § "Errors and edge cases" L99 | Timeout terminates SIGTERM-resistant hook and reports ms | Task 1, Task 2 |
| § "Errors and edge cases" L100 | EACCES/ENOENT after validation reports spawn error | Task 1 |
| § "Errors and edge cases" L101 | Arbitrary stdout volume is discarded, not a buffer error | Task 1 |
| § "Errors and edge cases" L102 | Failed or pending log sink does not change cleanup/results | Task 1 |
| § "Errors and edge cases" L103 | Self-removed checkout logs git failures; later records/prune still attempted | Task 1 |
| § "Errors and edge cases" L104 | Empty settings string acts as unset at executor boundary | Task 2 |
| § "Errors and edge cases" L105 | Setup-only and teardown-only independence | Task 1, Task 2 |
| § "Errors and edge cases" L106 | Setup failure on N tears down N then prior records and rethrows original error | Task 1 |
| § "Errors and edge cases" L107 | Finally cleanup on stopOn, supplied abort and task error | Task 2 |
| § "Errors and edge cases" L108 | No guarantee if the process is killed | Task 3 |
| § "Errors and edge cases" L109 | Synchronous foreground delay bounded per checkout; default 30000 | Task 1, Task 3 |
| § "Tests" L113 | Existing unit helpers, executable scripts, external recording files, Windows skip | Task 1 |
| § "Tests" L115 | Payload identity, once-only cleanup, teardown-only shape | Task 1 |
| § "Tests" L116 | Nonzero/timeout/spawn regression tests with bounded termination | Task 1 |
| § "Tests" L117 | Two-checkout rollback invocation/error regression | Task 1 |
| § "Tests" L118 | Resolver rejection plus empty-string public parity | Task 1, Task 2 |
| § "Tests" L119 | Missing checkout/branch git-failure warning tests | Task 1 |
| § "Tests" L120 | Throwing log sink cannot break cleanup | Task 1 |
| § "Tests" L121 | Several MiB stdout regression | Task 1 |
| § "Tests" L122 | Existing unit/integration cases unchanged and passing | Task 1, Task 2 |
| § "Tests" L124 | Dedicated terminal-path scenarios must create checkouts; preserve existing cases | Task 2 |
| § "Tests" L126 | Full unit and integration suites exercised by the header entrypoint | Verification |
| § "Documentation impact" L130 | Amend configuration section with twin settings, payload and failures | Task 3 |
| § "Documentation impact" L130 | Amend worktree-isolation lifecycle/logging section | Task 3 |
| § "Documentation impact" L130 | Create Unreleased Added entry with both keys and issue; release promotion deferred | Task 3 |
| § "Out of scope" L137 | No teardown for output-reference tree paths | Task 1 |
| § "Out of scope" L138 | Consumer repository wiring | waived: expressly out of scope |
| § "Out of scope" L139 | No phase field or setup stdin contract change | Task 1 |
| § "Out of scope" L140 | Do not merge either removal paths or hook runners | Task 1 |
| § "Out of scope" L141 | Keep synchronous spawnSync hook execution | Task 1 |
