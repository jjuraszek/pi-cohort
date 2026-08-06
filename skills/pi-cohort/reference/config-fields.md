# subagent `config` field reference

Fields accepted by `subagent({ action: "create" | "update", config: {...} })`.
`config` may be an object or a JSON string. Presence of `steps` makes it a chain.
Scope: this is the management create/update path (`parseStepList`), which accepts exactly the step fields below and requires `outputSchema` to be a file path; file-authored `.chain.md` chains support additional step fields (parallel, expand, collect, concurrency, failFast, worktree, acceptance, inline outputSchema) - see SKILL.md chain authoring.

## Agent config

| Field | Type | Meaning | Default |
|---|---|---|---|
| `name` | string | Required (create). Letters, numbers, spaces, hyphens. | - |
| `description` | string | Required (create). | - |
| `package` | string | Optional namespace; runtime name becomes `package.name`. | none |
| `scope` | `"user"` \| `"project"` | Where the definition file lands. | `"user"` |
| `systemPrompt` | string \| false | Persona body; false or "" clears. | `""` |
| `systemPromptMode` | `"append"` \| `"replace"` | How systemPrompt combines with the base prompt. | per-agent default |
| `model` | string \| false | Model override; false/"" clears. | inherit |
| `fallbackModels` | string (csv) \| string[] \| false | Models tried in order on failure; false/"" clears. | none |
| `tools` | string (csv) \| false | Tool allowlist; false/"" clears. MCP-direct tools rejected. | all |
| `skills` | string (csv) \| false | Skills injected into the agent; false/"" clears. | none |
| `extensions` | string (csv) \| "" \| false | Extension list; "" means empty list, false clears. | inherit |
| `thinking` | string \| false | Thinking level; false/"" clears. | inherit |
| `inheritProjectContext` | boolean | Inject project AGENTS.md context. | per-agent default |
| `inheritSkills` | boolean | Inherit parent-visible skills. | per-agent default |
| `defaultContext` | `"fresh"` \| `"fork"` \| false | Default context mode; false/"" clears. | `"fresh"` |
| `output` | string \| false | Default output filename; false/"" clears. | none |
| `reads` | string (csv) \| false | Default files read before running; false/"" clears. | none |
| `progress` | boolean | Default progress.md tracking. | off |
| `maxSubagentDepth` | integer >= 0 \| false | Nested subagent depth cap; false/"" clears. | inherit |
| `completionGuard` | boolean | Enable completion guard for this agent. | inherit |

## Chain config

Top-level: `name`, `description`, `package`, `scope` as above, plus required `steps` (non-empty array).

Per step:

| Field | Type | Meaning |
|---|---|---|
| `agent` | string | Required, non-empty. |
| `task` | string | Task template; defaults to `""`. |
| `phase` | string | Phase/group label. |
| `label` | string | User-facing label. |
| `as` | string | Identifier for `{outputs.name}` in later steps. |
| `outputSchema` | string | Schema FILE PATH (saved chains take a path, not an inline object). |
| `output` | string \| false | Output file path, or false to disable. |
| `outputMode` | `"inline"` \| `"file-only"` | Output return mode. |
| `reads` | string[] \| false | Files to read before the step. |
| `model` | string | Model override. |
| `skills` | string[] \| false | Skills to inject (NOTE: plural `skills` here, unlike the execution-time `skill` param). |
| `progress` | boolean | progress.md tracking. |
