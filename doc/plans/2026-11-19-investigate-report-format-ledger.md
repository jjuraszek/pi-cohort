# Ledger - loop engine
**Spec:** `doc/specs/2026-11-19-investigate-report-format.md`
base: 8d8283362c5098543718a9745f9f0ac15342c7a2
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | 08949f89a16d772b03eaad5d175d60668480a811

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; prompts/ still exists; 6 passed, 1 failed |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | open | 0 | |
| 11 | open | 0 | |

## Decisions

row 0 done | seeded 1 rows, closed 0 on baseline | row 1
