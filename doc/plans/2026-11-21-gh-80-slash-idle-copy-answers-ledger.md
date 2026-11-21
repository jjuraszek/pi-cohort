# Ledger - loop engine
**Spec:** `doc/specs/2026-11-21-gh-80-slash-idle-copy-answers.md`
base: 80a6a98e08bdffb1d229c7c26d672de59a4c539e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 2
allowance: 10
returned: 1 | home | 15a739245767fe90e0457aa199f4a0ba1cdabbfb

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | cut | 1 | deviates: unreachable in this checkout - missing source-base stop trace and this worker cannot launch a real scout; proof at top-level pi 1.6.0 two-copy RPC setup |
| 2 | open | 0 | |
| 3 | open | 0 | |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 failed | The idle handler now stays silent, and the integration test sees only the short-id error. | Keep the fix and test; the missing evidence is the source-base stop control followed by the fixed-build short-id trace on the two-copy pi 1.6.0 host.
amended | cut row 1 | Short-id live proof
