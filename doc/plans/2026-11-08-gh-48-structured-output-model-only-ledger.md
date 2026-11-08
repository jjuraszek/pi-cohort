# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`
base: 425b54fc7b52c656d7a879217425d6cd9c1b3114
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 4
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; registration exposure is model-only; no paid or external action launched |
| 2 | failed | 2 | timeout -k 30 10 node --input-type=module -e 'import("./src/shared/utils.ts").then(({detectSubagentError}) => import("node:assert/strict").then(({default: assert}) => assert.equal(detectSubagentError([{role:"toolResult",toolName:"codemode",isError:true,content:[{type:"text",text:"TypeError: tools.structured_output does not exist"}]},{role:"toolResult",toolName:"structured_output",isError:false,content:[{type:"text",text:"Structured output captured"}]}]).hasError, false, "codemode rejection survives direct capture and forces exit 1")))'; assertion failed: hasError is true after direct capture; exit-0 design conflicts with error promotion in src/runs/foreground/attempt-finalization.ts and src/shared/utils.ts outside approved component scope; no paid or external action launched |
| 3 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 42 passed, 0 failed; unchanged direct-call test saves the value and asserts terminate true; no paid or external action launched |
| 4 | done | 0 | timeout -k 30 10 python3 -c 'assert __import__("json").loads(__import__("pathlib").Path("package.json").read_text())["peerDependencies"]["@earendil-works/pi-coding-agent"] == ">=1.5.0" and "Requires Pi >=1.5.0." in __import__("pathlib").Path("README.md").read_text()'; passed peer range and README floor assertions |

## Decisions
row 0 done | seeded 2 rows, closed 1 on baseline | row 1
row 1 done | Registered model-only structured output, typed the registration mock, and updated the guide and changelog; no paid or external action launched. | Reuse subagent-prompt-runtime.ts registration and its unit test for the child-run integration check.
row 3 done | Confirmed the unchanged direct-call test saves the value and returns terminate true in the 42-test passing runtime check. | nothing new to build on
row 2 failed | Added real-child coverage proving script rejection and direct capture, but hidden-error promotion contradicts the required exit 0; no paid or external action launched. | Keep the real-child fixture; resolve attempt-finalization.ts hidden-error promotion before retrying the exit-0 assertion.
row 2 failed | Confirmed hidden-error detection rejects direct recovery; changing finalization exceeds approved scope, so the row remains blocked; no paid or external action launched. | Keep the fixture; obtain a component-boundary redraw for error recovery or amend the exit-0 design before rerunning the child test.
