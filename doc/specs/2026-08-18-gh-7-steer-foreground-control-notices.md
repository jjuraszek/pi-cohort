# Steer foreground control notices (gh-7)

Ticket: [jjuraszek/pi-cohort#7](https://github.com/jjuraszek/pi-cohort/issues/7)

## Problem

`deliverControlNotice` (`src/extension/control-notices.ts:38-57`) sends foreground
control notices with `{ triggerTurn: false }`. In pi's `sendCustomMessage` branch
dispatch, `triggerTurn: false` skips the steer path unconditionally and raw-pushes
the custom message into `agent.state.messages` - even while a run is streaming.
Every foreground notice fires from inside the parent's own in-flight `subagent`
tool call (`src/runs/foreground/subagent-executor.ts:380-401` emits synchronously
from `execute()`), so the notice is persisted between an assistant `toolCall` and
its `toolResult`:

```
assistant(toolCall subagent_82) / custom(subagent_control_notice) / toolResult(subagent_82)
```

Downstream, `convertToLlm` maps `custom -> role:"user"`; pi-ai's
`transformMessages` treats the user message as a tool-flow interrupt, injects a
synthetic `tool_result`, and the real result then duplicates the `tool_use_id` in
the merged turn. The Anthropic API rejects the request (400,
"unexpected `tool_use_id` found in `tool_result` blocks") and the session is
bricked - recoverable only by `/tree` fork or hand-editing the JSONL. This is
deterministic for any foreground child that stalls past the needs-attention
threshold mid-tool-cycle (two independently reproduced occurrences; the mechanism
is 100% reliable once the stall trigger fires).

All branch/drain claims were verified against the host-installed
`@earendil-works/pi-coding-agent@0.84.2` runtime (the pi actually running this
extension; `peerDependencies` is `"*"`). Note the version skew: this repo's own
devDependency lock is `0.74.2`, whose `sendCustomMessage` steers unconditionally
whenever `isStreaming` and never consults `triggerTurn` - the vulnerable
`isStreaming && triggerTurn !== false` branch exists from `0.84.x`. On
pre-`0.84.x` runtimes the fix is an inert no-op while streaming (steer happens
regardless), never unsafe; the unit tests assert only the options bag passed to
the `sendMessage` stub, so they remain valid proof under either locked runtime.
Verified on `0.84.2`: `sendCustomMessage`'s dispatch order
(steer only when `isStreaming && triggerTurn !== false`), `agent.steer` enqueuing
onto `steeringQueue`, and the agent loop draining steered messages at the top of
the next inner-loop iteration - after all `toolResult`s for the current turn,
before the next `streamAssistantResponse`. A steered custom message always lands
at a clean turn boundary and is persisted via the same
`appendCustomMessageEntry` path as the raw push, so durability is unchanged.

`control-notices.ts:55` is the repo's only `triggerTurn: false` call site; the
other `sendMessage` call sites (`notify.ts:103` with `true`,
`slash-commands.ts:320/331/347` with no options) are unaffected.

## Design

One production file changes: `src/extension/control-notices.ts`.

1. `deliverControlNotice`'s input type gains one field: `isIdle: () => boolean`.
2. Its `sendMessage` options change from
   `{ triggerTurn: input.details.source !== "foreground" }` to:

   ```ts
   { triggerTurn: input.details.source !== "foreground" || !input.isIdle() }
   ```

3. `handleSubagentControlNotice` - which already receives `state` - builds the
   closure at both of its `deliverControlNotice` call sites (immediate
   non-foreground delivery and the foreground debounce-timer callback):

   ```ts
   isIdle: () => input.state.lastUiContext?.isIdle() ?? false
   ```

No `index.ts` change, no new `SubagentState` field, no new `pi.on` subscription,
no new exported surface. `state.lastUiContext` is already refreshed on assistant
`message_end`, on UI `subagent` `tool_result`, and at session start
(`src/extension/index.ts:535-575`), so it is populated by the time any foreground
notice can fire. `ExtensionContext.isIdle(): boolean` is confirmed present in the
host runtime typings (`core/extensions/types.d.ts:232` in `0.84.2`; `:221` in
the repo-locked `0.74.2`).

Resulting behavior:

| Source | Session state | triggerTurn | pi branch taken |
|---|---|---|---|
| async (non-foreground) | any | `true` | steer while streaming / `_runAgentPrompt` while idle (unchanged) |
| foreground | streaming | `true` | **steer** - drains at the next turn boundary, never splices an open tool cycle |
| foreground | idle | `false` | raw append, no unsolicited turn (current idle behavior, preserved) |

The closure is evaluated at fire time - inside the debounce timer callback, at the
moment of the actual `sendMessage` - so a session whose streaming state changed
during the 1s foreground delay is classified by its state at delivery, not at
event receipt.

Foreground debounce, dedup (`visibleControlNotices`),
`clearPendingForegroundControlNotices`, actionability recheck
(`isForegroundNoticeStillActionable`), and intercom delivery are all unchanged.

## Edge cases

- `state.lastUiContext` unset (pre-`session_start`): `?? false` treats unknown as
  busy, yielding `triggerTurn: true`. Fails safe - steering/triggering while idle
  starts an unsolicited turn at worst; it never corrupts a tool cycle. Effectively
  unreachable since `session_start` sets `lastUiContext`.
- Idle foreground notice (`triggerTurn: false`): the notice lands in context with
  no immediate turn; the parent reads it on the next user message. This is the
  existing intended idle behavior and matches the issue's acceptance criteria.
- Session goes idle (or busy) between debounce arm and fire: fire-time evaluation
  picks the correct branch in both directions.

## Out of scope

- Integration-level reproduction of the `transformMessages` corruption: the
  corruption chain runs through pi's host session/transform layers, which the
  unit harness stubs out entirely - there is no way to drive real
  `convertToLlm`/`transformMessages` message flow from this repo's tests.
  Unit-level `triggerTurn` assertions are the accepted proof.
- Repairing already-corrupted session branches: pi-condense's concern
  (cross-referenced as `jjuraszek/pi-condense#11` in the issue roast).
- `visibleControlNotices` process-lifetime dedup keying (no `runId` in the key):
  a pre-existing limitation independent of delivery mechanics - a notice shown
  once suppresses for the whole process lifetime; explicitly not touched here.
- Proposed upstream pi API (not yet in pi: `deliverAs: "safeBoundary"`,
  exposing `pendingToolCalls`): unnecessary once steer is adopted.

## Testing

Extend `test/unit/control-notices.test.ts` using its existing conventions
(`node:test` + `node:assert`, real short timers with `await wait(...)`, the
`makeRecorder()` `sendMessage` stub, the `makeState()` helper). Add an optional
`lastUiContext` override to `makeState`, faked as a minimal inline object
`{ isIdle: () => bool }` cast as `SubagentState["lastUiContext"]` (type already
imported) - no import or mock of `ExtensionContext` from the pi package.

Prerequisites the new foreground cases must replicate from the existing tests:
delivery only happens when `isForegroundNoticeStillActionable` passes, so each
case needs a matching `state.foregroundControls` entry (e.g.
`state.foregroundControls.set("run-1", { runId: "run-1", currentAgent:
"worker", currentIndex: 0, currentActivityState: "needs_attention", ... })`)
and a short `foregroundDelayMs`, mirroring the existing fixture pattern.

One existing assertion must be retargeted: the current foreground test uses
`makeState()` (`lastUiContext: null`) and asserts `{ triggerTurn: false }`;
under the `?? false` fallback that setup now yields `triggerTurn: true`. Update
that test to inject `{ isIdle: () => true }` (making it the idle case) so it
does not collide with the new null-context case.

Cases:

1. Foreground notice while streaming (`isIdle() === false`) -> `sendMessage`
   options carry `triggerTurn: true`.
2. Foreground notice while idle (`isIdle() === true`) -> `triggerTurn: false`.
3. Foreground notice with `lastUiContext: null` -> `triggerTurn: true` (fallback).
4. Non-foreground notice while idle -> `triggerTurn: true` (unchanged).
5. Fire-time evaluation: arm the foreground debounce, flip the fake's idle state
   before the timer fires (mutable closure - `let idle = false; { isIdle: () =>
   idle }` - then flip `idle`, not a replaced `lastUiContext` object), assert
   the delivered value reflects the state at fire time.
6. Dedup unchanged (AC 3): deliver the same notice twice through
   `handleSubagentControlNotice` with a shared `visibleControlNotices` set,
   assert exactly one `sendMessage` call.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:unit` (and
`npm run test:all` before ship), per `AGENTS.md`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/observability.md` - append one sentence
  under the existing `## Events` heading (the file has no notices subsection):
  "While the session is streaming, foreground control notices are steered to a
  turn boundary - never between an assistant `toolCall` and its `toolResult`;
  while idle, they append without starting a turn." (issue AC 4; behavioral
  guarantee, not a code-mirror)
- Derived / memory docs invalidated: none

`CHANGELOG.md` gets a fix entry at implementation time per repo convention.

## Acceptance criteria (from issue #7, post-roast)

1. `test/unit/control-notices.test.ts`: a foreground notice delivered while the
   session is streaming calls `sendMessage` with `triggerTurn: true`; while idle,
   with `triggerTurn: false`.
2. Non-foreground delivery unchanged: always `triggerTurn: true`.
3. Existing foreground debounce, dedup, and
   `clearPendingForegroundControlNotices` behavior unchanged - no new parking
   structure, no new `pi.on` subscription, no new `SubagentState` field.
4. `doc/observability.md` states the delivery guarantee (turn-boundary steering,
   never inside an open tool cycle).

## Open questions

None.
