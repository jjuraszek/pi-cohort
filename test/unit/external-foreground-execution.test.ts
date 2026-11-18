import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createMockPi, makeAgent } from "../support/helpers.ts";
import { editCall, forkWithParentEdit } from "../support/fork-with-parent-edit.ts";
import type { ChildHostAttempt, ChildHostController, ChildHostExit } from "../../src/execution-backend/child-host-controller.ts";
import type { ExecutionControlChannel } from "../../src/execution-backend/control-channel.ts";
import { replayExecutionSession, type ReplayedSession } from "../../src/execution-backend/session-replay.ts";
import type { SessionWatcher } from "../../src/execution-backend/session-watcher.ts";
import type { ExecutionBackend, ExecutionSurfaceHandle } from "../../src/execution-backend/types.ts";
import {
	createExternalExecution,
	ExternalStartDeadlineError,
	isInterruptedExternalAttemptError,
	externalExecutionDiagnosticCode,
	type ExternalAttemptRequest,
	type ExternalExecutionOptions,
	type ExternalExecutionDependencies,
} from "../../src/runs/shared/external-execution.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";
import { EXECUTION_REPORT_PROTOCOL_VERSION, EXECUTION_REPORT_TYPE, type ExecutionReport } from "../../src/execution-backend/reporting-protocol.ts";

const identity = { runId: "run", childId: "child", attemptId: "attempt" };
const handle: ExecutionSurfaceHandle = { protocolVersion: 1, backend: "fake", surface: { kind: "pane", id: "p1" }, display: { label: "fake pane", hint: "safe" }, data: "SUCCESS fake terminal text" };

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

function line(kind: string, sequence: number, extras: Record<string, unknown> = {}, entry: Record<string, unknown> = {}, reportIdentity = identity): string {
	return `${JSON.stringify({ type: "custom", id: `${reportIdentity.attemptId}-report-${sequence}`, parentId: null, customType: "pi-cohort:execution-report:v1", data: { protocolVersion: 1, ...reportIdentity, kind, sequence, timestamp: "2026-09-06T00:00:00.000Z", ...extras }, ...entry })}\n`;
}

const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "answer" }],
	api: "test",
	provider: "test",
	model: "model-a",
	usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } },
	stopReason: "stop" as const,
	timestamp: 2,
};

function sessionContent(outcome: "success" | "failed" | "interrupted" = "success", controls: readonly ("abort" | "shutdown")[] = [], attemptId = "attempt", messageOverrides: Record<string, unknown> = {}): string {
	const reportIdentity = { ...identity, attemptId };
	const assistantId = `${attemptId}-assistant`;
	let content = line("ready", 1, {}, {}, reportIdentity);
	content += `${JSON.stringify({ type: "message", id: assistantId, parentId: `${attemptId}-report-1`, message: { ...assistant, ...messageOverrides } })}\n`;
	content += line("settled", 2, {}, { parentId: assistantId }, reportIdentity);
	content += line("result", 3, { outcome, finalOutput: "done", ...(outcome === "failed" ? { error: "failed safely" } : {}) }, { parentId: `${attemptId}-report-2` }, reportIdentity);
	let sequence = 4;
	for (const action of controls) {
		for (const state of ["requested", "applied"]) {
			content += line("control", sequence, { action, state }, { parentId: `${attemptId}-report-${sequence - 1}` }, reportIdentity);
			sequence++;
		}
	}
	return content;
}

function replay(content = sessionContent(), attemptId = "attempt"): ReplayedSession & { result: NonNullable<ReplayedSession["result"]> } {
	return replayExecutionSession(content, { ...identity, attemptId }) as ReplayedSession & { result: NonNullable<ReplayedSession["result"]> };
}

function request(overrides: Partial<ExternalAttemptRequest> = {}): ExternalAttemptRequest {
	return {
		attemptId: "attempt",
		command: "/bin/pi",
		args: ["--mode", "json"],
		cwd: "/exact/worktree",
		environment: { PATH: "/safe", TOKEN: "secret-sentinel" },
		sessionFile: "/trusted/session.jsonl",
		signal: new AbortController().signal,
		interruptSignal: new AbortController().signal,
		...overrides,
	};
}

function harness() {
	const ready = deferred<void>();
	const terminal = deferred<ReplayedSession & { result: NonNullable<ReplayedSession["result"]> }>();
	const exit = deferred<ChildHostExit>();
	const hostExit = deferred<ChildHostExit>();
	const interruptController = new AbortController();
	const calls: string[] = [];
	const starts: ChildHostAttempt[] = [];
	const controls: string[] = [];
	const closeReasons: string[] = [];
	let content = sessionContent();
	let releases = 0;
	let closes = 0;
	let shutdowns = 0;
	const controller: ChildHostController = {
		lease: { handle, events: { async *[Symbol.asyncIterator]() {} }, async reconcile() { return []; }, async release() { releases++; } },
		ready: ready.promise,
		hostExit: hostExit.promise,
		dispose() { calls.push("dispose"); },
		startAttempt(attempt) { calls.push("start"); starts.push(attempt); return exit.promise; },
		async shutdown() { calls.push("host-shutdown"); shutdowns++; hostExit.resolve({ status: 0, signal: null }); },
		async releaseObserver() { calls.push("release"); releases++; },
	};
	const backend = {
		name: "fake", protocolVersion: 1 as const, async detect() { return { available: true, version: "1", capabilities: [] }; },
		async launch() { throw new Error("owner must use the controller boundary"); }, async reattach() { return { status: "gone" as const }; },
		async close(actual: ExecutionSurfaceHandle, reason: string) { assert.strictEqual(actual, handle); calls.push("backend-close"); closeReasons.push(reason); closes++; },
	} satisfies ExecutionBackend;
	const control: ExecutionControlChannel = {
		configPath: "/private/report-config.json",
		connected: Promise.resolve(),
		async request(action) { calls.push(`control-${action}`); controls.push(action); return `${action}-id`; },
		async close() { calls.push("control-close"); },
	};
	const watcher: SessionWatcher = { terminal: terminal.promise, close() { calls.push("watcher-close"); } };
	const dependencies: ExternalExecutionDependencies = {
		async createController() { calls.push("controller"); return controller; },
		readyDeadline: promise => promise,
		async createControl() { calls.push("control"); return control; },
		createWatcher() { calls.push("watcher"); return watcher; },
		async readSession() { calls.push("read"); return content; },
		ensureSessionFile() { calls.push("session"); },
	};
	return {
		backend, controller, ready, terminal, exit, hostExit, calls, starts, controls, closeReasons, dependencies,
		interruptController, interruptSignal: interruptController.signal,
		setContent(value: string) { content = value; },
		counts: () => ({ releases, closes, shutdowns }),
	};
}

async function ownerFrom(fake: ReturnType<typeof harness>, optionOverrides?: Partial<Pick<ExternalExecutionOptions, "controlTimeoutMs" | "startDeadlineMs">>) {
	return createExternalExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal, ...optionOverrides }, fake.dependencies);
}

describe("external foreground execution owner", () => {
	it("returns the surface before readiness settles", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		assert.strictEqual(owner.surface, handle);
		let settled = false;
		void owner.ready.then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);
		fake.ready.resolve();
		await owner.ready;
	});

	it("uses no timers when the readiness deadline is injected", async () => {
		const fake = harness();
		const originalTimeout = globalThis.setTimeout;
		const originalInterval = globalThis.setInterval;
		let timers = 0;
		globalThis.setTimeout = ((..._arguments: unknown[]) => { timers++; return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout;
		globalThis.setInterval = ((..._arguments: unknown[]) => { timers++; return 0 as unknown as NodeJS.Timeout; }) as typeof setInterval;
		try {
			const owner = await ownerFrom(fake);
			fake.ready.resolve();
			await owner.ready;
		} finally {
			globalThis.setTimeout = originalTimeout;
			globalThis.setInterval = originalInterval;
		}
		assert.equal(timers, 0);
	});

	it("retains and releases a surface after a safe readiness deadline failure", async () => {
		const fake = harness();
		fake.dependencies.readyDeadline = async (_ready, _timeout, label) => { throw new Error(`${label} timed out`); };
		const owner = await ownerFrom(fake);
		await assert.rejects(owner.ready, /fake pane timed out/);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
		assert.deepEqual(fake.counts(), { releases: 1, closes: 0, shutdowns: 1 });
	});

	it("arms control and watcher before exact attempt launch without mutating caller data", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const input = request();
		const environment = input.environment;
		const pending = owner.runAttempt(input);
		await Promise.resolve(); await Promise.resolve();
		assert.deepEqual(fake.calls.slice(1, 5), ["session", "control", "watcher", "start"]);
		assert.deepEqual(fake.starts[0], { attemptId: "attempt", command: "/bin/pi", args: ["--mode", "json"], cwd: "/exact/worktree", environment: { PATH: "/safe", TOKEN: "secret-sentinel", PI_COHORT_REPORT_CONFIG: "/private/report-config.json" } });
		assert.deepEqual(environment, { PATH: "/safe", TOKEN: "secret-sentinel" });
		assert.equal(JSON.stringify(handle).includes("secret-sentinel"), false);
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay());
		fake.exit.resolve({ status: 0, signal: null });
		await pending;
	});

	it("maps durable result-first messages and usage only after shutdown evidence is durable", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const pending = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		fake.terminal.resolve(replay());
		await Promise.resolve();
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.exit.resolve({ status: 0, signal: null });
		const result = await pending;
		assert.equal(result.finalOutput, "done");
		assert.equal(result.model, "model-a");
		assert.deepEqual(result.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 1, turns: 1 });
		assert.deepEqual(result.exit, { code: 0, signal: null });
		assert.deepEqual(fake.controls, ["shutdown"]);
	});

	for (const context of ["fresh", "fork", "pane-fork"] as const) it(`counts only the ${context} child's own priced turn and tool result from its saved session`, async () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-owner-usage-")));
		const toolResult = {
			role: "toolResult" as const, toolCallId: "tool-1", toolName: "report", content: [], isError: false, timestamp: 3,
			usage: { input: 5, output: 4, cacheRead: 3, cacheWrite: 2, totalTokens: 14, cost: { input: 0.125, output: 0.125, cacheRead: 0.125, cacheWrite: 0.125, total: 0.5 } },
		};
		try {
			const childDirectory = path.join(directory, "child");
			let child: SessionManager;
			if (context !== "fresh") {
				const parent = SessionManager.create(directory, path.join(directory, "parent"));
				if (context === "pane-fork") parent.appendCustomEntry(EXECUTION_REPORT_TYPE, {
					protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION, ...identity, runId: "parent-run", kind: "ready", sequence: 1, timestamp: "2026-11-18T00:00:00.000Z",
				});
				parent.appendMessage({ role: "user", content: "parent task", timestamp: 1 });
				for (let index = 0; index < 3; index++) parent.appendMessage(assistant);
				parent.appendMessage({ ...toolResult, usage: assistant.usage });
				const resolver = createForkContextResolver(parent, "fork", { sessionDirForIndex: () => childDirectory });
				const forkFile = resolver.sessionFileForIndex(0, directory);
				assert.ok(forkFile);
				child = SessionManager.open(forkFile);
				assert.deepEqual(child.getBranch(), parent.getBranch(), "the real resolver copies parent entries with their ids");
			} else {
				child = SessionManager.create(directory, childDirectory);
			}
			const sessionFile = child.getSessionFile();
			assert.ok(sessionFile);
			const ownAssistant = {
				...assistant,
				model: "child-model",
				content: [{ type: "text" as const, text: "child answer" }],
				usage: { input: 20, output: 30, cacheRead: 40, cacheWrite: 50, totalTokens: 140, cost: { input: 0.05, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05, total: 0.25 } },
			};
			let sequence = 0;
			const report = (kind: ExecutionReport["kind"], extras: Record<string, unknown> = {}) => child.appendCustomEntry(EXECUTION_REPORT_TYPE, {
				protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION, ...identity, kind, sequence: ++sequence, timestamp: "2026-11-18T00:00:00.000Z", ...extras,
			});
			const fake = harness();
			fake.controller.startAttempt = async () => {
				child = SessionManager.open(sessionFile);
				report("ready");
				child.appendMessage({ role: "user", content: "child task", timestamp: 3 });
				child.appendMessage(toolResult);
				child.appendMessage(ownAssistant);
				report("settled");
				report("result", { outcome: "success", finalOutput: "child answer" });
				return { status: 0, signal: null };
			};
			const owner = await createExternalExecution({ backend: fake.backend, runId: identity.runId, childId: identity.childId, cwd: directory, signal: new AbortController().signal }, {
				createController: fake.dependencies.createController,
				async createControl() {
					return {
						configPath: path.join(directory, "report-config.json"),
						connected: Promise.resolve(),
						async request(action) {
							assert.equal(action, "shutdown");
							report("control", { action, state: "requested" });
							report("control", { action, state: "applied" });
							return "shutdown-id";
						},
						async close() {},
					};
				},
			});
			fake.ready.resolve();
			try {
				const result = await owner.runAttempt(request({ sessionFile, cwd: directory }));
				assert.equal(result.model, "child-model");
				assert.equal(result.turns, 1);
				assert.deepEqual(result.usage, { input: 25, output: 34, cacheRead: 43, cacheWrite: 52, cost: 0.75, turns: 1 });
				assert.equal(result.finalOutput, "child answer");
				const saved = SessionManager.open(sessionFile).getEntries();
				assert.equal(saved.filter(entry => entry.type === "message" && entry.message.role === "assistant").length, context === "fresh" ? 1 : 4, "attribution must not remove saved history");
			} finally {
				await owner.finish("retained");
			}
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not credit a forked foreground worker for its parent's edit", async t => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foreground-edit-")));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const mock = createMockPi();
		mock.install();
		t.after(() => mock.uninstall());
		const { sessionFile } = forkWithParentEdit(directory);
		const fake = harness();
		fake.ready.resolve();
		const result = await runSync(directory, [makeAgent("worker")], "worker", "Edit file.txt", {
			runtime: mock.runtime, sessionFile, runId: "edit-run", acceptance: { level: "none", reason: "exercise the completion guard" },
		}, {
			selectBackend: async () => ({ selection: { kind: "external", backend: fake.backend, detection: await fake.backend.detect() }, diagnostics: [] }),
			createExternalOwner: options => createExternalExecution(options, {
				createController: fake.dependencies.createController,
				async createControl(reportIdentity) {
					const child = SessionManager.open(sessionFile);
					let sequence = 0;
					const report = (kind: ExecutionReport["kind"], extra: Record<string, unknown> = {}) => child.appendCustomEntry(EXECUTION_REPORT_TYPE, {
						protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION, ...reportIdentity, kind, sequence: ++sequence, timestamp: new Date().toISOString(), ...extra,
					});
					fake.controller.startAttempt = async () => {
						report("ready");
						child.appendMessage(assistant);
						report("settled");
						report("result", { outcome: "success", finalOutput: "answer" });
						return { status: 0, signal: null };
					};
					return {
						configPath: path.join(directory, "report-config.json"), connected: Promise.resolve(),
						async request(action) {
							report("control", { action, state: "requested" });
							report("control", { action, state: "applied" });
							return `${action}-id`;
						},
						async close() {},
					};
				},
			}),
		});
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.exitCode, 1);
	});

	it("counts each attempt's turns and charges once when a fallback reuses the saved session", async t => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "foreground-retry-")));
		t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
		const mock = createMockPi();
		mock.install();
		t.after(() => mock.uninstall());
		const { sessionFile } = forkWithParentEdit(directory);
		const agent = makeAgent("worker", { model: "primary", fallbackModels: ["fallback"] });
		const fake = harness();
		fake.ready.resolve();
		fake.controller.startAttempt = async ({ args, attemptId }) => {
			assert.equal(args[args.indexOf("--session") + 1], sessionFile);
			const child = SessionManager.open(sessionFile);
			const model = args[args.indexOf("--model") + 1];
			const first = model === "primary";
			let sequence = 0;
			const report = (kind: ExecutionReport["kind"], extra: Record<string, unknown> = {}) => child.appendCustomEntry(EXECUTION_REPORT_TYPE, {
				protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION, runId: "retry", childId: "child-0", attemptId, kind, sequence: ++sequence, timestamp: new Date().toISOString(), ...extra,
			});
			report("ready");
			if (first) {
				child.appendUsage("cache_warm", assistant.provider, model, assistant.usage);
				child.appendMessage({ ...assistant, model, content: [editCall], stopReason: "toolUse" });
			}
			child.appendMessage({ ...assistant, model, ...(first ? { stopReason: "error" as const, errorMessage: "rate limited" } : {}) });
			report("settled");
			report("result", first ? { outcome: "failed", error: "rate limited", finalOutput: "" } : { outcome: "success", finalOutput: "answer" });
			return { status: first ? 1 : 0, signal: null };
		};
		const result = await runSync(directory, [agent], "worker", "Edit file.txt", {
			runtime: mock.runtime, sessionFile, runId: "retry", acceptance: { level: "none", reason: "exercise the completion guard" },
		}, {
			selectBackend: async () => ({ selection: { kind: "external", backend: fake.backend, detection: await fake.backend.detect() }, diagnostics: [] }),
			createExternalOwner: options => createExternalExecution(options, {
				createController: fake.dependencies.createController, createControl: fake.dependencies.createControl, createWatcher: fake.dependencies.createWatcher,
			}),
		});
		assert.match(result.error ?? "", /completed without making edits/);
		assert.deepEqual(result.modelAttempts?.map(attempt => attempt.usage), [
			{ input: 6, output: 9, cacheRead: 12, cacheWrite: 15, turns: 2, cost: 3 },
			{ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, turns: 1, cost: 1 },
		]);
		assert.deepEqual(result.usage, { input: 8, output: 12, cacheRead: 16, cacheWrite: 20, turns: 3, cost: 4 });
	});

	it("creates an absent session and rejects unsafe existing paths", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "external-owner-test-"));
		try {
			const fake = harness();
			const { ensureSessionFile: _ensure, ...dependencies } = fake.dependencies;
			const owner = await createExternalExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, dependencies);
			fake.ready.resolve();
			const sessionFile = path.join(directory, "session.jsonl");
			const pending = owner.runAttempt(request({ sessionFile }));
			await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
			assert.equal(fs.statSync(sessionFile).isFile(), true);
			if (process.platform !== "win32") assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
			fake.setContent(sessionContent("success", ["shutdown"]));
			fake.terminal.resolve(replay()); fake.exit.resolve({ status: 0, signal: null });
			await pending;

			const second = harness();
			const { ensureSessionFile: _secondEnsure, ...secondDependencies } = second.dependencies;
			const secondOwner = await createExternalExecution({ backend: second.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, secondDependencies);
			second.ready.resolve();
			const link = path.join(directory, "link.jsonl");
			fs.symlinkSync(sessionFile, link);
			await assert.rejects(secondOwner.runAttempt(request({ sessionFile: link })), (error: unknown) =>
				/regular non-symlink file/.test((error as Error).message) && externalExecutionDiagnosticCode(error) === "session_file_untrusted");
			assert.equal(second.starts.length, 0);

			if (process.platform !== "win32") {
				const third = harness();
				const { ensureSessionFile: _thirdEnsure, ...thirdDependencies } = third.dependencies;
				const thirdOwner = await createExternalExecution({ backend: third.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, thirdDependencies);
				third.ready.resolve();
				fs.chmodSync(sessionFile, 0o644);
				await assert.rejects(thirdOwner.runAttempt(request({ sessionFile })), (error: unknown) =>
					/owner-only/.test((error as Error).message) && externalExecutionDiagnosticCode(error) === "session_file_untrusted");
				assert.equal(third.starts.length, 0);
			}
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("propagates malformed or cross-attempt watcher failures and ignores surface text", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const pending = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		fake.terminal.reject(new Error("execution report correlation mismatch"));
		await assert.rejects(pending, /correlation mismatch/);
		assert.equal(fake.calls.includes("watcher-close"), true);
		assert.equal(fake.calls.includes("control-close"), true);
	});

	it("final-replays exactly once after exit and reports result_missing", async () => {
		const fake = harness();
		fake.setContent(line("ready", 1) + line("settled", 2));
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const pending = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		fake.exit.resolve({ status: 1, signal: null });
		await assert.rejects(pending, /result_missing/);
		assert.equal(fake.calls.filter(call => call === "read").length, 1);
	});

	it("maps parent abort and interrupt to one abort request, durable interruption, then shutdown", async () => {
		for (const signalName of ["signal", "interruptSignal"] as const) {
			const fake = harness();
			const owner = await ownerFrom(fake); fake.ready.resolve();
			const aborter = new AbortController();
			const pending = owner.runAttempt(request({ [signalName]: aborter.signal }));
			await Promise.resolve(); await Promise.resolve();
			aborter.abort();
			await Promise.resolve();
			fake.terminal.resolve(replay(sessionContent("interrupted")));
			await Promise.resolve();
			fake.setContent(sessionContent("interrupted", ["abort", "shutdown"]));
			fake.exit.resolve({ status: null, signal: "SIGTERM" });
			const result = await pending;
			assert.equal(result.interrupted, true);
			assert.deepEqual(fake.controls, ["abort", "shutdown"]);
		}
	});

	it("runs two sequential attempts through one controller surface", async () => {
		const fake = harness();
		fake.controller.startAttempt = async attempt => {
			fake.starts.push(attempt);
			return { status: 0, signal: null };
		};
		let currentContent = "";
		fake.dependencies.createControl = async reportIdentity => ({
			configPath: "/private/report-config.json",
			connected: Promise.resolve(),
			async request(action) {
				assert.equal(action, "shutdown");
				currentContent = sessionContent("success", ["shutdown"], reportIdentity.attemptId);
				return "shutdown-id";
			},
			async close() {},
		});
		fake.dependencies.createWatcher = (_file, reportIdentity) => ({
			terminal: Promise.resolve(replay(sessionContent("success", [], reportIdentity.attemptId), reportIdentity.attemptId)),
			close() {},
		});
		fake.dependencies.readSession = async () => currentContent;
		const owner = await ownerFrom(fake); fake.ready.resolve();
		await owner.runAttempt(request({ attemptId: "first" }));
		await owner.runAttempt(request({ attemptId: "second" }));
		assert.deepEqual(fake.starts.map(start => start.attemptId), ["first", "second"]);
		assert.equal(fake.calls.filter(call => call === "controller").length, 1);
	});

	it("rejects concurrent and repeated attempts while preserving one controller launch", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const first = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		await assert.rejects(owner.runAttempt(request({ attemptId: "other" })), /busy/);
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay()); fake.exit.resolve({ status: 0, signal: null });
		await first;
		await assert.rejects(owner.runAttempt(request()), /already been used/);
		assert.equal(fake.calls.filter(call => call === "controller").length, 1);
	});

	it("delivered finish shuts down, closes, and releases exactly once", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake); fake.ready.resolve();
		assert.deepEqual(await owner.finish("delivered"), { handle, retained: false });
		assert.deepEqual(await owner.finish("delivered"), { handle, retained: false });
		assert.deepEqual(fake.calls, ["controller", "host-shutdown", "backend-close", "release", "dispose"]);
		assert.deepEqual(fake.counts(), { releases: 1, closes: 1, shutdowns: 1 });
	});

	it("normal retained finish disposes once after successful shutdown and release", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake); fake.ready.resolve();
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay());
		fake.exit.resolve({ status: 0, signal: null });
		await owner.runAttempt(request());
		assert.equal(fake.calls.includes("dispose"), false);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
		await owner.finish("retained");
		assert.deepEqual(fake.calls.slice(-3), ["host-shutdown", "release", "dispose"]);
		for (const call of ["dispose", "watcher-close", "control-close", "release"]) assert.equal(fake.calls.filter(value => value === call).length, 1);
		assert.equal(fake.counts().closes, 0);
	});

	it("releases after shutdown or close failure and rejects conflicting dispositions", async () => {
		const shutdownFailure = harness();
		shutdownFailure.controller.shutdown = async () => { throw new Error("shutdown failed safely"); };
		const retained = await ownerFrom(shutdownFailure);
		await assert.rejects(retained.finish("delivered"), /shutdown failed safely/);
		assert.equal(shutdownFailure.counts().releases, 1);
		await assert.rejects(retained.finish("retained"), /already finishing as delivered/);

		const closeFailure = harness();
		let failClose = true;
		closeFailure.backend.close = async () => {
			if (failClose) { failClose = false; throw new Error("close failed safely"); }
		};
		const delivered = await ownerFrom(closeFailure);
		await assert.rejects(delivered.finish("delivered"), /close failed safely/);
		assert.equal(closeFailure.counts().releases, 1);
		assert.deepEqual(await delivered.finish("delivered"), { handle, retained: false });
		assert.equal(closeFailure.counts().releases, 1);
	});

	it("withReadyDeadline calls timer.unref so unsettled owner does not keep process alive", async () => {
		const unrefs: NodeJS.Timeout[] = [];
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((...args: unknown[]) => {
			const timer = originalSetTimeout(...(args as any));
			const origUnref = timer.unref.bind(timer);
			timer.unref = (() => { unrefs.push(timer); return origUnref(); }) as any;
			return timer;
		}) as typeof setTimeout;
		try {
			const fake = harness();
			delete fake.dependencies.readyDeadline;
			const owner = await createExternalExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal, readyTimeoutMs: 100 }, fake.dependencies);
			let settled = false;
			void owner.ready.catch(() => { settled = true; });
			await new Promise(r => setTimeout(r, 10));
			assert.equal(settled, false);
			assert.equal(unrefs.length, 1);
			await new Promise(r => setTimeout(r, 110));
			assert.equal(settled, true);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	it("ExternalAttemptRequest.signal and .interruptSignal are optional and abortPromise ignores undefined", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt({
			attemptId: "attempt",
			command: "/bin/pi",
			args: ["--mode", "json"],
			cwd: "/exact/worktree",
			environment: {},
			sessionFile: "/trusted/session.jsonl",
			// No signal or interruptSignal provided
		} as any);
		await Promise.resolve(); await Promise.resolve();
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay());
		fake.exit.resolve({ status: 0, signal: null });
		const result = await pending;
		assert.equal(result.interrupted, false);
		assert.equal(fake.calls.includes("start"), true, "attempt should start without signals");
	});

	it("finish wraps retained shutdown in try/finally to release observer on failure", async () => {
		const fake = harness();
		let shutdownCalled = false;
		fake.controller.shutdown = async () => { shutdownCalled = true; throw new Error("shutdown failed safely"); };
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		await assert.rejects(owner.finish("retained"), /shutdown failed safely/);
		assert.equal(shutdownCalled, true, "must call shutdown");
		assert.equal(fake.counts().releases, 1, "must release observer even on shutdown failure");
	});
	it("rejects successful result conflicting with nonzero child exit", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay());
		fake.exit.resolve({ status: 1, signal: null });
		await assert.rejects(pending, /successful durable result conflicts with child exit/);
	});

	it("rejects missing abort control evidence", async () => {
		const fake = harness();
		const abortRequested = deferred<void>();
		const baseCreateControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async (identity) => {
			const baseControl = await baseCreateControl(identity);
			const originalRequest = baseControl.request.bind(baseControl);
			baseControl.request = async (action) => {
				if (action === "abort") {
					fake.terminal.resolve(replay(sessionContent("interrupted")));
					abortRequested.resolve();
				} else if (action === "shutdown") {
					fake.setContent(sessionContent("interrupted", ["shutdown"]));
					fake.exit.resolve({ status: 0, signal: null });
				}
				return originalRequest(action);
			};
			return baseControl;
		};
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const aborter = new AbortController();
		const pending = owner.runAttempt(request({ interruptSignal: aborter.signal }));
		aborter.abort();
		await abortRequested.promise;
		await assert.rejects(pending, /durable abort control evidence is missing/);
	});

	it("rejects missing shutdown control evidence after result", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		await Promise.resolve(); await Promise.resolve();
		fake.setContent(sessionContent("success", [])); // No control evidence
		fake.terminal.resolve(replay());
		fake.exit.resolve({ status: 0, signal: null });
		await assert.rejects(pending, /durable shutdown control evidence is missing/);
	});

	for (const outcome of ["success", "failed", "interrupted"] as const) it(`preserves ${outcome} terminal after accepted abort and completes teardown`, async () => {
		const fake = harness();
		const abortRequested = deferred<void>();
		const baseCreateControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async (identity) => {
			const baseControl = await baseCreateControl(identity);
			const originalRequest = baseControl.request.bind(baseControl);
			baseControl.request = async (action) => {
				if (action === "abort") {
					fake.terminal.resolve(replay(sessionContent(outcome, [], "attempt", { stopReason: "error", errorMessage: "This operation was aborted" })));
					abortRequested.resolve();
				} else {
					fake.setContent(sessionContent(outcome, ["abort", "shutdown"], "attempt", { stopReason: "error", errorMessage: "This operation was aborted" }));
					fake.exit.resolve({ status: null, signal: "SIGTERM" });
				}
				return originalRequest(action);
			};
			return baseControl;
		};
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const aborter = new AbortController();
		const pending = owner.runAttempt(request({ interruptSignal: aborter.signal }));
		aborter.abort();
		await abortRequested.promise;
		const result = await pending;
		assert.equal(result.outcome, outcome);
		assert.equal(result.interrupted, true);
		assert.deepEqual(fake.controls, ["abort", "shutdown"]);
		assert.equal(fake.counts().shutdowns, 1);
		await owner.finish("retained");
		await owner.finish("retained");
		assert.equal(fake.counts().shutdowns, 1);
	});

	for (const first of ["result", "exit"] as const) it(`races cancellation against in-flight ${first}-first final replay`, async () => {
		const fake = harness();
		const reading = deferred<void>();
		const lateRead = deferred<string>();
		let reads = 0;
		fake.dependencies.readSession = () => {
			if (++reads === 1) { reading.resolve(); return lateRead.promise; }
			return Promise.resolve(sessionContent("failed", ["abort", "shutdown"]));
		};
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController();
		const pending = owner.runAttempt(request({ signal: aborter.signal }));
		if (first === "result") fake.terminal.resolve(replay(sessionContent("failed")));
		fake.exit.resolve({ status: 1, signal: null });
		await reading.promise;
		aborter.abort();
		if (first === "exit") fake.terminal.resolve(replay(sessionContent("failed")));
		for (let index = 0; index < 40; index++) await Promise.resolve();
		assert.equal(fake.calls.includes("dispose"), true, "cancellation must not wait for the old replay");
		const result = await pending;
		assert.equal(result.outcome, "failed");
		assert.equal(result.interrupted, true);
		assert.equal(fake.counts().shutdowns, 1);
		const surface = await owner.finish("retained");
		lateRead.reject(new Error("late replay failed"));
		await Promise.resolve();
		assert.deepEqual(await owner.finish("retained"), surface);
		assert.equal(fake.counts().shutdowns, 1);
	});

	it("accepts cancellation while shutdown of an already durable failure is pending", async () => {
		const fake = harness();
		const shutdown = deferred<string>();
		const armed = deferred<void>();
		const createControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async identity => {
			const control = await createControl(identity);
			const original = control.request.bind(control);
			control.request = action => {
				const response = original(action);
				if (action === "shutdown") { armed.resolve(); return shutdown.promise; }
				return response;
			};
			return control;
		};
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController();
		fake.terminal.resolve(replay(sessionContent("failed")));
		const pending = owner.runAttempt(request({ signal: aborter.signal }));
		await armed.promise;
		aborter.abort(); aborter.abort();
		fake.setContent(sessionContent("failed", ["shutdown"]));
		shutdown.resolve("shutdown-id");
		fake.exit.resolve({ status: 1, signal: null });
		const result = await pending;
		assert.equal(result.outcome, "failed");
		assert.equal(result.interrupted, true);
		assert.deepEqual(fake.controls, ["shutdown"]);
		assert.equal(fake.counts().shutdowns, 1);
	});

	for (const mode of ["reject", "stall"] as const) it(`disposes resources before ${mode} observer release`, async () => {
		const fake = harness();
		fake.controller.releaseObserver = async () => {
			assert.equal(fake.calls.includes("dispose"), true);
			if (mode === "reject") throw new Error("release rejected");
			await deferred<void>().promise;
		};
		fake.dependencies.controlDeadline = async (promise, _timeout, label) => {
			if (label === "observer release" && mode === "stall") throw new Error("release timed out");
			return promise;
		};
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const result = await owner.runAttempt(request());
		assert.match(result.error!, /release (rejected|timed out)/);
		assert.equal(result.error!.includes("manual cleanup"), false);
		await owner.finish("retained");
	});

	for (const evidence of ["applied", "requested-only"] as const) it(`validates delayed ${evidence} shutdown evidence after process settlement`, async () => {
		const fake = harness();
		const shutdownRequested = deferred<void>();
		const createControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async identity => {
			const control = await createControl(identity);
			const original = control.request.bind(control);
			control.request = async action => {
				const response = await original(action);
				if (action === "shutdown") shutdownRequested.resolve();
				return response;
			};
			return control;
		};
		fake.setContent(sessionContent("interrupted"));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const pending = owner.runAttempt(request());
		const checked = evidence === "requested-only"
			? assert.rejects(pending, /durable shutdown control evidence is missing/)
			: pending;
		await shutdownRequested.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(fake.calls.includes("dispose"), false);
		fake.setContent(evidence === "applied" ? sessionContent("interrupted", ["shutdown"]) : sessionContent("interrupted") + line("control", 4, { action: "shutdown", state: "requested" }));
		fake.exit.resolve({ status: 0, signal: null });
		const result = await checked;
		if (evidence === "applied") {
			assert.equal(result!.interrupted, true);
			assert.equal(result!.error, undefined);
		}
		assert.equal(fake.counts().closes, 0);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
	});

	it("waits for independent host exit before settlement and disposal", async () => {
		const fake = harness();
		fake.controller.shutdown = async () => { fake.calls.push("host-shutdown"); };
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController();
		const pending = owner.runAttempt(request({ signal: aborter.signal }));
		let settled = false;
		void pending.then(() => { settled = true; });
		aborter.abort();
		fake.setContent(sessionContent("interrupted", ["abort", "shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		for (let index = 0; index < 30; index++) await Promise.resolve();
		assert.equal(fake.calls.includes("host-shutdown"), true);
		assert.equal(settled, false);
		assert.equal(fake.calls.includes("dispose"), false);
		fake.hostExit.resolve({ status: 0, signal: null });
		assert.equal((await pending).error, undefined);
		assert.equal(fake.calls.includes("dispose"), true);
	});

	it("keeps resources through fallback when child exit rejects and host already exited", async () => {
		const fake = harness();
		let clock = 0;
		fake.dependencies.monotonicNow = () => clock;
		fake.dependencies.controlDeadline = async (promise, timeout, label) => {
			if (label === "child exit observation") {
				const outcome = await Promise.race([
					promise.then(() => "resolved", () => "rejected"),
					(async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); return "pending"; })(),
				]);
				assert.equal(outcome, "pending", "rejected exit observation must not end the fallback window");
				for (const call of ["dispose", "watcher-close", "control-close", "release"]) assert.equal(fake.calls.includes(call), false);
				clock += timeout;
				throw new Error(`${label} timed out`);
			}
			return promise;
		};
		fake.controller.dispose = () => { assert.equal(clock, 200); fake.calls.push("dispose"); };
		fake.hostExit.resolve({ status: 0, signal: null });
		fake.exit.reject(new Error("child host disconnected during attempt"));
		fake.setContent(sessionContent("interrupted", ["abort", "shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 }); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		const result = await owner.runAttempt(request({ signal: aborter.signal }));
		assert.equal(clock, 200);
		assert.deepEqual(result.exit, { code: null, signal: null });
		assert.match(result.error!, /Process termination could not be confirmed/);
		assert.equal(fake.counts().closes, 1);
		const calls = [...fake.calls];
		await owner.finish("retained"); await owner.finish("retained");
		assert.deepEqual(fake.calls, calls);
	});

	it("requests host shutdown when child exit arrives during fallback close", async () => {
		const fake = harness();
		let clock = 0;
		const waits: { label: string; timeout: number; at: number }[] = [];
		fake.dependencies.monotonicNow = () => clock;
		fake.dependencies.controlDeadline = async (promise, timeout, label) => {
			waits.push({ label, timeout, at: clock });
			if (label === "post-shutdown exit" || label === "host exit observation") {
				clock += timeout;
				throw new Error(`${label} timed out`);
			}
			clock += 1;
			return promise;
		};
		const close = fake.backend.close.bind(fake.backend);
		fake.backend.close = async actual => {
			await close(actual);
			fake.exit.resolve({ status: 0, signal: null });
		};
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 }); fake.ready.resolve();
		const result = await owner.runAttempt(request());
		assert.deepEqual(fake.counts(), { closes: 1, shutdowns: 1, releases: 1 });
		assert.ok(fake.calls.indexOf("host-shutdown") < fake.calls.indexOf("dispose"));
		assert.equal(waits.some(wait => wait.label === "host exit observation"), false);
		const shutdownWait = waits.find(wait => wait.label === "host shutdown")!;
		assert.equal(shutdownWait.at + shutdownWait.timeout, 200);
		assert.ok(clock < 200);
		assert.equal(result.error!.includes("manual cleanup"), false);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: false });
		assert.deepEqual(fake.counts(), { closes: 1, shutdowns: 1, releases: 1 });
	});

	for (const closeMode of ["resolve", "reject", "stall"] as const) it(`bounds fallback with ${closeMode} close and no child exit`, async () => {
		const fake = harness();
		let clock = 0;
		const waits: { label: string; timeout: number; clock: number }[] = [];
		const lateClose = deferred<void>();
		let closes = 0;
		fake.backend.close = async (_handle, reason) => {
			assert.equal(reason, "explicit_cleanup"); closes++;
			if (closeMode === "reject") throw new Error("close rejected");
			if (closeMode === "stall") await lateClose.promise;
		};
		fake.dependencies.monotonicNow = () => clock;
		fake.dependencies.controlDeadline = async (promise, timeout, label) => {
			waits.push({ label, timeout, clock });
			if (label === "post-shutdown exit" || label === "child exit observation" || label === "explicit cleanup" && closeMode === "stall") {
				clock += timeout;
				throw new Error(`${label} timed out`);
			}
			clock += 1;
			return promise;
		};
		fake.hostExit.resolve({ status: 0, signal: null });
		fake.setContent(sessionContent("success", ["abort", "shutdown"]));
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 }); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		fake.terminal.resolve(replay());
		const result = await owner.runAttempt(request({ signal: aborter.signal }));
		assert.equal(result.interrupted, true);
		assert.equal(result.outcome, "success");
		assert.match(result.error!, /Process termination could not be confirmed; manual cleanup may be required\./);
		assert.deepEqual(result.exit, { code: null, signal: null });
		assert.equal(closes, 1);
		assert.equal(fake.calls.includes("dispose"), true);
		const surface = await owner.finish("retained");
		assert.equal(surface.retained, closeMode !== "resolve");
		assert.deepEqual(await owner.finish("retained"), surface);
		lateClose.resolve(); await Promise.resolve();
		assert.equal(surface.retained, closeMode !== "resolve");
		assert.equal(closes, 1);
		assert.ok(waits.every(wait => wait.clock + wait.timeout <= (wait.label === "abort request" || wait.label === "post-abort terminal" || wait.label === "child shutdown" || wait.label === "post-shutdown exit" ? 100 : 200)));
		await assert.rejects(owner.runAttempt(request()), /already been used/);
		await assert.rejects(owner.runAttempt(request({ attemptId: "next" })), /interruption-cleaned/);
		await assert.rejects(owner.finish("delivered"), /already finishing/);
	});

	it("annotates the original corrupt-report diagnostic only after teardown", async () => {
		const fake = harness();
		const diagnostic = Object.assign(new TypeError("corrupt report"), { code: "original" });
		fake.dependencies.readSession = async () => { throw diagnostic; };
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		const pending = owner.runAttempt(request({ signal: aborter.signal }));
		fake.terminal.reject(diagnostic);
		fake.exit.resolve({ status: 1, signal: null });
		await assert.rejects(pending, error => {
			assert.strictEqual(error, diagnostic);
			assert.equal(isInterruptedExternalAttemptError(error), true);
			assert.equal(diagnostic.code, "original");
			assert.equal(fake.calls.includes("dispose"), true);
			assert.deepEqual(fake.controls, ["abort", "shutdown"]);
			return true;
		});
	});

	for (const action of ["abort", "shutdown"] as const) for (const mode of ["reject", "stall"] as const) it(`falls back once when ${action} control ${mode}s and child exit stalls`, async () => {
		const fake = harness();
		const createControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async identity => {
			const control = await createControl(identity);
			const original = control.request.bind(control);
			control.request = async requested => {
				await original(requested);
				if (requested === "abort") fake.terminal.resolve(replay(sessionContent("interrupted")));
				if (requested === action) {
					if (mode === "reject") throw new Error(`${action} rejected`);
					await deferred<void>().promise;
				}
				return "control-id";
			};
			return control;
		};
		fake.dependencies.controlDeadline = async (promise, _timeout, label) => {
			if (action === "abort" && label === "post-shutdown exit") throw new Error("child exit stalled");
			if (mode === "stall" && label === (action === "abort" ? "abort request" : "child shutdown")) throw new Error(`${action} stalled`);
			return promise;
		};
		const close = fake.backend.close.bind(fake.backend);
		fake.backend.close = async actual => {
			await close(actual);
			fake.exit.resolve({ status: 0, signal: null });
			fake.hostExit.resolve({ status: 0, signal: null });
		};
		fake.setContent(sessionContent("interrupted", ["abort", "shutdown"]));
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		const result = await owner.runAttempt(request({ signal: aborter.signal }));
		assert.equal(result.interrupted, true);
		assert.match(result.error!, new RegExp(`${action} (rejected|stalled)`));
		assert.equal(fake.counts().closes, 1);
		assert.deepEqual(fake.controls, ["abort", "shutdown"]);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: false });
	});

	it("retains a responsive surface when only the abort request rejects", async () => {
		const fake = harness();
		const createControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async identity => {
			const control = await createControl(identity);
			const original = control.request.bind(control);
			control.request = async action => {
				await original(action);
				if (action === "abort") {
					fake.terminal.resolve(replay(sessionContent("interrupted")));
					throw new Error("abort rejected");
				}
				fake.exit.resolve({ status: 0, signal: null });
				return "shutdown-id";
			};
			return control;
		};
		fake.setContent(sessionContent("interrupted", ["abort", "shutdown"]));
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		const result = await owner.runAttempt(request({ signal: aborter.signal }));
		assert.match(result.error!, /abort rejected/);
		assert.equal(result.error!.includes("manual cleanup"), false);
		assert.deepEqual(fake.counts(), { closes: 0, shutdowns: 1, releases: 1 });
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
	});

	for (const mode of ["confirmed", "unconfirmed", "closed", "rejected", "hanging"] as const) it(`rejects delivered finish after ${mode} interrupted cleanup without repeating cleanup`, async () => {
		const fake = harness();
		if (mode !== "confirmed") {
			fake.controller.shutdown = async () => {
				fake.calls.push("host-shutdown");
				if (mode !== "unconfirmed") throw new Error("host busy");
			};
			const close = fake.backend.close.bind(fake.backend);
			fake.backend.close = async actual => {
				await close(actual);
				if (fake.counts().closes > 1) throw new Error("duplicate close");
				if (mode === "rejected") throw new Error("close rejected");
				if (mode === "hanging") await deferred<void>().promise;
				if (mode === "closed") fake.hostExit.resolve({ status: 0, signal: null });
			};
			fake.dependencies.controlDeadline = async (promise, _timeout, label) => {
				if (label === "host exit observation" || label === "explicit cleanup" && mode === "hanging") throw new Error(`${label} timed out`);
				return promise;
			};
		}
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		const owner = await ownerFrom(fake); fake.ready.resolve();
		await owner.runAttempt(request());
		const calls = [...fake.calls];
		await assert.rejects(owner.finish("delivered"), /interruption-cleaned.*retained/);
		await assert.rejects(owner.finish("delivered"), /interruption-cleaned.*retained/);
		assert.deepEqual(fake.calls, calls);
		assert.equal(fake.counts().closes, mode === "confirmed" || mode === "unconfirmed" ? 0 : 1);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: mode !== "closed" });
		assert.deepEqual(fake.calls, calls);
	});

	it("records watcher disposal rejection without skipping interrupted finalization", async () => {
		const fake = harness();
		const createWatcher = fake.dependencies.createWatcher!;
		fake.dependencies.createWatcher = (...args) => {
			const watcher = createWatcher(...args);
			watcher.close = () => { fake.calls.push("watcher-close"); throw new Error("watcher close rejected"); };
			return watcher;
		};
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const result = await owner.runAttempt(request());
		assert.match(result.error!, /watcher close rejected/);
		assert.equal(fake.calls.filter(call => call === "watcher-close").length, 1);
		for (const call of ["dispose", "control-close", "release"]) assert.ok(fake.calls.includes(call));
		const calls = [...fake.calls];
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
		assert.deepEqual(fake.calls, calls);
		await assert.rejects(owner.runAttempt(request({ attemptId: "next" })), /interruption-cleaned/);
	});

	it("preserves result_missing after terminal timeout and bounded cleanup", async () => {
		const fake = harness();
		let clock = 0;
		fake.dependencies.monotonicNow = () => clock;
		fake.dependencies.controlDeadline = async (promise, timeout, label) => {
			if (label === "post-abort terminal" || label.includes("exit")) {
				clock += timeout;
				throw new Error(`${label} timed out`);
			}
			return promise;
		};
		fake.setContent(line("ready", 1) + line("settled", 2));
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 }); fake.ready.resolve();
		const aborter = new AbortController(); aborter.abort();
		await assert.rejects(owner.runAttempt(request({ signal: aborter.signal })), error => {
			assert.equal(isInterruptedExternalAttemptError(error), true);
			assert.equal(externalExecutionDiagnosticCode(error), "result_missing");
			assert.match((error as Error).message, /manual cleanup may be required/);
			assert.equal(fake.calls.includes("dispose"), true);
			assert.equal(fake.counts().closes, 1);
			return true;
		});
		assert.ok(clock <= 200);
		await owner.finish("retained");
	});

	for (const mode of ["busy", "stall"] as const) it(`bounds ${mode} host shutdown with one fallback and independent exit observation`, async () => {
		const fake = harness();
		let clock = 0;
		const waits: { label: string; timeout: number; at: number }[] = [];
		fake.dependencies.monotonicNow = () => clock;
		fake.controller.shutdown = async () => {
			fake.calls.push("host-shutdown");
			if (mode === "busy") throw new Error("host busy");
			await deferred<void>().promise;
		};
		fake.dependencies.controlDeadline = async (promise, timeout, label) => {
			waits.push({ label, timeout, at: clock });
			if (label === "host shutdown" && mode === "stall") {
				clock += timeout;
				throw new Error("host shutdown timed out");
			}
			clock += 1;
			return promise;
		};
		const close = fake.backend.close.bind(fake.backend);
		fake.backend.close = async actual => {
			await close(actual);
			assert.equal(fake.calls.includes("dispose"), false);
			fake.hostExit.resolve({ status: 0, signal: null });
		};
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 }); fake.ready.resolve();
		const result = await owner.runAttempt(request());
		assert.match(result.error!, /host (busy|shutdown timed out)/);
		assert.equal(result.error!.includes("manual cleanup"), false);
		assert.equal(fake.counts().closes, 1);
		assert.ok(clock <= 200);
		const fallbackIndex = waits.findIndex(wait => wait.label === "explicit cleanup");
		assert.ok(fallbackIndex > 0);
		for (const [index, wait] of waits.entries()) assert.equal(wait.at + wait.timeout, index < fallbackIndex ? 100 : 200);
		const calls = [...fake.calls];
		assert.deepEqual(await owner.finish("retained"), { handle, retained: false });
		await owner.finish("retained");
		assert.deepEqual(fake.calls, calls);
	});

	it("observes missing host evidence without destructively closing a responsive surface", async () => {
		const fake = harness();
		fake.controller.shutdown = async () => {};
		fake.dependencies.controlDeadline = async (promise, _timeout, label) => {
			if (label === "host exit observation") throw new Error("host evidence absent");
			return promise;
		};
		fake.setContent(sessionContent("interrupted", ["shutdown"]));
		const owner = await ownerFrom(fake); fake.ready.resolve();
		fake.terminal.resolve(replay(sessionContent("interrupted")));
		fake.exit.resolve({ status: 0, signal: null });
		const result = await owner.runAttempt(request());
		assert.match(result.error!, /manual cleanup may be required/);
		assert.equal(fake.counts().closes, 0);
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
	});

	it("rejects post-abort terminal wait exceeding control timeout", async () => {
		const fake = harness();
		const abortRequested = deferred<void>();
		const baseCreateControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async (identity) => {
			const baseControl = await baseCreateControl(identity);
			const originalRequest = baseControl.request.bind(baseControl);
			baseControl.request = async (action) => {
				if (action === "abort") {
					abortRequested.resolve();
				}
				return originalRequest(action);
			};
			return baseControl;
		};
		fake.dependencies.controlDeadline = async (_promise, _timeoutMs, label) => { throw new Error(`${label} timed out`); };
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 });
		fake.ready.resolve();
		const aborter = new AbortController();
		const pending = owner.runAttempt(request({ interruptSignal: aborter.signal }));
		aborter.abort();
		await abortRequested.promise;
		await assert.rejects(pending, /post-abort terminal timed out/);
	});

	it("rejects post-shutdown exit wait exceeding control timeout", async () => {
		const fake = harness();
		const shutdownRequested = deferred<void>();
		const baseCreateControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async (identity) => {
			const baseControl = await baseCreateControl(identity);
			const originalRequest = baseControl.request.bind(baseControl);
			baseControl.request = async (action) => {
				if (action === "shutdown") {
					fake.setContent(sessionContent("success", ["shutdown"]));
					shutdownRequested.resolve();
				}
				return originalRequest(action);
			};
			return baseControl;
		};
		fake.dependencies.controlDeadline = async (_promise, _timeoutMs, label) => { throw new Error(`${label} timed out`); };
		const owner = await ownerFrom(fake, { controlTimeoutMs: 100 });
		fake.ready.resolve();
		fake.terminal.resolve(replay(sessionContent("success")));
		const pending = owner.runAttempt(request());
		await shutdownRequested.promise;
		await assert.rejects(pending, /post-shutdown exit timed out/);
	});

	it("preserves both shutdown and release failures with AggregateError", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("success", ["shutdown"])));
		fake.exit.resolve({ status: 0, signal: null });
		await pending;
		const shutdownError = new Error("shutdown failed");
		const releaseError = new Error("release failed");
		fake.controller.shutdown = async () => { throw shutdownError; };
		const originalRelease = fake.controller.releaseObserver;
		fake.controller.releaseObserver = async () => { await originalRelease(); throw releaseError; };
		let error: unknown;
		await owner.finish("delivered").catch(e => { error = e; });
		assert(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.equal(error.errors[0], shutdownError);
		assert.equal(error.errors[1], releaseError);
	});

	it("preserves shutdown failure when release succeeds", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("success", ["shutdown"])));
		fake.exit.resolve({ status: 0, signal: null });
		await pending;
		const shutdownError = new Error("shutdown failed");
		fake.controller.shutdown = async () => { throw shutdownError; };
		let error: unknown;
		await owner.finish("retained").catch(e => { error = e; });
		assert.equal(error, shutdownError);
	});

	it("preserves release failure when shutdown succeeds", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("success", ["shutdown"])));
		fake.exit.resolve({ status: 0, signal: null });
		await pending;
		const releaseError = new Error("release failed");
		const originalRelease = fake.controller.releaseObserver;
		fake.controller.releaseObserver = async () => { await originalRelease(); throw releaseError; };
		let error: unknown;
		await owner.finish("delivered").catch(e => { error = e; });
		assert.equal(error, releaseError);
	});

	it("preserves both shutdown and release failures with AggregateError for retained disposition", async () => {
		const fake = harness();
		const owner = await ownerFrom(fake);
		fake.ready.resolve();
		const pending = owner.runAttempt(request());
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay(sessionContent("success", ["shutdown"])));
		fake.exit.resolve({ status: 0, signal: null });
		await pending;
		const shutdownError = new Error("shutdown failed");
		const releaseError = new Error("release failed");
		fake.controller.shutdown = async () => { throw shutdownError; };
		const originalRelease = fake.controller.releaseObserver;
		fake.controller.releaseObserver = async () => { await originalRelease(); throw releaseError; };
		let error: unknown;
		await owner.finish("retained").catch(e => { error = e; });
		assert(error instanceof AggregateError);
		assert.equal(error.errors.length, 2);
		assert.equal(error.errors[0], shutdownError);
		assert.equal(error.errors[1], releaseError);
	});
});

describe("external execution start deadline", () => {
	const flush = () => new Promise<void>(resolve => setImmediate(resolve));
	const readyOnly = (attemptId = "attempt") => line("ready", 1, {}, {}, { ...identity, attemptId });
	const deadlineError = (ms: number) => `Subagent killed: pi did not start its session within the start deadline (startDeadlineMs=${ms}ms).`;
	const unconfirmed = "Process termination could not be confirmed; manual cleanup may be required.";

	it("closes the surface and fails the attempt when pi has not reported ready at the deadline", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		void attempt.catch(() => {});
		await flush();
		assert.equal(fake.starts.length, 1);
		t.mock.timers.tick(999);
		await flush();
		assert.deepEqual(fake.closeReasons, [], "the deadline has not passed");
		t.mock.timers.tick(1);
		await flush();
		assert.deepEqual(fake.closeReasons, ["explicit_cleanup"]);
		fake.exit.resolve({ status: null, signal: "SIGHUP" });
		fake.hostExit.resolve({ status: null, signal: "SIGHUP" });
		await assert.rejects(attempt, (error: unknown) => {
			assert.ok(error instanceof ExternalStartDeadlineError);
			assert.equal(error.message, deadlineError(1000));
			return true;
		});
		assert.deepEqual(fake.controls, [], "a pi that never started has no control channel to ask");
		await assert.rejects(owner.runAttempt(request({ attemptId: "second" })), /interruption-cleaned/);
		assert.equal(fake.starts.length, 1, "no further attempt starts on the closed surface");
		assert.deepEqual(await owner.finish("retained"), { handle, retained: false });
		assert.deepEqual(fake.counts(), { releases: 1, closes: 1, shutdowns: 0 });
	});

	it("reports unconfirmed termination and a retained surface when the close fails", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		fake.backend.close = async () => { fake.closeReasons.push("explicit_cleanup"); throw new Error("fixture close failed"); };
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000, controlTimeoutMs: 50 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		void attempt.catch(() => {});
		await flush();
		t.mock.timers.tick(1000);
		await flush();
		fake.exit.reject(new Error("child host disconnected during attempt"));
		await flush();
		t.mock.timers.tick(50);
		await assert.rejects(attempt, { message: `${deadlineError(1000)}\n${unconfirmed}` });
		assert.deepEqual(fake.closeReasons, ["explicit_cleanup"]);
		assert.ok(fake.calls.includes("dispose"), "disposal ends the child through the host socket");
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
	});

	it("fails with the start-deadline error and cleans up when the close throws before returning a promise", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		fake.backend.close = () => { fake.closeReasons.push("explicit_cleanup"); throw new Error("fixture close threw"); };
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000, controlTimeoutMs: 50 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		void attempt.catch(() => {});
		await flush();
		t.mock.timers.tick(1000);
		await flush();
		fake.exit.reject(new Error("child host disconnected during attempt"));
		await flush();
		t.mock.timers.tick(50);
		await assert.rejects(attempt, (error: unknown) => {
			assert.ok(error instanceof ExternalStartDeadlineError);
			assert.equal(error.message, `${deadlineError(1000)}\n${unconfirmed}`);
			return true;
		});
		assert.deepEqual(fake.closeReasons, ["explicit_cleanup"]);
		assert.ok(fake.calls.includes("dispose"), "disposal ends the child through the host socket");
		assert.deepEqual(await owner.finish("retained"), { handle, retained: true });
	});

	it("does not end an attempt that reported ready, however long it then runs", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent(readyOnly());
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		await flush();
		t.mock.timers.tick(1000);
		await flush();
		t.mock.timers.tick(60_000);
		await flush();
		assert.deepEqual(fake.closeReasons, []);
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay()); fake.exit.resolve({ status: 0, signal: null });
		assert.equal((await attempt).outcome, "success");
	});

	it("stops counting once the attempt settles", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		await flush();
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay()); fake.exit.resolve({ status: 0, signal: null });
		await attempt;
		const reads = fake.calls.filter(call => call === "read").length;
		fake.setContent("");
		t.mock.timers.tick(1000);
		await flush();
		assert.equal(fake.calls.filter(call => call === "read").length, reads, "a settled attempt is not checked again");
		assert.deepEqual(fake.closeReasons, []);
	});

	it("counts each attempt's deadline from that attempt's own start", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		const attempts = new Map<string, { terminal: ReturnType<typeof deferred<ReturnType<typeof replay>>>; exit: ReturnType<typeof deferred<ChildHostExit>> }>();
		const attemptState = (attemptId: string) => {
			if (!attempts.has(attemptId)) attempts.set(attemptId, { terminal: deferred(), exit: deferred() });
			return attempts.get(attemptId)!;
		};
		fake.controller.startAttempt = attempt => { fake.starts.push(attempt); return attemptState(attempt.attemptId).exit.promise; };
		fake.dependencies.createWatcher = (_file, reportIdentity) => ({ terminal: attemptState(reportIdentity.attemptId).terminal.promise, close() {} });
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000 }); fake.ready.resolve();

		fake.setContent(readyOnly("first"));
		const first = owner.runAttempt(request({ attemptId: "first" }));
		await flush();
		t.mock.timers.tick(5000);
		await flush();
		fake.setContent(sessionContent("failed", ["shutdown"], "first"));
		attemptState("first").terminal.resolve(replay(sessionContent("failed", [], "first"), "first"));
		attemptState("first").exit.resolve({ status: 1, signal: null });
		assert.equal((await first).outcome, "failed", "the first attempt outlives the deadline and fails on its own");

		fake.setContent("");
		const second = owner.runAttempt(request({ attemptId: "second" }));
		await flush();
		t.mock.timers.tick(999);
		await flush();
		fake.setContent(readyOnly("second"));
		t.mock.timers.tick(1);
		await flush();
		assert.deepEqual(fake.closeReasons, [], "the second attempt reported ready within its own deadline");
		fake.setContent(sessionContent("success", ["shutdown"], "second"));
		attemptState("second").terminal.resolve(replay(sessionContent("success", [], "second"), "second"));
		attemptState("second").exit.resolve({ status: 0, signal: null });
		assert.equal((await second).outcome, "success");
	});

	it("starts counting at the request to start pi, not at the surface launch", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		const owner = await ownerFrom(fake, { startDeadlineMs: 1000 });
		const attempt = owner.runAttempt(request());
		await flush();
		t.mock.timers.tick(5000);
		await flush();
		assert.equal(fake.starts.length, 0, "the helper has not connected yet");
		fake.ready.resolve();
		await flush();
		assert.equal(fake.starts.length, 1);
		t.mock.timers.tick(999);
		await flush();
		fake.setContent(readyOnly());
		t.mock.timers.tick(1);
		await flush();
		assert.deepEqual(fake.closeReasons, []);
		fake.setContent(sessionContent("success", ["shutdown"]));
		fake.terminal.resolve(replay()); fake.exit.resolve({ status: 0, signal: null });
		assert.equal((await attempt).outcome, "success");
	});

	it("applies the default deadline when none is given", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		const owner = await ownerFrom(fake); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		void attempt.catch(() => {});
		await flush();
		t.mock.timers.tick(DEFAULT_CONTROL_CONFIG.startDeadlineMs - 1);
		await flush();
		assert.deepEqual(fake.closeReasons, []);
		t.mock.timers.tick(1);
		await flush();
		fake.exit.resolve({ status: null, signal: "SIGHUP" });
		fake.hostExit.resolve({ status: null, signal: "SIGHUP" });
		await assert.rejects(attempt, { message: deadlineError(300_000) });
	});

	it("honors a deadline longer than one timer can hold", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const fake = harness();
		fake.setContent("");
		const owner = await ownerFrom(fake, { startDeadlineMs: 3_000_000_000 }); fake.ready.resolve();
		const attempt = owner.runAttempt(request());
		void attempt.catch(() => {});
		await flush();
		t.mock.timers.tick(2_147_483_647);
		await flush();
		assert.deepEqual(fake.closeReasons, []);
		t.mock.timers.tick(3_000_000_000 - 2_147_483_647);
		await flush();
		fake.exit.resolve({ status: null, signal: "SIGHUP" });
		fake.hostExit.resolve({ status: null, signal: "SIGHUP" });
		await assert.rejects(attempt, { message: deadlineError(3_000_000_000) });
	});
});
