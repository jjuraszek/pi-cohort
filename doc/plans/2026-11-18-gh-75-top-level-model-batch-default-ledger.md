# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-gh-75-top-level-model-batch-default.md`
base: 7821a7f3c9baa9d0d315a202a4e1951b4d79113a
verification: npm run test:all
checks: commands
iterations: 5
allowance: 10
returned: 5 | home | 17b50cfd06b7fdf464773fc48a5ecd84a73dbe9b

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 480 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/async-execution.test.ts; 125 passed, 0 failed; pinned and unpinned tasks record the call model with and without thinking suffixes |
| 2 | done | 0 | timeout -k 30 180 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts; 57 passed, 0 failed; child metadata includes inherited models and count copies, while an empty default preserves pinned and parent models |
| 3 | done | 1 | timeout -k 30 480 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts test/integration/async-execution.test.ts; 182 passed, 0 failed, 0 skipped; explicit task models win in foreground metadata and background status with and without thinking suffixes, including repeated foreground tasks |
| 4 | done | 1 | timeout -k 30 480 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/parallel-execution.test.ts test/integration/async-execution.test.ts test/integration/slash-commands.test.ts test/unit/chain-serializer.test.ts; 224 passed, 0 failed, 0 skipped; foreground metadata and background status record child, then group, then call defaults ahead of agent pins; a string fanout template retains its observed baseline error Unknown agent: undefined (step 2) before fanout validation |
| 5 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/schemas.test.ts; 58 passed, 0 failed, 0 skipped; both model descriptions match the specified text and the serialized schema stays within 9,500 bytes |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 5: update model descriptions using test/unit/schemas.test.ts
row 1 done | Background parallel tasks now inherit the call's model ahead of pinned models, with thinking suffixes preserved. | Reuse applyModelInheritance in src/runs/foreground/subagent-executor.ts for foreground checks and extend it for chain steps.
row 2 done | Verified foreground inheritance through child metadata, including count copies, thinking suffixes, and empty defaults, and documented parallel precedence. | Reuse the metadata assertions in test/integration/parallel-execution.test.ts to check per-task model overrides.
row 3 done | Verified that per-task models override parallel call defaults in foreground metadata and background status, with and without thinking suffixes. | Reuse the model assertions in test/integration/parallel-execution.test.ts and test/integration/async-execution.test.ts for chain precedence checks.
row 4 done | Chain steps and fanout children now use the nearest model: their own, then their group's, then the call's, before the agent's pin. | Reuse chainModelScenario in test/support/helpers.ts to check recorded models across sequential steps, static groups, and fanout in both run modes.
row 5 done | The tool schema explains that a child's own model wins over its parallel group's default, then the call's default, then the agent's pin. | Use test/unit/schemas.test.ts to check both descriptions and the 9,500-byte schema budget.
amended | 1 item(s) | String-template fanout error text
