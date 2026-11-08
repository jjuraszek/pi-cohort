import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface DetectErrorResult {
	hasError: boolean;
	errorType?: string;
	details?: string;
	exitCode?: number;
}

type DetectSubagentError = (messages: unknown[]) => DetectErrorResult;

let detectSubagentError: DetectSubagentError | undefined;
let available = true;
try {
	({ detectSubagentError } = await import("../../src/shared/utils.ts"));
} catch {
	// Skip in lean unit mode when runtime-only imports are unavailable.
	available = false;
}

/**
 * Helper to create a tool result message (success or error).
 */
function toolResult(toolName: string, text: string, isError = false, details?: unknown): Record<string, unknown> {
	return {
		role: "toolResult",
		toolCallId: `call-${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text }],
		isError,
		details,
	};
}

function assistantMsg(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
	};
}

/** Assistant message with only a tool call, no text content */
function assistantToolCall(toolName: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: toolName, input: {} }],
		api: "test",
		provider: "test",
		model: "test",
	};
}

describe("detectSubagentError", { skip: !available ? "utils not importable" : undefined }, () => {
	// ---- Basic detection (must still work) ----

	it("returns no error for empty messages", () => {
		assert.equal(detectSubagentError([]).hasError, false);
	});

	it("returns no error when all tool results succeed", () => {
		const messages = [
			toolResult("read", "file contents here"),
			toolResult("bash", "ls output"),
			toolResult("read", "more contents"),
		];
		assert.equal(detectSubagentError(messages).hasError, false);
	});

	it("detects isError tool result as failure (no assistant response)", () => {
		const messages = [
			toolResult("read", "file contents"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "read");
		assert.match(result.details!, /EISDIR/);
	});

	it("detects bash fatal pattern (permission denied, no assistant response)", () => {
		const messages = [
			toolResult("bash", "ls: permission denied: /root/secret"),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "bash");
	});

	it("detects bash exit code in output", () => {
		const messages = [
			toolResult("bash", "error: process exited with code 127"),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.exitCode, 127);
	});

	// ---- Recovery: errors before the agent's final response are forgiven ----

	it("ignores error when agent recovered and continued", () => {
		const messages = [
			toolResult("read", "file contents"),
			toolResult("bash", "ok"),
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			toolResult("bash", "directory listing via bash"),
			assistantMsg("Here is my complete review..."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"error before agent's final text response should be ignored");
	});

	it("ignores error as final tool result when agent produced text response after", () => {
		// The exact scenario from our review run: agent did all work, last tool
		// call was read on directory → EISDIR, but agent produced 13.5KB review.
		const messages = [
			toolResult("read", "file contents of index.ts"),
			toolResult("read", "file contents of utils.ts"),
			toolResult("bash", "npm test output: 46 pass"),
			toolResult("read", "file contents of settings.ts"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
			assistantMsg("## Complete Review\n\nHere are all my findings..."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"agent produced substantive output after error — not a failure");
	});

	it("ignores bash fatal pattern when agent responded after", () => {
		const messages = [
			toolResult("bash", "ls: permission denied: /root/secret"),
			assistantMsg("I couldn't access /root/secret, but I found the data elsewhere."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"fatal pattern before agent's text response = recovered");
	});

	// ---- Errors AFTER the last assistant text response are still caught ----

	it("detects error after agent's last text response", () => {
		const messages = [
			assistantMsg("Here is my analysis..."),
			toolResult("bash", "rm -rf /important", false),
			toolResult("bash", "error: process exited with code 1", false),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.exitCode, 1);
	});

	it("detects isError after agent's last text response", () => {
		const messages = [
			toolResult("read", "file ok"),
			assistantMsg("Let me try one more thing..."),
			toolResult("write", "Permission denied", true),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true);
		assert.equal(result.errorType, "write");
	});

	// ---- Edge cases ----

	it("flags error when no assistant messages at all", () => {
		const messages = [
			toolResult("read", "ok"),
			toolResult("bash", "segmentation fault"),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"no assistant response = no recovery evidence");
	});

	it("does not treat tool-call-only assistant message as recovery", () => {
		// Assistant message that only contains a tool call, no text.
		// The error at index 0 should still be detected because the tool-call-only
		// assistant message doesn't count as recovery. The final tool result is
		// successful to ensure this test actually distinguishes correct behavior.
		const messages = [
			toolResult("bash", "permission denied: /etc/shadow"),
			assistantToolCall("bash"),
			toolResult("bash", "command succeeded"),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"tool-call assistant message without text is not a recovery");
	});

	it("does not treat empty/whitespace assistant message as recovery", () => {
		const messages = [
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			assistantMsg("   "),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, true,
			"whitespace-only assistant message is not a recovery");
	});

	it("returns no error when only assistant messages (no tool results)", () => {
		const messages = [
			assistantMsg("Hello, I'm ready to help."),
			assistantMsg("Here's my analysis."),
		];
		assert.equal(detectSubagentError(messages).hasError, false);
	});

	it("handles multiple errors with recovery between them", () => {
		// Error → recovery → error → recovery
		const messages = [
			toolResult("read", "ENOENT: no such file", true),
			assistantMsg("File not found, trying alternative..."),
			toolResult("read", "file contents"),
			toolResult("read", "EISDIR: illegal operation on a directory", true),
			assistantMsg("Got what I needed. Here's the full review."),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"all errors have recovery — agent completed successfully");
	});

	const validationError = () => toolResult("structured_output", "Structured output validation failed: root: Expected string", true);
	const structuredSuccess = () => toolResult("structured_output", "Structured output captured");
	const scriptDiagnostic = "Script error:\nTypeError: tools.structured_output does not exist.\n\nNo tool calls were made.";
	const scriptRejection = {
		...toolResult("codemode", "Script failed\n", true, { calls: [] }),
		content: [{ type: "text", text: "Script failed\n" }, { type: "text", text: scriptDiagnostic }],
	};
	const withDiagnostic = (text: string) => ({
		...scriptRejection,
		content: [scriptRejection.content[0], { type: "text", text }],
	});
	const correctionCases = [
		{ name: "schema rejection then success", messages: [validationError(), structuredSuccess()], errorType: undefined },
		{ name: "parameter rejection then success", messages: [toolResult("structured_output", 'Validation failed for tool "structured_output": value: Required', true), structuredSuccess()], errorType: undefined },
		{ name: "argument parse rejection then success", messages: [toolResult("structured_output", 'Invalid arguments for tool "structured_output": malformed JSON', true), structuredSuccess()], errorType: undefined },
		{ name: "two rejections then success", messages: [validationError(), validationError(), structuredSuccess()], errorType: undefined },
		{ name: "only rejection", messages: [validationError()], errorType: "structured_output" },
		{ name: "success then rejection", messages: [structuredSuccess(), validationError()], errorType: "structured_output" },
		{ name: "rejection then tool call only", messages: [validationError(), assistantToolCall("structured_output")], errorType: "structured_output" },
		{ name: "rejection then unrelated success", messages: [validationError(), toolResult("read", "ok")], errorType: "structured_output" },
		{ name: "read error remains after correction", messages: [validationError(), toolResult("read", "read failed", true), structuredSuccess()], errorType: "read" },
		{ name: "bash error remains after correction", messages: [toolResult("bash", "process exited with code 2"), validationError(), structuredSuccess()], errorType: "bash" },
		{ name: "abort is not validation", messages: [toolResult("structured_output", "Tool execution aborted", true), structuredSuccess()], errorType: "structured_output" },
		{ name: "truncation is not validation", messages: [toolResult("structured_output", "Tool call truncated: token limit exhausted", true), structuredSuccess()], errorType: "structured_output" },
		{ name: "arbitrary failure is not validation", messages: [toolResult("structured_output", "Failed to write capture", true), structuredSuccess()], errorType: "structured_output" },
		{ name: "another tool's validation is not superseded", messages: [toolResult("read", "Structured output validation failed: root: Expected string", true), structuredSuccess()], errorType: "read" },
	];
	correctionCases.push(
		{ name: "script rejection then direct success", messages: [scriptRejection, structuredSuccess()], errorType: undefined },
		{ name: "repeated script rejections then success", messages: [scriptRejection, scriptRejection, structuredSuccess()], errorType: undefined },
		{ name: "script and validation rejections then success", messages: [scriptRejection, validationError(), structuredSuccess()], errorType: undefined },
		{ name: "script rejection without success", messages: [scriptRejection], errorType: "codemode" },
		{ name: "script rejection after success", messages: [structuredSuccess(), scriptRejection], errorType: "codemode" },
		{ name: "script rejection then assistant call only", messages: [scriptRejection, assistantToolCall("structured_output")], errorType: "codemode" },
		{ name: "script rejection then unrelated success", messages: [scriptRejection, toolResult("read", "ok")], errorType: "codemode" },
		{ name: "another tool's namespace rejection", messages: [{ ...scriptRejection, toolName: "read" }, structuredSuccess()], errorType: "read" },
		{ name: "script rejection before text boundary", messages: [scriptRejection, assistantMsg("Recovered")], errorType: undefined },
		{ name: "success before text boundary does not recover later rejection", messages: [structuredSuccess(), assistantMsg("Continuing"), scriptRejection], errorType: "codemode" },
	);
	for (const [name, diagnostic] of [
		["no optional hints", "Script error:\nTypeError: tools.structured_output does not exist"],
		["optional hints", `${scriptDiagnostic}\nDid you mean another tool?\nAvailable tools: read`],
		["last diagnostic qualifies", `Script error:\nError: printed text\n${scriptDiagnostic}`],
	]) {
		correctionCases.push({ name, messages: [withDiagnostic(diagnostic), structuredSuccess()], errorType: undefined });
	}
	for (const [name, diagnostic] of [
		["unrelated codemode error", "Script error:\nTypeError: tools.read does not exist"],
		["printed phrase without marker", "TypeError: tools.structured_output does not exist"],
		["printed phrase before different terminal error", `${scriptDiagnostic}\nScript error:\nError: boom`],
		["phrase not at exception head", "Script error:\nError: TypeError: tools.structured_output does not exist"],
		["phrase on later diagnostic line", "Script error:\nError: boom\nTypeError: tools.structured_output does not exist"],
		["incomplete diagnostic", "Script error:\nTypeError: tools.structured_output does not"],
		["missing exception head", "Script error:\n"],
		["unfamiliar exception format", "Script error:\nReferenceError: tools.structured_output does not exist"],
		["unfamiliar marker format", "Script error: TypeError: tools.structured_output does not exist"],
		["truncation warning with intact tail", `Warning: truncated output\n${scriptDiagnostic}`],
	]) {
		correctionCases.push({ name, messages: [withDiagnostic(diagnostic), structuredSuccess()], errorType: "codemode" });
	}
	for (const [name, details] of [
		["missing metadata", undefined],
		["null metadata", null],
		["missing calls", {}],
		["null calls", { calls: null }],
		["string calls", { calls: "[]" }],
		["array-like calls", { calls: { length: 0 } }],
		["nested work before rejection", { calls: [{ toolName: "read", isError: false }] }],
	] as const) {
		correctionCases.push({ name, messages: [{ ...scriptRejection, details }, structuredSuccess()], errorType: "codemode" });
	}
	for (const fullOutputPath of [undefined, "/tmp/full-output.txt"]) {
		correctionCases.push({
			name: `truncation warning in separate text block with fullOutputPath ${fullOutputPath}`,
			messages: [{ ...scriptRejection, details: { calls: [], fullOutputPath }, content: [
				...scriptRejection.content, { type: "text", text: "Warning: truncated output" },
			] }, structuredSuccess()],
			errorType: "codemode",
		});
	}
	for (const failure of [
		toolResult("read", "read failed", true),
		toolResult("bash", "process exited with code 2"),
		toolResult("structured_output", "Failed to write capture", true),
		withDiagnostic("Script error:\nError: unrelated failure"),
	]) {
		for (const [position, messages] of [
			["before rejection", [failure, scriptRejection, structuredSuccess()]],
			["between rejection and success", [scriptRejection, failure, structuredSuccess()]],
			["after submission", [scriptRejection, structuredSuccess(), failure]],
		] as const) {
			correctionCases.push({ name: `${failure.toolName} failure ${position}`, messages: [...messages], errorType: failure.toolName as string });
		}
	}
	for (const { name, messages, errorType } of correctionCases) {
		it(`structured-output correction: ${name}`, () => {
			const result = detectSubagentError(messages);
			assert.equal(result.hasError, errorType !== undefined);
			assert.equal(result.errorType, errorType);
		});
	}

	// ---- Real-world regression test ----

	it("real-world: 19-read review run with trailing EISDIR", () => {
		// Simulate the actual _impl-reviewer run that produced a false positive
		const readResults = Array.from({ length: 18 }, (_, i) =>
			toolResult("read", `contents of file ${i + 1}`),
		);
		const messages = [
			...readResults,
			toolResult("bash", "npm test\n46 pass\n2 fail\nTests 48"),
			toolResult("read", "EISDIR: illegal operation on a directory, read", true),
			assistantMsg("## Implementation Review\n\n" + "x".repeat(13000)),
		];
		const result = detectSubagentError(messages);
		assert.equal(result.hasError, false,
			"complete review with trailing EISDIR must not be flagged as failure");
	});
});
