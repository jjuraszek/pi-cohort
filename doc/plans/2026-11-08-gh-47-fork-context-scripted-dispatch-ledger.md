# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-47-fork-context-scripted-dispatch.md`
base: f152e745a7b2891998d130c65be75ff66402ec30
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 41 passed, 1 failed; nested subagent capture returns undefined instead of removing the inherited codemode call and result; no paid or external action launched |
| 2 | cut | 0 | deviates: the user replaced the code-text signal with codemode's recorded `details.calls` invocation names (uncapped list of every tool the script invoked by name) as the incomplete-record fallback; the two signals differ - a comment that only mentions `tools.subagent` is kept now, a `tools["subagent"]()` call is stripped now - and Design restates the row with the `details.calls` signal |
| 3 | open | 0 | |
| 4 | cut | 0 | deviates: follows the row-2 decision - the paragraph names the `details.calls` fallback for incomplete records, since no code-text fallback exists; confirmed by the user at the spec gate (approval reply `5`) |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
