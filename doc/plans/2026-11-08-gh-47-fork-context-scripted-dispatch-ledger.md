# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-47-fork-context-scripted-dispatch.md`
base: f152e745a7b2891998d130c65be75ff66402ec30
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 0
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | |
| 2 | cut | 0 | deviates: the user replaced the code-text signal with codemode's recorded `details.calls` invocation names (uncapped list of every tool the script invoked by name) as the incomplete-record fallback; the two signals differ - a comment that only mentions `tools.subagent` is kept now, a `tools["subagent"]()` call is stripped now - and Design restates the row with the `details.calls` signal |
| 3 | open | 0 | |
| 4 | cut | 0 | deviates: follows the row-2 decision - the paragraph names the `details.calls` fallback for incomplete records, since no code-text fallback exists; confirmed by the user at the spec gate (approval reply `5`) |

## Decisions
