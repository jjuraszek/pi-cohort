# Subagent dispatch: omitted model and thinking inherit the parent session

**Goal:** A `subagent` dispatch that names no model runs the child on the model and thinking level the parent session is running at dispatch time, on every dispatch path.

**Date:** 2026-09-24
**Status:** Draft, awaiting review

## Problem

When a dispatch omits `model:` and neither the agent frontmatter nor `subagents.agentOverrides.<agent>.model` sets one, the child pi receives no `--model` argument and picks its own model from `settings.defaultModel`. The parent session's live model is consulted only for its provider (`ctx.model?.provider`) to disambiguate a bare id the caller did supply; it never fills an absent model.

Observed: a parent switched to `github-copilot/gpt-6-astra` dispatched `spec-summarizer` with no model; the child ran on `kimi-k3` (the saved default) and hit the provider first-event timeout.

Where: every foreground path ends in `runSync` (`src/runs/foreground/execution.ts:686-691`), which builds candidates from `options.modelOverride ?? agent.model`; `resolveModelCandidate` (`src/runs/shared/model-fallback.ts:23-40`) returns `undefined` for an absent model and `buildPiArgs` (`src/runs/shared/pi-args.ts:82-106`) emits `--model` only for a truthy value. The async path (`src/runs/background/async-execution.ts:53,358,674`) snapshots only `currentModelProvider` and resolves the same way in-process before handing precomputed candidates to the detached runner.

The same gap exists for the thinking level: `applyThinkingSuffix` (`pi-args.ts:75-80`) appends `:<level>` only from the agent's `thinking` field and drops `off`; the parent's `ctx.thinkingLevel` is never forwarded, so a model-only agent falls to the child's saved default thinking level.

Consumer docs already promise the inheriting behavior: pi-gauntlet `skills/brainstorming/SKILL.md:204,210`, pi-gauntlet `doc/configuration.md:63`, pi-gauntlet `doc/personas.md:9` ("inherits the main loop"); this repo's `agents/delegate.md:3` ("inherits the parent model"). The code does not deliver it.

## Acceptance criteria

none - no ticket

## Design

### Resolution rule

Two independent fields, each resolved once per dispatch, first defined wins:

| Field | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| model | per-call `model:` (single, per-task, per-chain-step) | agent `model` after `agentOverrides` merge | parent `ctx.model` as `${provider}/${id}` | none - no `--model`, child pi uses its `defaultModel` |
| thinking | agent `thinking` after `agentOverrides` merge | parent `ctx.thinkingLevel` | none - no suffix | - |

`ctx.thinkingLevel` is the `ExtensionContext` property (pi `types.d.ts:230`, live getter); `getThinkingLevel()` is on `ExtensionAPI` and is not used. The parent model is used only when both `ctx.model.provider` and `ctx.model.id` are defined (test contexts pass `model: { provider }` alone).

No per-call thinking parameter exists and none is added. There is no sentinel for "use pi's default model": an explicit pin is the only way a child diverges from the parent.

The rule is applied at the model-resolution seams, not by generic parent-argv forwarding. `doc/specs/2026-07-19-forward-parent-cli-flags.md` excludes `--model` from forwarding; that exclusion stands.

### Thinking suffix

`applyThinkingSuffix` emits `:off` when the resolved thinking is `off` and appends nothing only when thinking is absent. Today it drops `off`, which lets the child pick its own default (pi `sdk.js:115-131`), so a parent at `off` would spawn a child at `high`. pi's `--model` parser accepts `:off`. This also applies to an agent-pinned `thinking: off`, which today silently means "child default".

`THINKING_LEVELS` in `src/shared/model-info.ts:1` and `src/runs/shared/pi-args.ts:9` gain `max` (pi's `ThinkingLevel` includes it); without it a per-call `gpt-6:max` under a parent at `high` becomes `gpt-6:max:high`, and `resolveEffectiveThinking` misreports a parent at `max`.

### Foreground

One seam: `RunSyncOptions` (`src/shared/types.ts:752-798`, next to `preferredModelProvider`) gains `parentModel?: string` (provider-qualified) and `parentThinking?: string`. `runSync` resolves `options.modelOverride ?? agent.model ?? options.parentModel` for `buildModelCandidates` (`execution.ts:686`) and `agent.thinking ?? options.parentThinking` once as the effective thinking, then passes that value to the three consumers that read `agent.thinking` today: `execution.ts:148` (native `buildPiArgs`), `src/runs/foreground/external-single-attempt.ts:82` (external backend `buildPiArgs`), and `src/runs/foreground/attempt-finalization.ts:110` (`result.model` reporting). `buildModelCandidates` applies the effective thinking to every candidate, including `fallbackModels`, as it applies `agent.thinking` today.

The four `runSync` callers set both fields from `ctx` where they already set `preferredModelProvider: ctx.model?.provider`: `subagent-executor.ts:1434` (parallel), `:1995` (single), `chain-execution.ts:280` (parallel-in-chain), `:1032` (sequential step). The pre-resolution in the executor and in `chain-execution.ts:232-233,983-984` stays as it is (it only turns supplied bare ids into full ids); the fall-through lives in `runSync` so no foreground path can miss it.

`ctx.model` is a live getter (`agent-session.js:2059 getModel: () => this.model`), so the value is the dispatch-time model, including a mid-session `/model` switch.

### Async

`AsyncExecutionContext` (`async-execution.ts:49-64`) gains `parentModel?: string` and `parentThinking?: string`. The five inline constructions in `subagent-executor.ts` (`:598` resume, `:981` top-level async, `:1171` chain clarify-to-background, `:1612` parallel clarify-to-background, `:1890` single clarify-to-background) are replaced by one builder that captures `currentModelProvider`, `parentModel`, `parentThinking` from `ctx`, so no site can omit a field.

Both in-process resolution sites (`async-execution.ts:358-371`, `:674-690`) resolve model as `override ?? agent.model ?? ctx.parentModel` and thinking as `agent.thinking ?? ctx.parentThinking`, and feed the resolved thinking to `resolveEffectiveThinking` and to the candidate suffix map. The detached runner (`subagent-runner.ts`) consumes precomputed candidates and needs no change.

A running job keeps the values captured at dispatch; a later `/model` switch in the parent does not follow it. A resume (`action: "resume"`) is a fresh spawn and inherits the parent's then-current model and thinking when the agent is unpinned, replacing the model recorded in the child's session; a pinned agent resumes on its pin as today.

### Chain clarify

`chain-clarify.ts:395-402` shows `default` for a step with no model and refuses the thinking selector until a model is chosen (`:643-646`). It seeds the effective model and thinking from the inherited values, so the confirmation screen shows what will run and thinking is editable.

### `agentOverrides` `false`

For builtins, `model: false` / `thinking: false` clear the frontmatter value (`src/agents/agents.ts:558,562`); the cleared agent then inherits. For user and project agents, `applyCustomAgentOverride` (`agents.ts:635-646`) only fills fields the frontmatter left unset, so `false` cannot clear a frontmatter pin; the frontmatter is the author's pin and is edited directly. That contract is unchanged (pi-gauntlet `doc/personas.md:35` documents it).

### Nested dispatch

A child's own `ctx.model` and `ctx.thinkingLevel` are its inherited values, so grandchildren inherit transitively with no extra code.

### Edge cases

| Case | Behavior |
|---|---|
| `ctx.model` undefined or without `id` (SDK host, minimal test context) | model step 3 skipped; identical to today |
| `ctx.thinkingLevel` undefined | no suffix unless the agent pins one |
| parent model not available to the child (missing key, or the provider comes from an extension the child does not load because the agent sets `extensions:` and `buildPiArgs` emits `--no-extensions`) | child fails as an explicitly pinned unknown model does today; agent `fallbackModels` apply unchanged |
| builtin `agentOverrides.<agent>.model: false` / `thinking: false` | clears the pin; the agent then inherits |
| custom agent with a frontmatter pin and override `false` | pin stays (unchanged) |
| bare id supplied (per-call or agent) | unchanged: `currentModelProvider` disambiguates; inheritance never runs |
| agent pins `model` but no `thinking`, parent on `xhigh` | child gets `<pinned>:xhigh`; pi clamps unsupported levels |
| per-call `gpt-6:low`, parent `high` | suffix already present, keeps `low` |
| parent thinking `off` | child gets `<model>:off` |
| parent thinking `max` | child gets `<model>:max`; status reports `max` |

No new error path or warning.

## Out of scope

- A settings key to opt out of inheritance.
- A per-call `thinking` parameter.
- Changing `applyCustomAgentOverride` so `false` clears a custom frontmatter pin.
- Any pi-gauntlet code or doc change; its existing wording becomes accurate.
- Following a parent `/model` switch into an already-running async job.

## Tests

Existing files, mock child processes, no live model. New executor-level cases go through `createSubagentExecutor` with a ctx exposing `model: { provider, id }` and `thinkingLevel`; `makeMinimalCtx` (`test/support/helpers.ts:102-115`) is extended with both.

- `test/integration/single-execution.test.ts`: model-free agent, omitted `model:`, parent `github-copilot/gpt-6` at `high` -> child argv contains `--model github-copilot/gpt-6:high`; parent model undefined -> no `--model`; per-call and agent models still win; agent `thinking: "low"` beats parent `high`; parent `off` -> `:off`; parent `max` -> `:max`; per-call `gpt-6:max` under parent `high` stays `gpt-6:max`.
- `test/integration/parallel-execution.test.ts` and `test/integration/chain-execution.test.ts`: the model-free inheritance case for `tasks`, sequential chain steps, and parallel-in-chain groups.
- `test/integration/foreground-external-execution.test.ts`: external backend argv carries the inherited model and thinking.
- `test/integration/async-execution.test.ts`: the model-free case through top-level async and resume, asserting the snapshot carries `parentModel`/`parentThinking` and the stored step candidates (including fallbacks) reflect them.
- `test/unit/pi-args.test.ts`: `applyThinkingSuffix` emits `:off`; `max` is a recognized suffix.
- `test/unit/agent-overrides.test.ts`: builtin `model: false` and `thinking: false` yield an agent with the field unset; the existing custom-agent frontmatter-wins cases stay green.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (lines 23, 31, 83 "your current Pi default model" -> "the parent session's current model and thinking level"; the resolution table above placed once under "Changing a builtin agent's model"; line 172 `thinking` row: unset means the parent session's level, `off` is emitted), `doc/configuration.md` (lines 71-79: one clause stating `--model` stays excluded from flag forwarding because inheritance is explicit resolution, pointing at the precedence list), `CHANGELOG.md` `## [Unreleased]` (behavior change; migration: pin `subagents.agentOverrides.<agent>.model` to keep a child on a fixed model; note the cost shift and the `extensions:`-provider failure mode)
- Derived / memory docs invalidated: none

Guideline: `reference/documentation-impact.md`.

## Open questions

none
