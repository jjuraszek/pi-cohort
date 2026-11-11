# Ledger - loop engine
**Spec:** `doc/specs/2026-11-11-gh-61-foreground-max-runtime-cap.md`
base: 273a79b4e5f6d80b14ff1e96b1193dc054b46b9e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 10
allowance: 10

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 1 | timeout -k 30 120 node --import ./test/support/isolate-test-env.mjs --test test/integration/foreground-in-flight-control.test.ts; 19 passed, 0 failed; active and SIGTERM-resistant children fail at the cap with control disabled, short children succeed; no paid or external action launched |
| 2 | done | 1 | timeout -k 30 120 node --import ./test/support/isolate-test-env.mjs --test test/integration/foreground-in-flight-control.test.ts; 21 passed, 0 failed; top-level and default non-fail-fast chain siblings complete after a child cap, including queued tasks; no paid or external action launched |
| 3 | done | 1 | timeout -k 30 120 node --import ./test/support/isolate-test-env.mjs --test test/integration/foreground-in-flight-control.test.ts; 22 passed, 0 failed; settings-only maxRuntimeMs=800 terminates an active foreground child through resolveConfig with no call-time control; no paid or external action launched |
| 4 | done | 1 | timeout -k 30 120 node --import ./test/support/isolate-test-env.mjs --test test/integration/foreground-in-flight-control.test.ts; 24 passed, 0 failed; call-time caps of 1600 and 800 ms override settings of 800 and 1600 ms respectively and terminate active children; no paid or external action launched |
| 5 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/foreground-execution-routing.test.ts; 28 passed, 0 failed; omitted, resolved and partial control configs abort at 14400000 ms and not one ms earlier; no paid or external action launched |
| 6 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/foreground-execution-routing.test.ts; 31 passed, 0 failed; call-time caps above four hours abort exactly at their deadlines with bounded 32-bit timer chunks; no paid or external action launched |
| 7 | done | 0 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/subagent-control.test.ts; 42 passed, 0 failed; invalid cap values fall through to settings then default without clamping; no paid or external action launched |
| 8 | done | 1 | timeout -k 30 60 node --import ./test/support/isolate-test-env.mjs --test test/unit/foreground-execution-routing.test.ts; 41 passed, 0 failed; external cap aborts owner and attempt signals, rewrites interruptions and startup failures, and wins selection rejection races; no paid or external action launched |
| 9 | done | 1 | timeout -k 30 180 node --import ./test/support/isolate-test-env.mjs --test test/integration/top-level-async.test.ts; 21 passed, 0 failed; async child stays running past maxRuntimeMs=100 and completes its 1500 ms script with control enabled; no paid or external action launched |
| 10 | done | 1 | timeout -k 30 10 python3 -c 'assert all(any(all(t in line for t in tokens) for line in __import__("pathlib").Path(path).read_text().splitlines()) for path, tokens in [("doc/configuration.md", ["\"maxRuntimeMs\": 14400000"]), ("doc/configuration.md", ["maxRuntimeMs", "14400000", "foreground", "enabled: false"]), ("doc/programmatic-api.md", ["maxRuntimeMs", "14400000", "foreground only", "result.error", "enabled"]), ("doc/programmatic-api.md", ["Supports", "maxRuntimeMs"]), ("skills/pi-cohort/reference/config-fields.md", ["maxRuntimeMs", "integer >= 1", "14400000", "foreground only"]), ("skills/pi-cohort/SKILL.md", ["maxRuntimeMs", "control:"])])'; 6 documentation assertions passed after baseline failure; tables and settings example document the default and foreground cap independent of enabled; no paid or external action launched |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 7
row 1 done | Added a per-child monotonic cap, failure rewrite and abort escalation; 19 integration tests pass. | Reuse runSync's monotonicNow seam and mock-pi ignoreSigterm fixture for deadline and backend checks.
row 7 done | Resolved positive-integer maxRuntimeMs with call-time, settings and default precedence; 42 unit tests pass. | Reuse resolveControlConfig in src/runs/shared/subagent-control.ts for settings and override execution checks.
row 2 done | Added top-level and chain parallel cap-isolation checks; 21 integration tests pass without runtime changes. | Reuse the table-driven sibling cases in test/integration/foreground-in-flight-control.test.ts to check queued and running children.
row 3 done | Added a settings-only foreground cap check through resolveConfig; 22 integration tests pass without runtime changes. | Reuse the settings-cap executor fixture in test/integration/foreground-in-flight-control.test.ts to check call-time precedence.
row 4 done | Added shorter and longer call-time override checks; 24 integration tests pass without runtime changes. | Reuse the call-time precedence cases in test/integration/foreground-in-flight-control.test.ts for executor-level cap checks.
row 5 done | Added three deterministic default-deadline checks; 28 unit tests pass without runtime changes. | Reuse the mocked timers and monotonic clock cases in test/unit/foreground-execution-routing.test.ts for cap-boundary checks.
row 6 done | Added three extended call-time deadline checks including multiple 32-bit timer chunks; 31 unit tests pass without runtime changes. | Reuse the extended-deadline cases in test/unit/foreground-execution-routing.test.ts to check long caps and timer re-arming.
row 8 done | Fixed a cap-versus-backend-selection rejection race and added ten external cap checks; 41 unit tests pass. | Reuse the external cap cases in test/unit/foreground-execution-routing.test.ts for interruption rewrites, startup failures and selection races.
row 9 done | Added an async cap-exemption scenario with control enabled; 21 integration tests pass without runtime changes. | Reuse the runtime-cap scenario in test/integration/top-level-async.test.ts to verify async completion beyond a configured cap.
row 10 done | Documented maxRuntimeMs in configuration, API and skill references; six documentation assertions pass. | Reuse doc/configuration.md and doc/programmatic-api.md for settings and call-time cap guidance, including the default and foreground-only scope.
