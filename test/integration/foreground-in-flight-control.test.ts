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
import { startNestedControlInboxListener } from "../../src/extension/fanout-child.ts";
import { resolveSubagentRunId } from "../../src/runs/background/run-id-resolver.ts";
import { createNestedRoute, projectNestedEvents } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_PATH_ENV,
} from "../../src/runs/shared/pi-args.ts";
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
	progress: { activityState?: string; status: string };
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
		it(`interrupt with child id stops only that child (${mode})`, { skip: mode.startsWith("static") && process.platform === "win32" ? "worktree setup hook is a shebang script, which Windows cannot spawn" : undefined }, async () => {
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
				const [targetId, targetChild] = [...control.children.entries()].find(([, child]) => child.index === target);
				const response = await executor.execute("targeted-stop", { action: "interrupt", id: targetId.slice(0, 6) }, undefined, undefined, ctx);
				assert.match(response.content[0].text, /Interrupt requested for child/);
				assert.equal(targetChild.stopRequested, true);
				const repeated = await executor.execute("repeat-stop", { action: "interrupt", id: targetId }, undefined, undefined, ctx);
				assert.notEqual(repeated.isError, true, "duplicate stops while running are idempotent");
				if (mode.includes("mixed")) {
					const whole = await executor.execute("whole-stop", { action: "interrupt", id: runId }, undefined, undefined, ctx);
					assert.notEqual(whole.isError, true);
					assert.equal(control.stopping, true);
					assert.equal([...control.children.values()].find((child) => child.index === offset + 2).stopRequested, undefined);
				}
				const result = await pending;
				assert.equal(controller.signal.aborted, false, "the waiting call must not be cancelled");
				assert.equal(result.details.results.length, single ? 1 : 3 + offset, "later chain steps must not run");
				assert.equal(result.details.results[target].interrupted, true);
				assert.equal(result.details.results[target].exitCode, 0);
				assert.ok([...control.children.values()].every((child) => !child.interrupt));
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

	for (const mode of ["tasks[]", "dynamic parallel"] as const) {
		for (const target of [0, 1, 2]) {
			it(`resolves and stops headless nested ${mode} child ${target} through its registry id`, async () => {
				const route = createNestedRoute(`headless-${path.basename(tempDir)}`);
				const inheritedEnv = {
					[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
					[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
					[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
					[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
					[SUBAGENT_PARENT_RUN_ID_ENV]: route.rootRunId,
					[SUBAGENT_PARENT_CHILD_INDEX_ENV]: "0",
					[SUBAGENT_PARENT_DEPTH_ENV]: "0",
					[SUBAGENT_PARENT_PATH_ENV]: "[]",
				};
				const savedEnv = Object.fromEntries(Object.keys(inheritedEnv).map((key) => [key, process.env[key]]));
				Object.assign(process.env, inheritedEnv);
				const createState = () => ({
					baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(),
					grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
					foregroundControls: new Map(), lastForegroundControlId: null,
				});
				const ownerState = createState();
				const rootState = createState();
				rootState.foregroundControls.set(route.rootRunId, {
					runId: route.rootRunId, mode: "single", startedAt: 1, updatedAt: 1, children: new Map(), nestedRoute: route,
				});
				const createExecutor = (state, childSafe: boolean) => executorModule.createSubagentExecutor({
					captureRuntime: mockPi.captureRuntime,
					pi: { events: createEventBus(), getSessionName: () => undefined }, state,
					resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: tempDir,
					getSubagentSessionRoot: () => tempDir, expandTilde: (value: string) => value,
					discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
					allowMutatingManagementActions: !childSafe,
				});
				const owner = createExecutor(ownerState, true);
				const root = createExecutor(rootState, false);
				const dynamic = mode === "dynamic parallel";
				const offset = dynamic ? 1 : 0;
				if (dynamic) mockPi.onCall({ taskIncludes: "Seed items", output: "Seed", structuredOutput: { items: [0, 1, 2] } });
				for (const index of [0, 1, 2]) mockPi.onCall({ taskIncludes: `Headless child ${index}`, delay: index === target ? 60_000 : 1_500, output: `Headless output ${index}` });
				const params = dynamic ? { chain: [
					{ agent: "echo", task: "Seed items", as: "seed", outputSchema: { type: "object" } },
					{ expand: { from: { output: "seed", path: "/items" }, maxItems: 3 }, parallel: { agent: "echo", task: "Headless child {item}" }, collect: { as: "collected" } },
				] } : { tasks: [0, 1, 2].map((index) => ({ agent: "echo", task: `Headless child ${index}` })) };
				const controller = new AbortController();
				const listener = startNestedControlInboxListener({} as any, ownerState as any);
				const ctx = makeMinimalCtx(tempDir);
				const pending = owner.execute("headless-nested", { ...params, async: false, clarify: false }, controller.signal, undefined, ctx);
				try {
					const deadline = Date.now() + 5_000;
					while (mockPi.callCount() < 3 + offset && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
					assert.equal(mockPi.callCount(), 3 + offset);
					const published = projectNestedEvents(route).children;
					assert.equal(published.length, 1);
					const nested = published[0];
					assert.equal(rootState.foregroundControls.has(nested.id), false, "the caller must not own the nested run locally");
					assert.equal(nested.steps?.length, 3 + offset);
					const children = nested.steps!.slice(offset);
					for (const child of children) {
						assert.equal(child.status, "running");
						const resolved = resolveSubagentRunId(child.id, { state: rootState as any, target: "interrupt", asyncDirRoot: [] });
						assert.equal(resolved?.id, child.id);
						assert.equal(resolved?.kind, "child");
						assert.equal(resolved?.runId, nested.id);
						assert.equal(resolved?.owner.kind, "nested", "resolution must use the published registry, not local controls");
					}
					const targetId = children[target].id;
					const response = await root.execute("headless-stop", { action: "interrupt", id: targetId }, undefined, undefined, ctx);
					assert.notEqual(response.isError, true, response.content[0].text);
					const control = ownerState.foregroundControls.get(nested.id);
					assert.equal(control.children.get(targetId).stopRequested, true);
					for (const child of children.filter((_, index) => index !== target)) assert.equal(control.children.get(child.id).stopRequested, undefined);
					const result = await pending;
					assert.equal(controller.signal.aborted, false);
					assert.deepEqual(result.details.results.map((child) => child.id), nested.steps!.map((step) => step.id));
					assert.equal(result.details.results[offset + target].interrupted, true);
					for (const index of [0, 1, 2].filter((index) => index !== target)) {
						assert.equal(result.details.results[offset + index].finalOutput, `Headless output ${index}`);
						assert.notEqual(result.details.results[offset + index].interrupted, true);
						assert.match(result.content[0].text, new RegExp(`Headless output ${index}`));
					}
					if (dynamic) {
						assert.equal(result.isError, true);
						assert.match(result.content[0].text, /Dynamic step 2 failed/);
					} else {
						assert.notEqual(result.isError, true);
						assert.match(result.content[0].text, /2\/3 succeeded/);
					}
					assert.deepEqual(projectNestedEvents(route).children[0].steps!.slice(offset).map((step) => step.status),
						[0, 1, 2].map((index) => index === target ? "interrupted" : "completed"));
				} finally {
					controller.abort();
					await pending;
					clearInterval(listener);
					for (const [key, value] of Object.entries(savedEnv)) {
						if (value === undefined) delete process.env[key];
						else process.env[key] = value;
					}
					fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
				}
			});
		}
	}

	it("applies a child-id stop accepted before foreground callback registration", async (t) => {
		for (const index of [0, 1, 2]) mockPi.onCall({ taskIncludes: `Registration child ${index}`, output: `Registration output ${index}` });
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
		let stop: ReturnType<typeof executor.execute> | undefined;
		let targetId: string | undefined;
		let callbackCalls = 0;
		let registrations = 0;
		let registeringTarget = false;
		let liveControl;
		const abort = AbortController.prototype.abort;
		t.mock.method(AbortController.prototype, "abort", function (...args) {
			if (registeringTarget) callbackCalls++;
			return abort.apply(this, args);
		});
		t.mock.method(state.foregroundControls, "set", function (runId, control) {
			liveControl = control;
			t.mock.method(control.children, "set", function (id, child) {
				if (child.index === 1) {
					targetId = id;
					let registered: (() => boolean) | undefined;
					Object.defineProperty(child, "interrupt", {
						configurable: true,
						get: () => registered,
						set(callback: () => boolean) {
							registrations++;
							assert.equal(child.state, "running");
							assert.equal(child.interrupt, undefined);
							// Hold the real callback assignment until the public stop request is accepted.
							stop = executor.execute("registration-stop", { action: "interrupt", id }, undefined, undefined, ctx);
							assert.equal(child.stopRequested, true);
							assert.equal(callbackCalls, 0);
							registered = callback;
							registeringTarget = true;
							queueMicrotask(() => { registeringTarget = false; });
						},
					});
				}
				return Map.prototype.set.call(this, id, child);
			});
			return Map.prototype.set.call(this, runId, control);
		});
		const controller = new AbortController();
		const pending = executor.execute("registration-lifecycle", {
			tasks: [0, 1, 2].map((index) => ({ agent: "echo", task: `Registration child ${index}` })), async: false, clarify: false,
		}, controller.signal, undefined, ctx);
		try {
			const result = await pending;
			assert.ok(stop, "the stop must arrive during real foreground callback registration");
			const response = await stop;
			assert.notEqual(response.isError, true, response.content[0].text);
			assert.match(response.content[0].text, /Interrupt requested for child/);
			assert.equal(registrations, 1);
			assert.equal(callbackCalls, 1, "registration applies the accepted stop exactly once");
			assert.equal(controller.signal.aborted, false);
			assert.equal(liveControl.stopping, undefined);
			assert.equal(result.details.results[1].id, targetId);
			assert.equal(result.details.results[1].interrupted, true);
			for (const index of [0, 2]) {
				assert.equal(result.details.results[index].finalOutput, `Registration output ${index}`);
				assert.notEqual(result.details.results[index].interrupted, true);
			}
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /2\/3 succeeded/);
			assert.ok([...liveControl.children.values()].every((child) => !child.interrupt));
		} finally { controller.abort(); await pending; }
	});

	for (const scenario of [
		{ name: "run id stops three live children", stop: "run", count: 3, concurrency: 3 },
		{ name: "bare interrupt stops three live children", stop: "bare", count: 3, concurrency: 3 },
		{ name: "three child ids keep the per-child result path", stop: "children", count: 3, concurrency: 3 },
		{ name: "run id refuses queued launches", stop: "run", count: 5, concurrency: 2 },
		{ name: "parent abort refuses queued launches", stop: "abort", count: 5, concurrency: 2 },
		{ name: "child id lets queued siblings launch", stop: "child", count: 5, concurrency: 2 },
	]) {
		it(scenario.name, async () => {
			const tasks = Array.from({ length: scenario.count }, (_, index) => ({ agent: "echo", task: `Queue child ${index}` }));
			for (const [index, task] of tasks.entries()) mockPi.onCall({ taskIncludes: task.task, steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: scenario.stop === "child" && index > 0 ? 1_000 : 60_000, jsonl: [events.assistantMessage(`Completed queue child ${index}`)] },
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
			const controller = new AbortController();
			const ctx = makeMinimalCtx(tempDir);
			const pending = executor.execute("queue-lifecycle", { tasks, concurrency: scenario.concurrency, async: false, clarify: false }, controller.signal, undefined, ctx);
			try {
				const deadline = Date.now() + 5_000;
				while (mockPi.callCount() < scenario.concurrency && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
				assert.equal(mockPi.callCount(), scenario.concurrency);
				const [runId, control] = [...state.foregroundControls.entries()][0];
				const children = [...control.children.entries()];
				assert.equal(children.filter(([, child]) => child.state === "running").length, scenario.concurrency);
				assert.equal(children.filter(([, child]) => child.state === "pending").length, scenario.count - scenario.concurrency);
				if (scenario.stop === "abort") controller.abort();
				else {
					const targets = scenario.stop === "children" ? children.map(([id]) => id)
						: [scenario.stop === "child" ? children[0][0] : scenario.stop === "run" ? runId : undefined];
					for (const id of targets) {
						const response = await executor.execute("queue-stop", { action: "interrupt", ...(id ? { id } : {}) }, undefined, undefined, ctx);
						assert.notEqual(response.isError, true, response.content[0].text);
					}
				}
				const result = await pending;
				assert.notEqual(result.isError, true);
				assert.equal(controller.signal.aborted, scenario.stop === "abort");
				assert.equal(result.details.results.length, scenario.count);
				assert.equal(mockPi.callCount(), scenario.stop === "child" ? scenario.count : scenario.concurrency, "only admitted children spawn");
				assert.ok([...control.children.values()].every((child) => !child.interrupt));
				if (scenario.stop === "child") {
					assert.equal(control.stopping, undefined);
					assert.equal(result.details.results[0].interrupted, true);
					for (const index of [1, 2, 3, 4]) assert.equal(result.details.results[index].finalOutput, `Completed queue child ${index}`);
					assert.match(result.content[0].text, /4\/5 succeeded/);
				} else {
					assert.ok(result.details.results.every((child) => child.interrupted === true));
					assert.ok([...control.children.values()].every((child) => child.state === "interrupted"));
					if (scenario.stop === "children") {
						assert.equal(control.stopping, undefined);
						assert.match(result.content[0].text, /0\/3 succeeded/);
						assert.equal((result.content[0].text.match(/INTERRUPTED/g) ?? []).length, 3);
						assert.doesNotMatch(result.content[0].text, /paused after interrupt/);
					} else {
						assert.equal(control.stopping, true);
						assert.match(result.content[0].text, /paused after interrupt|Waiting for explicit next action/);
					}
				}
			} finally { controller.abort(); await pending; }
		});
	}

	it("whole-run interrupt after the last-started child settles still stops its older sibling", async (t) => {
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
			while ((mockPi.callCount() < 2 || [...state.foregroundControls.values()][0]?.children && [...[...state.foregroundControls.values()][0].children.values()].some((child) => child.index === 1 && child.state === "running")) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const [id, control] = [...state.foregroundControls.entries()][0];
			assert.ok([...control.children.values()].some((child) => child.index === 0 && child.state === "running"));
			state.asyncJobs.set("other-async", { asyncId: "other-async", asyncDir: tempDir, status: "running" });
			fs.writeFileSync(path.join(tempDir, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [{ status: "running" }] }));
			const kill = t.mock.method(process, "kill", () => true);
			const response = await executor.execute("fallback-stop", { action: "interrupt", id }, undefined, undefined, ctx);
			assert.equal(response.content[0].text, `Interrupt requested for foreground run ${id}.`);
			assert.equal(kill.mock.callCount(), 0);
			const result = await pending;
			assert.equal(result.details.results[0].interrupted, true);
			assert.equal(result.details.results[1].finalOutput, "Completed child 1");
			assert.equal(control.stopping, true);
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
			assert.equal(response.content[0].text, "interrupt no longer takes an index; pass the id at the start of the child's row.");
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

	for (const kind of ["abort", "interrupt"] as const) {
		it(`forces native ${kind} teardown when the child ignores graceful signals`, { skip: process.platform === "win32" }, async () => {
			const stubborn = createMockPi();
			stubborn.install();
			const pidFile = path.join(tempDir, `${kind}.pid`);
			fs.writeFileSync(stubborn.runtime.piEntryPath, `import fs from 'node:fs';
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
console.log(JSON.stringify({ type: 'tool_execution_start', toolCallId: 'hang', toolName: 'bash', args: {} }));
setInterval(() => {}, 1000);
`);
			const { createNestedRoute } = await import("../../src/runs/shared/nested-events.ts");
			const { stoppingAncestor } = await import("../../src/runs/shared/stop-control.ts");
			const route = createNestedRoute(`${kind}-root`);
			const controller = new AbortController();
			const startedAt = Date.now();
			let deadline: NodeJS.Timeout | undefined;
			try {
				const result = await Promise.race([execution!.runSync(tempDir, makeAgentConfigs(["scout"]), "scout", "hang", {
					runtime: stubborn.runtime, runId: route.rootRunId, id: `${kind}-child`, nestedRoute: route,
					[kind === "abort" ? "signal" : "interruptSignal"]: controller.signal,
					onUpdate: (update: { details?: { progress?: Array<{ toolCount?: number }> } }) => { if (update.details?.progress?.[0]?.toolCount) controller.abort(); },
				}), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("teardown deadline exceeded")), 5_000); })]);
				assert.ok(Date.now() - startedAt < 5_000, "forced teardown must finish within five seconds");
				assert.equal(stoppingAncestor(route, route.rootRunId, `${kind}-child`), `${kind}-child`, result.error);
				if (kind === "interrupt") assert.equal(result.interrupted, true);
				const pid = Number(fs.readFileSync(pidFile, "utf8"));
				assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
			} finally {
				clearTimeout(deadline);
				if (fs.existsSync(pidFile)) { try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {} }
				stubborn.uninstall();
				fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
			}
		});
	}

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
