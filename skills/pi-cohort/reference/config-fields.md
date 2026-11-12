# subagent field reference: `config`, call-time `control`, and child `settings`

Scope: management `config` (`action: create|update`), call-time `control`, and the child `settings` override. The execution-time `skill` override is documented in SKILL.md "Per-task overrides"; the last section below only contrasts it with management `skills` so the two are not confused.

## Management config (skills, plural)

These fields are written via `subagent({ action: "create" | "update", config })`; `skills` is plural here. This section also lists the call-time `control` overrides.
`config` may be an object or a JSON string. Presence of `steps` makes it a chain.
Scope (for `config`): this is the management create/update path (`parseStepList`), which accepts exactly the step fields below and requires `outputSchema` to be a file path; file-authored `.chain.md` chains support additional step fields (parallel, expand, collect, concurrency, failFast, worktree, acceptance, inline outputSchema) - see SKILL.md chain authoring.

### Agent config

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
| `skills` | string (csv) \| false | Skills injected into the agent (management config; execution-time per-task field is singular `skill`); false/"" clears. | none |
| `extensions` | string (csv) \| "" \| false | Extension list; "" means empty list, false clears. | inherit |
| `thinking` | string \| false | Thinking level; false/"" clears. | inherit |
| `settings` | object \| false | `settings.json` keys every child of this agent launches with; false clears. Read "Child settings override" below. | inherit |
| `inheritProjectContext` | boolean | Inject project AGENTS.md context. | per-agent default |
| `inheritSkills` | boolean | Inherit parent-visible skills. | per-agent default |
| `defaultContext` | `"fresh"` \| `"fork"` \| false | Default context mode; false/"" clears. | `"fresh"` |
| `output` | string \| false | Default output filename; false/"" clears. | none |
| `reads` | string (csv) \| false | Default files read before running; false/"" clears. | none |
| `progress` | boolean | Default progress.md tracking. | off |
| `maxSubagentDepth` | integer >= 0 \| false | Nested subagent depth cap; false/"" clears. | inherit |
| `completionGuard` | boolean | Enable completion guard for this agent. | inherit |

### Chain config

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
| `skills` | string[] \| false | Skills to inject into this step's agent (management config, plural); the execution-time `chain[].skill` param is singular. |
| `progress` | boolean | progress.md tracking. |
| `stopOn` | `{ path: string, in: string[] }` | End the chain after this step when the structured output at JSON Pointer `path` equals a member of `in`; supply `outputSchema`. Write to `.chain.md` as `stopOn: {"path":"/verdict","in":["FAIL"]}`. |

### Call-time `control` overrides

Pass per-call attention and runtime overrides as `subagent({ ..., control: {...} })`. Place `control` beside `tasks`/`chain`, not inside task items. Use the fields below even though the tool schema declares only `enabled` (`additionalProperties: true`). Supply valid values to override settings; let invalid values fall through to settings, then defaults (`resolveControlConfig`, `src/runs/shared/subagent-control.ts`).

| Field | Type | Meaning | Default |
|---|---|---|---|
| `enabled` | boolean | Toggle attention tracking. | `true` |
| `needsAttentionAfterMs` | integer >= 1 | No-activity window before `needs_attention`. | `60000` |
| `activeNoticeAfterMs` | integer >= 1 | Elapsed-ms threshold for the long-running notice. | `240000` |
| `inFlightSilenceCeilingMs` | integer >= 1 | Silent ms in-flight before escalation. | `600000` |
| `inFlightSilenceKillMs` | integer >= 1 | SIGTERM the child after this silent span (clamped above the needs-attention window). | `1800000` |
| `maxRuntimeMs` | integer >= 1 | Cap each child from its start regardless of activity (foreground only); treat expiry as a failure naming the cap, even with `enabled: false`. | `14400000` |
| `activeNoticeAfterTurns` | integer >= 1 | Notice by assistant turns. | off |
| `activeNoticeAfterTokens` | integer >= 1 | Notice by total tokens. | off |
| `failedToolAttemptsBeforeAttention` | integer >= 1 | Mutating-tool failures before `needs_attention`. | `3` |
| `notifyOn` | array of `"active_long_running"` \| `"needs_attention"` | Which events notify the parent. | both |
| `notifyChannels` | array of `"event"` \| `"async"` | Delivery channels. | both |

## Execution-time overrides (skill, singular)

Set `skill` (csv) on a top-level call, a `tasks[]` item, or a `chain[]` step to inject skills into that child for this dispatch; keep management edits in `config`.

| Field | Type | Meaning |
|---|---|---|
| `skill` | string (csv) | Inject skills into one child for this dispatch. |
| `label` | string | Set a single-call or `tasks[]` child label, or a sequential/static/dynamic chain task label, to render `<agent> - <label>` on live and result rows. Preserve item interpolation in dynamic template labels; keep a parallel group's own label on its group header. |

For the full per-task field list, see SKILL.md "Per-task overrides".

## Child settings override (`settings`)

Set `settings` to an object of `settings.json` keys to launch a child with those values in place of the parent's. Use any pi key or any extension's block; every key left out keeps the parent's value.

```
subagent({ tasks: [
  { agent: "worker", task: "one-shot job", settings: { contextPrune: { pruneOn: "next-prompt" } } },
  { agent: "worker", task: "job I will steer" }
] })
```

| Where | Applies to |
|---|---|
| top-level `settings` beside `agent` + `task` | that single child |
| `tasks[].settings`, `chain[].settings`, `chain[].parallel[].settings` | that one child; its siblings and the parent keep their settings |
| `chain[].parallel.settings` on a dynamic fanout step | every expanded child of the step |
| agent frontmatter `settings: {"key": value}` (JSON on one line), management `config.settings` | every launch of that agent |
| `subagents.agentOverrides.<name>.settings` in `settings.json` | every launch of that agent, when its frontmatter sets no `settings` |

Precedence per key, first defined wins:

| 1 | 2 | 3 |
|---|---|---|
| `settings` on the call | the agent's `settings` | the parent's agent-directory `settings.json` |

Objects merge key by key at every level; arrays and scalars replace.

Rules:

- Leave `defaultProjectTrust`, `httpProxy`, and `selfUpdateCommand` out: pi takes them only from the user's own `settings.json`, and the call fails before any child starts with `settings.<key> cannot be overridden for a child`.
- Put a key in the project's `.pi/settings.json` to pin it for every session in that project: pi merges project settings over the agent directory, so a project value beats this override.
- Repeat `settings` at each level of nesting: a child's own children launch with the parent's settings, not the child's override.
- Put an override that must survive `action: "resume"` in the agent's `settings`: a resumed child gets the agent's override, not the one from the original call.
- Write a local path in the parent's `settings.json` that climbs out of the agent directory (`../shared/ext.ts`) as an absolute path: pi resolves relative paths against the child's temporary directory.

The child runs with `PI_CODING_AGENT_DIR` set to a temporary agent directory: its `settings.json` is the merged file, every other entry links to the parent's directory, and it is removed when the child exits. `PI_SUBAGENT_BASE_AGENT_DIR` holds the parent's directory. The parent's `settings.json` is never written; a setting the child saves is discarded with the directory. A launch that cannot build the directory fails with `Cannot apply the child's settings override: <reason>`.
