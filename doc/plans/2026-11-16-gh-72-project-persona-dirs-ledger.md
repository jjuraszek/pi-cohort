# Ledger - loop engine
**Spec:** `doc/specs/2026-11-16-gh-72-project-persona-dirs.md`
base: 483ae9f246baddc454d226dea3f07d9c0a5b01c9
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | a1ae4d2501a88423b2dbfd9e0b2df958757f9c7d

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/agents.agent-dirs.test.ts; 0 passed, 2 failed; both forms return no project personas instead of configured-alpha and configured-beta |
| 2 | cut | 0 | deviates: configured directories add to the default project locations and outrank them; an empty array adds nothing |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |
| 8 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/agents.discovery-walk.test.ts; 16 passed; 0 failed |
| 9 | open | 0 | |
| 10 | cut | 0 | deviates: the docs state additive behavior in place of project-only replacement |

## Decisions
row 0 done | seeded 2 rows, closed 1 on baseline | row 1
