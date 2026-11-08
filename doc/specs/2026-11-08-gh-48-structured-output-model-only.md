# Register the child `structured_output` tool as `model-only`

**Ticket:** [#48](https://github.com/jjuraszek/pi-cohort/issues/48)
**Goal:** A schema-bound child can call `structured_output` only directly, never from inside a codemode script, so the capture always comes through the path whose result can end the turn.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Framing:** kept

## Problem

A child run with an `outputSchema` registers a `structured_output` tool from the child-side prompt runtime (`src/runs/shared/subagent-prompt-runtime.ts`, the `registerTool` call in the schema branch of `registerSubagentPromptRuntime`). A direct call validates the value, writes `{ status: "success", value }` to the capture path, and returns `terminate: true`. The registration carries no `exposure`, so pi defaults it to `direct`, and pi's codemode extension builds its sandbox namespace from the callable set (`_getCallableTools` in `agent-session.js` returns `codemode`/`deferred` tools plus active `direct` ones; `execute.js` builds `tools.<name>` from that list). A script can therefore call `tools.structured_output({ value })`: the capture file is written, but `toScriptValue` in `execute.js` converts the nested result to text or structured content and drops `terminate`, so the script continues, the codemode call returns a normal result, and the model may take further turns after the value was already saved.

Pi 1.5.0 declares `ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden"` (`dist/core/extensions/types.d.ts`); `model-only` is "declared to the model while active, never callable" - it stays out of the callable set and so out of the sandbox namespace, while a direct call works unchanged. Pi's own codemode tool and pi-gauntlet's trackers register this way. Observed in this session: a script calling a `model-only` tool fails with `TypeError: tools.phase_tracker does not exist. Available: read, bash, ...` before any tool event fires.

Two premises from the ticket were corrected during the brainstorm and bind the outcome:

- A captured value does not unconditionally end the child's run. Pi ends a tool batch only when every finalized result in it carries `terminate: true` (`shouldTerminateToolBatch`, `pi-agent-core/dist/agent-loop.js:471-472`), and queued steering or follow-up messages can continue the run. The outcome this spec promises is script inaccessibility plus unchanged direct-call semantics, not a termination guarantee.
- The pi floor is already `>=1.5.0` at the worktree base `b5a9ba2` ("Raise the Pi floor to 1.5.0 and bump dev dependencies"): `package.json:66` reads `">=1.5.0"` (locked by `test/unit/package-manifest.test.ts:61-78`, which checks the peer range, dev dependencies, and lockfile) and `README.md:36` reads `Requires Pi >=1.5.0.` (not covered by that test; verified by reading the line). The ticket's fourth row is satisfied with no further edit; the reporter's conditional-exposure alternative (set the field only when the running pi supports it, keep the 1.3.0 floor) has nothing left to protect.

Framing: kept - the pi `exposure` field is the designed mechanism for "declared but never callable from a script" and the smallest change; the narrower-outcome point above is a Problem statement, not an alternative design.

## Acceptance criteria

Ticket #48, `## Acceptance Criteria`, rows verbatim:

- [ ] The child-side `structured_output` tool is registered with `exposure: "model-only"` (unit test over the registration object).
  in-scope
- [ ] In a child run with an output schema on pi >= 1.5.0, a script calling `tools.structured_output(...)` fails because the tool is not in the script's `tools` namespace, while a direct `structured_output` call from the same child saves the value (child-run test on the local pi install).
  in-scope
- [ ] A direct `structured_output` call still saves the value and its result carries `terminate: true` (existing tests unchanged).
  in-scope
- [ ] `package.json`'s pi peer range and the README's pi floor both read `>= 1.5.0`.
  in-scope - already satisfied at the worktree base; no edit. Proof: the existing `test/unit/package-manifest.test.ts:61-78` locks the `package.json:66` peer range; the README half is a read-only check of `README.md:36` for `Requires Pi >=1.5.0.`.

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-48-structured-output-model-only
contract:
- create: git worktree add <home> -b <branch>
- destroy: git worktree remove <home> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `env -u PI_CODING_AGENT_DIR npm run test:unit`; `npm run test:integration`; `npm run test:all` before ship (run in the worktree)
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .agents/skills/release/SKILL.md
Rules: .pi/gauntlet-overrides.md
scope: AC 1, AC 2, AC 3, AC 4
design: owns `src/runs/shared/subagent-prompt-runtime.ts`, `test/unit/subagent-prompt-runtime.test.ts`, `test/integration/structured-output-model-only.test.ts`, `test/integration/fixtures/structured-output-model-only/` (persona `.md` plus scripted provider), `doc/agents-and-chains.md`, `CHANGELOG.md`; observable outcomes: a scripted `tools.structured_output` call fails with the sandbox TypeError (visible as a codemode tool result in the child's session file) and writes no capture, a direct call captures and returns `terminate: true`.

## Design

Remove: none.

Add:

- `exposure: "model-only"` on the `structured_output` `registerTool` call in `src/runs/shared/subagent-prompt-runtime.ts`.
- An `exposure?: ToolExposure` member on the narrowed `registerTool` parameter type in the same file (the local type at the `pi: { registerTool(...) }` shape, currently `name`, `label`, `description`, `parameters`, `execute`), importing the `ToolExposure` type from `@earendil-works/pi-coding-agent`.
- One unit test in `test/unit/subagent-prompt-runtime.test.ts`, `registered structured_output tool is declared model-only`, asserting the captured registration object carries `exposure: "model-only"`; the test file's mock `registerTool` option type widens to capture `exposure`.
- One real-child integration test, `test/integration/structured-output-model-only.test.ts`, with two fixtures under `test/integration/fixtures/structured-output-model-only/`: a persona `.md` (frontmatter `tools: codemode`, `extensions:` pointing at the provider, `model:` the scripted provider's model id, as `fanout-child-inherit-extensions/worker.md` does) and the scripted provider. The harness follows `fanout-child-inherit-extensions.test.ts` (resolve the package bin, isolate `HOME`/profile, prepend `PI_TEST_PI_BIN_DIR` or `node_modules/.bin`, install the provider as a child extension) and dispatches through the existing `tool.execute(...)` as `chain: [{ agent: "<fixture-persona>", task: "<fixture-task>", outputSchema: <schema> }]` - the schema-bound runtime binds only through a chain step's `outputSchema` (`chain-execution.ts`), and the child's tool allowlist comes from the persona, not the dispatch; that pair is what `buildPiArgs` turns into `--tools codemode,structured_output`. The provider's turn 1 emits a `codemode` call with arguments `{ code: "return await tools.structured_output({ value: <schema-valid value> })" }`; turn 2 emits a direct `structured_output` call with arguments `{ value: <same value> }` when the turn-1 result text contains `does not exist`, otherwise a `FIXTURE_UNEXPECTED: <turn-1 result>` text reply (a fixture diagnostic for a reviewer reading a failure, not the acceptance observable). The test asserts: the child exits 0; the returned structured output equals the value; and, reading the child's retained session file (the result's `sessionFile`, set by `execution.ts:927-928` from the executor's `sessionFileForIndex` and kept through compaction), the codemode tool result reports `tools.structured_output does not exist` and precedes a direct `structured_output` tool call and its result. Exit 0 and value equality alone also pass when the script call wrongly writes the capture, and the parent-visible output (`compactForegroundResult` drops `messages`; a chain step's output text is the structured value) never carries the codemode error, so the session-file read is the discriminating observation.
- One `[Unreleased]` line in `CHANGELOG.md`.
- One sentence in the structured-output paragraph of `doc/agents-and-chains.md` (the paragraph beginning "With `outputSchema`, a normal prose-only completion ...", around line 259): the tool is `model-only` - the model calls it directly, never from a codemode script, where it is absent from `tools`.

Data flow after the change: the child starts with `--tools <persona tools>,structured_output`. Pi declares `structured_output` to the model (it is active and `model-only` counts as declared, `agent-session.js:2975`) and excludes it from the callable set (`agent-session.js:1175-1180`), so the codemode sandbox has no `tools.structured_output` member. A script calling it throws `TypeError: tools.structured_output does not exist` inside the sandbox (pi may append a `Did you mean`/`Available:` hint depending on the callable set; the hint is not part of the contract); the codemode tool returns that text as an error result. No `tool_execution_start` fires for `structured_output`, so the runtime's `attempted` flag stays false and the existing one-time re-ask in `agent_before_settle` still fires if the child settles without a direct call. A direct call behaves exactly as today.

The tool description stays as is ("Submit the required final structured output for this subagent step. This terminates the step."); the batch-rule caveat is documented, not nudged at in the prompt.

Nothing else in the runtime moves: `attempted`, the `tool_execution_start`/`tool_execution_end` listeners, the `agent_before_settle` re-ask, capture validation, and the allowlist append in `src/runs/shared/pi-args.ts` keep their current responsibilities.

Paid or external actions: none. The integration test spawns a local pi child against a scripted in-process provider; no model calls, no network. The test is authorized to read the child's retained session file named by the result's `sessionFile` (local file read only). The implementation loop treats any action not named here as unreachable; adding one requires separate explicit authorization.

## Errors and edge cases

- A script calls `tools.structured_output(...)`: the sandbox throws the TypeError, the codemode result is an error, no capture file is written, `attempted` stays false, and the settlement re-ask behaves as for a child that never tried.
- A direct call: schema validation errors, the capture write (mode `0o600`), and `terminate: true` are unchanged.
- `codemode.mode: "only"` in the child: pi hides only callable `direct` declarations from the model (`extensions/codemode/tool.js:262-264`); a `model-only` tool is not callable, so it stays declared. The design holds under `on` and `only`.
- The `--tools` allowlist names `structured_output`, which marks it active and therefore declared; activation does not make a `model-only` tool callable, so the allowlist path in `pi-args.ts` needs no change.
- A direct call batched with other tool calls in the same assistant turn does not end the turn (pi's every-result-must-terminate rule); unchanged, see Out of scope.
- Pi below 1.5.0 would not honor the field; the floor already excludes it.

## Tests

- registration object carries `exposure: "model-only"` (AC 1, AC 3) - `registered structured_output tool is declared model-only` in `test/unit/subagent-prompt-runtime.test.ts`
- a scripted `tools.structured_output` call in a schema-bound real child fails with the TypeError, and the same child's direct call captures the value with exit 0 (AC 2) - `test/integration/structured-output-model-only.test.ts`: session-file assertion that the codemode tool result contains `tools.structured_output does not exist` and precedes the direct `structured_output` call and result, plus exit 0 and value equality
- direct call still captures and returns `terminate: true` (AC 3) - existing `registered structured_output tool accepts valid schema output and writes the capture file` in `test/unit/subagent-prompt-runtime.test.ts`, unchanged
- peer range reads `>=1.5.0` (AC 4, package half) - existing `test/unit/package-manifest.test.ts:61-78`, unchanged
- README floor reads `Requires Pi >=1.5.0.` (AC 4, README half) - none automated: read-only check of `README.md:36`; the file is not edited
- no capture file after the failed script call - `test/integration/structured-output-model-only.test.ts`: the session file shows no `structured_output` tool call before the codemode error result (the tool is absent from the sandbox, so the script could not have written the capture), and the observed direct call that follows is the only writer; value equality and the provider's turn-2 gate do not prove this on their own
- re-ask still fires after a failed script call - none: no tool event fires for a tool absent from the sandbox, so `attempted` is never set; the existing re-ask tests over the unattempted state cover it
- `codemode.mode: "only"` keeps the tool declared - none: pi behavior cited to `tool.js:262-264`; nothing in this repo branches on it

## Documentation impact

Template from `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/agents-and-chains.md` (structured-output paragraph, one sentence: model-only, direct call only - a communication contract a persona author with codemode-enabled children cannot see without reading the registration); `CHANGELOG.md` - `[Unreleased]`
- Derived / memory docs invalidated: none

Dropped candidates: `README.md` Installation (the floor line is already there), `doc/programmatic-api.md` and `doc/orchestration-patterns.md` (no contract they describe changes).

## Out of scope

- Guaranteeing that a captured value ends the child's run. Pi ends the batch only when every finalized call carries `terminate: true`, and steering or follow-up messages can continue it; this spec changes reachability, not termination.
- Rewording the tool description to nudge the model into a lone direct call (unverifiable by test; a separate ticket if wasted post-capture turns are still observed).
- A `tool_call` handler blocking nested calls by `parentToolCallId` (re-implements pi's exposure contract inside the extension).
- Conditional exposure for pi below 1.5.0 (the floor is already `>=1.5.0`).
- Any change to the pi floor, `package.json`, or `README.md` (AC 4 is satisfied at the base).
- Companion #47 (fork context stripping script-wrapped dispatches).

## Open questions

none
