# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-direct-call-hint-model-only-tools.md`
base: e2a1ff0c8e11eb5884c2fd2d0bc25cfa01ec9e89
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10
returned: 2 | home | 75f8140b2be44496ddeb1c2ffe61c45c59eb246e

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 5 passed, 0 failed; parent subagent description ends with the exact direct-call closing line |
| 2 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 5 passed, 0 failed; child-safe subagent description ends with the exact direct-call closing line |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Appended the exact direct-call closing line to the parent subagent description. | Reuse the suffix in src/extension/index.ts for the remaining descriptions and extend the Changed bullet in CHANGELOG.md.
row 2 done | Appended the exact direct-call closing line to the child-safe subagent description and verified it with the registration test. | Reuse the description suffix pattern in src/extension/fanout-child.ts for structured_output, substituting the tool name.
