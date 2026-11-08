# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`
base: 41a41858972ecd9f0b1a9ca2892990c1df16068b
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; registration exposure is model-only |
| 2 | open | 0 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/structured-output-model-only.test.ts; 0 passed, 1 failed; namespace rejection, zero nested calls, direct success and capture assertions passed; child.exitCode is 1 instead of 0 because codemode Script failed remains an error |
| 3 | done | 0 | timeout -k 30 60 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; unchanged direct-call test saves success envelope and returns terminate true |
| 4 | done | 0 | timeout -k 30 10 python3 -c 'assert (__import__("json").loads(__import__("pathlib").Path("package.json").read_text())["peerDependencies"]["@earendil-works/pi-coding-agent"], "Requires Pi >=1.5.0." in __import__("pathlib").Path("README.md").read_text()) == (">=1.5.0", True)'; passed peer range and README floor assertions |

## Decisions
row 0 done | seeded 4 rows, closed 3 on baseline | row 2
