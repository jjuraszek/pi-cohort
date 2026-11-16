# Ledger - loop engine
**Spec:** `doc/specs/2026-11-16-gh-72-project-persona-dirs.md`
base: 483ae9f246baddc454d226dea3f07d9c0a5b01c9
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 0
allowance: 10
returned: none

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | cut | 0 | deviates: configured directories add to the default project locations and outrank them; an empty array adds nothing |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | cut | 0 | deviates: the docs state additive behavior in place of project-only replacement |

## Decisions
