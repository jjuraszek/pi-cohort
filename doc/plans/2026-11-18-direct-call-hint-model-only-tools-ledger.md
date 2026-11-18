# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-direct-call-hint-model-only-tools.md`
base: e2a1ff0c8e11eb5884c2fd2d0bc25cfa01ec9e89
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 4
allowance: 10
returned: 3 | home | 065efc554118a091eb2e5e4e1fb8d6975c734c89

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 5 passed, 0 failed; parent subagent description ends with the exact direct-call closing line |
| 2 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/index-child-registration.test.ts; 5 passed, 0 failed; child-safe subagent description ends with the exact direct-call closing line |
| 3 | done | 1 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 68 passed, 0 failed; structured_output description ends with the exact direct-call closing line |
| 4 | open | 0 | |
| 5 | done | 0 | timeout -k 30 120 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/structured-output-model-only.test.ts; 1 passed, 0 failed; real child rejects scripted structured_output and captures its direct call |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Appended the exact direct-call closing line to the parent subagent description. | Reuse the suffix in src/extension/index.ts for the remaining descriptions and extend the Changed bullet in CHANGELOG.md.
row 2 done | Appended the exact direct-call closing line to the child-safe subagent description and verified it with the registration test. | Reuse the description suffix pattern in src/extension/fanout-child.ts for structured_output, substituting the tool name.
row 3 done | Appended the exact direct-call closing line to structured_output and verified it with the registration test. | Reuse test/unit/subagent-prompt-runtime.test.ts to check the description alongside the model-only exposure.
row 5 done | Verified that structured_output stays absent from a real child's script namespace and its direct call still captures output. | nothing new to build on
