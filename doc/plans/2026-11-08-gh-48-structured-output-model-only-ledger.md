# Ledger - loop engine
**Spec:** `doc/specs/2026-11-08-gh-48-structured-output-model-only.md`
base: 425b54fc7b52c656d7a879217425d6cd9c1b3114
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 1
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | open | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-prompt-runtime.test.ts; 41 passed, 1 failed; registration exposure is undefined, expected model-only; no paid or external action launched |
| 2 | open | 0 | |
| 3 | open | 0 | |
| 4 | done | 0 | timeout -k 30 10 python3 -c 'assert __import__("json").loads(__import__("pathlib").Path("package.json").read_text())["peerDependencies"]["@earendil-works/pi-coding-agent"] == ">=1.5.0" and "Requires Pi >=1.5.0." in __import__("pathlib").Path("README.md").read_text()'; passed peer range and README floor assertions |

## Decisions
row 0 done | seeded 2 rows, closed 1 on baseline | row 1
