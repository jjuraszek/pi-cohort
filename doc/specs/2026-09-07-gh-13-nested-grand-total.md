# Fix nested child grand-total initialization (#13)

## Context

A Pi child agent may delegate to another child when nested fanout is enabled. Each delegating process owns a `SubagentState`, and that state is required to carry a grand-total cost accumulator for foreground progress accounting. The top-level extension initializes this accumulator, but the child-safe extension does not. In child-safe mode the accumulator satisfies the shared-state contract; it is not rendered locally, and nested cost reaches the parent through nested-run summaries.

This is a narrow correction under the existing grand-total design in `doc/specs/2026-06-19-grand-total-cost-status.md`; it does not supersede that design.

## Problem

Any nested foreground delegation can crash at its first `recordSyncCost()` call, whether the reported cost is zero or non-zero. Single, parallel, and chain execution all dereference `state.grandTotal.syncCostByRun`; the child-safe state has no `grandTotal`, so the lead cannot complete normally.

For example, a deterministic parent -> lead -> grandchild single run admits the grandchild, then fails with `TypeError: Cannot read properties of undefined (reading 'syncCostByRun')` before either the grandchild or lead final response is observed. The single-run regression is a deliberate proxy for the same missing-state failure in all three foreground modes. Forwarded cumulative snapshots `0`, `0.25`, and `0.25` must be observed without failure, while map-level deduplication remains covered by the accumulator unit tests.

## Goals

- Restore the invariant that every `SubagentState` used by the foreground executor has a valid grand-total accumulator.
- Exercise the child-safe registration and nested progress path through a deterministic subprocess-backed integration test.
- Preserve existing cumulative snapshot semantics and avoid double counting repeated progress or completion values.
- Confine any merge interaction with the in-progress #11 intercom-removal branch to the import block of `src/extension/fanout-child.ts`.

## Non-goals

- Change cost aggregation, nested-event transport, progress rendering, or executor behavior.
- Make `recordSyncCost()` accept an absent accumulator.
- Change failed-child propagation, cancellation, malformed-output handling, discovery, isolation, CI, release, or preset behavior.
- Modify the #11-owned files listed in `doc/plans/2026-09-06-gh-11-remove-pi-intercom.md`, except for the independently required `src/extension/fanout-child.ts` initializer and import edits.

## Design

### Child-state initialization

`createChildSafeState()` in `src/extension/fanout-child.ts` will initialize `grandTotal` by calling the canonical `emptyGrandTotal()` constructor from `src/extension/grand-total.ts`. The constructor remains the single owner of the accumulator shape: main cost plus synchronous, asynchronous, and external maps. The new import is appended after the existing imports without reordering them, maximizing its distance from #11's planned intercom-import deletion.

No fallback or guard is added to `recordSyncCost()`. `SubagentState.grandTotal` is required by the shared type and by foreground accounting; restoring construction is preferable to hiding invalid state at a downstream consumer. `createChildSafeState()` remains private, and no production test hook is introduced.

### Nested integration regression

A new dedicated integration test file will register the real child-safe extension against a captured `ExtensionAPI`. Its fixture will isolate every input that can divert execution from the failing synchronous path:

- point `HOME` and `PI_CODING_AGENT_DIR` at a temporary profile with no user config;
- set the child and fanout-child environment flags;
- set `PI_SUBAGENT_DEPTH=1` and `PI_SUBAGENT_MAX_DEPTH=2`;
- create a discoverable project agent in the temporary cwd;
- install the repository's existing `createMockPi()` executable on `PATH`; and
- provide the minimal `ctx` shape for `cwd`, `sessionManager`, and `modelRegistry`, following the existing foreground integration fixtures.

The test captures the registered `subagent` tool and invokes `execute(id, { agent, task }, signal, capturingOnUpdate, ctx)`. The `action` field is omitted because foreground single execution is the tool's default dispatch shape. Supplying `capturingOnUpdate` is mandatory: `forwardSingleUpdate()` is only constructed when an update callback exists, and the regression must enter the in-flight crash site rather than only final accounting.

The test process represents the parent invoking the lead's child-safe tool. The mock Pi subprocess represents the grandchild and emits three assistant `message_end` events with per-message `usage.cost.total` values `0`, `0.25`, and `0`. The executor accumulates these into forwarded snapshots `0`, `0.25`, and `0.25`, then returns a final assistant response. The test asserts that the update spy observed this sequence, the resolved result is not an error, and the grandchild text is present. It does not inspect the private `syncCostByRun` map; `test/unit/grand-total-cost.test.ts` remains the authority for `Math.max` deduplication semantics.

This crosses the failing path: child-safe state construction, child-only tool registration, foreground subprocess parsing, `forwardSingleUpdate()`, `recordSyncCost()`, and final tool completion. Before the fix, the progress callback fails out of band in the stdout handler rather than rejecting `execute()` normally; the red run may therefore terminate through node:test's uncaught-exception handling or its test timeout. The green assertions are resolved result, observed updates, and returned text - not merely "does not throw."

### Error handling and cleanup

Existing error handling remains unchanged. Provider failures, non-zero exits, cancellation, malformed JSONL, and nested control routing continue through their current paths. The fix does not catch accounting errors; it supplies the required state that prevents this construction-time defect.

The regression restores all modified environment variables, uninstalls the mock executable, and removes temporary directories in cleanup. It uses a fresh fake API so the module-level duplicate-registration `WeakSet` does not suppress subsequent tests. Nested-route environment variables remain unset, so registration does not start the control-inbox interval.

### #11 overlap boundary

Issue #11 has not yet changed `src/extension/fanout-child.ts`, so current diffs cannot prove conflict-free application. Its plan removes live-resume handling inside `startNestedControlInboxListener()` around current lines 89-99 and removes the corresponding intercom imports. #13 changes `createChildSafeState()` and adds one import after the existing import block. The behavioral changes are independent, but adjacent import edits may require a mechanical conflict resolution.

#13 will not modify `src/runs/foreground/subagent-executor.ts`, `src/shared/types.ts`, `test/support/mock-pi-script.mjs`, or the #11-owned test files listed in `doc/plans/2026-09-06-gh-11-remove-pi-intercom.md`. Its regression lives in a new dedicated file. Final verification locates the sibling `gh-11-remove-intercom` worktree through `git worktree list`; any conflict must remain confined to the `fanout-child.ts` import block and resolve by preserving both #13's `emptyGrandTotal` import and #11's intercom removals.

## Testing

Implementation follows a focused red-green sequence:

1. Add the dedicated integration regression with a capturing `onUpdate` callback and confirm the unfixed branch fails through the missing `syncCostByRun` accumulator, using node:test's uncaught-exception or timeout signal for the out-of-band failure.
2. Initialize child `grandTotal` and confirm the result resolves successfully, the update spy observes `0`, `0.25`, `0.25`, and the grandchild text is returned.
3. Run `test/unit/grand-total-cost.test.ts` for monotonic and duplicate snapshot coverage.
4. Run `test/unit/index-child-registration.test.ts` and `test/unit/nested-control.test.ts` for child registration and nested-control compatibility.
5. Run `env -u PI_CODING_AGENT_DIR npm run test:unit`.
6. Run `npm run test:integration`.
7. Run `npm run test:all`.
8. Locate `gh-11-remove-intercom` through `git worktree list` and compare its final changed-file and hunk set with #13.

## Acceptance criteria

- With isolated profile, depth, and discovery fixtures, invoking the registered child-safe `subagent` tool as `execute(id, { agent, task }, signal, onUpdate, ctx)` processes grandchild progress, returns the grandchild text, and resolves without an error result or the reported `syncCostByRun` TypeError.
- The capturing `onUpdate` callback observes cumulative foreground cost snapshots `0`, `0.25`, and `0.25` from per-message costs `0`, `0.25`, and `0`; existing accumulator unit tests continue to verify that repeated progress and final recording do not double count the map value.
- The regression enters through the registered child-safe tool and exercises foreground subprocess progress forwarding, rather than testing only state construction or calling `recordSyncCost()` directly.
- Production changes are limited to canonical grand-total initialization in `src/extension/fanout-child.ts`; accounting semantics and downstream error handling remain unchanged.
- Compared with the sibling `gh-11-remove-intercom` worktree located through `git worktree list`, any conflict is confined to the `src/extension/fanout-child.ts` import block and resolves by retaining #13's `emptyGrandTotal` import alongside #11's intercom removals.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: none
- Derived / memory docs invalidated: none
