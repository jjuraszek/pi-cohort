# Bounded EPERM retry for startup temporary directories

Issue: [`jjuraszek/pi-cohort#10`](https://github.com/jjuraszek/pi-cohort/issues/10)

Baseline: pi-cohort 5.3.1 at commit `225ab55`. The reviewed implementation is `ensureAccessibleDir()` at `src/extension/index.ts:92-105`, its `mkdirSync()` calls at lines 93 and 102, and its startup call sites at lines 263-264.

## Problem

During synchronous extension registration, `ensureAccessibleDir()` creates the completed-result and async-run temporary directories. On Windows, either creation can intermittently fail with `EPERM`; relaunching seconds later can succeed without any other change. The same failure is possible when an existing directory fails its read/write access check and is removed before recreation.

The current `mkdirSync()` calls do not retry, so one transient failure aborts extension registration. Microsoft Defender and Storage Sense are possible correlations, not confirmed causes. The design must not encode either as the cause.

## Goals

- Tolerate transient `EPERM` from both directory-creation points in `ensureAccessibleDir()`.
- Preserve synchronous startup and the existing access-check/remove/recreate flow.
- Make the retry count and maximum added delay strictly bounded.
- Verify the policy deterministically without real one-second waits.
- Preserve original thrown values and existing behavior for every non-`EPERM` failure.

## Non-goals

- Retrying `accessSync()`, `rmSync()`, atomic JSON writes, renames, or any filesystem operation outside the two creation points.
- Retrying error codes other than `EPERM`.
- Diagnosing or working around a specific Windows service.
- Adding settings, platform-specific branches, asynchronous startup, a generic retry framework, logging, or a busy-wait fallback.

## Architecture

Add an extension-local module at `src/extension/mkdir-with-retry.ts`. It owns synchronous sleeping and one narrowly scoped directory-creation operation. It is extension-local rather than shared because no other caller needs this policy.

`src/extension/index.ts` retains `ensureAccessibleDir()` and its current responsibilities:

1. Unconditionally create the target through the retry helper; recursive creation remains idempotent when the directory already exists.
2. Verify synchronous read/write access.
3. If access fails, remove the directory recursively and forcefully.
4. Recreate it through the same retry helper.
5. Verify synchronous read/write access again.

Both existing direct `mkdirSync(path, { recursive: true })` calls are replaced. `accessSync()` and `rmSync()` stay outside the retry boundary; no `existsSync()` gate is introduced.

The behavior applies on every platform. The error code is the boundary; adding an operating-system check would create divergent behavior without improving the selected policy.

## Retry contract

The helper uses a visibly finite loop whose attempt counter ranges from 1 through 3 inclusive. It must not use recursion, an unbounded `while`, a mutable retry limit, or any branch that can repeat the same attempt.

For each invocation:

- Attempt 1 runs immediately.
- An `EPERM` from attempt 1 or 2 causes exactly one synchronous 1,000 ms wait, followed by the next attempt.
- Success returns immediately without any later wait or attempt.
- An `EPERM` from attempt 3 is rethrown immediately as the same value.
- Only a null-safe structural check - `typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"` - classifies a value as retryable. Any other thrown value, including `null`, `undefined`, or a primitive, is rethrown immediately as the same value.
- A failure from the wait operation propagates immediately. It is not caught, converted, or followed by another creation attempt. This deliberately favors exposing a broken wait primitive over masking it with the pending `EPERM`; Node 20 or newer supplies the required primitives.

Persistent `EPERM` therefore produces exactly 3 creation calls, exactly 2 waits, and at most 2,000 ms of added delay per helper invocation. Each invocation has its own bound; there is no global retry budget shared by the two startup directories or by initial creation and recreation. If both initial creation and recreation reach a third attempt for both directories, startup can block for up to 8,000 ms in aggregate. That silent synchronous delay is accepted to preserve the selected per-invocation policy and existing startup semantics.

Recursive creation semantics remain unchanged. If another process creates the directory between attempts, a subsequent recursive creation can succeed normally.

## Synchronous wait and test seam

The module allocates one exclusively owned, never-written `Int32Array(new SharedArrayBuffer(4))`. The production wait calls `Atomics.wait(waitArray, 0, 0, delayMs)` and intentionally ignores its return value. The untouched slot remains zero, so the expected value matches and the timeout performs the synchronous wait. This preserves registration semantics on the package's Node 20-or-newer runtime. There is no busy-wait fallback.

The module exports `mkdirWithEpermRetry(dirPath: string, deps?: { mkdir?: (path: string) => void; wait?: (milliseconds: number) => void }): void`. Its default `mkdir` executes `mkdirSync(path, { recursive: true })`; its default `wait` is the local synchronous wait. Production callers pass only the path. The dependency shape follows the codebase's existing optional-dependencies testing pattern, while the attempt count and delay remain internal module constants rather than configurable or injectable policy.

The dependency object is test infrastructure, not configuration or public extension API. It lets unit tests provide ordered outcomes and record waits without replacing ESM imports or sleeping in real time.

## Startup flow and failure behavior

Extension registration continues to call `ensureAccessibleDir()` for the completed-result directory and then the async-run directory before registering runtime behavior. A persistent failure in the first call still prevents the second call, preserving current fail-fast ordering.

A failed read/write check on an existing directory still triggers best-effort removal, recreation, and a second read/write check. Only recreation gains bounded `EPERM` handling. `rmSync()` retry options remain deliberately out of scope: if best-effort removal leaves a transiently locked directory and the following creation reports `EPERM`, creation can now add up to 2,000 ms before surfacing its final error. This is accepted rather than broadening issue #10 to removal policy.

Examples:

- Success on attempt 1: 1 creation, 0 waits.
- `EPERM`, then success: 2 creations, 1 wait.
- `EPERM`, `EPERM`, then success: 3 creations, 2 waits.
- Three `EPERM` values: 3 creations, 2 waits, third value rethrown.
- `EPERM`, then `EACCES`: 2 creations, 1 wait, `EACCES` value rethrown.

## Testing

Add focused coverage in `test/unit/mkdir-with-retry.test.ts` using injected `mkdir` and `wait` functions. Tests must assert calls and object identity rather than elapsed wall-clock time:

- First-attempt success makes one creation call and no wait call.
- One transient `EPERM` makes two creation calls and one 1,000 ms wait.
- Two transient `EPERM` values make three creation calls and two 1,000 ms waits.
- Persistent `EPERM` stops after exactly three creation calls and two waits, then rethrows the third value by identity.
- An immediate non-`EPERM` makes one creation call, no wait call, and rethrows the same value.
- `EPERM` followed by a non-`EPERM` waits once, makes no third attempt, and rethrows the second value by identity.
- `null`, `undefined`, and other thrown values without `code: "EPERM"` are rethrown unchanged without waiting.
- A wait failure propagates without another creation attempt.

The persistent-failure call-count test is the regression guard against an infinite retry loop. Because `ensureAccessibleDir()` is module-private and the project has no ESM module-mocking convention, wiring remains a review-level check rather than adding a source-text test or exporting production internals: both creation statements must call `mkdirWithEpermRetry()`, and the post-recreation `accessSync()` must remain in place. Review also confirms the production wait's exclusively owned zero-valued buffer and exact `Atomics.wait(waitArray, 0, 0, delayMs)` invocation; injected-wait tests cannot establish that wiring.

Verification runs the focused test first, then:

```bash
env -u PI_CODING_AGENT_DIR npm run test:unit
npm run test:integration
npm run test:all
```

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - records the startup reliability fix and its bounded retry behavior
- Derived / memory docs invalidated: none

This classification follows pi-gauntlet's `skills/brainstorming/reference/documentation-impact.md`; that workflow reference is not part of this repository. README and configuration documentation do not change because the retry has no user-operated setting, command, or API.

## Acceptance criteria

1. Both directory-creation points inside `ensureAccessibleDir()` use the same bounded helper.
2. An `EPERM` on attempt 1 or 2 waits exactly 1,000 ms and retries; later success continues normal registration.
3. Three consecutive `EPERM` values stop after attempt 3, perform exactly two waits, and rethrow the third value unchanged.
4. A non-`EPERM` value is rethrown unchanged without an additional wait or retry.
5. Initial success performs no wait and preserves current synchronous startup behavior.
6. Recreation after a failed access check receives the same retry policy and is followed by the existing read/write access verification.
7. Automated tests verify attempt and delay bounds without waiting in real time, including an explicit exactly-three-attempt guard against infinite retrying.
8. No other error code, filesystem operation, or code path gains retry behavior.
9. The behavior is identical across platforms and does not claim a confirmed external cause for the Windows report.

## Open questions

None.
