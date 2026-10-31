# Forked subagents run in the dispatch cwd

**Ticket:** jjuraszek/pi-cohort#40
**Goal:** A `context: "fork"` child's session header and runtime cwd equal the per-child cwd pi-cohort resolved for it, on every dispatch surface (single, parallel, chain, detached), while a fork that names no `cwd` still inherits the parent's and fresh dispatch is unchanged.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Predecessor:** `doc/specs/2026-10-19-chain-step-output-filesystem.md` (cwd resolution in the executors and the output-derived cwd lifecycle) - extended, not superseded; this spec carries the resolved cwd one step further, into the forked session header.

## Problem

pi-cohort spawns a forked child in the right OS directory but the child's pi runtime works in the parent's directory. The fork resolver opens the parent session with `SessionManager.open(file, dir)` (`src/shared/fork-context.ts:48-50`) and branches it with `createBranchedSession(leafId)` (`:61-66`); pi's `open` picks `cwdOverride ?? header cwd ?? process.cwd()` (pi 1.4.0 `dist/core/session-manager.js:1326-1347`) and the branched header gets `cwd: this.cwd` (`:1247`). The child is launched with `--session <forked file>` (`src/runs/shared/pi-args.ts:100-110`) and `cwd: options.cwd ?? runtimeCwd` (`src/runs/foreground/execution.ts:183-184`), but pi opens the file without an override (`dist/main.js:265-267`) and takes its runtime cwd from `sessionManager.getCwd()` (`:580, :702`), so the header wins and the child's first `pwd -P` prints the parent's A, not the dispatched B. The reporter observed two forked implementers refusing to edit a worktree and returning `status: BLOCKED` for this reason; the fresh-context sibling in the same session used B correctly (issue #40, body and reporter note).

The fix the ticket records is adopted: pass the child's cwd as the third argument of `SessionManager.open` before branching. The reporter note's warning is a design constraint: the cwd must be the effective per-child value, not the request-level one, because parallel and chain steps resolve `task.cwd ?? step.cwd` and `{outputs.<step>.<key>}` references at execution (`src/runs/foreground/chain-execution.ts:245-250, 295-307, 1098-1151`; `src/runs/foreground/subagent-executor.ts:1484-1493`), and detached runs pre-create every fork file in the parent before those values exist (`collectChainSessionFiles`, `src/runs/foreground/subagent-executor.ts:938-956`; `src/runs/background/async-execution.ts:461-463` leaves `{outputs.` cwd templates unresolved; the runner resolves `childCwd` at launch, `src/runs/background/subagent-runner.ts:666-674`).

Premises checked: the `cwdOverride` parameter exists at the declared peer floor (`package.json:66` declares `>=1.3.0`; the worktree's installed 1.3.0 `dist/core/session-manager.d.ts:378` carries `cwdOverride?`), so no floor bump. The reporter's original session artifacts and temporary checkout are gone and were not reproduced; the mechanism above is verified from source, not from those artifacts. Request-level `cwd` discovery of project agents and settings is already correct (CHANGELOG, "cwd is where project agents and settings are resolved from") and is not touched. The independent runner has no runtime import of `@earendil-works/pi-coding-agent` (pi is imported as types only, `src/runs/background/async-execution.ts:11`; `src/runs/shared/jiti-cli.ts:40-54` aliases only typebox), so it cannot re-branch at launch. `test/support/mock-pi-script.mjs:158` writes `cwd: process.cwd()` into headers and `:248` reports `process.cwd()`, so today's integration suite cannot show the defect.

Framing: kept. Checked the resolver, every foreground `runSync` site, the detached pre-creation path into the runner's launch-time `childCwd`, and pi's `--fork`/`forkFrom` alternative (`session-manager.js:1374-1416`, whole-file copy, rejected).

## Acceptance criteria

Ticket #40, Acceptance criteria, rows verbatim:

- [ ] Given a persisted parent session whose header `cwd` is A, a foreground `subagent({ context: "fork", cwd: "B" })` single-task dispatch produces a forked session file whose header `cwd` is B, and the child's first `bash` call `pwd -P` prints the realpath of B.
  in-scope
- [ ] Given the same parent, a chain whose parallel step's per-task `cwd` B is produced by a preceding step's output (not a literal in the chain) gives each forked task a header `cwd` of B and `pwd -P` equal to the realpath of B.
  in-scope
- [ ] Given the same parent, a detached (`async: true`) chain whose second step's `cwd` is produced by the first step's output gives that step's forked session file a header `cwd` equal to the resolved value and `pwd -P` equal to its realpath.
  in-scope
- [ ] A `context: "fork"` dispatch that names no `cwd` still inherits the parent session's cwd (header `cwd` A and `pwd -P` equal to the realpath of A).
  in-scope
- [ ] A `context: "fresh"` dispatch with `cwd: "B"` is unchanged: `pwd -P` equals the realpath of B and the child session header has no `parentSession`.
  in-scope
- [ ] A unit test covers the fork resolver: branching from a parent with header cwd A while requesting cwd B yields a session file whose header `cwd` is B.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-40-fork-cwd-override
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `env -u PI_CODING_AGENT_DIR npm run test:unit`; `npm run test:integration`; `npm run test:all` (CI runs `test:all`)
Rules: AGENTS.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: none
design: owns every path in Design; a one-member run.

## Design

Two mechanisms, split by surface: the parent branches with the right cwd when it knows it (foreground and async single), and the independent runner stamps the header when the file was branched before the cwd was known (detached chains and detached parallel).

### Resolver: branch under the child cwd

- `ForkContextResolver.sessionFileForIndex(index, cwd)` takes the per-child cwd as a second, required parameter (`src/shared/fork-context.ts`). Both hooks that open the parent gain the same third argument: `options.openSession` (`fork-context.ts:16`) becomes `(path, sessionDir, cwd) => SessionManager` with default `SessionManager.open(path, sessionDir, cwd)`, and the `sessionManager.openSession` hook on `ForkableSessionManager` (`:11`) becomes `(path, sessionDir, cwd)`. The hook is the single place the parent manager is opened, so every branched header carries the child cwd.
- The per-index cache is unchanged: one index branches once under its one cwd. The parent snapshot (`getSessionFile()`, leaf id) and the realpath containment check stay as they are.
- `childSessionFileForIndex` / `sessionFileHintForIndex` (`src/runs/foreground/subagent-executor.ts:2378-2379`) is the function every foreground `runSync` site reaches the resolver through, and it branches, not just names the file. It gains the same `(idx, cwd)` parameter and forwards it as `sessionFileForIndex(idx, cwd)`, preserving the fresh-session filename fallback `?? path.join(sessionDirForIndex(idx), "session.jsonl")`.
- The types gain the parameter: `sessionFileForIndex` and `sessionFileHintForIndex` at `subagent-executor.ts:164-165`, the parallel input type at `:1282`, and the chain callback types at `chain-execution.ts:111` and `:400`.
- The cwd passed is the already-resolved child cwd each call site holds in the same block today. Foreground sites: single `effectiveCwd` at the `runSync` launch `subagent-executor.ts:2054` (`effectiveCwd = effectiveParams.cwd ?? ctx.cwd` at `:2318`, so a fork naming no `cwd` passes the parent's A through the same path); parallel `taskCwd` after `resolveParallelTaskCwd` (`:1493`, worktree-aware, so a worktree-isolated fork's header names the agent worktree); chain parallel `taskCwd` (`chain-execution.ts:307`); chain sequential `stepCwd` (`:1151`; `stepCwd` is assigned at `:1099`). Async single-task fork sites, which know their cwd at dispatch, pass `effectiveCwd`: `subagent-executor.ts:1150` and the clarify-then-background `executeAsyncSingle` branch at `:1976`.
- The header stores the lexically resolved absolute path `resolveChildCwd` produces (`src/shared/utils.ts:27-30`). Symlink resolution stays with the child's shell; the ACs assert `pwd -P`, which is the realpath regardless of the header's spelling.

### Detached: stamp the header at launch

- `collectChainSessionFiles` (`subagent-executor.ts:938-956`) and the other pre-creation sites (`:1079, :1109, :1251`, and the foreground-parallel "run in background" site `:1715`) keep pre-creating fork files index-only, passing the request-level cwd (`effectiveCwd`) as the cwd argument so the signature is satisfied; the pre-created header is provisional.
- `src/runs/background/subagent-runner.ts` gains a private `stampSessionHeaderCwd(sessionFile, cwd)`: read the file, parse line 1 as JSON, require `type === "session"`, set `cwd`, write line 1 back, leave every other line byte-identical. The runner calls it once per step inside `runSingleStep`, after `childCwd` is resolved (`:668-671`) and after backend selection succeeds (`:676-699`), immediately before `const candidates = ...` (`:721`) and outside both attempt loops (external `buildPiArgs` at `:780`, native `buildPiArgs` at `:932`), for every step that carries a pre-created `sessionFile`. Backend-selection failures return ahead of the stamp and leave a reused file untouched. Literal, group-level, and `{outputs.` cwds all pass through this one call.
- A fresh-context step has no pre-created `sessionFile` and is untouched, which keeps AC 5's "no `parentSession`".
- Dynamic-fanout parallel steps get no pre-created fork files today (`collectChainSessionFiles` skips them, `:952`) and are unchanged.

### Test fixture

- `test/support/mock-pi-script.mjs` learns pi's precedence for `--session`: when the named file exists and its line 1 is a session header with a `cwd`, the fake selects that cwd, else `process.cwd()`. The selected cwd is written lexically into any header the fake emits (`:158`), and the `echoCwd` observation (`:248`) reports `fs.realpathSync.native(selected)`, emulating `pwd -P`. Header equals the lexical resolved path; observation equals its realpath. Test-only contract, no production code.
- Integration stubs of `sessionManager.openSession` (`test/integration/fork-context-execution.test.ts:59, :206`) hardcode `cwd: "/tmp"` in their branched headers today; they are updated to write the received third argument into the branched header.
- Existing reused-session fixtures that launch successfully supply empty or non-header files as `sessionFile` (`test/unit/async-execution.test.ts:443-470` "reuse" / "external-reuse"; `test/integration/async-execution.test.ts:794-827`). Under strict stamping they are updated to valid session-header JSONL (line 1 a `type: "session"` header, history lines after it); their history-byte assertions are preserved. The selection-failure test at `test/unit/async-execution.test.ts:403-434` keeps its non-header file and byte-identical assertion, which holds because the stamp runs after backend selection.

Remove: nothing.
Add: `cwd` parameter on `sessionFileForIndex`, `options.openSession`, and `sessionManager.openSession` in `src/shared/fork-context.ts`; `(idx, cwd)` on `childSessionFileForIndex` / `sessionFileHintForIndex` (`subagent-executor.ts:2378-2379`) and on the types at `subagent-executor.ts:164-165, :1282` and `chain-execution.ts:111, :400`; the argument at foreground sites `subagent-executor.ts:2054, :1493` and `chain-execution.ts:307, :1151`, at async-single sites `subagent-executor.ts:1150, :1976`, and at pre-creation sites `:1079, :1109, :1251, :1715` plus `collectChainSessionFiles`; private `stampSessionHeaderCwd` in `src/runs/background/subagent-runner.ts` and its single call before `const candidates` (`:721`); header precedence with realpath observation in `test/support/mock-pi-script.mjs`; stub and fixture updates in `test/integration/fork-context-execution.test.ts:59, :206`, `test/unit/async-execution.test.ts:443-470`, `test/integration/async-execution.test.ts:794-827`; cases in `test/unit/fork-context.test.ts`, `test/unit/async-execution.test.ts`, `test/integration/fork-context-execution.test.ts`, `test/integration/chain-execution.test.ts`, `test/integration/async-execution.test.ts`; a `CHANGELOG.md` `## [Unreleased]` entry naming #40.

## Errors and edge cases

- Stamp runs once per step after backend selection and before both attempt loops, so retries across model candidates and the external/native backends reuse one stamped file; it is idempotent.
- A pre-created `step.sessionFile` that is missing, unreadable, or whose line 1 is not a `type: "session"` header fails the step with an explicit error before launch (`exitCode: 1`, the error message as output, matching the runner's existing step-failure shape at `:674`). A child never launches under the parent cwd by accident, consistent with the resolver's no-silent-fallback rule. A backend-selection failure (`:676-699`) returns its own error first and never touches the file.
- Accepted consequence: a worktree-isolated parallel fork's header names the agent worktree, which `cleanupWorktrees` removes after the run, so the persisted fork session points at a deleted directory and a later non-interactive `--session` reopen of that file fails pi's missing-cwd check (pi 1.3.0 `dist/main.js:556-569`, `process.exit(1)`). The launch-time worktree cwd is kept; stamping the group cwd instead would reintroduce the wrong-cwd fork this change fixes.
- A nonexistent cwd keeps today's behavior: the spawn fails with ENOENT before any header is read; no new validation.
- The parent's own session file is never written; only branched files are.
- Header `cwd` may be the symlinked spelling while `pwd -P` is the realpath; both are correct, the ACs test the latter.

## Tests

- single fork with `cwd: B` -> header `cwd` equals resolved B (lexical) and reported cwd equals `realpath(B)` - `test/integration/fork-context-execution.test.ts`
- foreground chain parallel step with per-task cwd from a prior step's output -> each fork header equals resolved B and reported cwd equals `realpath(B)` - `test/integration/chain-execution.test.ts`
- detached chain second step with `{outputs.` cwd -> stamped header equals the resolved value and reported cwd equals its realpath - `test/integration/async-execution.test.ts`
- fork with no `cwd` -> header equals the parent's A and reported cwd equals `realpath(A)` - `test/integration/fork-context-execution.test.ts`
- fresh with `cwd: B` -> reported cwd equals `realpath(B)`, header has no `parentSession` - `test/integration/fork-context-execution.test.ts`
- resolver passes B as the third `openSession` argument and the branched header (real `SessionManager`) is B - `test/unit/fork-context.test.ts`
- stamp, exercised through `runSingleStep` (no public helper export): header `cwd` replaced, other lines byte-identical, idempotent across a second run, and explicit pre-launch failure on a missing file or non-header line 1 - `test/unit/async-execution.test.ts`
- updated "reuse" / "external-reuse" fixtures with valid session headers still launch and keep history bytes; selection-failure fixture with a non-header file stays byte-identical - `test/unit/async-execution.test.ts`, `test/integration/async-execution.test.ts`
- worktree parallel fork header names the agent worktree - `test/integration/fork-context-execution.test.ts`
- fake pi precedence: an existing `--session` file whose header cwd differs from the launch directory, with the header path spelled through a symlink -> `echoCwd` reports the realpath of the header cwd, not `process.cwd()` - `test/integration/fork-context-execution.test.ts`
- nonexistent cwd -> none: existing spawn-ENOENT behavior, unchanged

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - `## [Unreleased]` entry naming #40, ships with the fix (release promotes it). README "Architecture" (line 80 already promises every child launch receives its exact resolved cwd) and `doc/agents-and-chains.md` "Chain variables" state the contract this change makes true; neither gains a section or a changed contract
- Derived / memory docs invalidated: none

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- The parent guard that reports a `status: BLOCKED` child as "completed without making edits" (reporter note; separate follow-up).
- Dynamic-fanout parallel steps in detached chains: no pre-created fork files today, so no stamp; unchanged.
- pi-gauntlet #36's skill-level guards and its `context: "fresh"` workaround; no pi-gauntlet edit.
- A live-pi smoke test in the suite (Q1 answer A: the fake pi emulates the precedence instead).
- Request-level cwd discovery of project agents and settings (already correct).

## Open questions

None.
