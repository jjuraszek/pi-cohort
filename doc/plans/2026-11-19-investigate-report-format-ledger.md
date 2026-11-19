# Ledger - loop engine
**Spec:** `doc/specs/2026-11-19-investigate-report-format.md`
base: 8d8283362c5098543718a9745f9f0ac15342c7a2
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | 5bd26822d5f0519a3c70230cc74188ab9b58c1b5

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; package ships no prompt templates; 7 passed, 0 failed |
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
row 1 done | Removed the investigate prompt, its package registration and its command listing. | Add the replacement skill and report format to the new Unreleased section in CHANGELOG.md.
