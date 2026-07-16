# Top-level subagent artifacts are opt-in

## Context

GitHub issue [#1](https://github.com/jjuraszek/pi-cohort/issues/1) identifies an unsafe difference between top-level and chain execution. Agent frontmatter may define `output` and `defaultProgress` because chains run inside an isolated `chainDir`, but top-level relative paths resolve against the caller's working directory. An omitted top-level option can therefore create files such as `context.md`, `plan.md`, or `progress.md` without call-site intent. Parallel tasks can also target the same inherited `progress.md`.

The change intentionally narrows inheritance at the top-level boundary. It does not relocate artifacts or alter the chain artifact model.

## Goals

- Make top-level output and progress files deterministic, explicit opt-ins enforced by extension code.
- Apply the same contract to foreground, async, single, parallel, and `clarify: true` top-level calls.
- Preserve explicit output paths, `output: true`, `progress: true`, and both false hard-disables.
- Preserve `defaultReads` inheritance.
- Preserve all user-authored chain output, progress, and read inheritance.
- Document the compatibility break and migration action for custom callers.

## Non-goals

- No new top-level artifact directory, retention policy, cleanup rule, output provenance, per-task namespace, or result metadata.
- No change to debug artifacts, session logs, async status, child result text, or artifact-directory selection for explicitly enabled files.
- No warning period or automatic migration for callers that relied on omitted top-level fields.
- No change to relative or absolute path resolution.
- No change to agent frontmatter schema.
- No attempt to prevent a child model from using an explicitly granted write tool when its task or prompt directs a write. This change controls extension-managed output/progress artifacts, not arbitrary model tool use.

## Behavioral contract

### Top-level single calls

| Caller value | Normalized internal value | Effective output behavior |
|---|---|---|
| omitted or `undefined` | `false` | Return inline; do not create the agent-default output file |
| empty or whitespace-only string | `false` | Return inline; do not create an output file |
| `false` | `false` | Hard disable |
| `true` | configured filename, or `false` when absent | Use the selected agent's configured output filename |
| explicit non-empty path | unchanged string | Use the path with existing resolution semantics |

`null` is invalid under the tool schema and is not normalized. If `output: true` is passed for an agent without a configured output filename, no filename is invented and no output file is written.

Top-level single calls do not expose a progress option, so progress behavior changes only for parallel tasks.

### Top-level parallel tasks

Each task is resolved independently.

| Caller value | Effective behavior |
|---|---|
| `output` omitted | Do not create the agent-default output file |
| `output: false` | Hard disable output |
| `output: true` | Use that task's agent-configured output filename |
| explicit output path | Use the path with existing resolution semantics |
| `progress` omitted | Do not inherit `defaultProgress`; do not create `progress.md` |
| `progress: false` | Hard disable progress |
| `progress: true` | Enable existing progress behavior |
| `reads` omitted | Continue inheriting `defaultReads` |

Mixed parallel calls are valid: selected tasks may opt in while adjacent omitted tasks remain artifact-free.

### Clarify behavior

Top-level `clarify: true` receives concrete resolved behaviors: inherited top-level output is `false`, and inherited top-level parallel progress is `false`, never `undefined`. Single mode renders output as disabled. Parallel mode renders output and progress state for every task.

The single and parallel output editor operates on a concrete path. When disabled output has an agent-configured filename, opening the editor seeds that filename as the suggested value; accepting it returns the filename string, not a `true` override. Without a configured filename, the user must enter a path. In parallel mode, output editing applies to the selected task, and the progress key toggles only the selected task. Footer hints expose both controls.

A user edit is explicit intent for the current invocation only. Accepting the initial state does not create agent-default output or progress files. Canceling clarification retains existing cancellation behavior.

This is deterministic TypeScript enforcement, not a prompt instruction or polite request to the child model. Agent frontmatter alone cannot cause an extension-managed top-level output or progress write.

### Chains

User-authored sequential steps, static parallel groups, and dynamic fanout bypass top-level normalization. Their existing precedence remains:

1. step or task override;
2. agent frontmatter default;
3. disabled or absent fallback.

The existing `resolveStepBehavior` and `resolveParallelBehaviors` contracts remain unchanged.

## Architecture

Introduce a top-level request-normalization boundary before execution branches into foreground, async, or clarify handling. The boundary distinguishes omission from explicit opt-in without mutating agent definitions or changing shared chain resolution.

For single calls, normalization maps omitted, undefined, empty, and whitespace-only output to `false`; resolves `output: true` against the selected agent configuration; and preserves explicit non-empty paths and false. Both foreground and async single execution consume that concrete false-or-string value.

For parallel calls, normalization maps only omitted output and progress fields to explicit `false`. Explicit values remain unchanged. Reads are never mapped to false by this policy: an omitted reads field remains absent so the existing resolver continues inheriting `defaultReads`.

Normalization occurs before clarify opens. The clarified or direct normalized request then feeds execution, preventing foreground, async, and TUI paths from implementing different defaults.

Async top-level parallel execution may continue converting tasks into a synthetic one-step chain and invoking `executeAsyncChain` with `resultMode: "parallel"`. Explicit false values survive the existing step resolver and prevent agent output/default-progress inheritance. Real chains do not cross the top-level normalization boundary and remain unaffected.

## Components and responsibilities

### Top-level output normalization

`src/runs/shared/single-output.ts` owns existing explicit-value canonicalization, but the top-level boundary is its caller. `runSinglePath` and `runAsyncPath` must not prefill omission from `agentConfig.output`. They resolve top-level intent once into `false` or a concrete path before foreground, async, or clarify branching. Any downstream canonicalization receives only false or a path and is idempotent; it must not restore an agent default.

### Top-level dispatcher

`src/runs/foreground/subagent-executor.ts` owns the top-level boundary:

- `runSinglePath` must not substitute `agentConfig.output` for omitted caller output.
- `runAsyncPath` must pass the same normalized single value into async execution.
- `runParallelPath` must encode omitted task output/progress as false before behavior resolution and before constructing `ChainClarifyComponent`.
- The async-parallel task conversion must carry normalized values into the synthetic chain.
- Reads must remain absent when omitted.

Normalization must happen before any mode-specific branch that could reintroduce defaults. It must not mutate shared `AgentConfig` objects. Because the dispatcher uses `AgentConfig` only as a type, its import is normalized to a type-only import in the touched module.

### Clarify UI

`src/runs/foreground/chain-clarify.ts` must support the enforced top-level state instead of relying on chain-only controls. Its parallel renderer displays per-task writes/progress, `w` edits the selected task's output, and `p` toggles the selected task's progress. `BehaviorOverride.output` remains `string | false`: a clarify opt-in resolves `true` intent to a concrete configured filename before returning the override. Single mode uses the same configured-filename suggestion when editing disabled output.

### Tool contract

`src/extension/schemas.ts` must describe top-level output as opt-in, include boolean `true` as selecting the agent-configured filename, and state that omitted top-level parallel progress is disabled. Chain-specific schema descriptions retain inheritance language where applicable. This in-band contract lets an orchestrating model discover the enforced API without relying on persona instructions.

### Existing behavior resolvers

`src/shared/settings.ts` remains the source of truth for chain behavior resolution. Its global inheritance semantics are not changed. Top-level parallel tasks block output/progress inheritance by arriving with explicit false values; absent reads still inherit.

### Async execution

`src/runs/background/async-execution.ts` may continue using `resolveStepBehavior` for real and synthetic chains. The synthetic top-level caller supplies normalized overrides; real chain callers supply their existing step definitions.

### Reviewer persona

`agents/reviewer.md` must stop instructing consumer repositories to ignore repo-local `progress.md`. Progress files are no longer implicit at top level. Any replacement guidance must state that callers enable progress deliberately when they need it.

## Request flow

1. Validate the top-level request and resolve selected agents as today.
2. Normalize top-level filesystem-writing intent from caller-provided fields.
3. Leave omitted reads absent.
4. If clarification is enabled, present the normalized state and treat accepted edits as explicit invocation values.
5. Send the resulting state to foreground or async execution.
6. Continue using existing behavior resolution, output path resolution, progress handling, and file writers.
7. Return child result text inline unless `outputMode: "file-only"` is validly paired with an enabled output path.

For async parallel work, step 5 may package normalized tasks into a synthetic chain. Because omission has already become explicit false for output/progress, chain resolution cannot restore those defaults.

## Error handling and edge cases

- Normalization introduces no new runtime error class.
- Invalid agents, malformed requests, invalid paths, write failures, and async runner failures retain existing validation and reporting.
- The normalizer does not catch or downgrade artifact-write errors after an explicit opt-in.
- Explicit relative and absolute paths retain current base-directory, parent-directory, and safety behavior.
- Concurrent tasks explicitly targeting the same path retain current collision behavior. No locking, namespacing, overwrite prevention, or conflict error is added.
- Disabling output affects only the saved response file. It does not suppress inline child results.
- Disabling progress affects only progress-file creation. It does not affect async status, control monitoring, run logs, or execution.
- Clarify cancellation does not execute the request.
- `output: true` without an agent-configured filename remains a no-write case rather than inventing a global filename.

## Compatibility and migration

This is an intentional compatibility break for custom agents and callers that depended on omitted top-level `output` or `progress` inheriting frontmatter defaults.

Callers migrate by adding one of:

- `output: true` to use the selected agent's configured filename;
- `output: "path/to/file.md"` for an explicit path;
- `progress: true` on a top-level parallel task;
- a deliberate enablement through top-level clarify UI.

No migration is needed for chains, explicit false values, explicit paths, explicit true values, or omitted reads.

`outputMode: "file-only"` with omitted top-level output becomes an error because no output path exists. Such callers must add `output: true` or an explicit path. Count-replicated tasks and multiple tasks using the same agent must use distinct explicit output paths when saving concurrently; `output: true` resolves them to the same configured filename and retains the existing duplicate-path rejection.

## Testing approach

### Unit coverage

Extend `test/unit/single-output.test.ts` to retain the explicit-value truth table, including omitted/undefined and empty-string cases. Because the existing helper already canonicalizes undefined, add call-site regression coverage with an agent configured as `output: "default.md"`; assert that `runSinglePath` and `runAsyncPath` resolve omission to false rather than prefilling the configured filename.

Add focused parallel normalization coverage for:

- omitted output and progress becoming false;
- `output: true` resolving per selected agent;
- explicit output paths and false values remaining unchanged;
- explicit progress booleans remaining unchanged;
- omitted reads remaining absent.

### Foreground integration coverage

Cover:

- single run with configured agent output and omitted top-level output;
- single run with `output: true`;
- explicit relative and absolute single output paths;
- parallel tasks with configured output/default-progress and omitted fields;
- explicit output/progress opt-in;
- omitted reads inheriting `defaultReads`;
- mixed parallel tasks where only selected tasks opt in;
- concurrent top-level runs producing no inherited output/progress files.

### Async integration coverage

Mirror omitted and explicit cases for async single and parallel execution. The parallel case must exercise the synthetic-chain path and prove that omitted output/progress produce neither save/progress instructions nor files while default reads still apply.

### Clarify coverage

Verify the initial state passed to `ChainClarifyComponent` uses `output: false` and `progress: false`, explicit caller values remain selected, and accepting the initial state produces no inherited artifact. Cover single and parallel rendering, configured-filename seeding, selected-task output editing, selected-task progress toggling, returned concrete overrides, and execution of accepted edits.

### Chain regression coverage

Assert that omitted sequential chain steps and chain-parallel tasks still inherit agent output, `defaultProgress`, and `defaultReads`. These tests guard against changing shared resolver behavior globally.

### Assertions and verification

Tests inspect both generated child-task instructions and filesystem effects. A disabled case requires no save/progress instruction and no target file. An enabled case requires the expected resolved path and content.

Canonical verification:

```bash
env -u PI_CODING_AGENT_DIR npm run test:all
```

## Documentation impact

The materiality decision follows `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md`; `doc/programmatic-api.md`; `CHANGELOG.md`
- Derived / memory docs invalidated: none

`doc/agents-and-chains.md` currently calls `output` the "Default single-agent output file" and `defaultProgress` "Maintain progress.md" without distinguishing top-level and chain scope. It must state that top-level output/progress require explicit invocation intent while chain steps retain inherited defaults. `doc/programmatic-api.md` must list top-level output as disabled by default, document `output: true`, distinguish parallel progress from reads inheritance, and describe clarify's initial state. `CHANGELOG.md` must disclose the compatibility break and migration action.

No new standalone documentation file is justified. No router, index, `README.md`, `AGENTS.md`, or topic-guide amendment is required. `src/extension/schemas.ts` and `agents/reviewer.md` are executable implementation surfaces rather than documentation-impact entries.

In `agents/reviewer.md`, replace the repo-ignore instruction with: "Top-level progress files exist only when the caller explicitly enables them. Do not ask consumer repositories to add cohort scratch files to `.gitignore`." Keep `defaultReads: plan.md, progress.md` because chains depend on those inputs and `defaultReads` is explicitly unchanged; missing top-level files retain existing missing-read behavior.

## Acceptance criteria

1. Foreground and async top-level single calls with omitted output do not create an agent-default output file.
2. Foreground and async top-level parallel calls with omitted output/progress do not create agent-default output or progress files.
3. Top-level clarify receives concrete false defaults, renders per-task output/progress state, and executes selected-task user opt-ins as concrete overrides.
4. `output: true` uses the selected agent's configured filename and existing mode-specific base directory.
5. Explicit relative and absolute output paths retain current behavior.
6. Explicit `progress: true` retains current behavior.
7. `output: false` and `progress: false` remain hard disables.
8. Omitted top-level reads continue inheriting `defaultReads`.
9. User-authored chain output, progress, and read inheritance remains unchanged.
10. Regression coverage includes foreground/async single and parallel paths, clarify defaults, mixed tasks, and concurrent top-level runs.
11. Current-behavior documentation states that top-level artifacts are opt-in and provides migration instructions.
12. The reviewer persona no longer tells consumer repositories to ignore cohort scratch files.
