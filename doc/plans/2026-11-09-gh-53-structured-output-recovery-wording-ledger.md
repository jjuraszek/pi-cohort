# Ledger - loop engine
**Spec:** `doc/specs/2026-11-09-gh-53-structured-output-recovery-wording.md`
base: df12f3e3509030054c47efd4ec687f83eb4e1844
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 node --import ./test/support/register-loader.mjs --input-type=module -e '(await import("node:assert/strict")).default.equal((await import("./src/shared/utils.ts")).detectSubagentError([{role:"toolResult",toolName:"codemode",isError:true,details:{calls:[]},content:[{type:"text",text:"Script error:\nTypeError: tools.structured_output is not available"}]},{role:"toolResult",toolName:"structured_output",isError:false,content:[{type:"text",text:"Structured output captured"}]}]).hasError,false)'; exit 1: alternate verb reports hasError true instead of false; offline assertion only, no paid or external actions launched |
| 2 | open | 0 | |
| 3 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
