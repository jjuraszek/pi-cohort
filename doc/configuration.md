# Configuration

`pi-cohort` reads optional JSON config from `<PI_CODING_AGENT_DIR>/extensions/pi-cohort/config.json`. Back to [README](../README.md).

## `PI_CODING_AGENT_DIR`

Environment variable that relocates the **pi profile root** (where user agents, chains, settings, extension config, run history, and artifacts live). Resolution:

| Value | Resolves to |
|---|---|
| unset | `~/.pi/agent` |
| `~` | home directory |
| `~/sub/dir` | `<home>/sub/dir` |
| absolute/relative path | used as-is |

Setting it moves the `<PI_CODING_AGENT_DIR>/agents`, `/chains`, `/settings.json`, etc. roots. It is **not a discovery sandbox**: the global `~/.agents` root is always scanned as the lowest-priority user layer regardless of this variable, and project roots (`<repo>/.agents`, `<repo>/.pi/agents`) are always scanned relative to the workspace. To fully isolate discovery you must also avoid populating `~/.agents`.

## `asyncByDefault`

```json
{ "asyncByDefault": true }
```

Makes top-level calls use background execution when the request does not explicitly set `async`. Callers can still force foreground with `async: false` unless `forceTopLevelAsync` is enabled.

## `forceTopLevelAsync`

```json
{ "forceTopLevelAsync": true }
```

Forces depth-0 single, parallel, and chain runs into background mode and bypasses clarify UI by forcing `clarify: false`. Nested calls keep their own inherited settings.

## `parallel`

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

`maxTasks` defaults to `8`; `concurrency` defaults to `4`. Per-call `concurrency` takes precedence.

## `defaultSessionDir`

```json
{ "defaultSessionDir": "~/.pi/agent/sessions/subagent/" }
```

Session directory precedence is: `params.sessionDir`, then `config.defaultSessionDir`, then a directory derived from the parent session. Sessions are always enabled.

## `maxSubagentDepth`

```json
{ "maxSubagentDepth": 1 }
```

Controls nested delegation when no inherited `PI_SUBAGENT_MAX_DEPTH` is already in effect. Per-agent `maxSubagentDepth` can tighten the limit for that agent's child runs, but cannot relax an inherited stricter limit. This applies even to children that explicitly declare `tools: subagent`; at the cap, execution fanout is blocked instead of silently hiding nested work. See [orchestration-patterns.md](orchestration-patterns.md#recursion-guard) for the runtime recursion guard this backs.

## `showRosterOnStart`

```json
{ "showRosterOnStart": false }
```

At each interactive session start, prints a `[Subagents]` roster into chat listing discovered persona names grouped by effective scope (`builtin` / `user` / `project`) plus any `chains`, mirroring pi's own `[Skills]` / `[Prompts]` / `[Themes]` startup banner. Names are deduped by precedence: a persona shadowed by a higher scope (project > user > builtin) is listed only once, in its effective scope. Defaults to enabled; set to `false` to suppress. No effect in non-interactive (headless/child) runs.

## `intercomBridge`

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

Controls whether subagents receive runtime intercom coordination instructions and whether `intercom` and `contact_supervisor` are auto-added to their tool allowlist when needed.

Fields:

- `mode`: default `always`; use `fork-only` to inject only for forked runs, or `off` to disable the bridge.
- `instructionFile`: optional Markdown template replacing the default bridge instructions. `{orchestratorTarget}` is interpolated. Relative paths resolve from `~/.pi/agent/extensions/pi-cohort/`.

Bridge activation also requires `pi-intercom` to be installed and enabled through `pi install npm:pi-intercom` or a legacy local extension checkout, a targetable current session name or fallback alias, and `pi-intercom` in any explicit agent `extensions` allowlist.

The default injected guidance tells children to use `contact_supervisor` with `reason: "need_decision"` when blocked or needing a decision, `reason: "progress_update"` only for meaningful blocked/progress updates, generic `intercom` as fallback plumbing, and avoid routine completion handoffs. See [skills-and-companions.md](skills-and-companions.md#optional-pi-intercom-companion).

## `worktreeSetupHook`

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

The hook runs once per created worktree. Paths must be absolute, `~/...`, or repo-relative; bare command names are rejected.

stdin is a JSON object with `repoRoot`, `worktreePath`, `agentCwd`, `branch`, `index`, `runId`, and `baseCommit`. stdout must be one JSON object, for example:

```json
{ "syntheticPaths": [".venv", ".env.local"] }
```

`syntheticPaths` must be relative to the worktree root. They are removed before diff capture so helper files do not pollute patches. Tracked files are never excluded; marking a tracked path as synthetic fails setup. Default timeout is `30000` ms. See [orchestration-patterns.md](orchestration-patterns.md#worktree-isolation).
