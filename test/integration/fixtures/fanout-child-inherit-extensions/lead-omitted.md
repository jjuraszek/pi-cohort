---
name: lead-omitted
description: lead-omitted startup fixture
tools: read, bash, subagent, ping_fixture
model: fanout-fixture/scripted
---
Call ping, delegate to worker, then report both results.
