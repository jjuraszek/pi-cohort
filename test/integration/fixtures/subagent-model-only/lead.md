---
name: lead
description: Dispatch to exercise scripted rejection and direct leaf dispatch offline.
tools: subagent, codemode
extensions: ./.pi/extensions/provider.ts
model: subagent-model-only-fixture/scripted
---
Act as the fixture lead to exercise the direct-call boundary.
Return FIXTURE_DONE after the leaf completes.
Attempt scripted dispatch, recover with a direct subagent call, then report completion.
