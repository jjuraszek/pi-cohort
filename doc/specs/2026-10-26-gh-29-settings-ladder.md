# Read every pi-cohort setting from `settings.json#subagents` (#29)

**Goal:** Every `ExtensionConfig` key resolves per execution unit (task, parallel task, chain step or worktree group, resume target) from `settings.json#subagents` on the existing user < project-ladder walk at that unit's effective cwd, nearest level wins; the private `extensions/pi-cohort/config.json` is never read and its presence triggers one session-start migration warning.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** waves
**Ticket:** jjuraszek/pi-cohort#29
**Predecessor:** `doc/specs/2026-10-26-gh-27-worktree-teardown-hook.md` stays live; this spec changes only where its keys are read, not what they do.

## Problem

`loadConfig()` (`src/extension/config.ts`) reads one private file, `<agentDir>/extensions/pi-cohort/config.json`, once at extension load, with no cwd. Everything in `ExtensionConfig` (`src/shared/types.ts:855-885`) - including the worktree hooks from #27/#28 - lives only there, so a repository cannot ship its own setup/teardown hook, and a user who follows pi's committed `.pi/settings.json` convention finds no key for it. Meanwhile three cohort settings (`disableBuiltins`, `executionBackend`, `agentOverrides`) already resolve from `settings.json#subagents` through the project ladder in `src/agents/agents.ts:449-531`, so configuration is split across two sources with two precedence rules.

Framing: kept (ticket #29). The namespace is `settings.json#subagents`, one umbrella object for all 16 unique keys (the three already there plus the 14 `ExtensionConfig` keys; `executionBackend` belongs to both sets); no `piCohort` namespace. The user's original ask ("dedicated keys for setup/teardown") is already satisfied by `worktreeSetupHook`/`worktreeTeardownHook` and their `*TimeoutMs` keys; the gap is their source.

Premises verified: pi-gauntlet's loader (`extensions/lib/gauntlet-settings-loader.ts`, `gauntlet-settings.ts` in the sibling repo) is a two-layer shallow merge (profile + checkout-root `.pi/settings.json`) in a separate package; it is not importable and does not walk ancestor levels, so only its shape (pure merge, whole-value replace per key) is borrowed. Gauntlet has no settings schema version; "versioned settings" means a namespaced object in a committed project `.pi/settings.json`. The consumer repository the user pointed at follows that pattern; no detail from it appears here.

## Acceptance criteria

Ticket #29, Acceptance criteria, rows verbatim:

- [ ] With `subagents.worktreeTeardownHook` set to a repo-relative path in a project's `.pi/settings.json` and no user-level setting, a `worktree: true` task runs the hook from that path once per created worktree; the same holds for `worktreeSetupHook` and both `*TimeoutMs` keys.
  in-scope
- [ ] With the same key set in a project `.pi/settings.json`, an ancestor project level's `.pi/settings.json`, and the user profile `settings.json`, the nearest project value is the one in effect for every key previously defined in `ExtensionConfig` (`asyncByDefault`, `forceTopLevelAsync`, `defaultSessionDir`, `maxSubagentDepth`, `control`, `parallel`, `chain`, `worktreeSetupHook`, `worktreeSetupHookTimeoutMs`, `worktreeTeardownHook`, `worktreeTeardownHookTimeoutMs`, `showRosterOnStart`, `forwardParentFlags`, `executionBackend`); with only the user value set, the user value is in effect; with neither, the documented default applies.
  in-scope
- [ ] A detached or child run (async, fanout child, chain step) resolves these settings from the project it runs in, not from the parent's profile alone, so a hook configured in the project fires in those runs too.
  in-scope
- [ ] With a populated `extensions/pi-cohort/config.json` present and no `subagents.*` settings, the file is ignored and a session-start warning names the file and tells the user to move its keys to `settings.json#subagents`; no code path reads the file for values.
  in-scope
- [ ] `doc/configuration.md` describes `settings.json#subagents` as the only source, with every key's example shown in that shape, and no doc or source comment names `extensions/pi-cohort/config.json` except the migration note; `CHANGELOG.md` records the breaking change under `## [Unreleased]` (creating that heading if absent).
  in-scope
- [ ] The test that writes `extensions/pi-cohort/config.json` and calls `loadConfig()` is replaced by tests that exercise project-over-user resolution for at least one scalar key, one object key (`parallel` or `control`), and one hook path.
  in-scope

Reading of row 2 (Design clause): "the documented default applies" means the default the existing consumer applies when the key is absent (`src/runs/shared/worktree.ts:205,272` for the `30000` hook timeouts, `resolveCurrentMaxSubagentDepth` and `resolveTopLevelParallelMaxTasks` in `src/shared/types.ts:987,1022`, the `!== false` / `=== true` call-site checks for the booleans, `"auto"` for `executionBackend`); the resolver adds no defaults layer. Keys whose absence is contextual (`defaultSessionDir` falls back through the parent session; `chain.dynamicFanout.maxItems` has no default and must be set for dynamic fanout) keep that behavior and the docs say so.

Reading of row 3 (Design clause): "the project it runs in" is the effective cwd of each execution unit - `requestCwd` for a single task, each parallel task's cwd, each chain step's or worktree group's cwd after chain `cwd` placeholders are resolved, `target.cwd` when a resume target carries one. The parent resolves the config at that cwd before preparing the unit and carries the resolved values into a detached job by value; a fanout child receives the resolver, not a snapshot, so a nested `subagent()` inside it honors its own `params.cwd`.

Reading of row 5 (Design clause): "no doc or source comment names `extensions/pi-cohort/config.json`" applies to current-contract docs and source comments (`doc/configuration.md`, `README.md`, `doc/agents-and-chains.md`, the `src/extension/index.ts` header). Released `CHANGELOG.md` sections (`CHANGELOG.md:342,799`) and the predecessor spec `doc/specs/2026-09-06-gh-11-remove-pi-intercom.md:21` are history and keep the path.

## Design

### 1. The ladder reads all 16 keys (`src/agents/agents.ts`)

`readSubagentSettings` extracts, in addition to `disableBuiltins`, `executionBackend`, `agentOverrides`, each `ExtensionConfig` key from the `subagents` object with a per-key type check: booleans (`asyncByDefault`, `forceTopLevelAsync`, `showRosterOnStart`, `forwardParentFlags`), strings (`defaultSessionDir`, `worktreeSetupHook`, `worktreeTeardownHook`), non-negative integer (`maxSubagentDepth`), plain objects (`control`, `parallel`, `chain`). A new key with the wrong type is dropped with one warning naming the file and the key, emitted on every read (the resolver runs per execution unit, so the warning repeats per call); the level's other keys survive. The three existing keys keep their behavior: invalid `disableBuiltins` or `agentOverrides` throw and the project merge skips that whole level, invalid `executionBackend` throws `InvalidExecutionBackendSettingError` and aborts resolution (`src/agents/agents.ts:460,465-475,508-511`).

`worktreeSetupHookTimeoutMs` and `worktreeTeardownHookTimeoutMs` are carried through as read, not type-checked and never dropped: the existing positive-integer check in `src/runs/shared/worktree.ts:205-210,272-280` rejects `0`, negative, fractional, or non-numeric values before any worktree is created, exactly as it does today for the private file. An empty-string hook path stays "unset" (existing behavior).

`readMergedProjectSubagentSettings(cwd)` stays project-only (it walks `enumerateProjectLevels` farthest to nearest and never reads the profile; agent discovery depends on that for `agentScope: "project"`, `test/unit/agent-overrides.test.ts:141-164`). The new keys join its merge with the rule it already applies to scalars: the nearest defined value wins, and an object-valued key (`control`, `parallel`, `chain`) replaces the whole object, never a per-leaf merge (same as `agentOverrides` per persona and as gauntlet's `mergeGauntlet`).

New export `resolveExtensionConfig(cwd: string): ExtensionConfig` = `readSubagentSettings(getUserAgentSettingsPath())` (the profile, read strictly as discovery reads it today: a malformed profile throws) with `readMergedProjectSubagentSettings(cwd)` applied on top, nearest defined value winning, whole-object replacement for `control`/`parallel`/`chain`. The result is sparse: only keys defined at some level and type-valid are present; no defaults are filled in (see the row-2 reading).

`src/execution-backend/configured-selection.ts` drops its internal `readProjectExecutionBackend(input.cwd)` re-read (`configured-selection.ts:16-17`); the preference is `userConfig.executionBackend ?? "auto"` where `userConfig` is the config resolved at the execution unit's cwd. `readProjectExecutionBackend` is deleted. Both callers change: `src/runs/foreground/execution.ts:687-692` passes the unit-resolved config, and `src/runs/background/subagent-runner.ts:668-672` consumes the serialized `userPreference` that `detachedExecutionBackends` (`src/runs/background/async-execution.ts:91`) now fills from the unit-resolved value. `test/unit/execution-backend-configured-selection.test.ts` and `test/unit/execution-backend-project-settings.test.ts` are updated to the single-preference contract.

### 2. Delete `src/extension/config.ts`

`loadConfig()` and its re-export in `index.ts` go. `ExtensionConfig` stays in `src/shared/types.ts`; its comment names `settings.json#subagents`.

### 3. Per-unit resolution in the executor (`src/runs/foreground/subagent-executor.ts`)

`ExecutorDeps.config: ExtensionConfig` becomes `resolveConfig: (cwd: string) => ExtensionConfig`; the `asyncByDefault` and `forwardedFlags` deps go, since both derive from a resolved config (`forwardedFlags` = `deriveForwardedFlags(process.argv, config)`).

`execute()` resolves at `requestCwd` right after `requestCwd = resolveRequestedCwd(ctx.cwd, params.cwd)` for the call-level reads that have no narrower cwd: depth guard (`maxSubagentDepth`), `control`, `defaultSessionDir`, `forceTopLevelAsync`, `asyncByDefault`, `forwardedFlags`, `parallel` limits, `chain.dynamicFanout`. Every execution unit then resolves again at its own effective cwd before its execution is prepared, and that unit-scoped config supplies the four hook keys and `executionBackend`:

- single task: `requestCwd` (same object, no second read);
- parallel task: the task's resolved cwd; a worktree group is resolved at the group cwd, which is where `createWorktrees` runs (`src/runs/background/subagent-runner.ts:2106-2139`, `src/runs/foreground/chain-execution.ts:647-668`);
- chain step: the step cwd after `{outputs.` placeholders and `step.cwd` are resolved (`resolveChildCwd`), so a step whose cwd lands in another project uses that project's hooks;
- resume: `effectiveCwd = target.cwd ?? requestCwd` (`subagent-executor.ts:629`).

Detached runs: the detached runner is a separate process with the same filesystem, so it resolves per unit itself. `async-execution.ts` keeps serializing the call-level config into `SubagentRunConfig` (`subagent-runner.ts:107-131`) as the job-wide value; `subagent-runner.ts` then calls `resolveExtensionConfig(unitCwd)` for each step, parallel task, or worktree group once that unit's effective cwd is known (after `{outputs.` placeholders resolve, `subagent-runner.ts:660-672`), and takes the four hook keys and `executionBackend` from that unit-scoped result. The serialized tuple is the fallback only when the unit cwd equals the job cwd. No new serialized fields. Fanout: the executor passes `resolveConfig` into the fanout executor so each child registration resolves at its own cwd rather than freezing a snapshot.

`doctor` receives the call-scoped config and passes it into the existing `buildDoctorReport` (`src/extension/doctor.ts:187`); its output does not change.

### 4. Extension entry points

`src/extension/index.ts` `session_start`: resolve once from `ctx.cwd` for `showRosterOnStart`; then, in a top-level session only (the existing `process.env[SUBAGENT_CHILD_ENV] === "1"` guard at `index.ts:243` excludes fanout children and detached runners), if `<agentDir>/extensions/pi-cohort/config.json` exists (any content, including invalid or empty), emit one warning: the file path, "pi-cohort no longer reads this file", and "move its keys under `subagents` in `settings.json`". Channel: `ctx.hasUI ? ctx.ui.notify(message, "warning") : console.warn(message)`, so a headless `pi -p` session gets it too. The file is never opened for values.

`src/extension/fanout-child.ts` replaces the `loadConfig()` snapshot (`fanout-child.ts:129-141`) with `resolveConfig: resolveExtensionConfig` passed to `createSubagentExecutor`.

### 5. Migration

Keys keep their `ExtensionConfig` names verbatim, so a user moves the object from `config.json` into `~/.pi/agent/settings.json` under `"subagents"` (or into a project `.pi/settings.json`). Example project file:

```json
{
  "subagents": {
    "worktreeSetupHook": "./scripts/setup-worktree.mjs",
    "worktreeTeardownHook": "./scripts/teardown-worktree.mjs",
    "maxSubagentDepth": 3
  }
}
```

## Errors and edge cases

- Malformed JSON at a project level: warned and skipped; other levels still apply (existing behavior, `agents.ts:505-516`).
- Malformed user profile `settings.json`: the strict profile read throws and the call fails, as discovery already fails on the same file (`agents.ts:291-312,1072,1123`); not recovered here. Changing that needs a separate change to discovery.
- Wrong-typed new key: dropped with a warning naming file and key, per read; the rest of the level applies. Invalid `disableBuiltins`/`agentOverrides`: that level is skipped (existing). Invalid `executionBackend`: throws and aborts resolution (existing).
- Invalid hook timeout (`0`, negative, fractional, non-numeric) at any level: dispatch fails before any worktree is created (existing `worktree.ts` check); the value never falls back to an ancestor level or the default.
- No `subagents` object anywhere: consumers apply their existing defaults, no warning.
- Legacy file present alongside `settings.json#subagents`: warning fires, settings win, file unread.
- `cwd` outside any git repository: `enumerateProjectLevels` returns at most the nearest ancestor carrying `.pi` or `.agents` (`agents.ts:248-252,273-284`), so a non-git project's `.pi/settings.json` still applies; profile and defaults alone only when no marked level exists.
- Chain `cwd` carrying `{outputs.` placeholders: the step is resolved at the templated group cwd once placeholders are filled, not at `requestCwd`.
- Worktree children: a `worktree: true` child runs in its checkout (`execution.ts:687`), which carries only committed files; a nested `subagent()` inside it sees the project's `.pi/settings.json` only when that file is committed. Uncommitted or gitignored settings in the source checkout do not transfer.
- Relative hook paths still resolve from the repository root of the worktree group (`doc/configuration.md:115`), independent of which settings level defined them.

## Tests

Unit (`env -u PI_CODING_AGENT_DIR npm run test:unit`):

- Ladder: project `.pi/settings.json#subagents.worktreeSetupHook` beats user `settings.json`; nearest level beats the git-root level; user value applies when no project level defines the key; a wrong-typed `maxSubagentDepth` drops only that key; `parallel` set at two levels yields the nearer object whole; no settings at all yields a sparse config and the existing consumer resolvers (`resolveCurrentMaxSubagentDepth`, `resolveTopLevelParallelMaxTasks`, the worktree timeout parser) produce the documented defaults; a non-git directory with `.pi/settings.json` resolves that level; a malformed profile throws.
- Hook timeouts: `-1`, `0`, `1.5` set in `settings.json#subagents` reach the executor and fail dispatch before `createWorktrees` runs; empty-string hook path is unset.
- Executor: two `execute()` calls with different `cwd` each pass their own `worktreeSetupHook` and timeout to `createWorktrees`; `asyncByDefault` follows the call's config; a chain step with `cwd` in a second project uses that project's hook; a fanout child nested `subagent()` with `params.cwd` resolves at that cwd; resume at `target.cwd` uses that project's hooks.
- Configured selection: with no internal project re-read, the resolved `executionBackend` is the only preference (foreground and detached `userPreference`).
- `session_start`: legacy file present -> exactly one warning containing its path, via `ctx.ui.notify` when `hasUI` and `console.warn` otherwise; absent -> none; child runner -> none.
- Replace only the legacy `loadConfig()` fixture in `test/unit/pi-coding-agent-dir.test.ts:120-125` with a `settings.json#subagents` fixture. `test/unit/execution-reporting-protocol.test.ts`, `test/unit/external-foreground-execution.test.ts`, and `test/integration/detached-external-orchestration.test.ts` keep their `config.json` files: those are the reporter config and the detached runner job file, not `ExtensionConfig`.
- Switch every `createSubagentExecutor({ config, asyncByDefault, forwardedFlags })` caller to `resolveConfig`: `test/support/runtime-parent.mjs`, `test/support/sdk-host-parent.mjs`, `test/unit/executor-runtime-default.test.ts`, `test/unit/nested-control.test.ts`, `test/integration/{single,async,parallel,fork-context}-execution.test.ts`, `test/integration/doctor-executor.test.ts` (no `tsc` here; a stale `config:` dep fails only at runtime).

Integration (`npm run test:integration`): detached run started from a project with a hook in `.pi/settings.json` runs the hook (existing async worktree test extended with a settings fixture).

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/configuration.md` - opening paragraph and every key section state `settings.json#subagents` as the source, the user/project/nearest-wins ladder, whole-object replacement for `control`/`parallel`/`chain`, and the legacy-file warning; new `control` and `chain` (`chain.dynamicFanout.maxItems`) sections so every key has an example in the `subagents` shape; each key states its consumer default, or that it is unset/required (`defaultSessionDir` parent-session fallback, `maxItems` required for dynamic fanout); the worktree-child note that project settings reach nested calls only when committed (operations / tunable parameters); `README.md` configuration pointer (same category); `CHANGELOG.md` `## [Unreleased]` breaking-change entry (#29)
- Derived / memory docs invalidated: `src/extension/index.ts` header comment listing `config.json` keys; `doc/agents-and-chains.md` settings-merge section, which names only the three existing keys

## Out of scope

- A trust prompt for project-defined hooks (ticket: existing project trust model stays).
- Settings outside `ExtensionConfig` (environment variables, the forwarded CLI flags themselves).
- Importing or depending on pi-gauntlet's loader; adding a settings schema version.
- Per-leaf deep merge of object keys.
- Warn-and-skip recovery for a malformed user profile (discovery reads it strictly; changing that is a separate change).
- Settings-level provenance in `doctor` output.

## Open questions

None.
