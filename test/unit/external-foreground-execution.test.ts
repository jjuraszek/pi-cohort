import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ChildHostAttempt, ChildHostController, ChildHostExit } from "../../src/execution-backend/child-host-controller.ts";
import type { ExecutionControlChannel } from "../../src/execution-backend/control-channel.ts";
import { replayExecutionSession, type ReplayedSession } from "../../src/execution-backend/session-replay.ts";
import type { SessionWatcher } from "../../src/execution-backend/session-watcher.ts";
import type { ExecutionBackend, ExecutionSurfaceHandle } from "../../src/execution-backend/types.ts";
import {
	createExternalForegroundExecution,
	type ExternalAttemptRequest,
	type ExternalForegroundExecutionOptions,
	type ExternalForegroundExecutionDependencies,
} from "../../src/runs/foreground/external-execution.ts";

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

function sessionContent(outcome: "success" | "failed" | "interrupted" = "success", controls: readonly ("abort" | "shutdown")[] = [], attemptId = "attempt"): string {
	const reportIdentity = { ...identity, attemptId };
	const assistantId = `${attemptId}-assistant`;
	let content = `${JSON.stringify({ type: "message", id: assistantId, parentId: null, message: assistant })}\n`;
	content += line("ready", 1, {}, {}, reportIdentity);
	content += line("settled", 2, {}, {}, reportIdentity);
	content += line("result", 3, { outcome, finalOutput: "done", ...(outcome === "failed" ? { error: "failed safely" } : {}) }, { parentId: assistantId }, reportIdentity);
	let sequence = 4;
	for (const action of controls) {
		content += line("control", sequence++, { action, state: "requested" }, {}, reportIdentity);
		content += line("control", sequence++, { action, state: "applied" }, {}, reportIdentity);
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
	const interruptController = new AbortController();
	const calls: string[] = [];
	const starts: ChildHostAttempt[] = [];
	const controls: string[] = [];
	let content = sessionContent();
	let releases = 0;
	let closes = 0;
	let shutdowns = 0;
	const controller: ChildHostController = {
		lease: { handle, events: { async *[Symbol.asyncIterator]() {} }, async reconcile() { return []; }, async release() { releases++; } },
		ready: ready.promise,
		startAttempt(attempt) { calls.push("start"); starts.push(attempt); return exit.promise; },
		async shutdown() { calls.push("host-shutdown"); shutdowns++; },
		async releaseObserver() { calls.push("release"); releases++; },
	};
	const backend = {
		name: "fake", protocolVersion: 1 as const, async detect() { return { available: true, version: "1", capabilities: [] }; },
		async launch() { throw new Error("owner must use the controller boundary"); }, async reattach() { return { status: "gone" as const }; },
		async close(actual: ExecutionSurfaceHandle) { assert.strictEqual(actual, handle); calls.push("backend-close"); closes++; },
	} satisfies ExecutionBackend;
	const control: ExecutionControlChannel = {
		configPath: "/private/report-config.json",
		connected: Promise.resolve(),
		async request(action) { calls.push(`control-${action}`); controls.push(action); return `${action}-id`; },
		async close() { calls.push("control-close"); },
	};
	const watcher: SessionWatcher = { terminal: terminal.promise, close() { calls.push("watcher-close"); } };
	const dependencies: ExternalForegroundExecutionDependencies = {
		async createController() { calls.push("controller"); return controller; },
		readyDeadline: promise => promise,
		async createControl() { calls.push("control"); return control; },
		createWatcher() { calls.push("watcher"); return watcher; },
		async readSession() { calls.push("read"); return content; },
		ensureSessionFile() { calls.push("session"); },
	};
	return {
		backend, controller, ready, terminal, exit, calls, starts, controls, dependencies,
		interruptController, interruptSignal: interruptController.signal,
		setContent(value: string) { content = value; },
		counts: () => ({ releases, closes, shutdowns }),
	};
}

async function ownerFrom(fake: ReturnType<typeof harness>, optionOverrides?: Partial<Pick<ExternalForegroundExecutionOptions, "controlTimeoutMs">>) {
	return createExternalForegroundExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal, ...optionOverrides }, fake.dependencies);
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

	it("creates an absent session and rejects unsafe existing paths", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "external-owner-test-"));
		try {
			const fake = harness();
			const { ensureSessionFile: _ensure, ...dependencies } = fake.dependencies;
			const owner = await createExternalForegroundExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, dependencies);
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
			const secondOwner = await createExternalForegroundExecution({ backend: second.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, secondDependencies);
			second.ready.resolve();
			const link = path.join(directory, "link.jsonl");
			fs.symlinkSync(sessionFile, link);
			await assert.rejects(secondOwner.runAttempt(request({ sessionFile: link })), /regular non-symlink file/);
			assert.equal(second.starts.length, 0);

			if (process.platform !== "win32") {
				const third = harness();
				const { ensureSessionFile: _thirdEnsure, ...thirdDependencies } = third.dependencies;
				const thirdOwner = await createExternalForegroundExecution({ backend: third.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal }, thirdDependencies);
				third.ready.resolve();
				fs.chmodSync(sessionFile, 0o644);
				await assert.rejects(thirdOwner.runAttempt(request({ sessionFile })), /owner-only/);
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
		assert.deepEqual(fake.calls, ["controller", "host-shutdown", "backend-close", "release"]);
		assert.deepEqual(fake.counts(), { releases: 1, closes: 1, shutdowns: 1 });
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
			const owner = await createExternalForegroundExecution({ backend: fake.backend, runId: "run", childId: "child", cwd: "/work", signal: new AbortController().signal, readyTimeoutMs: 100 }, fake.dependencies);
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

	it("rejects abort producing non-interrupted result", async () => {
		const fake = harness();
		const abortRequested = deferred<void>();
		const baseCreateControl = fake.dependencies.createControl!;
		fake.dependencies.createControl = async (identity) => {
			const baseControl = await baseCreateControl(identity);
			const originalRequest = baseControl.request.bind(baseControl);
			baseControl.request = async (action) => {
				if (action === "abort") {
					fake.terminal.resolve(replay(sessionContent("success")));
					abortRequested.resolve();
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
		await assert.rejects(pending, /abort did not produce an interrupted durable result/);
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
