# Ledger - loop engine
**Spec:** `doc/specs/2026-11-18-fork-child-inherited-usage.md`
base: d026b6fbebadf8f2f4ecf316e3eea8f961c90b7d
verification: npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | 061ec59ba2ac01029df5101b12c6ec5f5f9c4d9c

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --test test/unit/external-foreground-execution.test.ts; 70 passed, 0 failed; fresh, fork and inherited pane-report cases each report 1 turn, cost 0.25, child-model |
| 2 | done | 0 | timeout -k 30 60 env TMPDIR=../../.git/worktrees/fork-child-inherited-usage/gauntlet/tmp node --test test/unit/execution-session-watcher.test.ts; 15 passed, 0 failed; real-fork and fresh live feeds emit nothing before ready and only own messages once afterward |
| 3 | open | 0 | |
| 4 | open | 0 | |
| 5 | open | 0 | |
| 6 | open | 0 | |
| 7 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 done | Replay now attributes messages and usage only after the attempt's exact ready report, excluding copied parent turns and reports. | Reuse session-replay.ts ownership filtering and the real-fork fixtures in external-foreground-execution.test.ts for later attribution checks.
row 2 done | The live feed emits only the child's own messages after ready and deduplicates repeated reads for fresh and forked sessions. | Reuse the disk-backed fresh and real-fork cases in execution-session-watcher.test.ts to check live-feed attribution.
