# Configuration

`pi-cohort` reads settings only from the `subagents` object in `settings.json`. Back to [README](../README.md).

## Settings source and precedence

The profile's `<PI_CODING_AGENT_DIR>/settings.json` (by default `~/.pi/agent/settings.json`) is the lowest-priority layer. Project `.pi/settings.json` files apply above it, from the git root down to the effective cwd; the nearest defined value wins. Project levels are marked by `.pi` or `.agents`. Outside git, only the nearest marked ancestor applies; with no marked ancestor, only the profile applies.

`control`, `parallel`, and `chain` replace the whole object at a nearer level, not individual leaves. For example, a nearer `parallel: {"concurrency": 2}` discards an ancestor's `maxTasks`; the consumer then uses its default of `8`. The resolver stays sparse and supplies no defaults.

Call policy resolves at the requested cwd. Hooks and backend selection resolve at each execution unit's effective cwd: the single task, parallel task, chain step or worktree group after cwd placeholders resolve, or resume target. Detached runs resolve unit settings late, once each unit's effective cwd is known. Only keys absent from that unit-scoped result fall back to serialized job-wide values, and only when the effective unit cwd equals the original job cwd. Defined empty hooks override that fallback; units in other projects do not inherit job-wide settings. Resolution errors fail the run rather than triggering fallback. Nested calls resolve at their own requested cwd.

Malformed profile settings fail the call; malformed project files are warned about and skipped so other levels still apply. Wrong-typed extension keys are dropped with a warning naming the file and key on each read, leaving other keys intact. Invalid `disableBuiltins` or persona override entries can reject the project level; invalid `executionBackend` aborts resolution rather than falling back. Hook timeout values are retained for dispatch validation, not dropped or replaced by ancestor values.

Discovery settings `disableBuiltins` and `agentOverrides` share this namespace; see [agent discovery and overrides](agents-and-chains.md#agents-and-chains-discovery-and-precedence) for their project-only discovery merge and per-persona replacement rules.

## Migration

The old `<PI_CODING_AGENT_DIR>/extensions/pi-cohort/config.json` is ignored, regardless of its contents. Move its object under `"subagents"` in the profile's `settings.json` or a project's `.pi/settings.json`, keeping the key names. For example:

```json
{
  "subagents": {
    "worktreeSetupHook": "./scripts/setup-worktree.mjs",
    "worktreeTeardownHook": "./scripts/teardown-worktree.mjs",
    "maxSubagentDepth": 3
  }
}
```

At each top-level session start, the old file's presence triggers one warning naming the file and asking you to move its keys. Interactive sessions use a UI warning; headless sessions use stderr. Child runners do not warn. There is no automatic migration, and the old file is never read for values.

Worktree checkouts carry only committed files: commit project `.pi/settings.json` if nested calls inside the checkout need it. Uncommitted or gitignored source-checkout settings do not transfer. Relative hook paths still resolve from the worktree group's repository root, not from the settings file. Project trust and hook lifecycle rules are unchanged.

## `PI_CODING_AGENT_DIR`

Environment variable that selects the **pi profile root** (where user agents, chains, settings, extension config, durable run history, and default sessions live). Temporary artifacts use separate storage. Resolution:

| Value | Resolves to |
|---|---|
| unset | `~/.pi/agent` |
| `~` | home directory |
| `~/sub/dir` | `<home>/sub/dir` |
| absolute/relative path | resolved to an absolute path at extension load |

The resolved profile is pinned at extension load for storage under `<PI_CODING_AGENT_DIR>/pi-cohort/`. Only an explicitly configured `PI_CODING_AGENT_DIR` is propagated to children and detached coordinators as that absolute path; an unset variable stays unset. Selecting another profile changes the roots used for new files; existing files are not relocated. A user-selected temporary profile or session base limits durability. There is no runtime-selection or retention setting.

Setting it selects the `<PI_CODING_AGENT_DIR>/agents`, `/chains`, `/settings.json`, etc. roots. It is **not a discovery sandbox**: the global `~/.agents` root is always scanned as the lowest-priority user layer regardless of this variable, and project roots (`<repo>/.agents`, `<repo>/.pi/agents`) are always scanned relative to the workspace. To fully isolate discovery you must also avoid populating `~/.agents`.

## `asyncByDefault`

```json
{ "subagents": { "asyncByDefault": true } }
```

Defaults to `false`. Makes top-level calls use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

## `forceTopLevelAsync`

```json
{ "subagents": { "forceTopLevelAsync": true } }
```

Defaults to `false`. Forces depth-0 single, parallel, and chain runs into background mode and bypasses clarify UI by forcing `clarify: false`. Nested calls are not forced into background mode by this option and resolve settings at their own requested cwd.

## `parallel`

```json
{
  "subagents": {
    "parallel": {
      "maxTasks": 12,
      "concurrency": 6
    }
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

## `control`

```json
{
  "subagents": {
    "control": {
      "enabled": true,
      "needsAttentionAfterMs": 60000,
      "activeNoticeAfterMs": 240000,
      "inFlightSilenceCeilingMs": 600000,
      "inFlightSilenceKillMs": 1800000,
      "failedToolAttemptsBeforeAttention": 3,
      "notifyOn": ["active_long_running", "needs_attention"],
      "notifyChannels": ["event", "async"]
    }
  }
}
```

These are the consumer defaults. Optional `activeNoticeAfterTurns` and `activeNoticeAfterTokens` have no defaults and remain unset. Numeric thresholds must be positive integers; invalid thresholds fall back in the consumer. The kill threshold is clamped to at least `inFlightSilenceCeilingMs + needsAttentionAfterMs`. `notifyOn` accepts the two event names shown above; `notifyChannels` accepts `event` and `async`. An empty list disables those notifications. Per-call control overrides take precedence over the resolved settings object; this is separate from whole-object replacement between settings levels.

## `chain`

```json
{
  "subagents": {
    "chain": { "dynamicFanout": { "maxItems": 8 } }
  }
}
```

`chain.dynamicFanout.maxItems` has no default. Dynamic fanout requires it or a step's `expand.maxItems`; the step value takes precedence. The limit must be an integer >= `0`. Expansion fails if the item count exceeds the limit.

## `defaultSessionDir`

```json
{ "subagents": { "defaultSessionDir": "~/.pi/agent/sessions/subagent/" } }
```

`defaultSessionDir` is unset by default. Session base precedence is unchanged: `params.sessionDir`, then `subagents.defaultSessionDir`, then a directory derived from the parent session (beside its file, named after its filename without `.jsonl`). Without a parent session file, the default base is `<PI_CODING_AGENT_DIR>/pi-cohort/sessions/`. Sessions are always enabled.

These settings select a base, not a shared run directory: every new run gets a full-UUID child directory, with per-child directories inside it. New fork snapshots live within that run's scope, not the parent's shared session directory. Existing session files are not relocated. An explicit temporary `sessionDir` or `defaultSessionDir` can disappear independently of retained history; revival still requires the recorded session file.

## `maxSubagentDepth`

```json
{ "subagents": { "maxSubagentDepth": 1 } }
```

Defaults to `2` through the runtime depth resolver. Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Per-agent `maxSubagentDepth` can tighten the limit for that agent's child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent`; at the cap, execution fanout is blocked instead of silently hiding nested work. See [orchestration-patterns.md](orchestration-patterns.md#recursion-guard) for the runtime recursion guard this backs.

## `showRosterOnStart`

```json
{ "subagents": { "showRosterOnStart": false } }
```

At each interactive session start, prints a `[Subagents]` roster into chat listing discovered persona names grouped by effective scope (`builtin` / `user` / `project`) plus any `chains`, mirroring pi's own `[Skills]` / `[Prompts]` / `[Themes]` startup banner. Names are deduped by precedence: a persona shadowed by a higher scope (project > user > builtin) is listed only once, in its effective scope. Defaults to enabled; set to `false` to suppress. No effect in non-interactive (headless/child) runs.

## `forwardParentFlags`

```json
{ "subagents": { "forwardParentFlags": false } }
```

Parent extension CLI flags are forwarded into spawned children by default: whatever extension flags you launched `pi` with (for example `--no-autofix` from pi-lens) are re-applied to every subagent child, across foreground, sync-background, and detached-async dispatch, at any nesting depth. Flags are derived from the parent's own argv by mirroring pi's argument parser: pi *core* flags (`--model`, `--mode`, `--system-prompt`, `--session*`, `-p`, `--extension`, ...) are never forwarded - only extension flags are. The child's model comes from explicit resolution instead - per-call, agent, then the parent session's current model and thinking level (see the resolution table in [`agents-and-chains.md`](agents-and-chains.md#changing-a-builtin-agents-model)). Forwarding is skipped silently when the parent was launched with `--extension`/`-e`/`--no-extensions`, or when the dispatched agent restricts its own extensions, because the child would not load the flag's owning extension. Defaults to enabled; set to `false` to disable entirely.

Caveat: if a child runs with a `cwd` in a different project whose *project-scoped* extension owns a forwarded flag, the child can fail to start on the unknown flag. User-scoped extensions (e.g. pi-lens) load regardless of `cwd` and are unaffected; set `forwardParentFlags: false` if the cross-project case bites.

## `executionBackend`

```json
{ "subagents": { "executionBackend": "auto" } }
```

Determines backend selection policy for spawned subagent processes. Current direct native runners do not consume this setting; it takes effect only through the backend-neutral execution path.

Accepts:
- `"auto"` (default): select the first available registered execution backend in insertion order; fall back to native execution if none are available. Registration order is policy: companion adapters (e.g. `pi-cohort-mux`) register higher-level/more opinionated transports first (cmux, then tmux).
- `"native"`: always select native execution, bypassing all registered backends.
- A registered backend name (e.g. `"cmux"`, `"tmux"`): select that specific backend; fail loudly if unavailable or if detection throws.

The nearest defined `subagents.executionBackend` wins through the settings ladder; when unset, the consumer uses `auto`. Blank, whitespace-only, and invalid-type values fail loudly. Unknown backend names fail at selection time. Diagnostics never echo adapter-provided error text or detection reasons.

**Inspiration:** backend selection adapts vim-dispatch's ordered first-match handler pattern ([`plugin/dispatch.vim#L84-L97`](https://github.com/tpope/vim-dispatch/blob/a2ff28abdb2d89725192db5b8562977d392a4d3f/plugin/dispatch.vim#L84-L97) defines ordered handlers; [`autoload/dispatch.vim#L408-L421`](https://github.com/tpope/vim-dispatch/blob/a2ff28abdb2d89725192db5b8562977d392a4d3f/autoload/dispatch.vim#L408-L421) iterates first-match-wins) without editor-specific lifecycle coupling.

## `worktreeSetupHook`

```json
{
  "subagents": {
    "worktreeSetupHook": "./scripts/setup-worktree.mjs",
    "worktreeSetupHookTimeoutMs": 45000,
    "worktreeTeardownHook": "./scripts/teardown-worktree.mjs",
    "worktreeTeardownHookTimeoutMs": 30000
  }
}
```

Both hook paths are unset by default. `worktreeSetupHook` runs once per created worktree; `worktreeTeardownHook` runs before its removal, including setup-failure rollback. The hooks are independent: setup-only and teardown-only configurations are supported. An empty string (`""`) is treated as unset at the executor boundary, with no validation or invocation.

Both hook paths accept absolute paths, `~/...`, or repo-relative paths containing `/` or `\`; relative paths resolve from the repository root. Bare command names, whitespace-only paths, missing files, and directories are rejected before any checkout is created. Both timeout settings default to `30000` ms and, when their hook is configured, must be positive integers; invalid values are rejected before checkout creation.

Both hooks receive the identical stdin JSON object: `version: 1`, `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, `baseCommit`, and optional `agent`. There is no `phase` field. Both run with the checkout root (`worktreePath`) as cwd, not `agentCwd`, and execute synchronously via `spawnSync`, blocking the event loop with a timeout per checkout.

The setup hook's stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup.

The teardown hook's stdout is discarded; no JSON response is required. Failures (including spawn errors, nonzero exits, signals, and timeouts) produce best-effort warnings with the checkout path and trimmed stderr when available. Cleanup continues without changing task results. Warning writes do not wait for delivery, so logs are not guaranteed before process exit. See [orchestration-patterns.md](orchestration-patterns.md#worktree-isolation) for cleanup guarantees.

## Manually verifying flag forwarding

The automated tests prove a forwarded flag reaches the child's argv. This manual check proves the flag actually takes effect in a real child - it requires pi-lens installed and a live model.

1. Launch pi in this repo with `pi --no-autofix`.
2. Ask it to dispatch a subagent that edits a Markdown file containing a loosely-formatted table (one that pi-lens autofix would normally re-pad).
3. Confirm the child leaves the table untouched, i.e. the child inherited `--no-autofix`.
4. As a control, repeat without `--no-autofix` and confirm the child DOES re-pad.

To disable forwarding entirely, set the `forwardParentFlags` setting above to `false`.
