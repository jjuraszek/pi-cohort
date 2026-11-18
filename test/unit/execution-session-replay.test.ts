import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { replayExecutionSession } from "../../src/execution-backend/session-replay.ts";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";
import { EXECUTION_REPORT_TYPE } from "../../src/execution-backend/reporting-protocol.ts";

const identity = { runId: "run", childId: "child", attemptId: "attempt" };
function report(kind: string, sequence: number, extras = {}, entry = {}) { return { type: "custom", id: `r${sequence}`, parentId: sequence === 1 ? null : `r${sequence - 1}`, customType: "pi-cohort:execution-report:v1", data: { protocolVersion: 1, kind, ...identity, sequence, timestamp: "2026-09-06T00:00:00.000Z", ...extras }, ...entry }; }
function replay(entries: unknown[]) { return replayExecutionSession(entries.map(JSON.stringify).join("\n") + "\n", identity); }
const lifecycle = () => [report("ready", 1), report("settled", 2), report("result", 3, { outcome: "success", finalOutput: "done" })];
const parentTurn = { role: "assistant" as const, content: [{ type: "text" as const, text: "parent answer" }], api: "openai-completions", provider: "test", model: "parent-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } }, stopReason: "stop" as const, timestamp: 2 };

describe("execution session replay", () => {
	it("owns only entries appended after ready even when the final branch rewinds into inherited history", () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-replay-fork-")));
		try {
			const parent = SessionManager.create(directory, path.join(directory, "parent"));
			parent.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
			parent.appendMessage(parentTurn);
			const forkPoint = parent.appendUsage("cache_warm", "test", "parent-model", parentTurn.usage).id;
			const charge = (total: number) => ({ ...parentTurn.usage, cost: { ...parentTurn.usage.cost, input: total, output: 0, total } });
			const abandonedCharge = charge(2);
			const finalCharge = charge(3);
			const resolver = createForkContextResolver(parent, "fork", { sessionDirForIndex: () => path.join(directory, "child") });
			const sessionFile = resolver.sessionFileForIndex(0, directory);
			assert.ok(sessionFile);
			const child = SessionManager.open(sessionFile);
			const read = (attempt = identity) => replayExecutionSession(fs.readFileSync(sessionFile, "utf8"), attempt);
			const beforeReady = read();
			assert.deepEqual(beforeReady.messages, []);
			assert.deepEqual(beforeReady.pendingMessages, []);
			assert.deepEqual(beforeReady.charges, []);
			assert.deepEqual(beforeReady.pendingCharges, []);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("ready", 1).data);
			const abandoned = { role: "user" as const, content: "abandoned own message", timestamp: 3 };
			child.appendMessage(abandoned);
			child.appendUsage("cache_warm", "test", "child-model", abandonedCharge);
			child.branch(forkPoint);
			const own = { ...parentTurn, model: "child-model", content: [{ type: "text" as const, text: "child answer" }], timestamp: 4 };
			child.appendMessage(own);
			child.appendUsage("cache_warm", "test", "child-model", finalCharge);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("settled", 2).data);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("result", 3, { outcome: "success", finalOutput: "child answer" }).data);
			const first = read();
			assert.deepEqual(first.messages, [own]);
			assert.deepEqual(first.pendingMessages, [abandoned, own]);
			assert.deepEqual(first.charges, [finalCharge]);
			assert.deepEqual(first.pendingCharges, [abandonedCharge, finalCharge]);
			assert.equal(child.getBranch().some(entry => entry.type === "custom" && entry.data?.kind === "ready"), false, "ownership does not require ready on the final branch");

			const secondIdentity = { ...identity, attemptId: "retry" };
			const retryTurn = { ...own, timestamp: 5 };
			const retryCharge = charge(4);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("ready", 1, secondIdentity).data);
			child.appendMessage(retryTurn);
			child.appendUsage("cache_warm", "test", "child-model", retryCharge);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("settled", 2, secondIdentity).data);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, report("result", 3, { ...secondIdentity, outcome: "success", finalOutput: "child answer" }).data);
			const second = read(secondIdentity);
			assert.deepEqual(second.messages, [retryTurn]);
			assert.deepEqual(second.pendingMessages, [retryTurn]);
			assert.deepEqual(second.charges, [retryCharge]);
			assert.deepEqual(second.pendingCharges, [retryCharge]);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reconstructs standard user, assistant, and tool result messages from the terminal branch", () => {
		const result = report("result", 3, { outcome: "success", finalOutput: "done" }, { id: "exact-result", parentId: "r2" });
		const user = { role: "user", content: "right", timestamp: 1 };
		const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "tool", arguments: {} }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 };
		const toolResult = { role: "toolResult", toolCallId: "call", toolName: "tool", content: [{ type: "text", text: "done" }], isError: false, timestamp: 3 };
		const value = replay([report("ready", 1), { type: "message", id: "wrong", parentId: "r1", message: { role: "user", content: "wrong", timestamp: 1 } }, { type: "message", id: "correct", parentId: "r1", message: user }, { type: "message", id: "assistant", parentId: "correct", message: assistant }, { type: "message", id: "tool", parentId: "assistant", message: toolResult }, report("settled", 2, {}, { parentId: "tool" }), result]);
		assert.deepEqual(value.messages, [user, assistant, toolResult]);
	});

	it("preserves valid custom and bash execution messages on the terminal branch", () => {
		const result = report("result", 3, { outcome: "success", finalOutput: "done" });
		const custom = { role: "custom", customType: "test", content: "custom", display: true, timestamp: 1 };
		const bash = { role: "bashExecution", command: "echo test", output: "test", exitCode: 0, cancelled: false, truncated: false, timestamp: 2 };
		const value = replay([report("ready", 1), { type: "message", id: "custom", parentId: "r1", message: custom }, { type: "message", id: "bash", parentId: "custom", message: bash }, report("settled", 2, {}, { parentId: "bash" }), result]);
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

	for (const mismatch of [{ childId: "wrong" }, { runId: "wrong" }]) it(`rejects a mismatched ${Object.keys(mismatch)[0]} only after the attempt claims its stream`, () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-replay-fork-")));
		try {
			const parent = SessionManager.create(directory, path.join(directory, "parent"));
			const partialReady = report("ready", 1, mismatch).data;
			const inheritedId = parent.appendCustomEntry(EXECUTION_REPORT_TYPE, partialReady);
			parent.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
			parent.appendMessage(parentTurn);
			const resolver = createForkContextResolver(parent, "fork", { sessionDirForIndex: () => path.join(directory, "child") });
			const sessionFile = resolver.sessionFileForIndex(0, directory);
			assert.ok(sessionFile);
			const child = SessionManager.open(sessionFile);
			assert.deepEqual(child.getEntry(inheritedId), parent.getEntry(inheritedId));
			const read = () => replayExecutionSession(fs.readFileSync(sessionFile, "utf8"), identity);
			assert.deepEqual(read().reports, []);
			const ownReady = report("ready", 1).data;
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, ownReady);
			assert.deepEqual(read().reports, [ownReady]);
			child.appendCustomEntry(EXECUTION_REPORT_TYPE, partialReady);
			assert.throws(read, /execution report correlation mismatch/);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
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
