# Ledger - loop engine
**Spec:** `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`
base: e25ad56b84008410cf95c99b58b8db297a5b631f
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 4
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --experimental-strip-types --test test/integration/foreground-in-flight-control.test.ts; 15 passed, 0 failed; static and dynamic chain failures retain sibling outputs and static patches; no paid/external actions launched, no detached jobs launched |
| 2 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --experimental-strip-types --test test/integration/foreground-in-flight-control.test.ts; 15 passed, 0 failed; sibling outputs, interrupted entry and chain failure contracts pass; no paid/external actions launched, no detached jobs launched |
| 3 | done | 1 | timeout -k 30 180 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --experimental-strip-types --test test/integration/top-level-async.test.ts; 16 passed, 0 failed; indexed requests, fallback registration, mixed signals and sibling statuses pass; no paid/external actions launched, fixture runners exited and no jobs remain |
| 4 | open | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --experimental-strip-types --test test/integration/foreground-in-flight-control.test.ts; 4 passed, 1 failed; index 3 incorrectly accepted: isError undefined instead of true; no paid/external actions launched |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 4
row 1 done | Implemented indexed foreground stops and chain failure results with sibling outputs and patches; 15 tests pass and no paid/external actions launched. | Reuse childInterrupts/stoppedByIndex in subagent-executor.ts for slash targeting and test/support/mock-pi.ts taskIncludes for deterministic child fixtures.
row 2 done | Documented indexed foreground results and verified sibling outputs, chain failures and label precedence; 35 tests pass with no paid/external actions or detached jobs launched. | Reuse doc/programmatic-api.md#foreground-stop-by-index for the result contract and test/unit/parallel-utils.test.ts for interrupted-label precedence.
row 3 done | Implemented async indexed-stop transport, pending-stop handling and pause statuses; 16 targeted tests pass with no paid/external actions launched. | Reuse test/integration/top-level-async.test.ts for background race fixtures and doc/programmatic-api.md#background-stop-by-index for request-file semantics.
