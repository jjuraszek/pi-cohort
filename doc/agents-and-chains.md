# Agents and chains

Reference for authoring, overriding, and discovering pi-cohort agents and saved
chains. Back to [README](../README.md).

## Builtin agents in plain English

| Agent | Use it when you want... |
|---|---|
| `scout` | Fast local codebase recon: relevant files, entry points, data flow, risks, and where another agent should start. |
| `planner` | A concrete implementation plan from existing context. It should read and plan, not edit code. |
| `worker` | Implementation work, including approved oracle handoffs. It edits files, validates, and escalates unapproved decisions instead of guessing. |
| `reviewer` | Code review and small fixes. It checks the implementation against the task/plan, tests, edge cases, and simplicity. |
| `context-builder` | A stronger setup pass before planning: gathers code context and writes handoff material such as `context.md` and `meta-prompt.md`. |
| `oracle` | A second opinion before acting. It challenges assumptions, catches drift, and recommends the safest next move without editing. |
| `delegate` | A lightweight general delegate when you want a child agent that behaves close to the parent session. |

A simple rule of thumb: use `scout` before you understand the code, `planner` before a bigger change, `worker` to implement, `reviewer` to check, and `oracle` when the decision itself feels risky.

## Changing a builtin agent's model

Builtin agents inherit your current Pi default model by default. This keeps new installs from depending on a provider you may not have configured. If you want a role to use a specific model, set an override instead of copying the bundled agent file.

For one run, put the override in the command:

```text
/run reviewer[model=anthropic/claude-sonnet-4:high] "Review this diff"
```

For a persistent override, edit settings. This example pins the reviewer everywhere, adds a backup model for provider failures, and keeps the other builtins on your normal default model:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

Use `~/.pi/agent/settings.json` for a user override or `.pi/settings.json` for a project override. The same `agentOverrides` block can change `tools`, `skills`, inherited context, prompt text, or disable a builtin. If you want a totally different agent, create a user or project agent with the same name; for normal tweaks, prefer overrides.

## Agents and chains: discovery and precedence

Agents are markdown files with YAML frontmatter and a system prompt body. They define the specialist that will run in the child Pi process.

Agent locations, lowest to highest priority:

| Scope | Path |
|---|---|
| Builtin | `<agent-dir>/extensions/pi-cohort/agents/` |
| User (global) | `~/.agents/*.md` |
| User (pi profile) | `<PI_CODING_AGENT_DIR>/agents/*.md` |
| Project (legacy) * | `<level>/.agents/*.md` |
| Project (preferred) * | `<level>/.pi/agents/*.md` |

\* Project roots are discovered at every level from cwd up to the git root, not just the repo root - see the walk description below.

Discovery reads each root **flat** (top-level `*.md` only), the two user roots are ordered `~/.agents < <PI_CODING_AGENT_DIR>/agents`, and `SKILL.md` is never loaded as an agent. See [AGENTS.md](../AGENTS.md).

`<PI_CODING_AGENT_DIR>` defaults to `~/.pi/agent` when the env var is unset (see [`PI_CODING_AGENT_DIR`](configuration.md#pi_coding_agent_dir)). Setting it relocates the pi profile root but does **not** sandbox discovery - `~/.agents` is always scanned as the lowest-priority user layer regardless.

Project agents are discovered by walking from cwd up to the git root and aggregating every level that contains `.pi` or `.agents`. Nearest level wins name collisions. When not inside a git repo, discovery falls back to the single nearest project root (no walk).

Discovery rules:

- **Flat only.** Only top-level `*.md` files in each root are loaded. Subdirectories (`skills/`, `chains/`, or any nesting) are never scanned for personas.
- **`SKILL.md` is excluded** by name - a skill manifest carries `name` + `description` frontmatter but is not an agent.
- **`.chain.md` / `.chain.json` files do not define agents.**
- **Collisions resolve by priority:** project levels are walked cwd -> git root; nearest level wins. Within a level, `.pi/agents` beats `.agents`. Any project level beats the user roots (`~/.agents`, `<PI_CODING_AGENT_DIR>/agents`).
- **Settings merge:** project `.pi/settings.json` `agentOverrides` and `disableBuiltins` merge across all walked levels, nearest wins. Override and create writes target the nearest project root.

Use `agentScope: "user" | "project" | "both"` to control discovery; `both` is the default and project definitions win runtime-name collisions.

Builtin agents load at the lowest priority, so a user or project agent with the same name overrides them. They do not pin a provider model; they inherit your current Pi default model unless you set `subagents.agentOverrides.<name>.model`. `oracle` is an advisory reviewer that critiques direction and proposes an execution prompt without editing files. `worker` is the implementation agent for normal tasks and approved oracle handoffs.

## Builtin overrides

You can override selected builtin fields without copying the whole agent. Overrides live in settings:

- User: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Example:

```json
{
  "subagents": {
    "agentOverrides": {
      "reviewer": {
        "inheritProjectContext": false
      }
    }
  }
}
```

Supported override fields are `model`, `fallbackModels`, `thinking`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `disabled`, `skills`, `tools`, `toolsPrepend`, `toolsAppend`, and `systemPrompt`. Use `defaultContext: false` in builtin overrides to clear an inherited context default. Project overrides beat user overrides.

`toolsPrepend` and `toolsAppend` add tools around the agent's effective `tools` list without requiring you to restate the full list. The resolved order is `toolsPrepend + tools + toolsAppend`, with first-occurrence dedupe. They apply to both builtin and custom agents. For custom agents they compose around the frontmatter `tools` value whether or not it is set. Only the winning override scope (project beats user) is applied -- additive fields do not layer across scopes.

```json
"agentOverrides": { "scout": { "toolsPrepend": ["some_extension_tool"] } }
```

Set `disabled: true` to hide a builtin from runtime discovery and agent-facing `subagent({ action: "list" })` output. For bulk control, set `subagents.disableBuiltins: true` in settings.

## Prompt assembly

Subagents are designed to be narrow by default. Custom agents start with a clean system prompt and only the context you intentionally give them. They do not automatically inherit Pi's whole base prompt, project instruction files, or discovered skills catalog.

Use these fields when an agent should see more:

| Field | Effect |
|---|---|
| `systemPromptMode: append` | Append the agent prompt to Pi's normal base prompt. |
| `inheritProjectContext: true` | Keep inherited project instructions from files like `AGENTS.md` and `CLAUDE.md`. |
| `inheritSkills: true` | Let the child see Pi's discovered skills catalog. |
| `defaultContext: fork` | Use forked session context when a launch omits `context`; explicit `context: "fresh"` still wins. |

Builtin agents opt into project instruction inheritance by default so they follow repo-specific rules out of the box. `delegate` also uses append mode because its job is orchestration inside the parent workflow.

## Agent frontmatter

A typical agent looks like this:

```yaml
---
name: scout
# Optional: registers this as code-analysis.scout while preserving name: scout
package: code-analysis
description: Fast codebase recon
tools: read, grep, find, ls, bash
extensions:
model: claude-haiku-4-5
fallbackModels: openai/gpt-5-mini, anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash, chrome-devtools
output: context.md
defaultReads: context.md
defaultProgress: true
completionGuard: false
interactive: true
maxSubagentDepth: 1
---

Your system prompt goes here.
```

Important fields:

| Field | Notes |
|---|---|
| `package` | Optional package identifier. A file with `name: scout` and `package: code-analysis` registers as `code-analysis.scout`; serialization keeps `name` and `package` separate. |
| `tools` | Builtin tool allowlist for this agent. |
| `extensions` | Omitted means normal extensions; empty means no extensions; comma-separated values allowlist specific extensions. |
| `model` | Default model. Bare ids prefer the current provider when possible, then unique registry matches. |
| `fallbackModels` | Ordered backup models for provider/model failures such as quota, auth, timeout, or unavailable model. Ordinary task failures do not trigger fallback. |
| `thinking` | Appended as a `:level` suffix at runtime unless a suffix is already present. |
| `systemPromptMode` | `replace` by default; `append` keeps Pi's base prompt. |
| `inheritProjectContext` | Keeps or strips inherited project instruction blocks. |
| `inheritSkills` | Keeps or strips Pi's discovered skills catalog. |
| `defaultContext` | Optional `fresh` or `fork` launch context default for this agent. |
| `skills` | Injects specific skills directly, regardless of `inheritSkills`. |
| `output` | Default single-agent output file. |
| `defaultReads` | Files to read before running in chain/parallel behavior. |
| `defaultProgress` | Maintain `progress.md`. |
| `completionGuard` | Set `false` only for non-implementation agents that may mention implementation words while using mutation-capable tools such as `bash`. |
| `interactive` | Parsed for compatibility but not enforced in v1. |
| `maxSubagentDepth` | Tightens nested delegation for this agent's children. |

## Tool and extension selection

If `tools` is omitted, `pi-cohort` does not pass `--tools`, so the child gets Pi's normal builtin tools. If `tools` is present, regular tool names become an explicit allowlist. Path-like `tools` entries, such as extension paths or `.ts`/`.js` files, are treated as tool-extension paths rather than builtin tool names. Agents that declare only known read-only builtin tools skip the implementation completion guard, but `bash` and unknown tools stay mutation-capable. Use `completionGuard: false` for bash-enabled validators or advisors that should never be judged as implementation agents.

Examples:

- `tools` omitted and `extensions` omitted: normal builtins and normal extensions.
- `tools: read, bash`: only `read` and `bash` as builtins.
- `tools: subagent, read`: a child-safe `subagent` tool is available inside that child so it can run explicitly assigned nested fanout.

`extensions` controls child extension loading:

```yaml
# Omitted: all normal extensions load

# Empty: no extensions
extensions:

# Allowlist
extensions: /abs/path/to/ext-a.ts, /abs/path/to/ext-b.ts
```

When `extensions` is present, it takes precedence over extension paths implied by `tools` entries.

## Chain files

Chains are reusable workflows stored separately from agent files. Use `.chain.md` for simple sequential saved chains. Use `.chain.json` when a chain needs dynamic fanout.

| Scope | Path |
|---|---|
| User | `<PI_CODING_AGENT_DIR>/chains/*.chain.md`, `<PI_CODING_AGENT_DIR>/chains/*.chain.json` |
| Project * | `<level>/.pi/chains/*.chain.md`, `<level>/.pi/chains/*.chain.json` |

\* Aggregated across every level from cwd to the git root; nearest wins.

Chain roots are read **flat** (top-level `*.chain.md` / `*.chain.json` only), matching agent discovery in pi-cohort; nested subdirectories are not scanned. Project chains aggregate `<level>/.pi/chains` across the same git-root walk as agents, nearest level wins. If both `.chain.md` and `.chain.json` define the same parsed runtime chain name in the same scope, `.chain.json` wins. If user and project scopes define the same parsed runtime chain name, the project chain wins. Chains support the same optional `package` frontmatter as agents; `name: review-flow` plus `package: code-analysis` runs as `code-analysis.review-flow` (the package comes from frontmatter, not the directory).

Example:

```md
---
name: scout-planner
description: Gather context then plan implementation
---

## scout
phase: Context
label: Map auth flow
as: context
output: context.md

Analyze the codebase for {task}

## planner
phase: Planning
label: Implementation plan
reads: context.md
model: anthropic/claude-sonnet-4-5:high
progress: true

Create an implementation plan based on {outputs.context}
```

Each `.chain.md` `## agent-name` section is a step. Config lines such as `phase`, `label`, `as`, `outputSchema`, `output`, `outputMode`, `reads`, `model`, `skills`, and `progress` go immediately after the header. A blank line separates config from task text. In saved `.chain.md` files, `outputSchema` is a path to a JSON Schema file; direct tool calls and `.chain.json` files can pass the schema object inline.

For `output`, `reads`, `skills`, and `progress`, chain behavior is three-state: omitted inherits from the agent, a value overrides, and `false` disables.

Use `phase` to group related work in status output, `label` for a readable step name, and `as` to store a successful step or parallel task result for later `{outputs.name}` references. Duplicate `as` names, invalid identifiers, and unknown output references fail before child execution.

Dynamic fanout is available only through direct `subagent({ chain: [...] })` JSON or saved `.chain.json` files. It expands an array from a prior structured named output, runs one child template per item, and stores the ordered collection under `collect.as`. The source must be structured output; prose is never parsed. `expand.maxItems` is required, over-limit arrays fail, nested fanout and arbitrary expressions are not supported, and `.chain.md` has no dynamic syntax in this release.

```json
{
  "name": "dynamic-review",
  "description": "Find review targets, fan out reviewers, then synthesize.",
  "chain": [
    {
      "agent": "scout",
      "task": "Return {\"items\":[{\"path\":\"...\",\"reason\":\"...\"}]} via structured_output.",
      "as": "targets",
      "outputSchema": { "type": "object" }
    },
    {
      "expand": {
        "from": { "output": "targets", "path": "/items" },
        "item": "target",
        "key": "/path",
        "maxItems": 12
      },
      "parallel": {
        "agent": "reviewer",
        "label": "Review {target.path}",
        "task": "Review {target.path}. Reason: {target.reason}",
        "outputSchema": { "type": "object" }
      },
      "collect": { "as": "reviews" },
      "concurrency": 4
    },
    {
      "agent": "worker",
      "task": "Synthesize fixes from {outputs.reviews}"
    }
  ]
}
```

Create simple `.chain.md` chains by writing files directly or with the `subagent({ action: "create", config: ... })` management action. Create dynamic `.chain.json` chains by writing the JSON file directly. Run saved chains with natural language or:

```text
/run-chain scout-planner -- refactor authentication
```

## Chain variables

Task templates support:

| Variable | Description |
|---|---|
| `{task}` | Original task from the first step. |
| `{previous}` | Output from the prior step, or aggregated output from a parallel step. |
| `{chain_dir}` | Path to the chain artifact directory. |
| `{outputs.name}` | Text value from a prior step or completed parallel task with `as: "name"`. |

Parallel outputs are aggregated with clear separators before being passed to the next step:

```text
=== Parallel Task 1 (worker) ===
...

=== Parallel Task 2 (worker) ===
...
```
