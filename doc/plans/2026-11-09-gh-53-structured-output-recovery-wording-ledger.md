# Ledger - loop engine
**Spec:** `doc/specs/2026-11-09-gh-53-structured-output-recovery-wording.md`
base: df12f3e3509030054c47efd4ec687f83eb4e1844
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 node --import ./test/support/register-loader.mjs --test test/integration/detect-error.test.ts; RED 6 wording assertions failed, GREEN 79 passed, 0 failed, 0 skipped; guide and changelog updated to the first-line token rule; offline tests only, no paid or external actions launched |
| 2 | done | 0 | timeout -k 30 60 node --import ./test/support/register-loader.mjs --test test/integration/detect-error.test.ts; 79 passed, 0 failed, 0 skipped; truncation, call metadata, later-success gates and updated wording expectations pass; offline tests only, no paid or external actions launched |
| 3 | done | 0 | timeout -k 30 60 node --import ./test/support/register-loader.mjs --test test/integration/detect-error.test.ts; 79 passed, 0 failed, 0 skipped; original does-not-exist and alternate is-not-available diagnostics both recover; offline tests only, no paid or external actions launched |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Matched the bounded first-line tool token, added wording cases, and updated the guide and changelog; no paid or external actions launched. | Reuse test/integration/detect-error.test.ts to check wording recovery and preserved gates.
row 2 done | Confirmed truncation, nested-call and later-success gates plus the three changed wording expectations with the passing detector check. | nothing new to build on
row 3 done | Confirmed both diagnostic verbs recover with the passing detector check while leaving the real-child fixture unchanged. | nothing new to build on
