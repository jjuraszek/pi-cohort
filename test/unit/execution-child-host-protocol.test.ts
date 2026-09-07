import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHILD_HOST_PROTOCOL_VERSION, ChildHostFrameDecoder, decodeChildHostFrames, validateChildHostMessage } from "../../src/execution-backend/child-host-protocol.ts";

describe("execution child host protocol", () => {
	it("validates exact versioned messages", () => {
		assert.deepEqual(validateChildHostMessage({ protocolVersion: 1, kind: "host_ready", runId: "run", childId: "child" }), { protocolVersion: 1, kind: "host_ready", runId: "run", childId: "child" });
		for (const value of [
			{ protocolVersion: 2, kind: "host_ready", runId: "run", childId: "child" },
			{ protocolVersion: 1, kind: "host_ready", runId: "run", childId: "child", extra: true },
			{ protocolVersion: 1, kind: "host_ready", runId: "run" },
			{ protocolVersion: 1, kind: "attempt_exited", runId: "run", childId: "child", attemptId: "a", status: "0", signal: null },
		]) assert.throws(() => validateChildHostMessage(value));
		assert.equal(CHILD_HOST_PROTOCOL_VERSION, 1);
	});

	it("frames split and coalesced input without retaining secrets", () => {
		const ready = JSON.stringify({ protocolVersion: 1, kind: "host_ready", runId: "run", childId: "child" });
		const secret = "secret-not-retained-after-frame";
		const attempt = JSON.stringify({ protocolVersion: 1, kind: "start_attempt", runId: "run", childId: "child", attemptId: "attempt", command: "node", args: [], cwd: "/tmp", environment: { TOKEN: secret } });
		const decoder = new ChildHostFrameDecoder();
		assert.deepEqual(decoder.push(`${ready.slice(0, 12)}`), []);
		assert.equal(decoder.push(`${ready.slice(12)}\n${attempt.slice(0, 20)}`).length, 1);
		assert.equal(decoder.push(`${attempt.slice(20)}\n${ready}\n`).length, 2);
		assert.equal(decoder.remainder, "");
		assert.equal(decoder.remainder.includes(secret), false);
		assert.throws(() => decodeChildHostFrames("x".repeat(65_537)));
		assert.throws(() => decodeChildHostFrames(`${ready}\nnot-json\n`));
	});
});
