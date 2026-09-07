import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { describe, it } from "node:test";
import { createExecutionControlChannel } from "../../src/execution-backend/control-channel.ts";
import { encodeControlRequest, type ControlRequest } from "../../src/execution-backend/control-protocol.ts";
import { createExecutionReportingExtension } from "../../src/execution-backend/reporting-extension.ts";
import { EXECUTION_REPORT_TYPE, loadReporterConfig, type ExecutionReport, type ReporterConfig } from "../../src/execution-backend/reporting-protocol.ts";

interface Entry {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: unknown;
}

class SessionManager {
	readonly entries: Entry[] = [];
	getEntries() { return this.entries; }
	getBranch() { return this.entries; }
	getSessionFile() { return "/private/session.jsonl"; }
}

interface TestContext {
	sessionManager: SessionManager;
	abort(): void;
	shutdown(): void;
}

class TestAPI {
	readonly handlers = new Map<string, (event: unknown, context: TestContext) => void>();
	readonly reports: ExecutionReport[] = [];
	readonly events = new EventEmitter();
	context: TestContext | undefined;
	on(event: "session_start" | "agent_settled", handler: (event: unknown, context: TestContext) => void) {
		this.handlers.set(event, handler);
	}
	appendEntry(customType: string, data: unknown) {
		assert.equal(customType, EXECUTION_REPORT_TYPE);
		const report = data as ExecutionReport;
		assert.equal(Object.hasOwn(report, "controlSocketPath"), false);
		this.reports.push(report);
		this.context?.sessionManager.entries.push({ type: "custom", id: `entry-${this.reports.length}`, parentId: null, customType, data });
		if (report.kind === "control" && report.state === "applied") this.events.emit("applied");
	}
	emit(context: TestContext) {
		this.context = context;
		this.handlers.get("session_start")?.({}, context);
	}
}

class InjectedSocket extends EventEmitter {
	destroyed = false;
	destroy() { this.destroyed = true; this.emit("close"); return this; }
}

const identity = { runId: "run", childId: "child", attemptId: "attempt" };
const unixOnly = { skip: process.platform === "win32" };

function context(order: string[] = []): TestContext {
	return {
		sessionManager: new SessionManager(),
		abort() { order.push("abort"); },
		shutdown() { order.push("shutdown"); },
	};
}

function controlReports(api: TestAPI): ExecutionReport[] {
	return api.reports.filter((report) => report.kind === "control");
}

describe("execution control reporting", () => {
	it("connects after ready and records abort requested, side effect, then applied", unixOnly, async () => {
		const channel = await createExecutionControlChannel(identity);
		try {
			const api = new TestAPI();
			const order: string[] = [];
			const reporterConfig = loadReporterConfig(channel.configPath);
			createExecutionReportingExtension(reporterConfig)(api);
			api.events.on("applied", () => order.push("applied"));
			api.emit(context(order));
			await channel.connected;
			assert.equal(api.reports[0]?.kind, "ready");
			const applied = once(api.events, "applied");
			await channel.request("abort");
			await applied;
			assert.deepEqual(order, ["abort", "applied"]);
			assert.deepEqual(controlReports(api).map((report) => report.kind === "control" ? [report.action, report.state] : []), [
				["abort", "requested"],
				["abort", "applied"],
			]);
		} finally {
			await channel.close();
		}
	});

	it("durably records shutdown applied before scheduling shutdown", unixOnly, async () => {
		const channel = await createExecutionControlChannel(identity);
		try {
			const api = new TestAPI();
			const order: string[] = [];
			api.events.on("applied", () => order.push("applied"));
			createExecutionReportingExtension(loadReporterConfig(channel.configPath))(api);
			api.emit(context(order));
			await channel.connected;
			const applied = once(api.events, "applied");
			await channel.request("shutdown");
			await applied;
			await Promise.resolve();
			assert.deepEqual(order, ["applied", "shutdown"]);
			assert.deepEqual(controlReports(api).map((report) => report.kind === "control" ? report.state : ""), ["requested", "applied"]);
		} finally {
			await channel.close();
		}
	});

	it("deduplicates request ids before control side effects", () => {
		const socket = new InjectedSocket();
		const api = new TestAPI();
		const order: string[] = [];
		const config: ReporterConfig = { protocolVersion: 1, ...identity, controlSocketPath: "/control.sock" };
		createExecutionReportingExtension(config, { createConnection: () => socket })(api);
		api.emit(context(order));
		const request: ControlRequest = { protocolVersion: 1, ...identity, requestId: "same", action: "abort" };
		socket.emit("data", Buffer.concat([encodeControlRequest(request), encodeControlRequest(request)]));
		assert.deepEqual(order, ["abort"]);
		assert.equal(controlReports(api).length, 2);
	});

	it("destroys invalid or cross-correlated sockets without invoking control", () => {
		for (const frame of [
			Buffer.from("not-json\n"),
			encodeControlRequest({ protocolVersion: 1, ...identity, childId: "other", requestId: "cross", action: "abort" }),
		]) {
			const socket = new InjectedSocket();
			const api = new TestAPI();
			const order: string[] = [];
			createExecutionReportingExtension({ protocolVersion: 1, ...identity, controlSocketPath: "/control.sock" }, { createConnection: () => socket })(api);
			api.emit(context(order));
			socket.emit("data", frame);
			assert.equal(socket.destroyed, true);
			assert.deepEqual(order, []);
			assert.deepEqual(controlReports(api), []);
		}
	});

	it("does not fabricate a result when the control socket disconnects", () => {
		const socket = new InjectedSocket();
		const api = new TestAPI();
		createExecutionReportingExtension({ protocolVersion: 1, ...identity, controlSocketPath: "/control.sock" }, { createConnection: () => socket })(api);
		api.emit(context());
		socket.emit("error", new Error("disconnect"));
		socket.emit("close");
		assert.deepEqual(api.reports.map(({ kind }) => kind), ["ready"]);
	});
});
