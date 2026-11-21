# Ledger - loop engine
**Spec:** `doc/specs/2026-11-21-gh-80-slash-idle-copy-answers.md`
base: 80a6a98e08bdffb1d229c7c26d672de59a4c539e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10
returned: seed | home | 316a014f32265f694853be3de86038fc55eca82e

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts; /interrupt-child abc received 2 responses instead of 1; a lone idle handler reported no active extension context instead of no responding bridge; 25 passed, 2 failed |
| 2 | open | 0 | |
| 3 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
