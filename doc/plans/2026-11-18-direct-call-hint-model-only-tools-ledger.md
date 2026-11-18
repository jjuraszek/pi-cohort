# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-direct-call-hint-model-only-tools.md`
base: e2a1ff0c8e11eb5884c2fd2d0bc25cfa01ec9e89
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | 8308a8d4feb20f454eaf5f11c413cfe51ba5f5c2

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 4 passed, 1 failed; parent subagent description is missing the direct-call closing line |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
