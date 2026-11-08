# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`
base: 41a41858972ecd9f0b1a9ca2892990c1df16068b
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; registration exposure is model-only |
| 2 | done | 1 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/structured-output-model-only.test.ts; 1 passed, 0 failed; namespace rejection, zero nested calls, direct capture, child exit 0 and parent value passed; detect-error.test.ts 74 passed, 0 failed after RED with 9 failures |
| 3 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; unchanged direct-call test saves success envelope and returns terminate true |
| 4 | done | 0 | timeout -k 30 10 python3 -c 'assert (__import__("json").loads(__import__("pathlib").Path("package.json").read_text())["peerDependencies"]["@earendil-works/pi-coding-agent"], "Requires Pi >=1.5.0." in __import__("pathlib").Path("README.md").read_text()) == (">=1.5.0", True)'; passed peer range and README floor assertions |

## Decisions
row 0 done | seeded 4 rows, closed 3 on baseline | row 2
row 2 done | Implemented narrow recovery and guide/changelog updates; 74 detector tests and the real-child test pass after RED failures. | Reuse src/shared/utils.ts recovery and test/integration/detect-error.test.ts fixtures for foreground/background error checks.
