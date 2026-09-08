import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replayExecutionSession } from "../../src/execution-backend/session-replay.ts";

const identity = { runId: "run", childId: "child", attemptId: "attempt" };
function report(kind: string, sequence: number, extras = {}, entry = {}) { return { type: "custom", id: `r${sequence}`, parentId: sequence === 1 ? null : `r${sequence - 1}`, customType: "pi-cohort:execution-report:v1", data: { protocolVersion: 1, kind, ...identity, sequence, timestamp: "2026-09-06T00:00:00.000Z", ...extras }, ...entry }; }
function replay(entries: unknown[]) { return replayExecutionSession(entries.map(JSON.stringify).join("\n") + "\n", identity); }
const lifecycle = () => [report("ready", 1), report("settled", 2), report("result", 3, { outcome: "success", finalOutput: "done" })];

describe("execution session replay", () => {
	it("reconstructs standard user, assistant, and tool result messages from the terminal branch", () => {
		const result = report("result", 3, { outcome: "success", finalOutput: "done" }, { id: "exact-result", parentId: "tool" });
		const user = { role: "user", content: "right", timestamp: 1 };
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "tool", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 };
		const toolResult = { role: "toolResult", toolCallId: "call", toolName: "tool", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 };
		const value = replay([{ type: "message", id: "wrong", parentId: null, message: { role: "user", content: "wrong", timestamp: 1 } }, { type: "message", id: "correct", parentId: null, message: user }, { type: "message", id: "assistant", parentId: "correct", message: assistant }, { type: "message", id: "tool", parentId: "assistant", message: toolResult }, report("ready", 1), report("settled", 2), result]);
		assert.deepEqual(value.messages, [user, assistant, toolResult]);
	});

	it("preserves valid custom and bash execution messages on the terminal branch", () => {
		const result = report("result", 3, { outcome: "success", finalOutput: "done" }, { parentId: "bash" });
		const custom = { role: "custom", customType: "test", content: "custom", display: true, timestamp: 1 };
		const bash = { role: "bashExecution", command: "echo test", output: "test", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 };
		const value = replay([{ type: "message", id: "custom", parentId: null, message: custom }, { type: "message", id: "bash", parentId: "custom", message: bash }, report("ready", 1), report("settled", 2), result]);
		assert.deepEqual(value.messages, [custom, bash]);
	});

	it("rejects blank, malformed, and malformed message entry JSONL lines", () => {
		assert.throws(() => replayExecutionSession("\n", identity), /blank complete/);
		assert.throws(() => replayExecutionSession("{bad}\n", identity), /malformed/);
		assert.throws(() => replay([{ type: "message", id: "missing-role", parentId: null, message: { content: "no role" } }]), /malformed session message entry/);
		assert.throws(() => replay([{ type: "message", id: "malformed-assistant", parentId: null, message: { role: "assistant", content: [] } }]), /malformed standard session message/);
		assert.throws(() => replay([{ type: "message", id: "missing-parent", message: { role: "user", content: "no parent" } }]), /malformed session message entry/);
	});

	it("tolerates exactly one partial trailing line", () => {
		const value = replayExecutionSession(JSON.stringify(report("ready", 1)) + "\n{\"partial", identity);
		assert.equal(value.incompleteTrailingLine, true); assert.equal(value.reports.length, 1);
	});

	it("ignores unrelated custom types and complete attempts", () => {
		const other = { ...report("ready", 1), id: "other-type", customType: "elsewhere", data: null };
		const otherAttempt = { ...report("ready", 1), id: "other-attempt", data: { ...report("ready", 1).data, attemptId: "other" } };
		assert.equal(replay([other, otherAttempt, report("ready", 1)]).reports.length, 1);
	});

	it("rejects correlation mismatches in a claimed stream", () => {
		for (const reportWithMismatch of [{ ...report("ready", 1), data: { ...report("ready", 1).data, childId: "wrong" } }, { ...report("ready", 1), data: { ...report("ready", 1).data, runId: "wrong" } }]) assert.throws(() => replay([reportWithMismatch]), /correlation/);
	});

	it("rejects sequence gaps and duplicates", () => {
		assert.throws(() => replay([report("ready", 1), report("settled", 3)]), /sequence/);
		assert.throws(() => replay([report("ready", 1), report("settled", 2), report("control", 2, { action: "abort", state: "requested" }, { id: "duplicate-sequence" })]), /sequence/);
	});

	it("rejects result before ready and settled, duplicate terminal results, and terminal lifecycle regressions", () => {
		assert.throws(() => replay([report("result", 1, { outcome: "success", finalOutput: "" })]), /out of order/);
		assert.throws(() => replay([report("ready", 1), report("result", 2, { outcome: "success", finalOutput: "" })]), /out of order/);
		assert.throws(() => replay([...lifecycle(), report("result", 4, { outcome: "success", finalOutput: "" })]), /out of order/);
		assert.throws(() => replay([...lifecycle(), report("settled", 4)]), /out of order/);
	});

	it("exposes validated control reports after the terminal result", () => {
		const value = replay([...lifecycle(), report("control", 4, { action: "abort", state: "requested" })]);
		assert.equal(value.result?.finalOutput, "done");
		assert.equal(value.reports.length, 4);
		assert.deepEqual(value.controls, [{
			protocolVersion: 1,
			...identity,
			kind: "control",
			sequence: 4,
			timestamp: "2026-09-06T00:00:00.000Z",
			action: "abort",
			state: "requested",
		}]);
	});

	it("reports a settled stream without result as pending", () => {
		assert.equal(replay([report("ready", 1), report("settled", 2)]).pendingResult, true);
	});

	it("rejects duplicate entry identifiers", () => {
		assert.throws(() => replay([{ type: "message", id: "same", parentId: null, message: { role: "custom", customType: "test", content: "one", display: true, timestamp: 1 } }, { type: "message", id: "same", parentId: null, message: { role: "custom", customType: "test", content: "two", display: true, timestamp: 2 } }, ...lifecycle()]), /duplicate session entry/);
	});

	it("rejects cycles and missing or non-string parent links on the result branch", () => {
		for (const parentId of ["missing", 3, undefined]) {
			const terminal = report("result", 3, { outcome: "success", finalOutput: "" }, { parentId });
			assert.throws(() => replay([report("ready", 1), report("settled", 2), terminal]), /parent link/);
		}
		const terminal = report("result", 3, { outcome: "success", finalOutput: "" }, { parentId: "cycle" });
		assert.throws(() => replay([{ type: "message", id: "cycle", parentId: "cycle", message: { role: "custom", customType: "test", content: "cycle", display: true, timestamp: 1 } }, report("ready", 1), report("settled", 2), terminal]), /parent cycle/);
	});
});
