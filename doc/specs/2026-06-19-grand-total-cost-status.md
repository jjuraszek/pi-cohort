# Grand-total session cost in the footer status

## Problem

The built-in pi footer shows a single cost figure (`$113.082`) that reflects
**main-loop spend only**. Work delegated to subagents - sync, chain, async,
and nested fanout - runs in child pi processes whose cost never reaches that
figure. No single number answers "what has this whole session cost, including
every subagent and its descendants?"

We want a **grand total** that accumulates main-loop cost plus the cost of every
subagent in the session's subtree, rises monotonically, refreshes live, does not
disturb the built-in footer, and includes async jobs (which the parent observes
only via polling) and nested fanout descendants.

## Ground truth that shapes the design

Established by reading the source, not assumed:

- **Subagents are constrained child processes.** `execution.ts` and
  `subagent-runner.ts` spawn `pi --mode json -p` with `--no-extensions` plus a
  fixed runtime extension set (`pi-args.ts`). A child does **not** load the
  pi-subagents extension, so it cannot run an accumulator or write to a shared
  ledger. The only cross-process channels are the ones that already exist.
- **A plain subagent is a leaf.** It has no subagent tool, so its full cost is
  its own main loop, which the parent already sums from the child's
  `message_end` events (`execution.ts:509`,
  `result.usage.cost += u.cost?.total || 0`). Nesting occurs only through the
  fanout child extension and the `nestedRoute` event sink.
- **A token-aggregation pipeline already exists end to end.**
  `parseSessionTokens` (`session-tokens.ts`) ->
  `subagent-runner` writes `statusPayload.totalTokens` ->
  `async-job-tracker` copies it to `job.totalTokens` (`:206`) ->
  `nested-events` propagates `NestedRunSummary.totalTokens` (`:258`, `:780`) ->
  `tui/render` displays it. `subagent-runner.ts:329` already computes
  `usage.cost` from events but never propagates it.
- **There is no cost field on the transports.** `AsyncStatus`, `AsyncJobState`,
  `NestedRunSummary`, and `NestedStepSummary` carry `totalTokens: TokenUsage`
  (`{input, output, total}` - token counts) but no dollar figure.
- **Two cost shapes.** pi-core session/stream events expose cost as an object
  (`usage.cost.total`); the local `Usage` type (`execution.ts:74`) uses a scalar
  `cost: number`. Extraction must read `cost?.total ?? 0` at event boundaries and
  the scalar where the run result already aggregated it.

## Decisions

- **Owner: pi-subagents.** It already holds the subagent cost data, the async
  poller, and the token-propagation pipeline; it can also read main-loop cost
  in-process. pi-essentials is untouched.
- **New figure, not an override.** The built-in `$` stays as-is. We add a
  distinct `Σ$` grand total. Overriding the built-in number would require
  replacing the whole footer (`setFooter`); rejected as fragile against pi core
  changes.
- **Mechanism: `ctx.ui.setStatus` under one key we own.** The footer renders
  three lines: cwd, the built-in stats line (with `$`), and a third line that
  joins **all** extension statuses, sorted alphabetically by key
  (`footer.js`). We render `Σ$X.XXX` under our own key and touch nothing else.
  pi-essentials renders the session name under its own key; both land on the
  shared status line, ordered by key. We do not force adjacency or overwrite any
  other extension's status.
- **Cost rides alongside `totalTokens`.** Rather than invent a parallel
  accumulator (which would double-count against the existing token pipeline), we
  add a cost field next to `totalTokens` at every hop that already carries it,
  and sum it at the top level the same way tokens are aggregated. Single source
  of truth.
- **Subtree semantics.** Each run reports its **subtree** cost (own main loop +
  its children's reported cost). Recursion bottoms out at leaves, where subtree
  cost = main-loop cost (already captured). Nested fanout descendants ride the
  existing `NestedRunSummary` propagation.
- **Cadence.** The total refreshes as new cost is observed: top-level main loop
  per completed assistant message (`message_end`); sync runs on each `progress`
  update and at completion; async jobs on each poll tick. It is not literally
  per-token (no per-token cost event exists) - it is per observed cost update.
- **Per-session lifetime.** Accumulators are in-memory in `index.ts`, seeded on
  start/resume from the active session's existing cost (so `Σ$` does not start
  below the built-in `$` after a resume), and cleared on `session_shutdown`. An
  async job detached from a **prior** session is out of scope and not counted.
- **Format: `│ Σ$X.XXX`**, three decimals to match the built-in `$`. The leading
  `│` divider separates our figure from the preceding extension status on the
  shared, space-joined footer status line (without it a bare `Σ$` reads as the
  neighbour's number, e.g. `navigator: (read-only) Σ$192.006`). No other
  annotation or subagent-delta suffix.

## Architecture

A grand-total accumulator lives on extension-local state in
`src/extension/index.ts` (not the cross-process `SubagentState`). It sums:

```
Σ$ = mainCost + syncSubtreeCost + asyncSubtreeCost
```

- **`mainCost`** - top-level main-loop spend. `pi.on("message_end")` adds
  `event.message.usage.cost.total` for assistant messages. Seeded on
  start/resume by summing `cost.total` over the active session branch's existing
  assistant entries, so a resumed session starts at parity with the built-in
  `$`. New / forked sessions seed at 0.
- **`syncSubtreeCost`** - foreground runs/chains. `execution.ts` already
  aggregates each run's subtree cost into `result.usage.cost` (leaf main loop;
  fanout adds nested children via the cost propagation below). The extension
  tracks `syncCompletedCost` (sum of sealed completed runs) plus a
  `Map<runId, number>` of live in-flight runs from `progress` updates, so
  concurrent/overlapping runs neither double-count nor regress.
- **`asyncSubtreeCost`** - `Map<jobId, number>` of each async job's latest
  reported subtree cost, refreshed by the poller and sealed by the completion
  handler. Finished entries are retained (not removed) so tracker eviction never
  drops the total.

Every update path ends in one `recompute()` (a pure sum) + one `setStatus`.
`recompute()` never rescans "live-only" state, so it cannot regress.

Status key: a named constant (e.g. `GRAND_TOTAL_STATUS_KEY = "subagents-grand-total"`).
Rendered string: `Σ$` + total formatted to three decimals.

## Cost propagation (the new plumbing)

Mirror the `totalTokens` pipeline with a sibling cost field:

| Hop | Today (tokens) | Add (cost) |
|---|---|---|
| Session scan | `parseSessionTokens(dir) -> TokenUsage` | also return summed `cost.total`; callers read it |
| Async status write | `subagent-runner` sets `statusPayload.totalTokens` | set `statusPayload.totalCost` (runner already computes `usage.cost` at `:329`) |
| Status type | `AsyncStatus.totalTokens` | `AsyncStatus.totalCost?: number` |
| Tracker copy | `job.totalTokens = status.totalTokens` (`:206`) | `job.totalCost = status.totalCost` |
| Job state type | `AsyncJobState.totalTokens` | `AsyncJobState.totalCost?: number` |
| Nested summary | `NestedRunSummary.totalTokens` (propagated `:258`, `:780`) | `NestedRunSummary.totalCost?: number`, propagated the same way |

The top level sums cost over the same job/registry set the TUI already iterates
for tokens; because nested descendants are folded into their parent's reported
subtree cost via this propagation, summing direct children (plus own main loop)
yields the full subtree without double-counting.

## Update flow

1. `message_end` (top-level) -> `mainCost += cost.total` -> `recompute()` ->
   `setStatus`.
2. Foreground run `progress` tick -> set that run's entry in the live map ->
   `recompute()`. On completion -> move into `syncCompletedCost`, drop the live
   entry -> `recompute()`.
3. Poller tick -> set `asyncCost[jobId] = job.totalCost` for each known job ->
   `recompute()`.
4. Async completion -> seal `asyncCost[jobId]` to final -> `recompute()`. Entry
   retained.

## Monotonicity

Each source only grows: `mainCost` sums non-negative deltas; `syncCompletedCost`
plus per-run live entries each only increase, and sealing adds a value >= the
last live contribution; async per-job values are monotonic and finished jobs
stay in the map. The only reset is the deliberate per-session clear.

## Error and edge cases

- **Missing cost** (provider reports none): `cost?.total ?? 0`; never `NaN`.
- **Headless / no UI** (`hasUI` false): keep accumulating, skip `setStatus`.
- **Resume**: seed `mainCost` from existing session entries so `Σ$` >= built-in
  `$` from the first render.
- **Fork / compact** emits `message_end`: `Σ$` reflects all observed spend and
  may exceed the active-branch built-in `$`. Accepted as "total spent";
  documented, not reconciled.
- **Async job from a prior session**: out of scope; not counted.
- **`setStatus` placement**: pi composes the shared status line and sorts by
  key; we do not force `Σ$` adjacency to the session name and never overwrite
  another extension's status.

## Testing

Unit tests over the accumulator and the cost-propagation helpers with synthetic
events - no live model calls. New test file
`test/unit/grand-total-cost.test.ts`:
- `recompute()` sums `mainCost` + sync + async correctly, including empty states.
- Concurrent sync runs: two live `runId` entries sum without double-count; one
  completing moves to `syncCompletedCost` without regressing the total.
- Async eviction does not decrement: seal a job, simulate tracker eviction,
  assert the total holds.
- Zero-cost guard: an event with absent `usage.cost` adds `0`, never `NaN`.
- Resume seeding: existing session entries seed `mainCost` at parity.
- Per-session reset: `session_shutdown` clears all accumulators.
- Cost extraction parity: extended `parseSessionTokens` (or its cost sibling)
  sums `cost.total` over a fixture `.jsonl` matching its token sum.
- Monotonic sequence: a scripted series of main/sync/async updates is
  non-decreasing.

Run: `env -u PI_CODING_AGENT_DIR npm run test:unit`.

## Documentation impact

- **README.md** - document the new `Σ$` grand-total footer status (what it
  includes - main loop + full subagent subtree -, that it is distinct from the
  built-in `$`, per-session lifetime).
- **CHANGELOG.md** - new entry.
- **AGENTS.md** - none.

## Out of scope

- **Other extensions' model cost.** `Σ$` covers main loop + subagents only.
  Cost spent by other extensions' own models (e.g. `pi-context-prune`, which
  renders its own `$` on the footer status line) is not folded in - it is
  neither the main loop nor a subagent, and no general API exposes it without
  scraping another extension's status. `Σ$` will sit as a third `$` on the
  shared status line, beside any such extension figure.
- Cross-session / detached async job accounting.
- Reconciling `Σ$` against the active branch after fork/compact.
- Any change to the built-in footer or its `$` figure.
- Rendering or owning the session name (pi-essentials' job).
- A configurable display format or annotation (bare `Σ$X.XXX` only).
