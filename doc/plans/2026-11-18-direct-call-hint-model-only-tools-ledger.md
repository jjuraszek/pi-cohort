# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-direct-call-hint-model-only-tools.md`
base: e2a1ff0c8e11eb5884c2fd2d0bc25cfa01ec9e89
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | eb2514861ee4cc836d1d5eff9d7d0d256423cca9

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 5 passed, 0 failed; parent subagent description ends with the exact direct-call closing line |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Appended the exact direct-call closing line to the parent subagent description. | Reuse the suffix in src/extension/index.ts for the remaining descriptions and extend the Changed bullet in CHANGELOG.md.
