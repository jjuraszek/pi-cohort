# Ledger - loop engine
**Spec:** `doc/specs/2026-11-11-gh-61-foreground-max-runtime-cap.md`
base: 273a79b4e5f6d80b14ff1e96b1193dc054b46b9e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 120 node --import ./test/support/isolate-test-env.mjs --test test/integration/foreground-in-flight-control.test.ts; 19 passed, 0 failed; active and SIGTERM-resistant children fail at the cap with control disabled, short children succeed; no paid or external action launched |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-control.test.ts; 42 passed, 0 failed; invalid cap values fall through to settings then default without clamping; no paid or external action launched |
| 8 | open | 0 | |
| 9 | open | 0 | |
| 10 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 7
row 1 done | Added a per-child monotonic cap, failure rewrite and abort escalation; 19 integration tests pass. | Reuse runSync's monotonicNow seam and mock-pi ignoreSigterm fixture for deadline and backend checks.
row 7 done | Resolved positive-integer maxRuntimeMs with call-time, settings and default precedence; 42 unit tests pass. | Reuse resolveControlConfig in src/runs/shared/subagent-control.ts for settings and override execution checks.
