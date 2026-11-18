# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-gh-75-top-level-model-batch-default.md`
base: 7821a7f3c9baa9d0d315a202a4e1951b4d79113a
verification: npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | a89565ff747491f697a9ddd668329c981ce19cd1

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/schemas.test.ts; 56 passed, 2 failed; top-level model text lacks inheritance and chain-step model description is missing |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 5: update model descriptions using test/unit/schemas.test.ts
