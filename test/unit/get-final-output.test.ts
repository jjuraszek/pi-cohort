import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { getFinalOutput } from "../../src/shared/utils.ts";

function assistantContent(content: unknown[]): Message {
	return { role: "assistant", content } as unknown as Message;
}

describe("getFinalOutput", () => {
	it("skips empty text parts in the latest assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "" },
			{ type: "text", text: "Summary" },
		])];

		assert.equal(getFinalOutput(messages), "Summary");
	});

	it("joins all non-empty text parts in a multi-part assistant message", () => {
		const messages = [assistantContent([
			{ type: "text", text: "Working on the fix..." },
			{ type: "thinking", thinking: "Cursor shell: shell $ npm test" },
			{ type: "text", text: "Implemented: patch applied." },
		])];

		assert.equal(getFinalOutput(messages), "Working on the fix...\nImplemented: patch applied.");
	});

	it("joins two text blocks with a newline", () => {
		const messages = [assistantContent([
			{ type: "text", text: "BLOCKED: need approval to rotate key" },
			{ type: "text", text: "Done: inspected\nRemaining: rotate" },
		])];

		assert.equal(
			getFinalOutput(messages),
			"BLOCKED: need approval to rotate key\nDone: inspected\nRemaining: rotate",
		);
	});

	it("leaves a single text block unchanged", () => {
		const messages = [assistantContent([{ type: "text", text: "Summary" }])];

		assert.equal(getFinalOutput(messages), "Summary");
	});

	it("skips tool-call parts between text blocks", () => {
		const messages = [assistantContent([
			{ type: "text", text: "First" },
			{ type: "toolCall", name: "read", arguments: { path: "README.md" } },
			{ type: "text", text: "Second" },
		])];

		assert.equal(getFinalOutput(messages), "First\nSecond");
	});

	it("falls back to an older assistant message when the latest text is whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "text", text: " \n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	it("falls back to an older assistant message when the latest assistant message is tool-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "Earlier" }]),
			assistantContent([{ type: "toolCall", name: "read", arguments: { path: "README.md" } }]),
		];

		assert.equal(getFinalOutput(messages), "Earlier");
	});

	it("returns empty output when all assistant text is empty or whitespace-only", () => {
		const messages = [
			assistantContent([{ type: "text", text: "" }]),
			assistantContent([{ type: "text", text: "\n\t " }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	it("does not use provider-error assistant text as fallback output", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "temporary provider failure" }],
				stopReason: "error",
				errorMessage: "provider transport failed",
			} as unknown as Message,
			assistantContent([{ type: "text", text: "" }]),
		];

		assert.equal(getFinalOutput(messages), "");
	});

	it("preserves surrounding whitespace on the selected non-empty text", () => {
		const messages = [assistantContent([{ type: "text", text: " \n Summary \n " }])];

		assert.equal(getFinalOutput(messages), " \n Summary \n ");
	});
});
