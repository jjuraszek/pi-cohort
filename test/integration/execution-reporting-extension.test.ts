import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";
import { createExecutionReportingExtension } from "../../src/execution-backend/reporting-extension.ts";
import { encodeControlRequest } from "../../src/execution-backend/control-protocol.ts";
import { replayExecutionSession } from "../../src/execution-backend/session-replay.ts";

const identity = { protocolVersion: 1 as const, runId: "run", childId: "child", attemptId: "attempt" };
const config = { ...identity, controlSocketPath: "/private/control.sock" };
type Entry = { type: string; id: string; parentId: string | null; customType?: string; data?: unknown; message?: unknown };
function assistant(overrides: Record<string, unknown> = {}) { return { role: "assistant", content: [] as unknown[], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1, ...overrides }; }

class FakeSessionManager {
	entries: Entry[];
	sessionFile: string | undefined;
	constructor(entries: Entry[] = [], sessionFile: string | undefined = "/tmp/session.jsonl") { this.entries = entries; this.sessionFile = sessionFile; }
	getEntries() { return this.entries; }
	getBranch() { return this.entries; }
	getSessionFile() { return this.sessionFile; }
	appendCustomEntry(customType: string, data: unknown) {
		this.entries.push({ type: "custom", id: `entry-${this.entries.length}`, parentId: this.entries.at(-1)?.id ?? null, customType, data });
	}
}

class SilentControlSocket extends EventEmitter {
	destroy() { this.emit("close"); return this; }
}

type FakeContext = {
	sessionManager: FakeSessionManager | SessionManager;
	abort(): void;
	shutdown(): void;
};

class FakeExtensionAPI {
	handlers = new Map<string, (event: unknown, context: FakeContext) => void>();
	appends: { customType: string; data: unknown }[] = [];
	manager?: FakeSessionManager | SessionManager;
	on(event: "session_start" | "agent_settled", handler: (event: unknown, context: FakeContext) => void) { this.handlers.set(event, handler); }
	appendEntry(customType: string, data: unknown) {
		this.appends.push({ customType, data });
		const manager = this.manager;
		if (!manager) throw new Error("append without an active session manager");
		manager.appendCustomEntry(customType, data);
	}
	emit(event: "session_start" | "agent_settled", manager: FakeSessionManager | SessionManager) {
		this.manager = manager;
		this.handlers.get(event)?.({}, { sessionManager: manager, abort() {}, shutdown() {} });
	}
}

function messageEntry(id: string, message: unknown): Entry { return { type: "message", id, parentId: null, message }; }
function report(kind: "ready" | "settled" | "result" | "control", overrides: Record<string, unknown> = {}): Entry {
	return { type: "custom", id: `report-${kind}`, parentId: null, customType: "pi-cohort:execution-report:v1", data: { ...identity, kind, sequence: 1, timestamp: "2025-01-01T00:00:00.000Z", ...(kind === "result" ? { outcome: "success", finalOutput: "done" } : {}), ...overrides } };
}
function kinds(api: FakeExtensionAPI) { return api.appends.map(({ data }) => (data as { kind: string }).kind); }

function setup(manager = new FakeSessionManager()) {
	const api = new FakeExtensionAPI();
	const socket = new SilentControlSocket();
	createExecutionReportingExtension(config, { createConnection: () => socket })(api);
	return { api, manager, socket };
}

describe("execution reporting extension", () => {
	for (const row of [
		{ context: "fresh", behavior: "no reply" },
		{ context: "fresh", behavior: "reply" },
		{ context: "fork", behavior: "no reply" },
		{ context: "fork", behavior: "abort before reply" },
		{ context: "fork", behavior: "reply" },
		{ context: "fork", behavior: "rewound reply" },
		{ context: "fork", behavior: "abandoned reply" },
	] as const) it(`reports only the ${row.context} attempt's result with ${row.behavior}`, () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reporter-ownership-")));
		try {
			const childDirectory = path.join(directory, "child");
			let child: SessionManager;
			if (row.context === "fork") {
				const parent = SessionManager.create(directory, path.join(directory, "parent"));
				parent.appendCustomEntry("pi-cohort:execution-report:v1", report("ready", { runId: "parent-run" }).data);
				parent.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
				for (let index = 0; index < 3; index++) parent.appendMessage(assistant({
					content: [{ type: "text", text: "parent answer" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } },
				}));
				const resolver = createForkContextResolver(parent, "fork", { sessionDirForIndex: () => childDirectory });
				const forkFile = resolver.sessionFileForIndex(0, directory);
				assert.ok(forkFile);
				child = SessionManager.open(forkFile);
				assert.deepEqual(child.getBranch(), parent.getBranch(), "the resolver copies the priced parent entries and their ids");
			} else {
				child = SessionManager.create(directory, childDirectory);
			}
			const inherited = child.getEntries();
			const inheritedLeaf = child.getLeafId();
			const { api, socket } = setup();
			api.emit("session_start", child);
			child.appendMessage({ role: "user", content: "child task", timestamp: 2 });
			if (row.behavior === "rewound reply") child.branch(inheritedLeaf!);
			const hasReply = ["reply", "rewound reply"].includes(row.behavior);
			if (hasReply || row.behavior === "abandoned reply") {
				child.appendMessage(assistant({ content: [{ type: "text", text: "child answer" }] }));
			}
			if (row.behavior === "abort before reply") socket.emit("data", encodeControlRequest({ ...identity, requestId: "abort-1", action: "abort" }));
			const sessionFile = child.getSessionFile();
			assert.ok(sessionFile);
			child = SessionManager.open(sessionFile);
			if (row.behavior === "abandoned reply") child.branch(inheritedLeaf!);
			api.emit("session_start", child);
			api.emit("agent_settled", child);
			api.emit("agent_settled", child);
			const replay = replayExecutionSession(fs.readFileSync(sessionFile, "utf8"), config);
			assert.equal(replay.result?.outcome, hasReply ? "success" : "failed");
			assert.equal(replay.result?.error, hasReply ? undefined : "result_missing");
			assert.equal(replay.result?.finalOutput, hasReply ? "child answer" : "");
			assert.equal(replay.result?.stopReason, hasReply ? "stop" : undefined);
			assert.equal(replay.reports.filter(report => report.kind === "ready").length, 1);
			assert.equal(replay.reports.filter(report => report.kind === "result").length, 1);
			assert.deepEqual(SessionManager.open(sessionFile).getEntries().slice(0, inherited.length), inherited, "reporting preserves inherited history");
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("uses the API append seam for ready, settled, and one terminal result across reloads", () => {
		const { api, manager } = setup();
		api.emit("session_start", manager);
		manager.entries.push({ ...messageEntry("assistant", assistant({ content: [{ type: "text", text: "done" }] })), parentId: manager.entries.at(-1)!.id });
		api.emit("session_start", manager); api.emit("agent_settled", manager); api.emit("agent_settled", manager);
		assert.deepEqual(kinds(api), ["ready", "settled", "result"]);
		assert.ok(api.appends.every(({ customType }) => customType === "pi-cohort:execution-report:v1"));
		const replay = replayExecutionSession([{ type: "session", id: "session" }, ...manager.entries].map(JSON.stringify).join("\n") + "\n", config);
		assert.equal(replay.result?.outcome, "success");
	});

	for (const row of [
		{ name: "applied abort before error", stopReason: "error", control: "socket", outcome: "interrupted" },
		{ name: "applied abort before success", stopReason: "stop", control: "socket", outcome: "interrupted" },
		{ name: "error without abort", stopReason: "error", control: "none", outcome: "failed" },
		{ name: "requested abort only", stopReason: "error", control: "requested", outcome: "failed" },
		{ name: "another attempt's applied abort", stopReason: "error", control: "other", outcome: "failed" },
		{ name: "native abort", stopReason: "aborted", control: "none", outcome: "interrupted" },
		{ name: "missing assistant after applied abort", stopReason: undefined, control: "socket", outcome: "failed" },
	] as const) {
		it(`classifies ${row.name} from correlated applied provenance`, () => {
			const entries = row.stopReason ? [messageEntry("m", assistant({ stopReason: row.stopReason, ...(row.stopReason === "error" ? { errorMessage: "This operation was aborted" } : {}) }))] : [];
			if (row.control === "requested" || row.control === "other") entries.push(report("control", { action: "abort", state: row.control === "requested" ? "requested" : "applied", ...(row.control === "other" ? { attemptId: "other" } : {}) }));
			const { api, manager, socket } = setup();
			api.emit("session_start", manager);
			manager.entries.push(...entries);
			const abort = encodeControlRequest({ ...identity, requestId: "abort-1", action: "abort" });
			if (row.control === "socket") {
				socket.emit("data", abort);
				const controls = api.appends.filter(({ data }) => (data as { kind: string }).kind === "control");
				assert.deepEqual(controls.map(({ data }) => {
					const { protocolVersion, runId, childId, attemptId, action, state } = data as typeof identity & { action: string; state: string };
					return { protocolVersion, runId, childId, attemptId, action, state };
				}), ["requested", "applied"].map((state) => ({ ...identity, action: "abort", state })));
			}
			api.emit("agent_settled", manager);
			const results = () => manager.entries.filter((entry) => (entry.data as { kind?: string } | undefined)?.kind === "result");
			assert.equal((results()[0].data as { outcome: string }).outcome, row.outcome);
			const terminal = JSON.stringify(results());
			if (row.control === "socket") socket.emit("data", abort);
			api.emit("agent_settled", manager);
			assert.equal(results().length, 1);
			assert.equal(JSON.stringify(results()), terminal);
		});
	}

	for (const outcome of ["success", "failed"] as const) {
		it(`preserves an existing ${outcome} terminal after abort`, () => {
			const terminal = report("result", { outcome });
			const bytes = JSON.stringify(terminal);
			const { api, manager, socket } = setup(new FakeSessionManager([terminal]));
			api.emit("session_start", manager);
			const abort = encodeControlRequest({ ...identity, requestId: "abort-1", action: "abort" });
			socket.emit("data", abort); socket.emit("data", abort);
			api.emit("agent_settled", manager); api.emit("agent_settled", manager);
			assert.equal(JSON.stringify(terminal), bytes);
			assert.equal(manager.entries.filter((entry) => (entry.data as { kind?: string } | undefined)?.kind === "result").length, 1);
			assert.deepEqual(kinds(api), ["ready", "control", "control"]);
		});
	}

	it("requires a persisted session before reporting ready", () => {
		const manager = new FakeSessionManager(); manager.sessionFile = undefined;
		const { api } = setup(manager);
		assert.throws(() => api.emit("session_start", manager), /persisted session/);
		assert.deepEqual(kinds(api), []);
	});

	it("writes a missing result after a prior settled report without repeating settled", () => {
		const { api, manager } = setup(new FakeSessionManager([report("ready"), messageEntry("assistant", assistant({ content: [{ type: "text", text: "done" }] })), report("settled")]));
		api.emit("agent_settled", manager);
		assert.deepEqual(kinds(api), ["result"]);
	});

	it("does nothing after an existing terminal result", () => {
		const { api, manager } = setup(new FakeSessionManager([report("ready"), messageEntry("assistant", assistant()), report("settled"), report("result")]));
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
		const { api, manager } = setup();
		api.emit("session_start", manager);
		manager.entries.push(messageEntry("assistant", { role: "assistant", content: [] }));
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
			const { api, manager } = setup();
			api.emit("session_start", manager);
			manager.entries.push(messageEntry("m", message));
			api.emit("agent_settled", manager);
			const result = api.appends.at(-1)?.data as { outcome: string; error?: string };
			assert.equal(result.outcome, outcome); assert.equal(result.error, error);
		}
	});
});
