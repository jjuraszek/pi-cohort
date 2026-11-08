# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-49-subagent-model-only-exposure.md`
base: f690b9b8ac5eede0244a4844af96d4d32d7b775f
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; parent exposure is model-only; 5 passed, 0 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-1.jobs |
| 2 | done | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; fanout exposure is model-only; 5 passed, 0 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-1.jobs |
| 3 | done | 1 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/subagent-model-only.test.ts; on mode rejects scripted dispatch and preserves direct progress, nested events, and one leaf session; 2 passed, 0 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-2.jobs |
| 4 | done | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR PI_OFFLINE=1 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/subagent-model-only.test.ts; only mode keeps subagent declared and preserves rejection, direct progress, nested events, and one leaf session; 2 passed, 0 failed; no paid/external or detached launch, provenance ${TMPDIR:-/tmp}/loop-f690b9b8ac5eede0244a4844af96d4d32d7b775f-2.jobs |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 2 rows, closed 0 on baseline | row 1
row 1 done | Set parent subagent exposure to model-only without paid/external actions or detached launches. | Reuse src/extension/index.ts registration for direct-only integration checks.
row 2 done | Set fanout subagent exposure to model-only and passed all five registration checks without paid/external actions or detached launches. | Reuse src/extension/fanout-child.ts registration for nested direct-only integration checks.
row 3 done | Verified offline on-mode rejection, direct recovery, progress, nested events, and one leaf session without paid/external actions or detached launches. | Reuse test/integration/subagent-model-only.test.ts and its scripted fixtures for isolated real-Pi boundary checks.
row 4 done | Verified offline only-mode declaration survival and direct-only checks without paid/external actions or detached launches. | Reuse the on/only parameter cases in test/integration/subagent-model-only.test.ts to check both codemode loadouts.
