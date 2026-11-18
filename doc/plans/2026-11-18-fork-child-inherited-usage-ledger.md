# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-fork-child-inherited-usage.md`
base: d026b6fbebadf8f2f4ecf316e3eea8f961c90b7d
verification: npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | eab96c5f0c7e8d217fc84649eae64886b13c2c3d

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --test test/unit/external-foreground-execution.test.ts; 68 passed, 1 failed; fork reports 4 turns, cost 3.25, model-a instead of 1 turn, cost 0.25, child-model; fresh control passes |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
