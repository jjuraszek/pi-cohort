# Ledger - loop engine
**Spec:** `doc/specs/2026-11-21-gh-80-slash-idle-copy-answers.md`
base: 80a6a98e08bdffb1d229c7c26d672de59a4c539e
verification: env -u PI_CODING_AGENT_DIR npm run test:all
checks: commands
iterations: 5
allowance: 10
returned: 1 | home | f055192258feacf7a66771e424f629f5cd4792d5

| row | status | attempts | evidence |
|---|---|---|---|
| 1 | done | 2 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts; 29 passed, 0 failed; pi 1.6.0 control-stop.out on 5ab3ef7: idle error then child-stop acknowledgment; post-control-short.out on 0c00e43: one response and one exact short-id error notice, no context error |
| 2 | done | 1 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts; 29 passed, 0 failed; pi 1.6.0 fixed-launch-one.out and fixed-launch-two.out: each final card matched its request ID and contained its own successful scout output; neither run had a no-context card or notice |
| 3 | done | 1 | timeout -k 30 90 env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --import ./test/support/register-loader.mjs --test test/integration/slash-commands.test.ts; 29 passed, 0 failed; pi 1.6.0 fixed-stop.out: one reply and one child-specific info notice for the listed scout cee082, no context error; the terminal result for the acknowledged child ID recorded interrupted: true |

## Decisions
row 0 done | seeded 1 rows, closed 0 on baseline | row 1
row 1 failed | The idle handler now stays silent, and the integration test sees only the short-id error. | Keep the fix and test; the missing evidence is the source-base stop control followed by the fixed-build short-id trace on the two-copy pi 1.6.0 host.
amended | cut row 1 | Short-id live proof
row 2 failed | The integration test saw one reply to /run scout say hi, a card with the scout's output, and no notice. | Keep the test; after the source-base stop control, compare the final cards and notices from one-copy and two-copy runs on a top-level pi 1.6.0 RPC host.
amended | cut row 2 | Launch card live proof
row 3 failed | The integration test stopped the listed mock scout, saw one stop acknowledgment and confirmed interrupted: true for that child. | Keep the test; capture the source-base double reply, then the fixed build's single stop notice and interrupted child result on a top-level two-copy pi 1.6.0 RPC host.
amended | cut row 3 | Running child live proof
amended | 3 item(s) | Short-id live proof observed
row 1 done | After the stop control reproduced the double reply, /interrupt-child abc on the fixed two-copy host returned one response and showed only the short-id error. | Reuse post-control-short.out in the worker scratch directory to check the response and notice without starting pi.
row 2 done | With one copy and with two, /run scout say hi showed the scout's own output on the final card without a no-context error on the card or in any notice. | nothing new to build on
row 3 done | On the two-copy host, /interrupt-child cee082 showed one stop acknowledgment, no context error, and the terminal result for that scout recorded interrupted: true. | nothing new to build on
amended | 1 item(s) | Row 2 checker limits accepted
