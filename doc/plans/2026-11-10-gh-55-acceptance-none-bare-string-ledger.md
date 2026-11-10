# Ledger - loop engine
**Spec:** `doc/specs/2026-11-10-gh-55-acceptance-none-bare-string.md`
base: 97c869bfff02b34c12e512c2dd49e84840ab7879
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 180 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/acceptance.test.ts test/unit/chain-serializer.test.ts test/unit/foreground-execution-routing.test.ts test/integration/single-execution.test.ts; 161 passed, 0 failed; bare none rejected at every dispatch and saved-chain position; no paid or external action launched |
| 2 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/acceptance.test.ts; 24 passed, 0 failed; attested and none with reason validate without errors |
| 3 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/acceptance.test.ts; 25 passed, 0 failed; false validates and resolves to none on the async update repro |
| 4 | cut | 0 | deviates: framing answer B - an explicit level is never raised, so no run produces this text; the run this row describes resolves to `attested` and is not checked for `validation-output` |
| 5 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/acceptance.test.ts; 26 passed, 0 failed; explicit checked and inferred reviewed retain the exact tests-added rejection message |
| 6 | done | 0 | timeout -k 30 60 node --test test/unit/schemas.test.ts; 55 passed, 0 failed including schema shape and 9500-byte budget; schema and all three prose surfaces require object-form none with reason; changelog names both upgrade failures |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Rejected bare none at both boundaries and honored explicit levels with 161 passing tests; no paid or external action launched. | Reuse acceptance.ts validation and resolution plus the table-driven boundary tests for acceptance changes.
row 2 done | Confirmed attested and object-form none still validate with no errors. | Reuse the valid-input cases in test/unit/acceptance.test.ts to guard supported shorthand and opt-out inputs.
row 3 done | Confirmed deprecated false validates and resolves to none with its existing reason. | Reuse the false compatibility test in test/unit/acceptance.test.ts for future normalization changes.
row 5 done | Confirmed explicit and inferred gates keep the exact rejection summary without raised-level text. | Reuse the paired rejection-message cases in test/unit/acceptance.test.ts when changing acceptance reports.
row 6 done | Updated schema, docs, skill, and changelog for reasoned none and explicit levels; 55 schema tests pass. | Reuse test/unit/schemas.test.ts to guard the description and budget, and the acceptance docs for caller guidance.
