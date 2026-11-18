# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-fork-child-inherited-usage.md`
base: d026b6fbebadf8f2f4ecf316e3eea8f961c90b7d
verification: npm run test:all
checks: commands
iterations: 6
allowance: 10
returned: 5 | home | e7c585a38e18d928a1793300033b401663d9193b

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --test test/unit/external-foreground-execution.test.ts; 70 passed, 0 failed; fresh, fork and inherited pane-report cases each report 1 turn, cost 0.25, child-model |
| 2 | done | 0 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --test test/unit/execution-session-watcher.test.ts; 15 passed, 0 failed; real-fork and fresh live feeds emit nothing before ready and only own messages once afterward |
| 3 | done | 1 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --import ./test/support/register-loader.mjs --test test/integration/execution-reporting-extension.test.ts; 23 passed, 0 failed; no owned reply yields failed/result_missing even after abort or rewind; own answers survive reload and copied reports |
| 4 | done | 2 | timeout -k 30 600 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/external-foreground-execution.test.ts test/integration/background-external-execution.test.ts; 109 passed, 0 failed, 0 skipped; the foreground guard reported no edits and the background mutation flag was false despite the copied parent edit |
| 5 | done | 1 | timeout -k 30 180 node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/unit/external-foreground-execution.test.ts; 72 passed, 0 failed; the first attempt recorded 2 turns and $3 including cache warming, the retry recorded 1 turn and $1, and the child reported 3 turns and $4 |
| 6 | open | 0 | |
| 7 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Replay now attributes messages and usage only after the attempt's exact ready report, excluding copied parent turns and reports. | Reuse session-replay.ts ownership filtering and the real-fork fixtures in external-foreground-execution.test.ts for later attribution checks.
row 2 done | The live feed emits only the child's own messages after ready and deduplicates repeated reads for fresh and forked sessions. | Reuse the disk-backed fresh and real-fork cases in execution-session-watcher.test.ts to check live-feed attribution.
row 3 done | The reporter now uses only owned branch messages, so a fork with no own reply fails with result_missing even after abort or rewind. | Reuse the real-fork cases in execution-reporting-extension.test.ts to check result attribution across reloads and branch rewinds.
row 4 failed | Foreground and background checks both rejected the copied edit, but the background test file exceeded 180 seconds in unrelated interruption cases. | Keep both real-fork cases and rerun the two files with a 600-second deadline for background teardown.
row 4 done | The foreground completion guard and the background mutation flag both exclude the parent's edit when a forked child makes no edits. | Reuse forkWithParentEdit() to create a real child session with a priced parent edit and its copied leaf ID.
row 5 done | A retry on the same saved conversation counts only its own turn, and the child total includes both attempts' charges exactly once. | Reuse chargesFrom in session-replay.ts for owned non-message charges and usageFrom in external-execution.ts to sum them with assistant usage.
