import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { createExecutionReportingExtension } from "../../src/execution-backend/reporting-extension.ts";
import { replayExecutionSession } from "../../src/execution-backend/session-replay.ts";

const identity = { protocolVersion: 1 as const, runId: "run", childId: "child", attemptId: "attempt" };
const config = { ...identity, controlSocketPath: "/private/control.sock" };
type Entry = { type: string; id: string; parentId: string | null; customType?: string; data?: unknown; message?: unknown };
function assistant(overrides: Record<string, unknown> = {}) { return { role: "assistant", content: [] as unknown[], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1, ...overrides }; }

class FakeSessionManager {
	entries: Entry[];
	sessionFile: string | undefined;
	constructor(entries: Entry[] = [messageEntry("assistant", assistant({ content: [{ type: "text", text: "done" }] }))], sessionFile: string | undefined = "/tmp/session.jsonl") { this.entries = entries; this.sessionFile = sessionFile; }
	getEntries() { return this.entries; }
	getBranch() { return this.entries; }
	getSessionFile() { return this.sessionFile; }
}

class SilentControlSocket extends EventEmitter {
	destroy() { this.emit("close"); return this; }
}

type FakeContext = {
	sessionManager: FakeSessionManager;
	abort(): void;
	shutdown(): void;
};

class FakeExtensionAPI {
	handlers = new Map<string, (event: unknown, context: FakeContext) => void>();
	appends: { customType: string; data: unknown }[] = [];
	manager?: FakeSessionManager;
	on(event: "session_start" | "agent_settled", handler: (event: unknown, context: FakeContext) => void) { this.handlers.set(event, handler); }
	appendEntry(customType: string, data: unknown) {
		this.appends.push({ customType, data });
		const manager = this.manager;
		if (!manager) throw new Error("append without an active session manager");
		manager.entries.push({ type: "custom", id: `entry-${manager.entries.length}`, parentId: manager.entries.at(-1)?.id ?? null, customType, data });
	}
	emit(event: "session_start" | "agent_settled", manager: FakeSessionManager) {
		this.manager = manager;
		this.handlers.get(event)?.({}, { sessionManager: manager, abort() {}, shutdown() {} });
	}
}

function messageEntry(id: string, message: unknown): Entry { return { type: "message", id, parentId: null, message }; }
function report(kind: "ready" | "settled" | "result", overrides: Record<string, unknown> = {}): Entry {
	return { type: "custom", id: `report-${kind}`, parentId: null, customType: "pi-cohort:execution-report:v1", data: { ...identity, kind, sequence: 1, timestamp: "2025-01-01T00:00:00.000Z", ...(kind === "result" ? { outcome: "success", finalOutput: "done" } : {}), ...overrides } };
}
function kinds(api: FakeExtensionAPI) { return api.appends.map(({ data }) => (data as { kind: string }).kind); }

function setup(manager = new FakeSessionManager()) {
	const api = new FakeExtensionAPI();
	createExecutionReportingExtension(config, { createConnection: () => new SilentControlSocket() })(api);
	return { api, manager };
}

describe("execution reporting extension", () => {
	it("uses the API append seam for ready, settled, and one terminal result across reloads", () => {
		const { api, manager } = setup();
		api.emit("session_start", manager); api.emit("session_start", manager); api.emit("agent_settled", manager); api.emit("agent_settled", manager);
		assert.deepEqual(kinds(api), ["ready", "settled", "result"]);
		assert.ok(api.appends.every(({ customType }) => customType === "pi-cohort:execution-report:v1"));
		const replay = replayExecutionSession([{ type: "session", id: "session" }, ...manager.entries].map(JSON.stringify).join("\n") + "\n", config);
		assert.equal(replay.result?.outcome, "success");
	});

	it("requires a persisted session before reporting ready", () => {
		const manager = new FakeSessionManager(); manager.sessionFile = undefined;
		const { api } = setup(manager);
		assert.throws(() => api.emit("session_start", manager), /persisted session/);
		assert.deepEqual(kinds(api), []);
	});

	it("writes a missing result after a prior settled report without repeating settled", () => {
		const { api, manager } = setup(new FakeSessionManager([messageEntry("assistant", assistant({ content: [{ type: "text", text: "done" }] })), report("ready"), report("settled")]));
		api.emit("agent_settled", manager);
		assert.deepEqual(kinds(api), ["result"]);
	});

	it("does nothing after an existing terminal result", () => {
		const { api, manager } = setup(new FakeSessionManager([messageEntry("assistant", assistant()), report("ready"), report("settled"), report("result")]));
		api.emit("agent_settled", manager);
		assert.deepEqual(kinds(api), []);
	});

	it("rejects malformed correlated reports rather than suppressing a write", () => {
		const malformed = report("ready", { sequence: 0 });
		const { api, manager } = setup(new FakeSessionManager([messageEntry("assistant", assistant()), malformed]));
		assert.throws(() => api.emit("session_start", manager), /sequence must be a positive integer/);
		assert.deepEqual(kinds(api), []);
	});

	it("rejects malformed assistant messages rather than reporting result_missing", () => {
		const { api, manager } = setup(new FakeSessionManager([messageEntry("assistant", { role: "assistant", content: [] })]));
		api.emit("session_start", manager);
		assert.throws(() => api.emit("agent_settled", manager), /malformed standard session message/);
		assert.deepEqual(kinds(api), ["ready", "settled"]);
	});

	it("reports final assistant outcomes with aborted taking precedence over errors", () => {
		for (const [message, outcome, error] of [
			[assistant({ stopReason: "aborted", errorMessage: "bad" }), "interrupted", undefined],
			[assistant({ stopReason: "error", errorMessage: "bad" }), "failed", "bad"],
			[assistant({ errorMessage: "bad" }), "failed", "bad"],
			[assistant(), "success", undefined],
			[{ role: "user", content: "only", timestamp: 1 }, "failed", "result_missing"],
		] as const) {
			const { api, manager } = setup(new FakeSessionManager([messageEntry("m", message)]));
			api.emit("session_start", manager); api.emit("agent_settled", manager);
			const result = api.appends.at(-1)?.data as { outcome: string; error?: string };
			assert.equal(result.outcome, outcome); assert.equal(result.error, error);
		}
	});
});
