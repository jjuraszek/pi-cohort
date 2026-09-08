import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionWatcher } from "../../src/execution-backend/session-watcher.ts";
import { EXECUTION_REPORT_TYPE } from "../../src/execution-backend/reporting-protocol.ts";

const identity = { runId: "run", childId: "child", attemptId: "attempt" };

function resultLine(sequence: number, overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type: "custom",
		id: `entry-${sequence}`,
		parentId: null,
		customType: EXECUTION_REPORT_TYPE,
		data: {
			protocolVersion: 1,
			...identity,
			kind: "result",
			sequence,
			timestamp: new Date().toISOString(),
			outcome: "success",
			finalOutput: "done",
			...overrides,
		},
	})}\n`;
}

function readyLine(sequence: number): string {
	return `${JSON.stringify({
		type: "custom",
		id: `ready-${sequence}`,
		parentId: null,
		customType: EXECUTION_REPORT_TYPE,
		data: { protocolVersion: 1, ...identity, kind: "ready", sequence, timestamp: new Date().toISOString() },
	})}\n`;
}
function settledLine(sequence: number): string {
	return `${JSON.stringify({
		type: "custom",
		id: `settled-${sequence}`,
		parentId: null,
		customType: EXECUTION_REPORT_TYPE,
		data: { protocolVersion: 1, ...identity, kind: "settled", sequence, timestamp: new Date().toISOString() },
	})}\n`;
}

interface FakeWatch {
	readonly path: string;
	readonly listener: () => void;
	readonly onError: (error: Error) => void;
	closed: boolean;
}

function createFakeFileSystem(initialContent = "") {
	let content = initialContent;
	const reads: string[] = [];
	const watches: FakeWatch[] = [];
	return {
		reads,
		watches,
		setContent(next: string) {
			content = next;
		},
		fire() {
			for (const watch of watches) if (!watch.closed) watch.listener();
		},
		fail(error: Error) {
			for (const watch of watches) if (!watch.closed) watch.onError(error);
		},
		dependencies: {
			watch(path: string, listener: () => void, onError: (error: Error) => void) {
				const handle: FakeWatch = { path, listener, onError, closed: false };
				watches.push(handle);
				return { close: () => { handle.closed = true; } };
			},
			async readFile(path: string) {
				reads.push(path);
				return content;
			},
		},
	};
}

function makeAssistantMessage(overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "ok" }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-3-5-sonnet",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: 1700000000000,
		...overrides,
	};
}

function makeMessageLine(id: string, message: unknown) {
	return `${JSON.stringify({ type: "message", id, parentId: null, message })}\n`;
}

describe("execution session watcher", () => {
	it("arms the watcher before the initial replay", () => {
		const fake = createFakeFileSystem("");
		const order: string[] = [];
		const dependencies = {
			watch(path: string, listener: () => void) {
				order.push("watch");
				return fake.dependencies.watch(path, listener);
			},
			async readFile(path: string) {
				order.push("read");
				return fake.dependencies.readFile(path);
			},
		};
		createSessionWatcher("/session.jsonl", identity, dependencies);
		assert.deepEqual(order.slice(0, 1), ["watch"]);
	});

	it("resolves immediately when the terminal result is already present at arm time", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2) + resultLine(3));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		const replayed = await watcher.terminal;
		assert.equal(replayed.result?.finalOutput, "done");
		watcher.close();
	});

	it("waits while the trailing line is incomplete, then resolves on a push event", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2) + JSON.stringify({ type: "custom" }));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		let settled = false;
		void watcher.terminal.then(() => { settled = true; });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(settled, false);
		fake.setContent(readyLine(1) + settledLine(2) + resultLine(3));
		fake.fire();
		const replayed = await watcher.terminal;
		assert.equal(replayed.result?.finalOutput, "done");
		assert.equal(settled, true);
		watcher.close();
	});

	it("rejects loudly on a malformed complete line without fabricating a result", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		fake.setContent(readyLine(1) + settledLine(2) + "not-json\n");
		fake.fire();
		await assert.rejects(watcher.terminal, /malformed complete session JSONL line/);
		watcher.close();
	});

	it("rejects on a cross-correlated report without fabricating a result", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		const crossReport = JSON.stringify({
			type: "custom",
			id: "entry-cross",
			parentId: null,
			customType: EXECUTION_REPORT_TYPE,
			data: { protocolVersion: 1, runId: "other-run", childId: "child", attemptId: "attempt", kind: "result", sequence: 3, timestamp: new Date().toISOString(), outcome: "success", finalOutput: "x" },
		});
		fake.setContent(readyLine(1) + settledLine(2) + `${crossReport}\n`);
		fake.fire();
		await assert.rejects(watcher.terminal, /execution report correlation mismatch/);
		watcher.close();
	});

	it("rejects when the filesystem watcher reports an error", async () => {
		const fake = createFakeFileSystem(readyLine(1));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		fake.fail(new Error("watch failed safely"));
		await assert.rejects(watcher.terminal, /watch failed safely/);
		watcher.close();
	});

	it("coalesces rapid push events into a single re-read while a read is in flight", async () => {
		let pendingResolve: ((value: string) => void) | undefined;
		const reads: number[] = [];
		let readCount = 0;
		const dependencies = {
			watch(_path: string, listener: () => void, _onError: (error: Error) => void) {
				dependencies.listener = listener;
				return { close() {} };
			},
			listener: undefined as (() => void) | undefined,
			async readFile(_path: string) {
				readCount++;
				reads.push(readCount);
				if (readCount === 1) {
					return new Promise<string>((resolve) => { pendingResolve = resolve; });
				}
				return readyLine(1) + settledLine(2) + resultLine(3);
			},
		};
		const watcher = createSessionWatcher("/session.jsonl", identity, dependencies);
		await Promise.resolve();
		dependencies.listener?.();
		dependencies.listener?.();
		dependencies.listener?.();
		pendingResolve?.("");
		const replayed = await watcher.terminal;
		assert.equal(replayed.result?.finalOutput, "done");
		assert.equal(readCount, 2, "three coalesced events while a read was pending should trigger exactly one follow-up read");
		watcher.close();
	});

	it("close() is idempotent and stops further reads", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		await Promise.resolve();
		watcher.close();
		watcher.close();
		const readsBefore = fake.reads.length;
		fake.fire();
		await Promise.resolve();
		assert.equal(fake.reads.length, readsBefore, "no read should happen after close");
	});

	it("close() before settling rejects the terminal promise instead of hanging", async () => {
		const fake = createFakeFileSystem(readyLine(1) + settledLine(2));
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
		watcher.close();
		await assert.rejects(watcher.terminal, /session watcher closed/);
	});

	it("calls onNewMessage for each newly observed session message, deduplicated across reads", async () => {
		const assistantMsg = makeAssistantMessage();
		const msgLine = makeMessageLine("m1", assistantMsg);
		// Session with just ready and a message (no result yet).
		const fake = createFakeFileSystem(readyLine(1) + msgLine);
		const observed: unknown[] = [];
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies, (msg) => observed.push(msg));
		// Trigger reads without new entries (coalesce/dedup check).
		fake.fire();
		fake.fire();
		// Add settled + result to complete the session (sequences must be consecutive).
		fake.setContent(readyLine(1) + msgLine + settledLine(2) + resultLine(3));
		fake.fire();
		await watcher.terminal;
		watcher.close();
		// Message should appear exactly once despite multiple reads.
		assert.equal(observed.length, 1);
		assert.deepEqual(observed[0], assistantMsg);
	});

	it("forwards each message in order and does not replay old entries after a new read", async () => {
		const msg1 = makeAssistantMessage({ content: [{ type: "text" as const, text: "first" }] });
		const msg2 = { role: "user" as const, content: "second", timestamp: 1700000001000 };
		const line1 = makeMessageLine("m1", msg1);
		const line2 = makeMessageLine("m2", msg2);
		const fake = createFakeFileSystem(readyLine(1));
		const observed: unknown[] = [];
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies, (msg) => observed.push(msg));
		const pending = watcher.terminal;
		// Append first message only -- no result yet.
		fake.setContent(readyLine(1) + line1);
		fake.fire();
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(observed.length, 1);
		// Append second message plus settled+result to complete the session.
		fake.setContent(readyLine(1) + line1 + line2 + settledLine(2) + resultLine(3));
		fake.fire();
		await pending;
		watcher.close();
		assert.equal(observed.length, 2);
		assert.deepEqual(observed[0], msg1);
		assert.deepEqual(observed[1], msg2);
	});

	it("does not call onNewMessage after terminal settles", async () => {
		const msg = makeAssistantMessage();
		const msgLine = makeMessageLine("m1", msg);
		// Complete session from the start.
		const fake = createFakeFileSystem(readyLine(1) + msgLine + settledLine(2) + resultLine(3));
		const observed: unknown[] = [];
		const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies, (msg) => observed.push(msg));
		await watcher.terminal;
		const countAfterTerminal = observed.length;
		// A late fire should not emit again.
		fake.setContent(readyLine(1) + msgLine + settledLine(2) + resultLine(3));
		fake.fire();
		await new Promise(resolve => setTimeout(resolve, 10));
		watcher.close();
		assert.equal(observed.length, countAfterTerminal);
	});

	it("never registers a timer", () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalSetInterval = globalThis.setInterval;
		let timerUsed = false;
		globalThis.setTimeout = ((..._args: unknown[]) => { timerUsed = true; return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout;
		globalThis.setInterval = ((..._args: unknown[]) => { timerUsed = true; return 0 as unknown as NodeJS.Timeout; }) as typeof setInterval;
		try {
			const fake = createFakeFileSystem(readyLine(1) + settledLine(2) + resultLine(3));
			const watcher = createSessionWatcher("/session.jsonl", identity, fake.dependencies);
			watcher.close();
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.setInterval = originalSetInterval;
		}
		assert.equal(timerUsed, false);
	});
});
