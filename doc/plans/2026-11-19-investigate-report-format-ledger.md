# Ledger - loop engine
**Spec:** `doc/specs/2026-11-19-investigate-report-format.md`
base: 8d8283362c5098543718a9745f9f0ac15342c7a2
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 4
allowance: 10
returned: 6 | home | 1f55f88ca590aadc082e5a7b67931bf462701935

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; package ships no prompt templates; 7 passed, 0 failed |
| 2 | done | 1 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; investigate trigger frontmatter stays model-invocable; 8 passed, 0 failed |
| 3 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; temp folder and dispatch rules passed; 10 passed, 0 failed |
| 4 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; eight brief headings match in order; 11 passed, 0 failed |
| 5 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; reviewer task and fallback passed independently of template; 12 passed, 0 failed |
| 6 | failed | 1 | timeout -k 30 10 python3 "$(git rev-parse --git-dir)/gauntlet/tmp/check-report-shape.py"; unreachable: fresh worker output requires the subagent tool, unavailable to the loop implementer - parent Pi session with dispatch enabled; scratch/report-eval-dir locates the brief and expected facts |
| 7 | open | 0 | |
| 8 | open | 0 | |
| 9 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; three headings always present and the clash heading conditional on a clash line; 15 passed, 0 failed |
| 10 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; neither skill file contains an invocation prefix; 16 passed, 0 failed |
| 11 | done | 0 | timeout -k 30 30 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts; neither skill file contains gauntlet; 16 passed, 0 failed |

## Decisions

row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Removed the investigate prompt, its package registration and its command listing. | Add the replacement skill and report format to the new Unreleased section in CHANGELOG.md.
row 2 done | Added a model-invocable investigation skill with the original trigger and documented its entry point. | Extend skills/investigate/SKILL.md after its request and authorization checks.
row 3 done | Confined child output, session storage and the brief to one checked temp folder. | Use the dispatch settings and failure rules in step 2 of skills/investigate/SKILL.md for both waves.
row 4 done | Defined the eight brief sections and how to fold verified findings into the draft before writing it. | Follow the markdown template in skills/investigate/SKILL.md when creating the synthetic brief.
row 5 done | The reviewer now ends its assessment with cited clashes or a clean verdict naming the sources checked. | Use the verdict format and not-assessed fallback in skills/investigate/SKILL.md when rendering Design fit.
row 9 done | Defined three required report sections and a fourth only for a documented clash. | Use skills/investigate/reference/report.md as the loaded worker's report rules for the synthetic brief.
row 10 done | Checked that neither skill file spells a skill invocation. | Reuse the consumer-name test in test/unit/prompts-inventory.test.ts to check both shipped files.
row 11 done | Confirmed neither skill file names the consuming package. | nothing new to build on
row 6 failed | Prepared the synthetic brief and checked for the loaded report, but this session has no worker dispatch tool. | Reuse the brief and expected facts located by scratch/report-eval-dir; replay the captured loaded.md with check-report-shape.py.
