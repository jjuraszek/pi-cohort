# Stop any subagent by the short id its row starts with

**Ticket:** [#62](https://github.com/jjuraszek/pi-cohort/issues/62)
**Goal:** Every row that draws one subagent starts with a six-character id; `/interrupt-child <id>` and `subagent({ action: "interrupt", id })` stop that subagent and everything below it, at any nesting depth, with no index anywhere in the stop path.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.; fund 2 fix rounds
**Engine:** waves
**Date:** 2026-11-11
**Source bases:** pi-cohort `ecabac5` (7.7.3); `@earendil-works/pi-coding-agent` 1.5.0 (the worktree's `node_modules` copy), read-only; installed pi-gauntlet, read-only.
**Predecessor:** `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`, the index as the stop address in `Foreground targeting`, `interrupt action`, `Background transport` and `/interrupt-child <index> [run-id]`.

## Problem

Ticket #62, "Live rows do not show what to type to stop a child, and a nested child cannot be stopped alone". A person watching a run cannot read off the screen what to type to stop one child, and a child of a nested run cannot be stopped on its own.

User request, verbatim: "#62 we should prefix any custom text with exact id to be used at /interrupt-child commaned. each subprocess no matter how deep in future it will be should be possible to be stopped! its unification change. I expect not to have carved out special cases but universal rule".

User decisions taken during the design discussion, in order:

- The stop command takes one token, never an index plus a run id; a full UUID is never displayed; "it should be human tool after all".
- "what if we kill index idea? it asking for troubles." No index for stopping. Stopping a subagent stops every subagent below it.
- The id is "not internal value but it should be visble all the time as prefix value for subagent render line (that is why it needs to be short)", and easy to copy.
- In the expanded view every running subagent has its own row at any depth, with no cap on running ones; the collapsed view keeps its one-line counts.
- Each child carries its own minted id (not an id computed from run id and index). "make sure that killing subagent propagates to its children (no zombies)".

Framing: kept

Supported by the source:

- A child has no id of its own. Its address is the pair (run id, zero-based index): `childInterrupts: Map<number, ...>` per run (`src/shared/types.ts:753`; `src/runs/foreground/subagent-executor.ts:1494, 2039, 2463-2468`; `src/runs/foreground/chain-execution.ts:290, 1143`). `randomUUID()` mints run ids, request ids and capability tokens only (`src/runs/foreground/subagent-executor.ts:664, 2359`; `src/runs/shared/nested-events.ts:130`).
- Live rows number children one-based (`src/tui/render.ts:653-665`; `src/runs/background/run-status.ts:52-62`) while `/interrupt-child` takes the zero-based index (`src/slash/slash-commands.ts:560-595`). No row shows a run id or a stop index.
- `interrupt` with `index` on a nested run is refused (`src/runs/foreground/subagent-executor.ts:2270-2276`); the nested control request has no child field (`src/runs/shared/nested-events.ts:68-77, 647-672`).
- Stop by index is a released contract since 7.7.3 (`CHANGELOG.md`, `README.md:180-184`, `doc/commands.md:16-20`, `doc/programmatic-api.md:136-160`, `skills/pi-cohort/SKILL.md:75`). The installed pi-gauntlet uses neither `/interrupt-child` nor `interrupt` with `index` (rg over the package, zero hits).

Corrected premises:

- Passing `index` through the nested request does not give a depth-independent stop. Every child that may dispatch polls one control inbox inherited unchanged from the root (`src/runs/shared/pi-args.ts:207-220`). A child that does not own the target answers `Nested run <id> is not active in this fanout child.`, writes that result and deletes the request (`src/extension/fanout-child.ts:71-103`); the caller takes the first result (`src/runs/foreground/subagent-executor.ts:536-547`). With two dispatching children alive, a non-owner can answer first.
- A stopped child's own children keep running. The stop sends SIGINT, then SIGTERM after one second (`src/runs/foreground/execution.ts:617-630`; `src/runs/background/subagent-runner.ts:437-446`). A child runs pi in print mode, which handles SIGTERM and SIGHUP and has no SIGINT handler (`node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js:31-45`), so the child dies without cleanup. `session_shutdown` in this extension stops no run (`src/extension/index.ts:563-592`), and neither the dispatching child nor the background runner handles SIGTERM (`src/runs/background/subagent-runner.ts:1872` registers the interrupt signal only).
- A whole-run stop of a background run signals one child. The runner calls `activeChildInterrupt`, which holds the last registered child (`src/runs/background/subagent-runner.ts:1822, 1867`); in a parallel group the other running children are marked paused without being signalled. Read from source, not exercised.
- Some running subagents have no row. The collapsed widget folds all nested children into one count line; the expanded widget stops at two nested levels and 12 lines (`src/tui/render.ts:767-806`); the nested projection drops levels past 3, steps past 12 and children past 16 (`src/runs/shared/nested-events.ts:38-40`).

Implicit dependencies:

- Interactive-session harness for ticket row 11 - looked up in `test/integration/slash-commands.test.ts` and `test/support/` - not found. The existing test drives the registered command handler through the slash bridge while a foreground call is blocked; this spec's test does the same.
- A run nested deeper than three levels staying resolvable by id - `src/runs/shared/nested-events.ts:40, 170, 232, 291, 391-396` read - not checkable from source alone, not exercised. Design removes the dependency: live entries are exempt from every cap site listed in `### Inventory`, and control ancestry is kept in full (`src/runs/shared/nested-path.ts:4, 26-37`).
- Descendants exiting when their parent child is stopped - traced above - not found. Design adds the owner-alive check.

Assumptions stated to the user and not objected to:

- "Each subprocess" means every subagent cohort dispatches at any depth, not OS processes a child's tools spawn.
- Rows show six characters; any unique prefix is accepted.
- `index` on `resume` is untouched.
- Background rows carry the same prefix and `/interrupt-child <id>` stops them too.
- Settled rows keep their id.

## Acceptance criteria

Ticket #62, Acceptance Criteria, rows verbatim:

- [ ] Given a foreground `tasks[]` run of three children in flight, each child's live row shows its stop index, marked as such: 0, 1 and 2.
  deviates: replaced by the child-id rule
- [ ] Given a foreground chain run with two sequential steps followed by a parallel step of three children, while the three run, their rows show stop indexes 2, 3 and 4.
  deviates: replaced by the child-id rule
- [ ] Given a single-agent foreground run in flight, its live row shows stop index 0.
  deviates: replaced by the child-id rule
- [ ] Every live child row shows the id of its run in a form `/interrupt-child <index> <run-id>` accepts, with one foreground run in flight and with two.
  deviates: replaced by the child-id rule
- [ ] A child dispatched with a `label` shows that label on its live row while it runs, and its result row keeps the label after it settles, for each dispatch shape:
  - a single-agent call
  - a `tasks[]` item
  - a sequential chain step
  - a static chain `parallel` item
  - a child of a dynamic `parallel` template
  in-scope
- [ ] Tab completion for `/interrupt-child` lists each running child's index with its agent name and, when set, its label; with two foreground runs in flight each suggestion also carries the run id.
  deviates: replaced by the child-id rule
- [ ] Given a foreground run whose child 0 dispatched a nested parallel run of three children, the expanded top-level display shows each running nested child on its own row with its stop index, the nested run's id, and its label when set.
  deviates: replaced by the child-id rule
- [ ] In that run nested child 1 never ends its turn; a test driving the tool directly sends `subagent({ action: "interrupt", id: "<nested-run-id>", index: 1 })`; nested child 1 alone stops, and nested children 0 and 2 run to completion.
  deviates: replaced by the child-id rule
- [ ] The result the nested run's parent child receives contains the outputs of nested children 0 and 2 and marks nested child 1 interrupted.
  in-scope
- [ ] `interrupt` with an `index` that names no running child of the nested run returns an error naming the index and stops no child.
  deviates: replaced by the child-id rule
- [ ] Given the same nested run in an interactive session, the user types `/interrupt-child 1 <nested-run-id>` while the top-level caller is blocked; nested child 1 alone stops, and nested children 0 and 2 complete.
  deviates: replaced by the child-id rule

## Legs

### Leg: jjuraszek/pi-cohort
branch: gh-62-universal-child-stop-handle
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (`release.sh <level>`) per overrides `## Release`
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7, AC 8, AC 9, AC 10, AC 11
design: owns `src/shared/types.ts`, `src/extension/schemas.ts`, `src/extension/fanout-child.ts`, `src/runs/foreground/subagent-executor.ts`, `src/runs/foreground/chain-execution.ts`, `src/runs/foreground/execution.ts`, `src/runs/foreground/external-single-attempt.ts`, `src/runs/background/subagent-runner.ts`, `src/runs/background/async-execution.ts`, `src/runs/background/async-job-tracker.ts`, `src/runs/background/async-status.ts`, `src/runs/background/run-id-resolver.ts`, `src/runs/background/run-status.ts`, `src/runs/shared/nested-events.ts`, `src/runs/shared/nested-path.ts`, `src/runs/shared/nested-render.ts`, `src/runs/shared/pi-args.ts`, `src/runs/shared/subagent-prompt-runtime.ts`, `src/slash/slash-commands.ts`, `src/tui/render.ts`, `skills/pi-cohort/SKILL.md`, `skills/pi-cohort/reference/config-fields.md`, the test files named in `## Tests`, `README.md`, `doc/commands.md`, `doc/programmatic-api.md`, `CHANGELOG.md`, and the banner in `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`; observable outcomes are ticket rows 5 and 9 plus the Design clauses that replace the nine deviating rows

## Design

Terms. **Run id**: the UUID one `subagent` call already mints. **Child id**: a new UUID the owner mints for each child it dispatches. **Stop id**: what a person reads and types - the first six characters of a run id or child id. **Owner**: the process that spawned a child and holds its stop control - the top-level session, a dispatching child, or a background runner. **Target**: the full run id or child id a stop id resolves to. **Row**: the one line that carries a subagent's or a run's glyph and name; the lines under it (activity, output path, live status, recent tools, recent output, command hints) are detail lines. **Live entry**: a run that is `queued` or `running`, a child that is `pending` or `running`, or any entry with such a descendant. **Stop record**: an empty file named by a full target id in the `stops/` directory of the root route; it closes launches under that target. The execution-backend protocol's `childId` (`child-<index>`, `src/runs/foreground/execution.ts:764`) is an unrelated correlation value and does not change.

One rule replaces the nine deviating ticket rows: every row that draws one subagent starts with that subagent's stop id, and that one token is the whole argument of the stop. Rows 1-4 and 7 become "the row starts with the stop id"; row 6 becomes "completion lists stop ids"; rows 8 and 11 become "the stop takes the nested child's id"; row 10 becomes "an id that matches no running subagent is an error that stops nothing".

### Inventory

Remove:

- `index` as an input of `interrupt`: the foreground, background and nested branches in `src/runs/foreground/subagent-executor.ts` that read it, and the nested-index refusal at `:2270-2276`. The schema field stays because `resume` uses it; its description names `resume` only.
- The `/interrupt-child <index> [run-id]` grammar and its index completions (`src/slash/slash-commands.ts:560-595`).
- The `interrupt-request-<index>.json` and `interrupt-request-all.json` request files (`src/runs/foreground/subagent-executor.ts:440, 552-575`; `src/runs/background/subagent-runner.ts:1837-1851`), and `directNestedAsyncInterrupt` as the fallback `interruptNestedRun` takes after an unanswered inbox request (`src/runs/foreground/subagent-executor.ts:558-585`).
- `stoppedByIndex`, `lastAssigned` as a stop fallback, and the index-keyed `childInterrupts` map on the foreground control (`src/shared/types.ts:753`; `src/runs/foreground/subagent-executor.ts:2457-2470`); the runner's index-keyed `childInterrupts` map, `pendingStops` set and `activeChildInterrupt` slot (`src/runs/background/subagent-runner.ts:1405-1406, 1821-1867`).
- The non-owner reply `Nested run <id> is not active in this fanout child.` and the request deletion that goes with it (`src/extension/fanout-child.ts:71-76, 99`).
- Every cap that drops, folds or clamps a live entry. In `src/tui/render.ts`: the two-level and 12-line folds in `formatNestedWidgetLines` (`:767-806`) and the `fitWidgetLineBudget` fold (`:900-912`). In `src/runs/shared/nested-render.ts`: the `maxDepth` and `maxLines` folds in `formatNestedRunLines` (`:70-106`), with the budgets its callers pass (`src/runs/foreground/subagent-executor.ts:251`; `src/runs/background/run-status.ts:234, 240`; `src/runs/background/async-status.ts:354, 358`). In `src/runs/shared/nested-events.ts`: the `MAX_DEPTH` clamps and recursion stops (`:170, 232, 262, 291`), the `MAX_STEPS` slices (`:251, 872`), and the `MAX_CHILDREN` slices in sanitize, registry merge and step attach (`:232, 291, 384, 396, 804`). Each keeps applying to settled entries with no live descendant. The `agents` list on a run record stays capped (`:274`); it is display metadata.
- The `MAX_NESTED_PATH_ENTRIES` slice and the field whitelist that drops `childId` in `sanitizeNestedPath` (`src/runs/shared/nested-path.ts:4, 26-37`). Ancestry is control data and is never cut.
- `steps` riding inside run records (`src/runs/shared/nested-events.ts:249-252, 857-872`; `src/runs/foreground/subagent-executor.ts:2476-2533`); child records replace them (`### Live records`).
- The full run UUID on a row: `[<run id>]` on nested status rows (`src/runs/shared/nested-render.ts:88`) and the leading run id of `formatRunHeader` (`src/runs/background/async-status.ts:339-344`). The `<label> (<agent>)` form (`src/runs/background/async-status.ts:301`; `src/runs/background/run-status.ts:231`).
- The `<8-char run id prefix>[/<index>]` part of child session names (`src/runs/shared/pi-args.ts:89-90`).

Add:

- `id: string` on `AgentProgress`, `SingleResult`, the background step record (`AsyncStatus["steps"][number]`) and `NestedStepSummary`; `label?: string` on `AgentProgress`, `SingleResult` and `NestedStepSummary` (`src/shared/types.ts`). The background step record already has `label` (`src/shared/types.ts:623`); it is carried as is and only its rendering changes.
- `childId?: string` on `NestedPathEntry` and on each entry of `NestedRunAddress.path`, kept by `sanitizeNestedPath` through `encodeNestedPathEnv`, `parseNestedPathEnv` and `sanitizeInternalSummary`, and written into `PI_SUBAGENT_PARENT_PATH` by the owner for native and external attempts (`src/runs/shared/pi-args.ts:199-219`; `src/runs/foreground/external-single-attempt.ts:77`).
- `children: Map<string, { agent: string; label?: string; index: number; state: "pending" | "running" | "completed" | "failed" | "interrupted"; stopRequested?: true; interrupt?: () => boolean }>` on the foreground control, keyed by child id, replacing `childInterrupts`; the same map in the background runner; `stopping?: true` on both run records.
- `interrupt-request-<target id>.json` as the one background request file.
- `targetId` in place of `targetRunId` on the nested control request and the nested control result, in their parsers and writers, and in the caller's wait predicate (`src/runs/shared/nested-events.ts:57-77, 647-702, 741-754`; `src/runs/foreground/subagent-executor.ts:536-557`).
- Child ids in `resolveSubagentRunId` (`src/runs/background/run-id-resolver.ts`), with a result that names the target kind, the full target id and the owner route; the background child-id inventory (`### Resolving a stop id`).
- The child record `subagent.nested.child` in the event sink, its merge into the registry, and its writer in the foreground executor and the background runner (`### Live records`).
- `children?: NestedRunSummary[]` on `AgentProgress`, the in-flight projection timer of the foreground owner, and nested rows in the expanded `renderSubagentResult` (`### Rows`).
- `retainedNestedRoutes` on `SubagentState` (`### Resolving a stop id`).
- The owner-only answer in `startNestedControlInboxListener` (`src/extension/fanout-child.ts:51-110`).
- Stop records and the admission check in the foreground executor, the background launch (`src/runs/background/async-execution.ts:279-326`) and the background runner (`### No zombies`).
- `PI_SUBAGENT_OWNER_PID` in every natively spawned child's environment, set empty for external attempts (`src/runs/shared/pi-args.ts`), and the owner-alive check in `src/runs/shared/subagent-prompt-runtime.ts`.
- The owner steps on every owner-stop path - stop record, signal, sweep, answer - and the whole-run background stop signalling every running child (`### Stopping a target`).
- The stop id as first token in every row renderer: `renderSingleCompact`, `renderMultiCompact`, the expanded `renderSubagentResult` rows, `foregroundStyleWidgetStepLines`, the compact widget rows, `formatNestedWidgetLines` (`src/tui/render.ts`), `stepLineLabel` rows (`src/runs/background/run-status.ts:52-62`), `formatNestedRunLines` (`src/runs/shared/nested-render.ts`), and `formatRunHeader` and `formatStepLine` (`src/runs/background/async-status.ts`).
- `label` on `TaskItem` and a top-level `label` on `SubagentParams` for the single-agent call (`src/extension/schemas.ts:146-156, 255`), carried into the records above for all five dispatch shapes.
- Stop-id completions for `/interrupt-child`.
- Skill text: the stop-by-id wording and the renamed `doc/programmatic-api.md` anchor in `skills/pi-cohort/SKILL.md:75`; `label` on `tasks[]` items and the single-agent call in `skills/pi-cohort/reference/config-fields.md`.

### Identity

The owner mints `randomUUID()` for each child when it creates the child's record, before any spawn: once per single-agent call, per `tasks[]` item after `count` expansion, per sequential chain step, per static `parallel` item, and per dynamic `parallel` item when the template is materialized. The id is stable across retry attempts of the same child. It is written to the child's progress record when the row is created and copied to its result, its background step record and its child record, so every surface reads the same value.

A record that exists before its child starts carries its id from creation with state `pending`: every background step, which the runner creates `pending` at run start (`src/runs/background/subagent-runner.ts:1428, 1447, 1459, 1985`), and every foreground `tasks[]` item waiting behind the concurrency limit (`src/runs/foreground/subagent-executor.ts:1462`). A child's state moves `pending` -> `running` when its owner begins the launch (the `interrupt` callback may register later) -> `completed`, `failed` or `interrupted`. A pending child's row prints its stop id like any other row. A stop that names a pending child is rejected with the pending error in `## Errors and edge cases`; a stop of its run keeps it from starting.

A stop id is the first six characters of the full id. It is never recomputed from position.

Child session names become `<agent> <stop id of the child> from <parent>`.

### Rows

Every row starts with its stop id as the first non-whitespace token, followed by one space, with no brackets or punctuation attached; a list bullet (`- `) counts as indent. A child row prints the child's stop id; a run row prints the run's stop id. On nested rows the indent precedes the id and the `↳` marker follows it. Settled rows keep the id. Detail lines carry no stop id.

```text
3f9a1c ⠋ Agent 2/3: scout - audit auth · running
  7b20de ↳ ⠋ scout · running
```

Which line is a row, per surface:

| Surface | Run row | Child row |
|---|---|---|
| Foreground tool result (`renderSubagentResult`, `renderSingleCompact`, `renderMultiCompact`) | the header line of a multi-child result (glyph, mode, stats); a single-agent result has none | each `Agent n/m` or `Step n` line; the header line of a single-agent result |
| Background widget (`buildSingleWidgetLines`, the compact rows, `widgetChainDetails`) | the status line with the glyph and the mode name (`src/tui/render.ts:874-875`, second line); the title line `async subagent ...` is not a row | each step line |
| Nested rows on either (`formatNestedWidgetLines`) | each nested run line | each nested step line |
| Status text (`formatNestedRunLines`; `formatRunHeader` and `formatStepLine`; `stepLineLabel` rows) | each nested run line; the run header | each step line |

A label, when set, follows the agent name as `<agent> - <label>` on the live row and on the result row, for all five dispatch shapes (ticket row 5). The background status rows that print `<label> (<agent>)` today switch to the same form. A dynamic template's label keeps its item interpolation. A parallel group's own label stays on the group header and is not a child label.

Folding. A row of a live entry is never folded, capped or replaced by a fold line, on any surface and at any depth. Detail lines stay foldable under the existing budgets, including the detail lines of a running row. Rows of settled entries keep their existing caps. The line builders hand `fitWidgetLineBudget` and `formatNestedRunLines` rows and detail lines apart instead of a flat `string[]`; a fold removes detail lines first, then settled rows, and when live rows alone exceed the budget they are all drawn. The collapsed view keeps its one-line counts and prefixes the rows it already draws.

Foreground nested rows. Nested rows exist only in the background widget today: `formatNestedWidgetLines` is fed from `AsyncJobState` alone, and a foreground control refreshes `nestedChildren` only at settle points and on `status` (`src/runs/foreground/subagent-executor.ts:239, 1283, 1840, 1873, 2117, 2147`). While a foreground run is in flight its owner re-projects its route with `updateForegroundNestedProjection` (`src/runs/shared/nested-events.ts:815-819`) every `POLL_INTERVAL_MS` (250 ms, `src/shared/types.ts:979`), attaches each nested run to `children` on the `AgentProgress` of the child that dispatched it - matched by the `childId` of the run's last ancestry entry - and calls `onUpdate` when an attached row was added or changed state. The timer stops when the run returns; the settle-point projection stays, so the result keeps the final rows. The expanded `renderSubagentResult` draws the attached nested rows under each child row through `formatNestedWidgetLines`. The collapsed foreground result draws no nested rows, as today.

### Live records

Nested status travels as two kinds of record in the route's event sink. Each record is one file of at most `MAX_EVENT_BYTES` (64 KB, unchanged); a full run summary with its steps inside is no longer written, because the reader rejects the whole event above that size and `writeNestedEvent` throws (`src/runs/shared/nested-events.ts:296, 600-643`), which loses every id in it.

| Record | Type | Carries | Written by the run's owner |
|---|---|---|---|
| Run record | `subagent.nested.started`, `.updated`, `.completed` (today's types) | run fields and the full ancestry `path`; no `steps` | as today |
| Child record | `subagent.nested.child` (new) | `runId` and one step: `id`, `agent`, `label`, `status`, flat `index`, and the `NestedStepSummary` fields of today | when the child's record is created (state `pending`), at each state change, and - for the background runner - on a status write that changed that child's fields |

Merge. The registry stores each run's steps keyed by child id, in `index` order. A child record replaces the stored step with the same id unless its `ts` is older, and a terminal status is never replaced by a non-terminal one - the rule `mergeSummary` applies to runs (`src/runs/shared/nested-events.ts:344-351`). Replay is idempotent, which the 1000-name `processedEvents` window relies on (`:614`). A child record whose run is not in the registry yet is left unprocessed and applied by a later projection. Step caps apply to settled steps only.

Size. A run record no longer grows with the number of children; its ancestry grows with depth, which `maxSubagentDepth` bounds. A child record is bounded by the field caps of `sanitizeStep` (`:210-234`). A child record that would still exceed the limit is written with its identity fields only (`id`, `agent`, `label`, `status`, `index`).

Foreground publication. A nested foreground run publishes `started` with no steps and `completed` after settlement, and nothing in between (`src/runs/foreground/subagent-executor.ts:2476-2554`); only the background runner emits `updated` (`src/runs/background/subagent-runner.ts:1498-1553`). The owner of a nested foreground run writes a child record from the code that creates a `children` entry and from the code that changes its state - including dynamic `parallel` items materialized mid-chain - not from the `onUpdate` callback, so the records exist with or without a UI. A root foreground run needs no records for its own children: the resolver reads its `children` map in process.

Legacy input. A nested step is admitted to the projected `NestedStepSummary` only when it carries its owner's child id; a pre-upgrade step without that id is omitted from the projected steps, whether pending, running or settled, and has no individual row, completion or child-id stop target. Projection never mints an id, derives one from a run id or index, substitutes the run's id, or renders a tokenless child row. This is an explicit legacy-record compatibility break, not permission to fold or omit valid live entries: all children created by the upgraded owners have ids from creation and remain subject to the universal row-prefix and live-entry rules. Keep valid enclosing run records and independently recorded descendants; do not delete stored legacy artifacts or infer missing child identity. Cover id-less legacy input and mixed legacy/identified steps in `test/unit/nested-events.test.ts`, asserting that valid identified steps and run records survive and no identity is fabricated.

### Resolving a stop id

`/interrupt-child <id>` and `subagent({ action: "interrupt", id })` both pass the typed text to `resolveSubagentRunId`. For `interrupt` the text must be at least four characters. The resolver matches it as an exact id or prefix against one namespace: every run id and child id on record in the registries below, live and settled alike.

| Registry | Run ids | Child ids | Scope |
|---|---|---|---|
| Foreground controls of this process | map keys | `children` keys of each control | this process |
| Background run directories | directory names (today) | the background inventory below | every run directory under the shared roots, from any session, as today |
| Nested registry of each authorized route | run summaries (today) | step ids of each run summary | the routes of this process's foreground controls and tracked background jobs (`src/runs/background/run-id-resolver.ts:31-44`) plus its retained routes; in a dispatching child the existing `descendantOf` restriction stays (`src/runs/foreground/subagent-executor.ts:211-220`) |

An exact full-id match wins. Otherwise exactly one distinct full id must match the prefix; the same full id on record in two registries is one match. Live records get no precedence over settled ones: a prefix shared with a settled id is ambiguous, so a prefix never changes which id it addresses when a record settles. `status` and `resume` keep resolving run ids only, with no minimum length.

The result names the target kind (`run` or `child`), the full target id and the owner route (`foreground`, `async` or `nested`).

Background inventory. Run ids match by directory name, so no file is opened for them. Child ids are not in directory names, and the shared root is persistent (872 run directories counted on one machine during review), so the resolver keeps a per-process inventory keyed by run directory: the run's state, the `mtime` of its `status.json`, and each step's `id`, `agent`, `label` and `status`. A directory is read when first seen. A run recorded in a terminal state is not read again; a non-terminal run is re-read only when the `mtime` changed. Tracked jobs (`state.asyncJobs`) feed their entry from the tracker's existing poll. The inventory is refreshed when `interrupt` resolves an id; completion reads it as it stands and opens no file. Settled steps stay in the inventory, so the settled-child error keeps working for every background run on record.

Retained routes. A foreground control is deleted when its run returns (`src/runs/foreground/subagent-executor.ts:2561-2568`), and with it the only route to a nested background run that is still alive, which lives outside the top-level async root (`src/runs/background/async-execution.ts:433`; `src/runs/background/async-job-tracker.ts:236-259`). When a root foreground run returns while its registry holds a live descendant (`hasLiveNestedDescendants`, `src/runs/shared/nested-events.ts:821-829`), its route moves to `retainedNestedRoutes`. A poll at the tracker's cadence re-projects each retained route and drops it when no live descendant remains. Resolution, completion, the sweep and the widget read retained routes with the routes of live controls and tracked jobs; the widget draws each retained root as a run row with its live nested rows. Only routes this process created are retained.

A bare `interrupt` with no `id` selects the current foreground run as `getForegroundControl` does today (`src/runs/foreground/subagent-executor.ts:178`), or the background run as today when no foreground run exists, and stops it as a run target.

### Stopping a target

The caller resolves the target and routes it by where the owner is. When one target id is on record in more than one registry, the first row that applies wins:

| Owner | Route |
|---|---|
| This process (a foreground control holds the target) | Run the owner steps here. |
| A background runner (top-level or nested; an async directory whose `status.json` is `running` with a live pid) | Write `interrupt-request-<target id>.json` in the run's async directory and send the runner the interrupt signal. The runner reads the request and runs the owner steps for the child whose id equals the target, or for its run when the target is its run id. A signal with no request file stops nothing. |
| A dispatching child (nested foreground run) | Write a control request carrying `targetId` to the shared inbox and wait up to 1000 ms for a control result with the same `requestId` and `targetId`. |

A nested background run is therefore stopped through its runner and never through the inbox, and an unanswered inbox request is never followed by a whole-run signal.

The inbox listener in each dispatching child applies one rule: when one of its foreground controls holds the target as its run id or as a child id, it runs the owner steps, writes the result, and removes the request; otherwise it leaves the request untouched and writes nothing. The caller removes only its own request when the wait ends.

Owner steps. An owner applies the same four steps, in this order, to every stop of a child or run it owns, whatever started it - an `interrupt` request, the abort signal of the waiting call, or a control-policy kill:

1. Close admission. Write the stop record for the target. For a run target also set `stopping` on the run, so its launch loop starts no further child: `tasks[]` items queued behind the concurrency limit (`src/runs/shared/parallel-utils.ts:79-98`), later chain steps and pending background steps are never spawned. A queued foreground child settles `interrupted` without a process; a pending background step stays `pending` and its run settles `paused`.
2. Signal. Child target: set `stopRequested` on its entry and call its `interrupt`. Run target: call `interrupt` on every running child; `stopRequested` is not set.
3. Sweep. Stop every background run under the target (`### No zombies`).
4. Answer. Write the reply. Steps 1-3 never wait for the reply and are not undone when its write fails or arrives after the caller's deadline; the listener keeps retrying the write as today (`src/extension/fanout-child.ts:93-98`).

A stop before the callback exists. A child-target stop that finds the entry `running` with no `interrupt` callback yet sets `stopRequested` and is accepted; the owner calls `interrupt` as soon as the callback registers. This replaces the runner's index-keyed `pendingStops` (`src/runs/background/subagent-runner.ts:1826-1855`) and gives the foreground owner the same rule, where the request fails today (`src/runs/foreground/subagent-executor.ts:2463-2468`).

Result. A stop by child id produces the result the predecessor defines for a stop by index: the siblings finish, and the owner's waiting call returns their outputs with the stopped child marked `interrupted: true` (ticket row 9). The predecessor's test "stopped by index only" (`src/runs/foreground/subagent-executor.ts:1865`; `src/runs/foreground/chain-execution.ts:759, 969`) becomes "every interrupted result's child has `stopRequested`". A stop by run id never sets `stopRequested`, so three child-id stops of a three-child run produce the targeted result and one run-id stop produces the predecessor's whole-run interrupt result. A whole-run stop now signals every running child of the run instead of the last one started.

### No zombies

Three rules, the same at every depth.

Stopped ids admit nothing. Before it spawns a child or launches a background run, an owner looks in `stops/` for its own run id and for every `runId` and `childId` in its ancestry. On a hit it launches nothing: a foreground dispatch returns `Subagent launch refused: <stop id> is stopping.`, and a background runner settles its run `paused` without spawning. The runner checks at startup and before each child spawn, so a run that was still queued when the stop arrived never starts a child. A background launch publishes its registration record first and checks second (`src/runs/background/async-execution.ts:279-326` publishes before the runner starts); a launch whose check missed the stop record has therefore already published, and the sweep sees it. A stop record names the target only, so a sibling whose ancestry does not contain the target is not affected. `resume` starts its run under a new run id from the caller's own ancestry (`src/runs/foreground/subagent-executor.ts:664-671`), so a stop record never blocks a revival.

Owner gone, child exits. `buildPiArgs` sets `PI_SUBAGENT_OWNER_PID` to the spawning process's pid for every natively spawned child. The prompt runtime extension, which every child loads (`src/runs/shared/pi-args.ts:144-146`), reads it and every 1000 ms calls `checkPidLiveness` (`src/runs/background/stale-run-reconciler.ts:309-321`). On `dead` the child sends itself SIGTERM, which print mode handles by disposing the runtime and exiting; if the process is still alive 3000 ms later it calls `process.exit(143)`. `alive` and `unknown` change nothing. The timer is unref'd. A stopped child's native subtree therefore exits level by level, each level within one poll plus its exit time of its owner's death, and the same holds after a crash, a force-kill, or a session that quits. Detached background runners carry no owner check; the two other rules reach them.

External attempts. A supported external backend runs the child in a surface it owns (`executionBackend` defaults to `auto`, `doc/configuration.md:150-161`), possibly in another pid namespace, where the owner's pid reads `dead` and the child would stop itself. The owner therefore sets `PI_SUBAGENT_OWNER_PID` to the empty string in an external attempt's environment (`src/runs/foreground/external-single-attempt.ts:77-113`; `src/runs/background/subagent-runner.ts:804, 956`), which also masks a value inherited through `process.env`; an empty value disables the pid check. Owner liveness there is the child host's socket to the owner: `runChildHost` terminates the active attempt when that socket closes (`src/execution-backend/child-host-runtime.ts:64`), wherever the backend runs the host. An explicit stop of an external child runs the same owner steps; step 2 aborts the attempt's `interruptSignal`, which sends `abort` then `shutdown` over the control channel and falls back to `backend.close(handle, "explicit_cleanup")` (`src/runs/shared/external-execution.ts:275-336`). Children an external child spawns natively carry its pid, which is valid in its own namespace; background runs under it are found by the sweep through their ancestry. No subagent is outside the rule.

Background runs are swept. Background runners are detached on purpose and are not children of the stopped process. In step 3 the owner projects the registry of the target's root route and, for every background run that is `queued` or `running` and whose ancestry `path` contains the target as a `runId` or a `childId`, stops that run by its run id through the background route above. A queued run with no live pid needs nothing more: its runner reads the stop record at startup. Because admission closed in step 1 and launches publish before they check, one sweep after step 1 sees every background run under the target.

### `/interrupt-child <id>`

The command takes exactly one argument. It dispatches `action: "interrupt"` with that `id` through the slash bridge and reports through `ctx.ui.notify`, as today. With no foreground run in flight it reaches background runs through the same resolver.

Completion lists the running subagents of this session: children of its foreground runs, steps of its tracked background jobs, and running nested children in its authorized and retained routes, read from in-memory state. Background children of other sessions resolve when typed and are not listed. Each item's value is the stop id, extended to the shortest prefix that is unique in the whole resolver namespace - run ids and settled ids included - and never a full UUID; its text reads `<stop id> <agent>` or `<stop id> <agent> - <label>`.

### Predecessor scope

Supersedes `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md` for the index as the stop address: its `Foreground targeting`, `interrupt action`, `Background transport` and `/interrupt-child <index> [run-id]` sections. Its `Foreground result` section stands: siblings finish, the waiting call returns their results with the stopped child marked interrupted, and chain groups take the failed-group route.

### Paid or external actions

None. Implementation and verification run locally against the mock child, the prompt-runtime process harness and the execution-backend testkit backend (`src/execution-backend/testkit.ts`). The loop treats an action without a clause here as unreachable; adding one needs separate explicit authorization.

## Errors and edge cases

Every rejection below is decided before any signal is sent and stops nothing. The unanswered inbox request is not a rejection; it is listed last as an unconfirmed outcome.

- Stop id shorter than four characters: `Stop id '<text>' is too short; type at least 4 characters of the id at the start of the row.`
- No record matches: `No running subagent matches '<text>'.` followed by the running stop ids with their agent names, or `No subagent is running.`
- Several ids match: the error lists every match as `<kind>:<prefix> <name>` with each prefix long enough to tell the matches apart. `<kind>` is the target kind, `run` or `child`; `<name>` is the child's agent, or the name the run's row shows. Owner-route kinds (`foreground`, `async`, `nested`) do not appear.
- The id matches a pending child: `Subagent <stop id> (<agent>) has not started; stop its run to keep it from starting.`
- The id matches a settled child whose record still exists (its run is still in flight, or it is a step of a background or nested run on record): `Subagent <stop id> (<agent>) is no longer running: <state>.` `<state>` is `completed`, `failed` or `interrupted`, mapped as in the table below. A settled child of a foreground run that has returned has no record and gets the no-match error.
- `interrupt` with `index`: `interrupt no longer takes an index; pass the id at the start of the child's row.` `index` on `resume` is untouched.
- `/interrupt-child` with no argument or more than one: the usage line `/interrupt-child <id>` and the running stop ids.
- The background route finds no live runner pid: the existing `No running async run with an interrupt-capable pid was found` error.

| Record | `completed` | `failed` | `interrupted` |
|---|---|---|---|
| Foreground `children` map | `completed` | `failed` | `interrupted` |
| Background step (`status.json`) and nested step record | `complete`, `completed` | `failed` | `paused` |

Unconfirmed outcome:

- No owner answers the inbox request within 1000 ms: `The owner of <stop id> did not confirm the stop within 1000 ms; the stop may still take effect.` The caller removes its own request and sends no other signal. The owner interrupts before it persists its reply (`src/extension/fanout-child.ts:73-99`), so the target may already be stopped and its subtree torn down. If the owner is dead, the target exits through the owner-alive check.

Edges:

- An owner whose liveness reads `unknown` (a permission error) counts as alive.
- A reused pid can make a dead owner read as alive; the child then runs until its own work ends. Accepted.
- On Windows a child sending itself SIGTERM ends at once without cleanup; it still exits.
- A background run started by a child that crashes rather than being stopped keeps running, as today. A background run launched while its ancestor is being stopped is not this case: the stop record and the sweep stop it.
- Two requests for the same target: a request for a target that is already stopping (`stopRequested` set or its run `stopping`, not yet settled) returns the accepted result again and sends no second signal. Once the target has settled, the settled-child error applies.
- A child id and a run id never share a full value (both are UUIDs); a shared six-character prefix is the ambiguous case above.

## Tests

- A unique child-id prefix resolves to that child; a unique run-id prefix resolves to the run; the too-short, no-match and ambiguous errors each name the typed text; a prefix shared by a running child and a settled id is ambiguous; an id on record in both a running async directory and a nested registry resolves once, to the `async` route; a terminal run's `status.json` is read once across two resolutions - `test/unit/run-id-resolver.test.ts`
- With two dispatching children alive under one root, only the owner answers a request, the non-owner leaves the request in place, and nested child 1 alone stops while 0 and 2 complete (replaces ticket rows 8 and 10) - `test/unit/nested-control.test.ts`
- The nested run's parent child receives the outputs of nested children 0 and 2 with child 1 marked interrupted (ticket row 9) - `test/unit/nested-control.test.ts`
- No owner answering within 1000 ms returns the unconfirmed-outcome text, removes only the caller's request, and writes no `interrupt-request-*` file; with the owner's reply write delayed past the deadline, and with it failing, the child is stopped, the stop record exists, and the caller gets the unconfirmed-outcome text - `test/unit/nested-control.test.ts`
- A real nested foreground run with its children in flight and no `onUpdate` callback: each nested child id reaches the registry, resolves through `resolveSubagentRunId`, and stops that child, including a dynamic `parallel` item - `test/integration/foreground-in-flight-control.test.ts`
- A live entry past 3 levels, 12 steps or 16 children survives sanitize, registry merge and step attach; settled entries past them are dropped; a settled run with a live descendant is kept - `test/unit/nested-events.test.ts`
- A run with 17 running children, each with `sessionFile` and `currentPath` at their maximum length, publishes through `writeNestedEvent`, projects into the registry with all 17 ids, and each id resolves and stops its child; a child record arriving before its run record is applied by the next projection; an older child record does not replace a newer one - `test/unit/nested-events.test.ts`, `test/unit/run-id-resolver.test.ts`
- An ancestry of six entries with `childId` round-trips `encodeNestedPathEnv`, `parseNestedPathEnv` and `sanitizeInternalSummary` unchanged - `test/unit/nested-events.test.ts`, `test/unit/pi-args.test.ts`
- A target five ancestors deep with seventeen siblings resolves, has its own row, and stops with its subtree, including a detached background run under it; a sibling outside its ancestry keeps running - `test/integration/async-execution.test.ts`
- `interrupt` with `index`, a settled child id and a pending child id each return their error and stop nothing; a second request for a stopping child returns the accepted result and sends no second signal - `test/integration/indexed-interrupt-errors.test.ts`, renamed `test/integration/interrupt-id-errors.test.ts`
- A foreground `tasks[]` run of three: stopping child 1 by id leaves 0 and 2 to finish; stopping by run id, and a bare `interrupt`, each stop all three; stopping all three one by one by child id returns the targeted result, not the whole-run result; a child-id stop that arrives before the child's `interrupt` callback registers is applied when it registers - `test/integration/foreground-in-flight-control.test.ts`
- A foreground `tasks[]` run with more tasks than `concurrency`: after a run-id stop no queued task is spawned; after a child-id stop the next queued task starts; the same teardown runs when the waiting call's abort signal fires - `test/integration/foreground-in-flight-control.test.ts`, `test/unit/parallel-utils.test.ts`
- A chain with two sequential steps and a parallel step of three: stopping one parallel child by id keeps the predecessor's group result - `test/integration/chain-execution.test.ts`
- `/interrupt-child <id>` stops a nested child while the top-level caller is blocked; no argument and two arguments print the usage line; completions carry stop id, agent and label for foreground, background and nested children, list no child of another session's background run, and extend a value whose six characters collide with a run id or a settled id (replaces ticket rows 6 and 11) - `test/integration/slash-commands.test.ts`
- The stop id is the first token of every row in the tool result and the widget, live and settled, for single, `tasks[]` and chain runs with one and with two foreground runs; the widget title line and detail lines carry none (replaces ticket rows 1-4) - `test/integration/render-widget.test.ts`, `test/unit/render-helpers.test.ts`
- A label shows as `<agent> - <label>` on the live row and the result row for each of the five dispatch shapes (ticket row 5) - `test/integration/render-widget.test.ts`, `test/unit/schemas.test.ts`
- The expanded widget draws every live nested child with its id past two levels and past 12 lines, folds detail lines before settled rows and never a live row; the collapsed view keeps its count line (replaces ticket row 7) - `test/unit/widget-nested-render.test.ts`
- The expanded foreground result of an in-flight run draws its live nested children, fed through `onUpdate`, past two levels and past 12 lines - `test/integration/render-widget.test.ts`
- Status text rows start with the stop id, show no full run UUID on a row, print `<agent> - <label>`, and keep a live nested row past `maxDepth` and `maxLines` - `test/unit/run-status.test.ts`, `test/integration/async-status.test.ts`
- `PI_SUBAGENT_OWNER_PID`, the child id in each ancestry entry, and the `<agent> <stop id> from <parent>` session name reach the child - `test/unit/pi-args.test.ts`, `test/integration/child-session-name.test.ts`
- A child whose owner is killed exits within 5000 ms (one 1000 ms poll, the 3000 ms forced-exit fallback, 1000 ms slack), and that child's own child within 5000 ms of the child's exit; an `unknown` liveness result and an empty `PI_SUBAGENT_OWNER_PID` do not exit. The harness is a node process that loads `src/runs/shared/subagent-prompt-runtime.ts` with a stub Pi API and a real owner pid; the mock child loads no extension (`test/support/mock-pi-script.mjs`) and is not the subject here - new `test/integration/owner-gone-exit.test.ts`
- With the testkit backend: an external attempt's environment carries an empty `PI_SUBAGENT_OWNER_PID` even when the owner's own environment has one; stopping an external child by id ends it through `abort` and `shutdown`; closing the owner's host socket terminates the attempt - `test/integration/foreground-external-execution.test.ts`, `test/integration/background-external-execution.test.ts`
- A background parallel run: stopping one child by id pauses only it; stopping by run id signals every running child and starts no pending step; a signal with no request file stops nothing; a child-id request that precedes callback registration is applied at registration - `test/integration/top-level-async.test.ts`; the tests that write `interrupt-request-all.json` move to the new file name - `test/integration/detached-external-orchestration.test.ts`, `test/integration/background-external-execution.test.ts`
- Stopping a target stops the queued and running background runs recorded under it and no other; a background launch attempted under a stop record is refused; a launch that published just before the stop record was written is swept - `test/integration/async-execution.test.ts`
- After a foreground root returns with a nested background run alive, that run's child still resolves, completes and stops through the retained route; the route is dropped once nothing under it is live; an id from a route this process did not create does not resolve - `test/integration/async-job-tracker.test.ts`
- The typed command in a live interactive session - none: the repo has no interactive harness; the handler-driven test in `test/integration/slash-commands.test.ts` stands in.
- A reused owner pid - none: not reproducible in a test; accepted edge.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `README.md` - child session naming, stopping one child, and the child-environment table: `PI_SUBAGENT_OWNER_PID` added, the `PI_SUBAGENT_RUN_ID` row no longer says its prefix appears in the session name (communication contract, operations); `doc/commands.md` - `Direct commands`, the `/interrupt-child <id>` grammar (communication contract); `doc/programmatic-api.md` - `Foreground stop by index` and `Background stop by index` become stop by id with every link to the renamed anchors updated, including the `interrupt-request-<target id>.json` file, stop records and the owner-alive rule, and `label` on `tasks[]` items and the single-agent call in the parameter text (communication contract, operations); `CHANGELOG.md` - `## [Unreleased]`: `interrupt` with `index` and the `<index> [run-id]` grammar removed, marked breaking, and the child session-name change (communication contract)
- Derived / memory docs invalidated: none

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- `index` on `resume` and the `Revive child` hint.
- OS processes a child's tools spawn; they go down with their child as today.
- Background runs left behind by a child that crashes.
- Cancelling one pending child before it starts; a stop of its run keeps it from starting.
- pi-gauntlet giving a label to each child it dispatches (ticket Out of scope / Follow-up); how a gauntlet wave treats a stopped child stays in jjuraszek/pi-gauntlet#139.
- The execution-backend protocol's `childId` value.
- The index as a stop address, in ticket rows 1-4, 6-8, 10 and 11: replaced by the child-id rule, no follow-up.

## Open questions

- User decision at the gate - row prefix on a collision. Rows and session names show exactly six characters (approved). Two ids on record can share six characters; the row token then returns the ambiguous error, which lists longer prefixes, while completion already inserts the shortest unique prefix. Should a row and a session name whose six characters collide show the same shortest unique prefix completion inserts (longer than six, never a full UUID)? Until the user decides, the six-character commitment stands. Settles: the stop id definition in `### Identity`, the row form in `### Rows`, and the row tests in `test/integration/render-widget.test.ts`.
