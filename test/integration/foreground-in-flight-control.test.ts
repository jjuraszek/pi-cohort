/**
 * Integration tests: in-flight turn awareness in the foreground control watchdog.
 *
 * Verifies that a silent gap INSIDE an open turn (after message_start, before
 * message_end) is capped by inFlightSilenceCeilingMs rather than by
 * needsAttentionAfterMs.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	makeAgentConfigs,
	events,
	tryImport,
} from "../support/helpers.ts";

interface RunSyncResult {
	exitCode: number;
	error?: string;
	controlEvents?: Array<{ type?: string; message: string; reason?: string }>;
	progress: { activityState?: string; status: string; error?: string };
	modelAttempts?: Array<{ success: boolean }>;
	interrupted?: boolean;
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

const executorModule = await import("../../src/runs/foreground/subagent-executor.ts");
const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const available = !!execution;
const runSync = execution?.runSync;

describe("foreground in-flight turn control", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const runSync = (cwd, agents, agent, task, options) => execution!.runSync(cwd, agents, agent, task, { ...options, runtime: mockPi.runtime });

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	for (const mode of ["parallel", "parallel mixed", "static", "static stopOn", "static stopOn matched", "dynamic", "failFast", "mixed", "single", "sequential"]) {
		it(`interrupt with index stops only that parallel child (${mode})`, { skip: mode.startsWith("static") && process.platform === "win32" ? "worktree setup hook is a shebang script, which Windows cannot spawn" : undefined }, async () => {
			const dynamic = mode === "dynamic";
			const single = mode === "single" || mode === "sequential";
			const worktree = mode.startsWith("static");
			const offset = dynamic ? 1 : 0;
			const target = single ? 0 : offset + 1;
			let cwd = tempDir;
			let hook: string | undefined;
			if (worktree) {
				cwd = path.join(tempDir, "repo");
				fs.mkdirSync(cwd);
				const git = (...args: string[]) => execFileSync("git", args, { cwd, timeout: 5_000, stdio: "pipe" });
				git("init");
				git("config", "user.name", "Tests");
				git("config", "user.email", "tests@example.com");
				fs.writeFileSync(path.join(cwd, "changed.txt"), "before\n");
				git("add", ".");
				git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
				hook = path.join(tempDir, "setup.cjs");
				fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync('changed.txt', 'partial patch\\n'); console.log('{}');\n`);
				fs.chmodSync(hook, 0o755);
			}
			if (dynamic) mockPi.onCall({ taskIncludes: "Seed items", output: "Seed", structuredOutput: { items: [0, 1, 2] } });
			for (const index of single ? [0] : [0, 1, 2]) {
				mockPi.onCall({
					taskIncludes: `Child task ${index}`,
					steps: [
						{ jsonl: [events.messageStart()] },
						{ delay: single || index === 1 ? 60_000 : 1_500, jsonl: [events.assistantMessage(`Completed child ${index}`)] },
					],
					structuredOutput: mode.includes("stopOn") ? { verdict: "PASS" } : undefined,
				});
			}
			const state = {
				baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(),
				grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
				foregroundControls: new Map(), lastForegroundControlId: null,
			};
			const executor = executorModule.createSubagentExecutor({
				captureRuntime: mockPi.captureRuntime,
				pi: { events: createEventBus(), getSessionName: () => undefined }, state,
				resolveConfig: () => ({ control: { enabled: false }, worktreeSetupHook: hook }),
				tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
			});
			const tasks = [0, 1, 2].map((index) => ({ agent: "echo", task: `Child task ${index}`, as: `child_${index}`,
				...(mode.includes("stopOn") ? { outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] } } : {}),
			}));
			const chain = dynamic ? [
				{ agent: "echo", task: "Seed items", as: "seed", outputSchema: { type: "object" } },
				{ expand: { from: { output: "seed", path: "/items" }, maxItems: 3 }, parallel: { agent: "echo", task: "Child task {item}" }, collect: { as: "collected" } },
			] : single ? [tasks[0]] : [{ parallel: tasks, worktree, failFast: mode === "failFast", concurrency: mode === "failFast" ? 2 : 3,
				...(mode.includes("stopOn") ? { stopOn: { path: "/verdict", in: [mode.endsWith("matched") ? "PASS" : "FAIL"] } } : {}),
			}];
			const controller = new AbortController();
			const ctx = makeMinimalCtx(cwd);
			const pending = executor.execute(`targeted-${mode}`, {
				...(mode.startsWith("parallel") ? { tasks } : mode === "single" ? tasks[0] : { chain: [...chain, { agent: "echo", task: "Must not run" }] }),
				async: false,
			}, controller.signal, () => {}, ctx);
			try {
				const initialCount = single ? 1 : mode === "failFast" ? 2 : 3 + offset;
				const deadline = Date.now() + 5_000;
				while (mockPi.callCount() < initialCount && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(mockPi.callCount(), initialCount);
				const [runId, control] = [...state.foregroundControls.entries()][0];
				const response = await executor.execute("targeted-stop", { action: "interrupt", id: runId, index: target }, undefined, undefined, ctx);
				assert.match(response.content[0].text, new RegExp(`Interrupt requested for child ${target} of foreground run`));
				assert.equal(control.childInterrupts.has(target), false);
				if (!single) for (const index of mode === "failFast" ? [offset] : [offset, offset + 2]) assert.equal(control.childInterrupts.has(index), true);
				const repeated = await executor.execute("repeat-stop", { action: "interrupt", id: runId, index: target }, undefined, undefined, ctx);
				assert.equal(repeated.isError, true);
				assert.equal(control.stoppedByIndex.has(target), true);
				if (mode.includes("mixed")) {
					const whole = await executor.execute("whole-stop", { action: "interrupt", id: runId }, undefined, undefined, ctx);
					assert.notEqual(whole.isError, true);
					const alreadyAborted = await executor.execute("already-aborted", { action: "interrupt", id: runId, index: offset + 2 }, undefined, undefined, ctx);
					assert.equal(alreadyAborted.isError, true);
					assert.equal(control.stoppedByIndex.has(offset + 2), false);
				}
				const result = await pending;
				assert.equal(controller.signal.aborted, false, "the waiting call must not be cancelled");
				assert.equal(result.details.results.length, single ? 1 : 3 + offset, "later chain steps must not run");
				assert.equal(result.details.results[target].interrupted, true);
				assert.equal(result.details.results[target].exitCode, 0);
				assert.equal(control.childInterrupts.size, 0);
				assert.equal(control.lastAssigned, undefined);
				if (single || mode.includes("mixed")) {
					assert.match(result.content[0].text, /paused after interrupt|Interrupted\. Waiting/);
					assert.notEqual(result.isError, true);
					return;
				}
				for (const index of [0, 2]) {
					const child = result.details.results[offset + index];
					assert.notEqual(child.interrupted, true);
					assert.equal(child.exitCode, 0);
					assert.equal(child.finalOutput, `Completed child ${index}`);
					assert.match(result.content[0].text, new RegExp(`Completed child ${index}`));
				}
				if (mode === "parallel") {
					assert.match(result.content[0].text, /2\/3 succeeded/);
					assert.match(result.content[0].text, /=== Task 2: echo ===\nINTERRUPTED/);
					assert.notEqual(result.isError, true);
				} else {
					assert.equal(result.isError, true);
					assert.match(result.content[0].text, /## Outputs/);
					assert.match(result.content[0].text, /#### Task 2 \(echo(?:, as child_1)?\) - interrupted/);
					if (mode.endsWith("matched")) {
						assert.equal(result.details.stop.matches.length, 2);
						assert.match(result.content[0].text, /## Stop/);
					} else assert.equal(result.details.stop, undefined);
					if (dynamic) {
						assert.match(result.content[0].text, /Dynamic step 2 failed:\n- Item 2 \(echo, key 1\): interrupted/);
						assert.equal(result.details.outputs.collected.structured.length, 3);
						assert.equal(result.details.workflowGraph.nodes[1].status, "failed");
					} else {
						assert.match(result.content[0].text, /Parallel step 1 failed:\n- Task 2 \(echo\): interrupted/);
						assert.equal(result.details.outputs.child_1, undefined);
						if (worktree) {
							for (const index of [0, 2]) {
								const patch = result.details.outputs[`child_${index}`].patchPath;
								assert.ok(result.content[0].text.includes(`Full patches: ${path.dirname(patch)}`));
								assert.match(fs.readFileSync(patch, "utf8"), /partial patch/);
							}
							const stoppedPatch = path.join(path.dirname(result.details.outputs.child_0.patchPath), "task-1-echo.patch");
							assert.match(fs.readFileSync(stoppedPatch, "utf8"), /partial patch/);
						}
					}
				}
			} finally {
				controller.abort();
				await pending;
			}
		});
	}

	for (const mode of ["top-level", "chain"] as const) {
		it(`siblings of a capped parallel child finish (${mode})`, async () => {
			const cap = 1_500;
			for (const index of [0, 1, 2, 3]) {
				mockPi.onCall({
					taskIncludes: `Capped parallel task ${index}`,
					steps: [
						{ jsonl: [events.messageStart()] },
						{ delay: index === 0 ? 6_000 : 1_000, jsonl: [events.assistantMessage(`Completed sibling ${index}`)] },
					],
				});
			}
			const state = {
				baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(),
				grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
				foregroundControls: new Map(), lastForegroundControlId: null,
			};
			const executor = executorModule.createSubagentExecutor({
				captureRuntime: mockPi.captureRuntime,
				pi: { events: createEventBus(), getSessionName: () => undefined }, state,
				resolveConfig: () => ({ control: { enabled: false } }),
				tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
			});
			const tasks = [0, 1, 2, 3].map((index) => ({ agent: "echo", task: `Capped parallel task ${index}` }));
			const controller = new AbortController();
			const result = await executor.execute(`capped-${mode}`, {
				...(mode === "top-level" ? { tasks, concurrency: 2 } : { chain: [{ parallel: tasks, concurrency: 2 }] }),
				async: false, clarify: false, control: { maxRuntimeMs: cap },
			}, controller.signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(controller.signal.aborted, false, "a child cap must not abort the caller");
			assert.equal(mockPi.callCount(), 4, "queued siblings must still start after the cap");
			assert.equal(result.details.results.length, 4);
			const [capped, ...siblings] = result.details.results;
			assert.notEqual(capped.exitCode, 0);
			assert.match(capped.error, /maxRuntimeMs=1500ms/);
			assert.equal(capped.interrupted, undefined);
			for (const [index, sibling] of siblings.entries()) {
				assert.equal(sibling.exitCode, 0);
				assert.equal(sibling.error, undefined);
				assert.equal(sibling.interrupted, undefined);
				assert.equal(sibling.finalOutput, `Completed sibling ${index + 1}`);
			}
		});
	}

	it("whole-run interrupt after the last-started child settles falls through to async without stopping an older sibling", async (t) => {
		for (const index of [0, 1]) mockPi.onCall({ taskIncludes: `Child task ${index}`, steps: [
			{ jsonl: [events.messageStart()] },
			{ delay: index === 0 ? 1_500 : 100, jsonl: [events.assistantMessage(`Completed child ${index}`)] },
		] });
		const state = {
			baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
			foregroundControls: new Map(), lastForegroundControlId: null,
		};
		const executor = executorModule.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir, expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
		});
		const ctx = makeMinimalCtx(tempDir);
		const controller = new AbortController();
		const pending = executor.execute("last-settled", { async: false, clarify: false,
			tasks: [0, 1].map((index) => ({ agent: "echo", task: `Child task ${index}` })),
		}, controller.signal, undefined, ctx);
		try {
			const deadline = Date.now() + 5_000;
			while ((mockPi.callCount() < 2 || [...state.foregroundControls.values()][0]?.childInterrupts.has(1)) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const [id, control] = [...state.foregroundControls.entries()][0];
			assert.equal(control.lastAssigned, undefined);
			assert.equal(control.childInterrupts.has(0), true);
			state.asyncJobs.set("other-async", { asyncId: "other-async", asyncDir: tempDir, status: "running" });
			fs.writeFileSync(path.join(tempDir, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [{ status: "running" }] }));
			const kill = t.mock.method(process, "kill", () => true);
			const response = await executor.execute("fallback-stop", { action: "interrupt", id }, undefined, undefined, ctx);
			assert.equal(response.content[0].text, "Interrupt requested for async run other-async.");
			assert.equal(kill.mock.callCount(), 1);
			assert.equal(kill.mock.calls[0].arguments[0], process.pid);
			assert.equal(fs.existsSync(path.join(tempDir, "interrupt-request-all.json")), true);
			const result = await pending;
			for (const [index, child] of result.details.results.entries()) {
				assert.notEqual(child.interrupted, true);
				assert.equal(child.finalOutput, `Completed child ${index}`);
			}
		} finally {
			t.mock.restoreAll();
			controller.abort();
			await pending;
		}
	});

	it("interrupt with an index naming no running child errors", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 2_000, jsonl: [events.assistantMessage("Sibling completed")] },
			],
		});
		const state = {
			baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
			foregroundControls: new Map(), lastForegroundControlId: null,
		};
		const executor = executorModule.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			resolveConfig: () => ({ control: { enabled: false } }),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const controller = new AbortController();
		const ctx = makeMinimalCtx(tempDir);
		const pending = executor.execute("invalid-child-index", {
			tasks: [0, 1, 2].map((index) => ({ agent: "echo", task: `Task ${index}` })),
			async: false,
		}, controller.signal, undefined, ctx);
		try {
			const deadline = Date.now() + 5_000;
			while (mockPi.callCount() < 3 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(mockPi.callCount(), 3, "all three children must start before the request");
			const [runId] = state.foregroundControls.keys();
			assert.ok(runId, "the foreground run must still be in flight");
			const response = await executor.execute("invalid-stop", {
				action: "interrupt", id: runId, index: 3,
			}, undefined, undefined, ctx);
			const result = await pending;
			assert.equal(response.isError, true, "index 3 names no running child and must return an error");
			assert.match(response.content[0].text, /no running child at index 3/);
			assert.equal(result.details.results.length, 3);
			for (const child of result.details.results) {
				assert.equal(child.exitCode, 0);
				assert.notEqual(child.interrupted, true, "an invalid index must stop no child");
				assert.equal(child.finalOutput, "Sibling completed");
			}
		} finally {
			controller.abort();
			await pending;
		}
	});

	it("treats a silent in-flight turn under the ceiling as active_long_running, not needs_attention", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 1_300, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-inflight",
			// 1s: message_start from a real child must land before the attention timer under full-suite load
			controlConfig: { enabled: true, needsAttentionAfterMs: 1_000, inFlightSilenceCeilingMs: 100_000, activeNoticeAfterMs: 100_000, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.equal(result.exitCode, 0);
		assert.ok(!controlEvents.some((e) => e.type === "needs_attention"), "must not flag needs_attention mid-turn");
	});

	it("escalates a silent in-flight turn past the ceiling to needs_attention", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 1_300, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-ceiling",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, inFlightSilenceCeilingMs: 500, activeNoticeAfterMs: 100_000, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.equal(result.exitCode, 0);
		assert.ok(controlEvents.some((e) => e.type === "needs_attention"), "must escalate once silence exceeds the ceiling");
	});

	it("SIGTERMs an in-flight turn that stays silent past inFlightSilenceKillMs", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 5_000, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-killcap",
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				inFlightSilenceCeilingMs: 300,
				inFlightSilenceKillMs: 600,
				activeNoticeAfterMs: 100_000,
				notifyOn: ["active_long_running", "needs_attention"],
			},
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.notEqual(result.exitCode, 0, "killed run must settle non-zero");
		assert.ok(controlEvents.some((e) => e.type === "needs_attention"), "needs_attention must be emitted before the kill");
		assert.notEqual(result.progress.status, "interrupted");
		assert.ok(result.error?.includes("inFlightSilenceKillMs"), "error must name the cap");
	});

	for (const scenario of ["active", "short", "ignores SIGTERM"] as const) {
		it(`maxRuntimeMs caps ${scenario} children with control disabled`, {
			skip: scenario === "ignores SIGTERM" && process.platform === "win32",
		}, async () => {
			const cap = 800;
			mockPi.onCall({
				ignoreSigterm: scenario === "ignores SIGTERM",
				steps: [
					{ jsonl: [events.messageStart()] },
					...Array.from({ length: scenario === "short" ? 1 : scenario === "active" ? 25 : 60 }, () => ({
						delay: 100, jsonl: [events.toolStart("read"), events.toolEnd("read")],
					})),
					{ jsonl: [events.assistantMessage("done")] },
				],
			});
			let activityUpdates = 0;
			const start = performance.now();
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Stream", {
				runId: `runtime-${scenario}`,
				controlConfig: { enabled: false, maxRuntimeMs: cap },
				onUpdate: (update) => {
					if (update.details.progress[0].toolCount > 0) activityUpdates++;
				},
			});
			const elapsed = performance.now() - start;
			assert.ok(activityUpdates > 0, "real child must emit tool activity before the deadline");
			assert.equal(result.modelAttempts?.length, 1);
			if (scenario === "short") {
				assert.equal(result.exitCode, 0);
				assert.equal(result.error, undefined);
			} else {
				assert.notEqual(result.exitCode, 0);
				assert.ok(elapsed >= cap, "must not kill before the cap");
				assert.ok(elapsed < (scenario === "active" ? 2_500 : 5_500), `settled after ${elapsed}ms`);
				assert.match(result.error!, /maxRuntimeMs=800ms/);
				assert.equal(result.interrupted, undefined);
				assert.equal(result.progress.status, "failed");
				assert.equal(result.progress.error, result.error);
				assert.equal(result.modelAttempts![0].success, false);
			}
		});
	}

	it("does not kill a turn that keeps emitting events past the kill cap", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync!(tempDir, agents, "echo", "Stream", {
			runId: "run-streaming",
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				inFlightSilenceCeilingMs: 400,
				inFlightSilenceKillMs: 1_200,
				activeNoticeAfterMs: 100_000,
				notifyOn: ["active_long_running", "needs_attention"],
			},
		});
		assert.equal(result.exitCode, 0, "a streaming child must run to completion");
	});
});
