# Ledger - loop engine
**Spec:** `doc/specs/2026-11-16-gh-72-project-persona-dirs.md`
base: 483ae9f246baddc454d226dea3f07d9c0a5b01c9
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10
returned: 3 | home | b4c2a61f0d21b002ffe58573dec07aa16d4fd5a4

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/agents.agent-dirs.test.ts; 13 passed, 0 failed; string and array discovery, trimming, path expansion and invalid-value warnings pass |
| 2 | cut | 0 | deviates: configured directories add to the default project locations and outrank them; an empty array adds nothing |
| 3 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/agents.agent-dirs.test.ts; 22 passed, 0 failed; bundled and user discovery, disable settings and overrides match absent-setting baselines for a path and empty array; profile agentDirs adds nothing and invalid values warn |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |
| 8 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/agents.discovery-walk.test.ts; 16 passed; 0 failed |
| 9 | open | 0 | |
| 10 | cut | 0 | deviates: the docs state additive behavior in place of project-only replacement |

## Decisions
row 0 done | seeded 2 rows, closed 1 on baseline | row 1
row 1 done | Added project agentDirs parsing, per-level discovery, validation, and configuration docs. | Reuse resolveSettingsPath in src/shared/utils.ts and the isolated fixtures in test/unit/agents.agent-dirs.test.ts for later discovery checks.
row 3 done | Added checks proving bundled and user discovery, overrides, and disables survive configured paths and empty arrays. | Reuse the compatibility matrix in test/unit/agents.agent-dirs.test.ts to compare listing and dispatch against absent-setting baselines.
