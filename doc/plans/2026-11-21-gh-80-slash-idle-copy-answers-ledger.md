# Ledger - loop engine
**Spec:** `doc/specs/2026-11-21-gh-80-slash-idle-copy-answers.md`
base: 80a6a98e08bdffb1d229c7c26d672de59a4c539e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 3
allowance: 10
returned: 2 | home | 6ba0e3d38546ea1b89b41a7b3b706e084c0e2ded

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | cut | 1 | deviates: unreachable in this checkout - missing source-base stop trace and this worker cannot launch a real scout; proof at top-level pi 1.6.0 two-copy RPC setup |
| 2 | cut | 1 | deviates: unreachable in this checkout - missing source-base stop control and live one- and two-copy scout traces; proof at top-level pi 1.6.0 RPC host with model access |
| 3 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 failed | The idle handler now stays silent, and the integration test sees only the short-id error. | Keep the fix and test; the missing evidence is the source-base stop control followed by the fixed-build short-id trace on the two-copy pi 1.6.0 host.
amended | cut row 1 | Short-id live proof
row 2 failed | The integration test saw one reply to /run scout say hi, a card with the scout's output, and no notice. | Keep the test; after the source-base stop control, compare the final cards and notices from one-copy and two-copy runs on a top-level pi 1.6.0 RPC host.
amended | cut row 2 | Launch card live proof
