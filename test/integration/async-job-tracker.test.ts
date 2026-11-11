import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createMockPi, createTempDir, events as childEvents, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { createNestedRoute, findNestedRouteForRootId, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import registerSubagentExtension from "../../src/extension/index.ts";
import { listStopTargets, resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { RUN_STATE_ROOT_DIR } from "../../src/shared/types.ts";

interface AsyncJobTrackerModule {
	createAsyncJobTracker(
		pi: { events: { emit(channel: string, data: unknown): void } },
		state: Record<string, unknown>,
		asyncDirRoot: string,
		options?: {
			completionRetentionMs?: number;
			pollIntervalMs?: number;
			resultsDir?: string;
			kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
			now?: () => number;
		},
	): {
		ensurePoller(): void;
		resetJobs(ctx?: unknown): void;
		handleStarted(data: unknown): void;
		handleComplete(data: unknown): void;
	};
}

const trackerMod = await tryImport<AsyncJobTrackerModule>("./src/runs/background/async-job-tracker.ts");
const typesMod = await tryImport<{ LEGACY_ASYNC_DIR: string }>("./src/shared/types.ts");
const available = !!trackerMod;

function createState() {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundControls: new Map(),
		retainedNestedRoutes: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		safetyRescanTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function createEventRecorder() {
	const events: Array<{ channel: string; data: unknown }> = [];
	return {
		pi: {
			events: {
				emit: (channel: string, data: unknown) => {
					events.push({ channel, data });
				},
			},
		},
		events,
	};
}

function pidGone(): never {
	const error = new Error("missing") as NodeJS.ErrnoException;
	error.code = "ESRCH";
	throw error;
}

// The tracker drains/repairs jobs on an async poll loop; a fixed sleep races it and flakes on slow
// CI (Windows). Poll the condition with a wide budget instead, then let the caller assert for a diagnostic.
async function waitForCondition(predicate: () => boolean, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function createUiContext() {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_theme: string, text: string) => text,
			},
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		get widgets() {
			return widgets;
		},
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("async job tracker", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("polls only retained routes and drops them after the last live descendant settles", async () => {
		const root = createTempDir("pi-retained-route-");
		const route = createNestedRoute("returned-root");
		const foreign = createNestedRoute("foreign-root");
		const state = createState();
		const tracker = trackerMod!.createAsyncJobTracker(createEventRecorder().pi, state, root, { pollIntervalMs: 10 });
		const emit = (target: typeof route, id: string, status: string, ts: number) => writeNestedEvent(target, {
			type: "subagent.nested.updated", ts, parentRunId: target.rootRunId,
			child: { id, parentRunId: target.rootRunId, depth: 1, path: [{ runId: target.rootRunId }], state: status, agent: "worker" },
		});
		try {
			emit(route, "retained-child", "running", 1); emit(foreign, "foreign-child", "running", 1);
			state.retainedNestedRoutes.set(route.rootRunId, route);
			tracker.ensurePoller();
			await waitForCondition(() => listStopTargets({ state }, false).some((entry) => entry.id === "retained-child"));
			assert.ok(listStopTargets({ state }, false).some((entry) => entry.id === "retained-child"));
			assert.equal(resolveSubagentRunId("retained-child", { state, asyncDirRoot: root, target: "interrupt" })?.owner.kind, "nested");
			assert.throws(() => resolveSubagentRunId("foreign-child", { state, asyncDirRoot: root, target: "interrupt" }), /No running subagent matches/);
			emit(route, "retained-child", "complete", 2);
			await waitForCondition(() => state.retainedNestedRoutes.size === 0);
			assert.equal(state.retainedNestedRoutes.size, 0);
		} finally {
			tracker.resetJobs(); if (state.poller) clearInterval(state.poller);
			removeTempDir(path.dirname(route.eventSink)); removeTempDir(path.dirname(foreign.eventSink)); removeTempDir(root);
		}
	});
	for (const caller of ["slash", "delegation"]) {
		it(`starts retained child polling after a ${caller} caller returns without a tool result`, async (t) => {
			const root = createTempDir("pi-retained-caller-");
			const mock = createMockPi();
			const originalArgv = [...process.argv];
			const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("PI_SUBAGENT_")));
			const callbacks = new Map<string, Function>();
			const commands = new Map<string, any>();
			const listeners = new Map<string, Set<(data: any) => void>>();
			const events = {
				on(name: string, handler: (data: any) => void) {
					const handlers = listeners.get(name) ?? new Set();
					handlers.add(handler); listeners.set(name, handlers);
					return () => handlers.delete(handler);
				},
				emit(name: string, data: any) { for (const handler of listeners.get(name) ?? []) handler(data); },
			};
			let route: ReturnType<typeof createNestedRoute> | undefined;
			let owner: ChildProcess | undefined;
			let asyncDir: string | undefined;
			try {
				fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
				fs.writeFileSync(path.join(root, ".pi", "agents", "echo.md"), "---\nname: echo\ndescription: test agent\ncompletionGuard: false\n---\nFollow the task.\n");
				mock.install();
				process.argv = [process.execPath, mock.runtime.piEntryPath];
				mock.onCall({ steps: [{ jsonl: [childEvents.messageStart()] },
					{ delay: 500, jsonl: [childEvents.assistantMessage("root done")] }] });
				for (const key of Object.keys(childEnv)) delete process.env[key];
				registerSubagentExtension({
					events, on: (name: string, handler: Function) => callbacks.set(name, handler),
					registerCommand: (name: string, spec: unknown) => commands.set(name, spec),
					registerShortcut() {}, registerMessageRenderer() {}, registerTool() {},
					sendMessage() {}, getSessionName: () => undefined,
				} as never);
				const ctx = makeMinimalCtx(root);
				ctx.sessionManager.getEntries = () => [];
				callbacks.get("session_start")!({}, ctx);
				const requestChannel = caller === "slash" ? "subagent:slash:request" : "prompt-template:subagent:request";
				const responseChannel = caller === "slash" ? "subagent:slash:response" : "prompt-template:subagent:response";
				const completed = new Promise<any>((resolve) => events.on(responseChannel, resolve));
				const task = "return with live descendants";
				events.emit(requestChannel, caller === "slash"
					? { requestId: `retained-${caller}`, params: { agent: "echo", task, agentScope: "project", async: false } }
					: { requestId: `retained-${caller}`, agent: "echo", task, context: "fresh", model: "test-model", cwd: root });
				await waitForCondition(() => mock.callCount() > 0);
				assert.equal(mock.callCount(), 1);
				const callFile = fs.readdirSync(mock.dir).find((file) => file.startsWith("call-"))!;
				const { args } = JSON.parse(fs.readFileSync(path.join(mock.dir, callFile), "utf-8"));
				const sessionFile = args[args.indexOf("--session") + 1];
				const runId = path.basename(path.dirname(path.dirname(sessionFile)));
				route = findNestedRouteForRootId(runId);
				assert.ok(route);
				writeNestedEvent(route, { type: "subagent.nested.updated", ts: 1, parentRunId: runId,
					child: { id: "returned-nested-run", parentRunId: runId, depth: 1, path: [{ runId }], state: "complete", agent: "echo",
						steps: [{ id: "aabbccdd-child", agent: "echo", label: "retained work", status: "running" }] } });
				if (process.platform !== "win32") {
					asyncDir = path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", runId, "returned-background-run");
					fs.mkdirSync(asyncDir, { recursive: true });
					owner = spawn(process.execPath, ["-e", `
						const fs = require("node:fs"), path = require("node:path");
						const dir = process.argv[1];
						process.on("SIGUSR2", () => {
							const requests = fs.readdirSync(dir).filter(name => name.startsWith("interrupt-request-"));
							fs.writeFileSync(path.join(dir, "received-stop.json"), JSON.stringify(requests));
						});
						setInterval(() => {}, 1000);
						process.stdout.write("ready");
					`, asyncDir], { stdio: ["ignore", "pipe", "inherit"] });
					await once(owner.stdout!, "data");
					fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
						runId: "returned-background-run", state: "running", pid: owner.pid, startedAt: Date.now(), lastUpdate: Date.now(),
						steps: [{ id: "fedcba98-child", agent: "echo", label: "background work", status: "running" }],
					}));
					writeNestedEvent(route!, { type: "subagent.nested.updated", ts: 4, parentRunId: runId,
						child: { id: "returned-background-run", parentRunId: runId, depth: 1, path: [{ runId }],
							state: "running", agent: "echo", asyncDir,
							steps: [{ id: "fedcba98-child", agent: "echo", label: "background work", status: "running" }] } });
				}
				const response = await completed;
				assert.notEqual(response.isError, true);
				writeNestedEvent(route, { type: "subagent.nested.child", ts: 2, runId: "returned-nested-run",
					id: "ddeeff00-child", index: 1, agent: "echo", label: "late work", status: "running" });
				const completions = (prefix: string) => commands.get("interrupt-child").getArgumentCompletions(prefix);
				await waitForCondition(() => completions("ddeeff").length > 0);
				assert.equal(completions("ddeeff")[0]?.value, "ddeeff");
				assert.match(completions("ddeeff")[0].label, /late work/);
				await t.test("stops a distinct retained background child after the root returns", {
					skip: process.platform === "win32" ? "requires POSIX background interrupt signals" : undefined,
				}, async () => {
					assert.ok(asyncDir);
					assert.ok(owner);
					const received = path.join(asyncDir, "received-stop.json");
					await waitForCondition(() => completions("fedcba").length > 0);
					assert.equal(completions("fedcba")[0]?.value, "fedcba");
					assert.match(completions("fedcba")[0].label, /background work/);
					const target = resolveSubagentRunId("fedcba", { target: "interrupt", asyncDirRoot: root,
						state: { ...createState(), retainedNestedRoutes: new Map([[runId, route!]]) } as never });
					assert.equal(target?.kind, "child");
					assert.equal(target?.id, "fedcba98-child");
					assert.equal(target?.runId, "returned-background-run");
					assert.equal(target?.owner.kind, "async");
					assert.equal(target?.owner.kind === "async" && target.owner.location.asyncDir, asyncDir);
					const stopped = new Promise<any>((resolve) => events.on("subagent:slash:response", resolve));
					events.emit("subagent:slash:request", { requestId: "retained-stop", params: { action: "interrupt", id: "fedcba" } });
					const stopResponse = await stopped;
					assert.notEqual(stopResponse.isError, true);
					assert.match(stopResponse.result.content[0].text, /Interrupt requested for child fedcba98-child/);
					await waitForCondition(() => fs.existsSync(received));
					assert.deepEqual(JSON.parse(fs.readFileSync(received, "utf8")), ["interrupt-request-fedcba98-child.json"]);
					assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "interrupt-request-fedcba98-child.json"), "utf8")).targetId, "fedcba98-child");
					fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
						runId: "returned-background-run", state: "paused", pid: owner.pid, startedAt: Date.now(), lastUpdate: Date.now(),
						steps: [{ id: "fedcba98-child", agent: "echo", status: "paused" }],
					}));
					writeNestedEvent(route!, { type: "subagent.nested.completed", ts: Date.now(), parentRunId: runId,
						child: { id: "returned-background-run", parentRunId: runId, depth: 1, path: [{ runId }],
							state: "paused", agent: "echo", asyncDir,
							steps: [{ id: "fedcba98-child", agent: "echo", status: "paused" }] } });
					await waitForCondition(() => completions("fedcba").length === 0);
					assert.deepEqual(completions("fedcba"), []);
				});
				for (const [index, [id, label]] of [["aabbccdd-child", "retained work"], ["ddeeff00-child", "late work"]].entries()) {
					writeNestedEvent(route, { type: "subagent.nested.child", ts: 3, runId: "returned-nested-run", id, index, agent: "echo", label, status: "completed" });
				}
				await waitForCondition(() => completions("ddeeff").length === 0 && completions("aabbcc").length === 0);
				assert.deepEqual(completions("ddeeff"), []);
				assert.deepEqual(completions("aabbcc"), []);
			} finally {
				callbacks.get("session_shutdown")?.();
				if (owner && owner.exitCode === null && owner.signalCode === null) {
					const exited = once(owner, "exit");
					owner.kill("SIGKILL");
					await exited;
				}
				if (asyncDir) removeTempDir(asyncDir);
				process.argv = originalArgv;
				Object.assign(process.env, childEnv);
				mock.uninstall();
				if (route) removeTempDir(path.dirname(route.eventSink));
				removeTempDir(root);
			}
		});
	}
	it("removes completed jobs after retention and requests a rerender", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-1", asyncDir: path.join(asyncRoot, "run-1"), agent: "worker" });
			tracker.handleComplete({ id: "run-1", success: true });

			assert.equal(state.asyncJobs.size, 1);
			await waitForCondition(() => state.asyncJobs.size === 0);

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected widget cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("uses flattened async-start agents for initial parallel group widget state", () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot);

			tracker.handleStarted({
				id: "run-parallel-start",
				asyncDir: path.join(asyncRoot, "run-parallel-start"),
				agent: "scout",
				agents: ["scout", "reviewer", "worker", "writer"],
				chain: ["[scout+reviewer+worker]", "writer"],
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			const job = state.asyncJobs.get("run-parallel-start");
			assert.deepEqual(job?.agents, ["scout", "reviewer", "worker"]);
			assert.equal(job?.chainStepCount, 2);
			assert.deepEqual(job?.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.equal(job?.stepsTotal, 3);
			assert.equal(job?.activeParallelGroup, true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("adds flat step indexes to polled active parallel group steps", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-chain");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-chain",
				mode: "chain",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				steps: [
					{ agent: "scout", status: "complete" },
					{
						agent: "reviewer",
						status: "running",
						currentTool: "read",
						currentToolArgs: "src/tui/render.ts",
						recentTools: [{ tool: "grep", args: "async widget", endMs: Date.now() - 100 }],
						recentOutput: ["reviewer line"],
					},
					{ agent: "auditor", status: "running" },
					{ agent: "writer", status: "pending" },
				],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-chain", asyncDir: runDir, mode: "chain", agents: ["scout", "reviewer", "auditor", "writer"] });

			await new Promise((resolve) => setTimeout(resolve, 50));

			const job = state.asyncJobs.get("run-chain");
			assert.deepEqual(job?.steps?.map((step: { index?: number }) => step.index), [1, 2]);
			assert.deepEqual(job?.agents, ["reviewer", "auditor"]);
			assert.equal(job?.steps?.[0]?.currentTool, "read");
			assert.equal(job?.steps?.[0]?.currentToolArgs, "src/tui/render.ts");
			assert.deepEqual(job?.steps?.[0]?.recentTools?.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "grep", args: "async widget" }]);
			assert.deepEqual(job?.steps?.[0]?.recentOutput, ["reviewer line"]);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("rerenders changed polled status but not unchanged bookkeeping", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-unchanged");
			fs.mkdirSync(runDir, { recursive: true });
			const writeStatus = (lastUpdate: number, toolCount?: number) => fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-unchanged",
				mode: "single",
				state: "running",
				startedAt: 1000,
				lastUpdate,
				...(toolCount !== undefined ? { toolCount } : {}),
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			}), "utf-8");
			writeStatus(2000);

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-unchanged", asyncDir: runDir, agent: "worker" });

			const requestsAfterStart = ui.renderRequests;
			await new Promise((resolve) => setTimeout(resolve, 35));
			assert.ok(ui.renderRequests > requestsAfterStart, "first status load should redraw the widget");

			const requestsAfterStatusLoaded = ui.renderRequests;
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-unchanged",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
			assert.equal(ui.renderRequests, requestsAfterStatusLoaded, "unchanged status and control cursors should not request widget redraws");

			writeStatus(3000, 1);
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.ok(ui.renderRequests > requestsAfterStatusLoaded, "changed non-terminal status should redraw the widget");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("schedules cleanup when polling observes a completed status without a completion event", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-2");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-2",
				mode: "single",
				state: "complete",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "complete" }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-2", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.size === 0);

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected polling cleanup to request a rerender");
			assert.equal(ui.widgets.at(-1), undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("repairs stale running jobs during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-stale-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-stale");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-stale",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now() - 1000,
				steps: [{ agent: "worker", status: "running", startedAt: Date.now() - 1000 }],
			}), "utf-8");

			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now(),
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-stale", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.size === 0);

			assert.equal(state.asyncJobs.size, 0);
			assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8")).state, "failed");
			assert.equal(JSON.parse(fs.readFileSync(path.join(resultsDir, "run-stale.json"), "utf-8")).success, false);
			assert.ok(ui.renderRequests > 0, "expected stale repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("reconciles a dead tracked legacy runner and publishes its failure", async () => {
		const asyncRoot = createTempDir("pi-async-job-legacy-");
		assert.ok(typesMod);
		fs.mkdirSync(typesMod.LEGACY_ASYNC_DIR, { recursive: true });
		const runDir = fs.mkdtempSync(path.join(typesMod.LEGACY_ASYNC_DIR, "tracked-legacy-"));
		const id = path.basename(runDir);
		const state = createState();
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const statusPath = path.join(runDir, "status.json");
			const resultPath = path.join(resultsDir, `${id}.json`);
			fs.writeFileSync(statusPath, JSON.stringify({
				runId: id,
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			}), "utf-8");
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1000,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => 2000,
			});
			tracker.handleStarted({ id, asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.get(id)?.status === "failed" && fs.existsSync(resultPath));

			assert.equal(JSON.parse(fs.readFileSync(statusPath, "utf-8")).state, "failed");
			const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(result.success, false);
			assert.equal(result.id, id);
			assert.equal(result.asyncDir, runDir);
			assert.equal(state.asyncJobs.get(id)?.status, "failed");
		} finally {
			tracker?.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(runDir);
			removeTempDir(asyncRoot);
		}
	});

	it("repairs started jobs whose runner dies before writing status", async () => {
		const asyncRoot = createTempDir("pi-async-job-no-status-");
		try {
			const resultsDir = path.join(asyncRoot, "results");
			const runDir = path.join(asyncRoot, "run-no-status");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
				resultsDir,
				kill: pidGone,
				now: () => Date.now() + 2000,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({
				id: "run-no-status",
				asyncDir: runDir,
				pid: 12345,
				sessionId: "session-current",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				chainStepCount: 1,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
			});

			await waitForCondition(() => state.asyncJobs.size === 0);

			assert.equal(state.asyncJobs.size, 0);
			const status = JSON.parse(fs.readFileSync(path.join(runDir, "status.json"), "utf-8"));
			const result = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-no-status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(status.mode, "parallel");
			assert.equal(status.currentStep, 0);
			assert.equal(status.chainStepCount, 1);
			assert.deepEqual(status.parallelGroups, [{ start: 0, count: 3, stepIndex: 0 }]);
			assert.deepEqual(status.steps.map((step: { agent: string; status: string }) => [step.agent, step.status]), [
				["scout", "failed"],
				["reviewer", "failed"],
				["worker", "failed"],
			]);
			assert.equal(result.success, false);
			assert.equal(result.sessionId, "session-current");
			assert.ok(ui.renderRequests > 0, "expected startup-crash repair cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("cleans up jobs when status polling hits a terminal read error", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-");
		try {
			const runDir = path.join(asyncRoot, "run-bad-status");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const ui = createUiContext();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.resetJobs(ui.ctx as never);
			tracker.handleStarted({ id: "run-bad-status", asyncDir: runDir, agent: "worker" });

			await waitForCondition(() => state.asyncJobs.size === 0);

			assert.equal(state.asyncJobs.size, 0);
			assert.ok(ui.renderRequests > 0, "expected malformed status cleanup to request a rerender");
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not clean up a status-read failure while nested descendants are live", async () => {
		const asyncRoot = createTempDir("pi-async-job-bad-status-nested-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-bad-status-nested");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), "{", "utf-8");
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-bad-status-nested", asyncDir: runDir, agent: "worker" });
			const job = state.asyncJobs.get("run-bad-status-nested");
			assert.ok(job);
			job.nestedChildren = [{
				id: "nested-live",
				parentRunId: "run-bad-status-nested",
				depth: 1,
				path: [{ runId: "run-bad-status-nested" }],
				state: "running",
				agent: "nested-worker",
			}];

			await new Promise((resolve) => setTimeout(resolve, 80));

			assert.equal(state.asyncJobs.has("run-bad-status-nested"), true);
			assert.equal(state.asyncJobs.get("run-bad-status-nested")?.status, "failed");
			assert.equal(state.cleanupTimers.has("run-bad-status-nested"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps root jobs running when nested refresh fails during polling", async () => {
		const asyncRoot = createTempDir("pi-async-job-nested-refresh-um");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		const originalError = console.error;
		console.error = () => {};
		try {
			const runDir = path.join(asyncRoot, "run-nested-refresh");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-nested-refresh",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 5,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({
				id: "run-nested-refresh",
				asyncDir: runDir,
				agent: "worker",
				nestedRoute: {
					rootRunId: "run-nested-refresh",
					eventSink: path.join(asyncRoot, "not-contained-events"),
					controlInbox: path.join(asyncRoot, "not-contained-controls"),
					capabilityToken: "bad-token",
				},
			});

			await new Promise((resolve) => setTimeout(resolve, 50));

			assert.equal(state.asyncJobs.get("run-nested-refresh")?.status, "running");
			assert.equal(state.cleanupTimers.has("run-nested-refresh"), false);
		} finally {
			console.error = originalError;
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("cancels cleanup timers when polling observes a non-terminal status", async () => {
		const asyncRoot = createTempDir("pi-async-job-cleanup-cancel-");
		let tracker: ReturnType<AsyncJobTrackerModule["createAsyncJobTracker"]> | undefined;
		try {
			const runDir = path.join(asyncRoot, "run-recovered");
			fs.mkdirSync(runDir, { recursive: true });
			const state = createState();
			const recorder = createEventRecorder();
			tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				completionRetentionMs: 1_000,
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-recovered", asyncDir: runDir, agent: "worker" });
			tracker.handleComplete({ id: "run-recovered", success: true });
			assert.equal(state.cleanupTimers.has("run-recovered"), true);

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-recovered",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const deadline = Date.now() + 200;
			while (Date.now() < deadline && state.cleanupTimers.has("run-recovered")) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			assert.equal(state.cleanupTimers.has("run-recovered"), false);
			assert.equal(state.asyncJobs.get("run-recovered")?.status, "running");
		} finally {
			tracker?.resetJobs();
			removeTempDir(asyncRoot);
		}
	});

	it("keeps incomplete async control event lines for the next poll", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-partial");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-partial",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			const eventPath = path.join(runDir, "events.jsonl");
			const partialRecord = JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-partial",
					agent: "worker",
					message: "worker needs attention",
				},
			});
			fs.writeFileSync(eventPath, partialRecord, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-partial", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.length, 0);

			fs.appendFileSync(eventPath, "\n", "utf-8");
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), true);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("clears transient current tool fields when status clears them", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-clear-tool");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				currentTool: "edit",
				currentToolStartedAt: Date.now() - 100,
				currentPath: "src/runs/background/subagent-runner.ts",
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-clear-tool", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 30));
			let job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, "edit");
			assert.equal(job?.currentPath, "src/runs/background/subagent-runner.ts");

			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-clear-tool",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");

			await new Promise((resolve) => setTimeout(resolve, 30));
			job = state.asyncJobs.get("run-clear-tool");
			assert.equal(job?.currentTool, undefined);
			assert.equal(job?.currentToolStartedAt, undefined);
			assert.equal(job?.currentPath, undefined);
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("bridges async control events from events.jsonl to the parent event bus", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-3");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-3",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["event"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-3",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-3", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 40));

			const controlEvent = recorder.events.find((event) => event.channel === "subagent:control-event");
			assert.ok(controlEvent);
			const noticeText = (controlEvent.data as { noticeText?: string }).noticeText ?? "";
			assert.match(noticeText, /Status: subagent/);
			assert.match(noticeText, /Interrupt: subagent/);
			assert.doesNotMatch(noticeText, new RegExp("Nudge" + ":"));
		} finally {
			removeTempDir(asyncRoot);
		}
	});

	it("does not bridge async control records without the event channel", async () => {
		const asyncRoot = createTempDir("pi-async-job-tracker-");
		try {
			const runDir = path.join(asyncRoot, "run-async-channel");
			fs.mkdirSync(runDir, { recursive: true });
			fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
				runId: "run-async-channel",
				mode: "single",
				state: "running",
				startedAt: Date.now() - 1000,
				lastUpdate: Date.now(),
				steps: [{ agent: "worker", status: "running" }],
			}), "utf-8");
			fs.writeFileSync(path.join(runDir, "events.jsonl"), `${JSON.stringify({
				type: "subagent.control",
				channels: ["async"],
				event: {
					type: "needs_attention",
					to: "needs_attention",
					ts: 123,
					runId: "run-async-channel",
					agent: "worker",
					message: "worker needs attention",
				},
			})}\n`, "utf-8");

			const state = createState();
			const recorder = createEventRecorder();
			const tracker = trackerMod!.createAsyncJobTracker(recorder.pi, state as never, asyncRoot, {
				pollIntervalMs: 10,
			});
			tracker.handleStarted({ id: "run-async-channel", asyncDir: runDir, agent: "worker" });

			await new Promise((resolve) => setTimeout(resolve, 40));

			assert.equal(recorder.events.some((event) => event.channel === "subagent:control-event"), false);
		} finally {
			removeTempDir(asyncRoot);
		}
	});
});
