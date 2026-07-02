# Spec: `cost:external` cross-extension cost protocol

Date: 2026-06-21
Status: Draft (pending user approval)
Worktree: `.worktrees/cost-external-protocol`

## Problem

pi-cohort owns the unified spend line - the `Σ$` grand total rendered by
`src/extension/grand-total.ts`. Today it sums two cost signals:

1. main-loop assistant-message cost (`recordMainCost`, fed by `message_end`);
2. per-subagent-run cost (`syncCostByRun` + `asyncCostByJob` maps).

Some companion extensions spend on LLM calls that never flow through the agent
loop. The first concrete case is **pi-context-prune**, which makes its own
`stream()` summarization calls that bypass the loop, so they never hit
`message_end` and are invisible in `Σ$` today. This spec adds a **third cost
signal**: external spend reported by other extensions over the shared
`pi.events` bus, folded into the same `Σ$` total.

The mechanism is a **generic cross-extension cost protocol**, not a
pruner-specific hook. Any extension can contribute by emitting on the agreed
channel.

This spec also folds in a small, related status-rendering change: **wrapping
every status this package emits in box-drawing dividers** (`│ ... │`) so the
package's footer entries are visually isolated regardless of which order pi
loads extensions in. Both changes touch the same status-line surface, so they
ship together; see [Status divider wrapping](#status-divider-wrapping-all-package-statuses).

## Wire contract (fixed - do not re-litigate)

This shape is already agreed with the producer side (pi-context-prune is being
specced in parallel against the same contract). It is a hard interface.

- **Channel:** `pi.events` string channel `"cost:external"`.
- **Payload** (cumulative-per-source, **not** deltas):

  ```
  {
    source: string;        // stable producer id, e.g. "pi-context-prune"
    totalCost: number;     // cumulative USD this source has spent THIS session
    inputTokens?: number;  // optional cumulative, for breakdown display
    outputTokens?: number; // optional cumulative
  }
  ```

- Producers emit their **cumulative session total** on **every** update.
  pi-cohort keeps a `Map<source, entry>`, recomputes
  `external = Σ totalCost over the map`, and folds it into the grand total
  alongside `mainCost + sync + async`.
- Cumulative-per-source makes it **idempotent and replay-safe**: a double-fire
  or re-emit overwrites the same key - never double-counts. This mirrors the
  existing `syncCostByRun` / `asyncCostByJob` map pattern.
- **Producer obligation on resume (SHOULD).** A producer that wants its spend
  visible after a session resume SHOULD re-emit its current cumulative total
  when its own `session_start` fires. pi-cohort does not persist or reseed
  the external slice (see [Hard constraints](#hard-constraints-decided---do-not-reopen)),
  so without this re-emit the source's spend is absent until its next update.
  This is a documented producer recommendation, not part of the payload shape;
  the parallel pi-context-prune spec must honor it for post-resume visibility.

## Hard constraints (decided - do not reopen)

- **Live-only / ephemeral.** No session reseed for the external slice. The map
  starts empty on `session_start`; pi-cohort does **not** read other
  extensions' session entries. Rationale: external is a minor fraction of the
  sum; durability is not worth coupling pi-cohort to another extension's
  entry schema.
- **Fire-and-forget.** pi-cohort must tolerate zero producers (no-op),
  multiple producers, and unknown/new sources without error.

## Design

### State shape

`SubagentState["grandTotal"]` (`src/shared/types.ts`) gains a fourth field. The
sync/async maps store bare numbers; external stores a small struct because the
contract carries an optional token breakdown for doctor display.

```ts
grandTotal: {
  mainCost: number;
  syncCostByRun: Map<string, number>;
  asyncCostByJob: Map<string, number>;
  externalCostBySource: Map<string, ExternalCostEntry>;  // NEW
}

interface ExternalCostEntry {
  totalCost: number;
  inputTokens?: number;
  outputTokens?: number;
}
```

`ExternalCostEntry` is declared in `src/shared/types.ts` next to the
`grandTotal` definition.

### Accounting module (`src/extension/grand-total.ts`)

Three changes:

1. **`emptyGrandTotal()`** adds `externalCostBySource: new Map()`. This is the
   only constructor of the initial `grandTotal`; it is called on extension init
   and on every `session_start`, so the map is always created empty.

2. **`recordExternalCost(gt, payload): boolean`** - new function, the single
   validation + sanitization boundary for untrusted cross-extension input. It
   accepts `payload: unknown`, narrows it structurally, sanitizes per the rules
   below, and on a usable payload does
   `gt.externalCostBySource.set(source, entry)` and returns `true`. On a
   fully-rejected payload it leaves the map untouched and returns `false`.

   **Plain `set`, not `Math.max`.** Unlike `recordSyncCost` /
   `recordAsyncCost` (which `Math.max` against the prior value to guard against
   stale/out-of-order run updates), external uses a plain overwrite. The
   contract specifies cumulative-per-source with "re-emit overwrites the same
   key"; the source owns its cumulative figure and we do not second-guess it.
   Stated divergence, deliberate. **Consequence:** the external slice is **not
   monotonic** - a producer correcting its cumulative downward (e.g. after a
   recount) lowers `Σ$`. The existing main/sync/async slices remain monotonic;
   only external can move down. The documentation section amends the README
   monotonicity claim to carve this out (see [Documentation impact](#documentation-impact)).

3. **`recompute(gt)`** gains one term:

   ```ts
   let total = safe(gt.mainCost);
   for (const v of gt.syncCostByRun.values()) total += safe(v);
   for (const v of gt.asyncCostByJob.values()) total += safe(v);
   for (const e of gt.externalCostBySource.values()) total += safe(e.totalCost);
   return total;
   ```

`renderGrandTotal(state)` and `formatGrandTotal(total)` are unchanged - they
already format whatever `recompute` returns into the `Σ$` footer.

### Validation & sanitization (C + B)

All inbound sanitization lives in `recordExternalCost` - the one boundary.
Nothing downstream re-validates; `recompute` trusts the map. Payload arrives as
`unknown`; the function does its own `typeof` narrowing rather than trusting a
cast. Unknown extra fields are ignored.

| Field | Rule | On violation |
|---|---|---|
| `source` | non-empty string after `trim()` | reject whole payload (cannot key the map) |
| `totalCost` | finite number (`Number.isFinite`) | reject whole payload (cannot sum) |
| `totalCost` | negative | clamp to `0`, keep payload |
| `inputTokens` | finite and `>= 0` | drop just this field (store `undefined`) |
| `outputTokens` | finite and `>= 0` | drop just this field (store `undefined`) |

Salvage what is valid, clamp the obvious, reject only the unusable. Negative or
`NaN` tokens never poison the cost sum - they are display-only and
independently salvaged. A payload with good `source` + `totalCost` but garbage
`inputTokens` still records the cost; only the bad optional field is dropped.

**Logging (the B half).** On a **hard reject** (unusable `source` or non-finite
`totalCost`), emit one `console.warn(...)` line - the same logging primitive
the codebase already uses for diagnostics (e.g. `src/intercom/intercom-bridge.ts`).
The message names `source` (or `"<missing>"`) and the reason. No logger
parameter is threaded into `recordExternalCost`; it calls `console.warn`
directly, matching the existing pattern. Clamps and dropped optional fields are
**silent** - they are expected producer sloppiness, not errors, and logging
them would spam. Rejects are rare and indicate a genuinely broken producer, so
they are worth one diagnostic line.

### Event wiring + rerender (`src/extension/index.ts`)

A `cost:external` subscription is added to the existing `eventUnsubscribes`
array (built next to the `SUBAGENT_ASYNC_*` registrations around L496-499), so
teardown is identical to the existing event handlers - no new lifecycle path.

```ts
const eventUnsubscribes = [
  pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, handleStarted),
  pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, handleComplete),
  pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
  pi.events.on("cost:external", (payload) => {
    if (recordExternalCost(state.grandTotal, payload)) {
      renderGrandTotal(state);
    }
  }),
];
globalStore[eventUnsubscribeStoreKey] = eventUnsubscribes;
```

The `cost:external` entry goes **inside the array literal** that is then
assigned to `globalStore[eventUnsubscribeStoreKey]`. Do not `push` to the array
after that assignment - the existing teardown loop iterates the array captured
at assignment time, and a late push would leak the subscription.

**The rerender is the core behavior.** Event in -> validate/sanitize -> map
updated -> `recompute` -> `Σ$` footer repainted. The handler repaints on every
**accepted** event (boolean `true`), including an idempotent re-emit of an
identical cumulative total (harmless: recompute yields the same sum, footer
redraws to the same string). Rejected payloads (boolean `false`) do not
repaint. We do not diff values before repainting - it is cheap and guarantees
the contract's "emit cumulative on every update" always reflects in `Σ$`.

`renderGrandTotal(state)` takes a single argument and reads
`state.lastUiContext` internally; the handler does not need a `ctx`.

### Session lifecycle (live-only)

- `resetSessionState` (called from `session_start`) already does
  `state.grandTotal = emptyGrandTotal()` then `seedMainCostFromSession(...)`.
  The new map is created empty by `emptyGrandTotal()` and is **never reseeded**.
  `seedMainCostFromSession` is **not** extended to external - pi-cohort does
  not read other extensions' session entries (hard constraint).
- **Post-resume consequence:** after a resume, `Σ$` reflects external spend only
  from `cost:external` events fired in the resumed session. A producer's prior
  spend reappears only if that producer re-emits its cumulative total - which is
  a producer-side **SHOULD**, not a guarantee of the payload contract (see the
  producer obligation in [Wire contract](#wire-contract-fixed---do-not-relitigate)).
  Because payloads are cumulative-per-source, one re-emit restores the correct
  figure; no catch-up protocol is needed on our side. A producer that never
  re-emits stays absent from the external slice for the resumed session - an
  accepted limitation of the live-only design.
- **Teardown:** the `cost:external` unsubscribe rides the existing
  `eventUnsubscribes` loop in `session_shutdown`. The map is per-`state`, so it
  dies with the session; `emptyGrandTotal()` on the next `session_start`
  guarantees a clean slate even if `state` is reused.
- **Zero-producer case:** the map stays empty, `Σ externalCostBySource = 0`,
  `Σ$` is byte-identical to today. No producer, no behavior change.

### Doctor breakdown (`src/extension/doctor.ts`)

`buildDoctorReport(input)` already receives `DoctorReportInput` with
`state: SubagentState`, so it has `state.grandTotal` in hand - no new plumbing.
A `Cost` section is appended to the `lines` array, following the existing
section pattern (Runtime / Filesystem / Discovery / Intercom bridge), produced
by a new `formatCostLines(input): string[]` helper. The footer stays a bare
`Σ$` (decision A); the per-source breakdown is doctor-only (decision B), and
the doctor section is **read-only** - it never mutates the map.

Rendered shape:

```
Cost
- main:     $0.0421
- sync:     $0.0xxx  (N runs)
- async:    $0.0xxx  (N jobs)
- external: $0.0xxx  (M sources)
  - pi-context-prune   $0.0xxx   (in 1.2k / out 0.4k)
  - <other-source>     $0.0xxx
- Σ total:  $0.0xxx
```

- The `external` summary line is **always** rendered (consistent with the other
  three signals), showing `$0.000 (0 sources)` when the map is empty.
- **Per-source sub-rows are shown only when `externalCostBySource` is
  non-empty.** Token columns on a sub-row render only when that source supplied
  them.
- **Token formatting.** A sub-row's `(in .../ out ...)` segment formats each
  count as: raw integer when `< 1000`, else `(Math.round(n / 100) / 10).toFixed(1) + "k"`
  (so `1234` -> `"1.2k"`, `400` -> `"400"`). The helper is declared inline in
  `doctor.ts` alongside `formatCostLines`; no shared utility is introduced.

### Status divider wrapping (all package statuses)

**Goal:** every status this package writes to the shared footer is wrapped in
box-drawing dividers on **both** sides - `│ <text> │` - so it reads as one
isolated unit regardless of which neighbouring extension's status precedes or
follows it. Today only `formatGrandTotal` self-protects, and only on the
leading side (`grand-total.ts:42` hardcodes `` `│ Σ$${...}` ``); the
`subagent-slash` status has no divider at all.

**Single source of truth.** `src/shared/status-format.ts` (the existing
status-string module) gains:

```ts
export const STATUS_DIVIDER = "│";  // U+2502 box-drawing, matches shipped grand-total
export function wrapStatus(text: string): string {
  return `${STATUS_DIVIDER} ${text} ${STATUS_DIVIDER}`;
}
```

The box-drawing `│` (not ASCII `|`) is a deliberate, justified visual mark per
`AGENTS.md`; it stays consistent with the already-shipped grand-total divider
and stays visually distinct from the literal ` | ` separator already inside the
`subagent-slash` text.

**Applied at every text-emitting call site:**

| Site | Today | After |
|---|---|---|
| `grand-total.ts:42` (`formatGrandTotal`) | returns `` `│ Σ$${total.toFixed(3)}` `` | returns `wrapStatus(\`Σ$${total.toFixed(3)}\`)` |
| `slash-commands.ts:202` | `setStatus("subagent-slash", "running...")` | `setStatus("subagent-slash", wrapStatus("running..."))` |
| `slash-commands.ts:221` | `setStatus("subagent-slash", \`${count} tools${tool} | Ctrl+O live detail\`)` | same text, wrapped via `wrapStatus(...)` |

`formatGrandTotal` drops its hand-rolled leading `` `│ ` `` and routes through
`wrapStatus`, so the divider definition lives in exactly one place. The two
`setStatus("subagent-slash", undefined)` **clears** (`slash-commands.ts:338`,
`:354`) and the grand-total clear (`index.ts:581`) are untouched - they remove
the status, so there is nothing to wrap.

**Trade-off, accepted:** symmetric wrapping means when this package's status
renders **last** on the footer, the trailing `│` dangles with nothing after it
(`... Σ$0.042 │`). That is the cost of order-independence: the package no longer
relies on a neighbour rendering after it to look bounded.

## Testing

Node `--test` with type-stripping, in `test/unit/`, mirroring
`test/unit/grand-total-cost.test.ts`. Run with:

```bash
env -u PI_CODING_AGENT_DIR npm run test:unit
```

- **`recordExternalCost`:** valid payload sets map + returns `true`; re-emit
  same source overwrites (no double-count); two sources sum; clamp negative
  `totalCost` to `0`; reject non-finite `totalCost` (returns `false`, map
  untouched); reject empty / missing / whitespace-only `source`; drop a bad
  optional token field but keep the cost; ignore unknown extra fields.
- **`recompute`:** folds external alongside main/sync/async; empty external map
  equals today's sum.
- **`emptyGrandTotal`:** `externalCostBySource` present and empty.
- **Lifecycle:** a `session_start` reset leaves the external map empty (no
  reseed touches it).
- **Handler:** an accepted event triggers a render; a rejected event does not
  (assert via the boolean return / a render spy).
- **Doctor:** `Cost` section lists per-source rows when the map is non-empty;
  suppresses sub-rows (but keeps the `external` summary line) when empty.
- **`wrapStatus`:** returns `│ <text> │` (both sides, single space padding);
  `formatGrandTotal` output is wrapped (assert it starts and ends with
  `STATUS_DIVIDER`). Add to or alongside the existing status-format unit test
  for `src/shared/status-format.ts` if one exists; otherwise a focused case in
  the grand-total test file.

## Documentation impact

Three docs change, shipping in the same worktree commit:

1. **`README.md` - grand-total section.** Today it states other extensions'
   model cost is excluded; that sentence is rewritten. The same section's
   monotonicity claim (`README.md:162`, "only ever rises within a session") is
   amended to carve out the external slice: main/sync/async only rise, but the
   external slice may move down when a producer corrects its cumulative total.
   The section gains a
   **`cost:external` protocol** subsection - the integrator-facing contract so
   future producers wire in without reading our source. As a structured,
   LLM-readable block it documents: the channel name; the payload shape
   (cumulative-per-source, not deltas; emit cumulative on every update); the
   idempotency / replay guarantee; the live-only behavior (not persisted or
   reseeded; re-emit on your own `session_start` to restore post-resume); the
   sanitization summary (negative cost clamped, bad optional tokens dropped,
   unusable `source` / `totalCost` rejected); and where it surfaces (folded into
   `Σ$`, per-source breakdown in `subagent({ action: "doctor" })`).
2. **`README.md` - doctor section.** Note the new `Cost` section with per-source
   external rows.
3. **`CHANGELOG.md` - `[Unreleased]`.** Reword the existing grand-total `Added`
   line: drop "Other extensions' model cost is out of scope" (now opt-in via the
   `cost:external` protocol) and qualify the "monotonic" claim (the external
   slice may move down on a producer correction). Add an `Added` bullet for the
   protocol itself, and a `Changed` bullet for the `│ ... │` status wrapping
   (all package footer statuses are now divider-isolated).

No separate `doc/` protocol file - README is the single consumer-facing home
(one source of truth).

## Out of scope

- Persistence / session reseed of the external slice (explicitly excluded by
  the live-only constraint).
- Per-source breakdown in the footer or in `subagent({ action: "status" })` -
  the footer stays a bare `Σ$`; the breakdown lives only in `doctor`.
- Any change to the producer side (specced in parallel in the pi-context-prune
  repo against this same contract).
- A delta-based or ack-based protocol variant - the contract is
  cumulative-per-source, fixed.
- Suppressing the dangling trailing `│` when the package status renders last -
  symmetric wrapping is the decision; no neighbour-detection or conditional
  trailing divider.
- Changing the divider glyph to ASCII `|`, or introducing a `subagent-slash`
  status-key constant - out of scope for this change.
