# Ledger - loop engine
**Spec:** `doc/specs/2026-11-10-gh-58-interrupt-one-parallel-child.md`
base: e25ad56b84008410cf95c99b58b8db297a5b631f
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --experimental-strip-types --test test/integration/foreground-in-flight-control.test.ts; 4 passed, 1 failed; index 3 incorrectly accepted: isError undefined instead of true; no paid/external actions launched |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 4
