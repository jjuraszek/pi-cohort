# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-gh-75-top-level-model-batch-default.md`
base: 7821a7f3c9baa9d0d315a202a4e1951b4d79113a
verification: npm run test:all
checks: commands
iterations: 3
allowance: 10
returned: 3 | home | 8f28e5790d3a6fd6b16495ee2228d8d00fa0f978

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 480 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts; 125 passed, 0 failed; pinned and unpinned tasks record the call model with and without thinking suffixes |
| 2 | done | 0 | timeout -k 30 180 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts; 57 passed, 0 failed; child metadata includes inherited models and count copies, while an empty default preserves pinned and parent models |
| 3 | done | 1 | timeout -k 30 480 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts test/integration/async-execution.test.ts; 182 passed, 0 failed, 0 skipped; explicit task models win in foreground metadata and background status with and without thinking suffixes, including repeated foreground tasks |
| 4 | open | 0 | |
| 5 | open | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/schemas.test.ts; 56 passed, 2 failed; top-level model text lacks inheritance and chain-step model description is missing |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 5: update model descriptions using test/unit/schemas.test.ts
row 1 done | Background parallel tasks now inherit the call's model ahead of pinned models, with thinking suffixes preserved. | Reuse applyModelInheritance in src/runs/foreground/subagent-executor.ts for foreground checks and extend it for chain steps.
row 2 done | Verified foreground inheritance through child metadata, including count copies, thinking suffixes, and empty defaults, and documented parallel precedence. | Reuse the metadata assertions in test/integration/parallel-execution.test.ts to check per-task model overrides.
row 3 done | Verified that per-task models override parallel call defaults in foreground metadata and background status, with and without thinking suffixes. | Reuse the model assertions in test/integration/parallel-execution.test.ts and test/integration/async-execution.test.ts for chain precedence checks.
