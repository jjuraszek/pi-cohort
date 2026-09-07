import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CONTROL_MAX_FRAME_BYTES,
	CONTROL_PROTOCOL_VERSION,
	ControlFrameDecoder,
	encodeControlRequest,
	type ControlRequest,
	validateControlRequest,
} from "../../src/execution-backend/control-protocol.ts";

const request: ControlRequest = {
	protocolVersion: CONTROL_PROTOCOL_VERSION,
	runId: "run",
	childId: "child",
	attemptId: "attempt",
	requestId: "request",
	action: "abort",
};

describe("execution control protocol", () => {
	it("validates exact requests and encodes one JSONL frame", () => {
		assert.deepEqual(validateControlRequest(request), request);
		assert.deepEqual(validateControlRequest({ ...request, action: "shutdown" }), {
			...request,
			action: "shutdown",
		});
		assert.deepEqual(encodeControlRequest(request), Buffer.from(`${JSON.stringify(request)}\n`));
		for (const malformed of [
			null,
			{ ...request, protocolVersion: 2 },
			{ ...request, action: "steer" },
			{ ...request, requestId: "" },
			{ ...request, childId: 3 },
			{ ...request, extra: true },
			Object.fromEntries(Object.entries(request).filter(([key]) => key !== "attemptId")),
		]) assert.throws(() => validateControlRequest(malformed));
	});

	it("decodes split and coalesced Buffer or string frames without retaining parsed data", () => {
		const decoder = new ControlFrameDecoder();
		const secret = "secret-complete-request";
		const first = encodeControlRequest({ ...request, requestId: secret });
		const second = encodeControlRequest({ ...request, requestId: "second", action: "shutdown" });
		const split = first.indexOf(Buffer.from("attempt")) + 3;
		assert.deepEqual(decoder.feed(first.subarray(0, split)), []);
		assert.deepEqual(
			decoder.feed(Buffer.concat([first.subarray(split), second])).map(({ requestId }) => requestId),
			[secret, "second"],
		);
		assert.equal(decoder.remainder.includes(Buffer.from(secret)), false);
		assert.deepEqual(decoder.feed(`${JSON.stringify(request)}\n`), [request]);
	});

	it("bounds each complete frame and only the incomplete remainder", () => {
		const decoder = new ControlFrameDecoder(CONTROL_MAX_FRAME_BYTES);
		const frame = encodeControlRequest({ ...request, requestId: "x".repeat(33_000) });
		assert.ok(frame.length < CONTROL_MAX_FRAME_BYTES);
		assert.equal(decoder.feed(Buffer.concat([frame, frame])).length, 2);
		assert.throws(() => decoder.feed("\n"), /empty control frame/);
		assert.throws(
			() => new ControlFrameDecoder(10).feed(`${JSON.stringify(request)}\n`),
			/control frame size limit exceeded/,
		);
		assert.throws(
			() => new ControlFrameDecoder(4).feed(Buffer.from("ééé")),
			/control frame size limit exceeded/,
		);
	});
});
