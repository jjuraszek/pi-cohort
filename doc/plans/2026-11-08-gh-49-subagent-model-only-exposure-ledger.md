# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-49-subagent-model-only-exposure.md`
base: f690b9b8ac5eede0244a4844af96d4d32d7b775f
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; parent exposure expected model-only, got undefined; 3 passed, 2 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-0.jobs |
| 2 | open | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; fanout exposure expected model-only, got undefined; 3 passed, 2 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-0.jobs |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 2 rows, closed 0 on baseline | row 1
