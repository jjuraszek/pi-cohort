import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { resolveSubagentRunId, listStopTargets } from "../../src/runs/background/run-id-resolver.ts";
import { stopForegroundTarget, registerForegroundInterrupt, stoppingAncestor, recordStop, sweepBackgroundDescendants } from "../../src/runs/shared/stop-control.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import registerFanoutChildSubagentExtension, { startNestedControlInboxListener } from "../../src/extension/fanout-child.ts";
import { createMockPi } from "../support/mock-pi.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, nestedResultsPath, projectNestedEvents, readNestedControlRequests, readNestedControlResults, writeNestedControlRequest, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import { RUN_STATE_ROOT_DIR, TEMP_ROOT_DIR, ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";

const routeRoots: string[] = [];
const savedEnv = {
	MOCK_PI_QUEUE_DIR: process.env.MOCK_PI_QUEUE_DIR,
	[SUBAGENT_CHILD_ENV]: process.env[SUBAGENT_CHILD_ENV],
	[SUBAGENT_FANOUT_CHILD_ENV]: process.env[SUBAGENT_FANOUT_CHILD_ENV],
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
};

afterEach(() => {
	// Detached runners keep writing events/log/result after status.json turns terminal.
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const mockPi = createMockPi();

function createState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		safetyRescanTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function createExecutor(state = createState(), agents: Array<Record<string, unknown>> = [], allowMutatingManagementActions = true, events: any = { emit() {}, on() { return () => {}; } }, captureRuntime?: () => any) {
	return createSubagentExecutor({
		captureRuntime: captureRuntime ?? mockPi.captureRuntime,
		pi: { events, getSessionName() { return "parent"; } } as any,
		state,
		resolveConfig: () => ({ maxSubagentDepth: 2, control: {} } as any),
		tempArtifactsDir: os.tmpdir(),
		getSubagentSessionRoot: (parentSessionFile) => parentSessionFile ? path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl")) : os.tmpdir(),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: agents as any }),
		allowMutatingManagementActions,
	});
}

it("uses the selected foreground file's immediate parent when no root was stamped", async () => {
	const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "foreground-origin-")));
	try {
		const sessionFile = path.join(root, "selected.jsonl");
		fs.writeFileSync(sessionFile, "history\n");
		const state = createState();
		state.foregroundRuns!.set("foreground-legacy", { runId: "foreground-legacy", runtime: mockPi.runtime, mode: "single", cwd: root, updatedAt: 1, children: [{ agent: "worker", index: 0, status: "complete", sessionFile }] } as any);
		const result = await createExecutor(state, [{ name: "worker" }]).execute("resume", { action: "resume", id: "foreground-legacy", message: "continue" }, new AbortController().signal, undefined, {
			...ctx(root), modelRegistry: { getAvailable() { throw new Error("reached validated foreground origin"); } },
		});
		assert.match(text(result), /reached validated foreground origin/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("reports the selected root when async jiti is unavailable", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "selected-no-jiti-"));
	routeRoots.push(root);
	const runtime = { ...mockPi.runtime, piPackageRoot: root };
	const executor = createExecutor(createState(), [{ name: "worker", source: "user", systemPrompt: "help" }], true, undefined, () => runtime);
	const result = await executor.execute("launch", { agent: "worker", task: "go", async: true }, new AbortController().signal, undefined, {
		cwd: root, hasUI: false, isProjectTrusted: () => true, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent", getSessionName: () => undefined },
	} as any);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /Cannot resolve jiti from selected Pi installation/);
	assert.ok(result.content[0].text.includes(root));
});

it("retains one capture failure while management stays available", async () => {
	let captures = 0;
	const executor = createExecutor(createState(), [{ name: "worker" }], true, undefined, () => {
		captures++;
		throw new Error("selected parent runtime unavailable");
	});
	for (const action of ["doctor", "status"] as const) {
		const result = await executor.execute("inspect", { action }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		if (action === "doctor") assert.match(String(result.content[0].text), /selected parent runtime unavailable/);
	}
	for (let index = 0; index < 2; index++) {
		const result = await executor.execute("launch", { agent: "worker", task: "test" }, new AbortController().signal, undefined, ctx(os.tmpdir()));
		assert.equal(result.isError, true);
		assert.match(String(result.content[0].text), /selected parent runtime unavailable/);
	}
	assert.equal(captures, 1);
});

function ctx(root: string, sessionFile: string | null = null) {
	return {
		cwd: root,
		hasUI: false,
		isProjectTrusted() { return true; },
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return sessionFile; }, getSessionName() { return undefined; } },
		modelRegistry: { getAvailable() { return []; } },
	} as any;
}

function createNestedRun(id = "nested-live", state: "running" | "complete" | "failed" | "paused" = "running", extras: Record<string, unknown> = {}) {
	const route = createNestedRoute("root-control");
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: state === "running" ? "subagent.nested.updated" : "subagent.nested.completed",
		ts: 100,
		parentRunId: "root-control",
		parentStepIndex: 0,
		child: { id, parentRunId: "root-control", parentStepIndex: 0, depth: 1, path: [{ runId: "root-control", stepIndex: 0 }], state, agent: "worker", ownerState: state === "running" ? "live" : "gone", capabilityToken: route.capabilityToken, ...extras },
	});
	return route;
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = createState();
	state.foregroundControls.set(route.rootRunId, {
		runId: route.rootRunId,
		mode: "single",
		startedAt: 1,
		updatedAt: 1,
		nestedRoute: route,
	});
	state.lastForegroundControlId = route.rootRunId;
	return state;
}

function setNestedRouteEnv(route: ReturnType<typeof createNestedRoute>, parentRunId = route.rootRunId) {
	process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
	process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
	process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
	process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
	process.env[SUBAGENT_PARENT_RUN_ID_ENV] = parentRunId;
	process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "0";
}

function text(result: Awaited<ReturnType<ReturnType<typeof createExecutor>["execute"]>>): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.equal(predicate(), true);
}

describe("stop target ownership", () => {
	it("resolves distinct child and run ids without duplicating live foreground owners", async () => {
		const route = createNestedRun("run-abcd", "running", { steps: [
			{ id: "aaaaaa-first", index: 0, agent: "stale", status: "running" },
		] });
		const state = stateWithNestedRoute(route);
		let stops = 0;
		state.foregroundControls.set("run-abcd", {
			runId: "run-abcd", mode: "parallel", children: new Map([
				["aaaaaa-first", { agent: "live", index: 0, state: "running" }],
				["aaaaaa-second", { agent: "waiting", index: 1, state: "pending" }],
			]), interrupt: () => { stops++; return true; },
		} as any);
		const deps = { state, target: "interrupt" as const, asyncDirRoot: [] };
		const exact = resolveSubagentRunId("aaaaaa-first", deps)!;
		assert.equal(exact.kind, "child");
		assert.equal(exact.owner.kind, "foreground");
		assert.equal(exact.name, "live");
		assert.equal(resolveSubagentRunId("run-", deps)?.kind, "run");
		assert.throws(() => resolveSubagentRunId("aaaaaa", deps), /child:aaaaaa-f live.*child:aaaaaa-s waiting/);
		assert.throws(() => resolveSubagentRunId("aaa", deps), /too short/);
		const executor = createExecutor(state);
		const pending = await executor.execute("stop", { action: "interrupt", id: "aaaaaa-second" }, undefined, undefined, ctx(os.tmpdir()));
		assert.equal(text(pending), "Subagent aaaaaa (waiting) has not started; stop its run to keep it from starting.");
		assert.equal(stops, 0);
		state.foregroundControls.delete("run-abcd");
		state.foregroundRuns.set("history-run", { runId: "history-run", mode: "parallel", cwd: os.tmpdir(), updatedAt: 1, children: [
			{ id: "aaaaaa-history", agent: "history", index: 0, status: "interrupted" },
		] });
		assert.equal(resolveSubagentRunId("aaaaaa", deps)?.id, "aaaaaa-first", "resume history must not introduce stop-prefix collisions");
		for (const id of ["history-run", "aaaaaa-history"]) {
			assert.throws(() => resolveSubagentRunId(id, deps), /No running subagent matches/);
		}
		assert.equal(listStopTargets(deps).some((entry) => entry.id === "aaaaaa-history"), false);
		const unknown = await executor.execute("stop", { action: "interrupt", id: "aaaaaa-history" }, undefined, undefined, ctx(os.tmpdir()));
		assert.match(text(unknown), /No running subagent matches 'aaaaaa-history'/);
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 200, runId: "run-abcd", id: "aaaaaa-first", index: 0, agent: "worker", status: "interrupted" });
		const settled = await executor.execute("stop", { action: "interrupt", id: "aaaaaa-first" }, undefined, undefined, ctx(os.tmpdir()));
		assert.equal(text(settled), "Subagent aaaaaa (worker) is no longer running: interrupted.");
		assert.equal(stops, 0);
	});

	for (const { id, owner, probes } of [
		{ id: "root-control", owner: "foreground", probes: [] },
		{ id: "nested-selected", owner: "nested", probes: [] },
		{ id: "background-other", owner: "async", probes: [[123456, 0]] },
		{ id: "other-child", owner: "async", probes: [[123456, 0]] },
		{ id: "nested-background", owner: "async", probes: [[654321, 0]] },
		{ id: "descendant-child", owner: "async", probes: [[654321, 0]] },
	]) {
		it(`resolves stop ${id} without probing unrelated background owners`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-owner-probes-"));
			routeRoots.push(root);
			const asyncDir = path.join(root, "background-other");
			fs.mkdirSync(asyncDir);
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId: "background-other", state: "running", pid: 123456,
				steps: [{ id: "other-child", agent: "worker", status: "running" }],
			}));
			const route = createNestedRun("nested-selected");
			const nestedDir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId, "nested-background");
			routeRoots.push(nestedDir);
			fs.mkdirSync(nestedDir, { recursive: true });
			const step = { id: "descendant-child", agent: "worker", index: 0, status: "running" as const };
			fs.writeFileSync(path.join(nestedDir, "status.json"), JSON.stringify({
				runId: "nested-background", state: "running", pid: 654321, steps: [step],
			}));
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
				id: "nested-background", state: "running", asyncDir: nestedDir, steps: [step],
				parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1, path: [{ runId: route.rootRunId, stepIndex: 0 }],
			} });
			const kill = mock.method(process, "kill", () => true);
			try {
				const target = resolveSubagentRunId(id, { state: stateWithNestedRoute(route), target: "interrupt", asyncDirRoot: root });
				assert.equal(target?.owner.kind, owner);
				assert.deepEqual(kill.mock.calls.map((call) => call.arguments), probes);
			} finally { kill.mock.restore(); }
		});
	}

	it("resolves retained route ids and caches their projection without reading during completion", () => {
		const route = createNestedRun("retained-run", "running", { steps: [
			{ id: "retained-child", index: 0, agent: "worker", status: "running" },
		] });
		const state = createState();
		state.retainedNestedRoutes = new Map([[route.rootRunId, route]]);
		const deps = { state, asyncDirRoot: [] };
		const target = resolveSubagentRunId("retained-child", { ...deps, target: "interrupt" })!;
		assert.equal(target.owner.kind, "nested");
		assert.equal(target.runId, "retained-run");
		assert.equal(resolveSubagentRunId("retained-run", deps)?.kind, "nested");
		const read = mock.method(fs, "readFileSync", () => { throw new Error("completion read a file"); });
		try {
			syncBuiltinESMExports();
			assert.equal(listStopTargets(deps).find((entry) => entry.id === "retained-child")?.name, "worker");
			assert.equal(read.mock.callCount(), 0);
		} finally { read.mock.restore(); syncBuiltinESMExports(); }
	});

	for (const id of ["", "    ", "abc"]) {
		it(`rejects explicit short stop text ${JSON.stringify(id)} without stopping or listing runs`, async () => {
			const state = createState();
			let stops = 0;
			state.foregroundControls.set("running-owner", { runId: "running-owner", children: new Map(), interrupt: () => { stops++; return true; } } as any);
			assert.throws(() => resolveSubagentRunId(id, { state, target: "interrupt", asyncDirRoot: [] }), /too short; type at least 4 characters/);
			const result = await createExecutor(state).execute("stop", { action: "interrupt", id }, undefined, undefined, ctx(os.tmpdir()));
			assert.equal(result.isError, true);
			assert.match(text(result), /too short; type at least 4 characters/);
			assert.equal(stops, 0);
		});
	}

	it("refreshes changed live background records but retains terminal inventory for memory-only lookup", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-inventory-"));
		try {
			const dir = path.join(root, "background-abcd");
			fs.mkdirSync(dir);
			const file = path.join(dir, "status.json");
			const deps = { asyncDirRoot: root, target: "interrupt" as const, nested: { routes: [] } };
			const write = (state: string, agent: string, time: number) => {
				fs.writeFileSync(file, JSON.stringify({ runId: "background-abcd", state, pid: process.pid, steps: [{ id: "background-child", agent, status: state }] }));
				fs.utimesSync(file, time, time);
			};
			write("running", "old", 100);
			assert.equal(resolveSubagentRunId("background-child", deps)?.name, "old");
			write("complete", "finished", 101);
			assert.equal(resolveSubagentRunId("background-child", deps)?.state, "completed");
			write("running", "replacement", 102);
			assert.equal(resolveSubagentRunId("background-child", deps)?.name, "finished");
			fs.rmSync(file);
			assert.equal(listStopTargets(deps).find((target) => target.id === "background-child")?.name, "finished");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("closes admission before signals, deduplicates stops, and blocks late foreground launches", async () => {
		const route = createNestedRoute("stop-admission");
		routeRoots.push(path.dirname(route.eventSink));
		const calls: string[] = [];
		const control = { runId: route.rootRunId, mode: "parallel", nestedRoute: route, children: new Map([
			["first-child", { agent: "worker", index: 0, state: "running" }],
			["second-child", { agent: "worker", index: 1, state: "running" }],
			["later-child", { agent: "worker", index: 2, state: "pending" }],
		]), updatedAt: 0 } as any;
		for (const id of ["first-child", "second-child"]) registerForegroundInterrupt(control, id, () => {
			assert.equal(stoppingAncestor(route, control.runId), control.runId);
			calls.push(id);
			return true;
		});
		assert.equal(stopForegroundTarget(control), true);
		assert.equal(stopForegroundTarget(control), true);
		assert.deepEqual(calls, ["first-child", "second-child"]);
		assert.equal(control.children.get("later-child").stopRequested, undefined);
		let backendCalls = 0;
		const refused = await runSync(os.tmpdir(), [{ name: "worker" } as any], "worker", "late", {
			id: "later-child", runId: control.runId, nestedRoute: route,
		} as any, { selectBackend: async () => { backendCalls++; throw new Error("must not acquire backend"); } });
		assert.equal(refused.interrupted, true);
		assert.equal(backendCalls, 0);
		const ancestry = Array.from({ length: 8 }, (_, index) => ({ runId: `level-${index}`, childId: `child-${index}` }));
		recordStop(route, "child-6");
		assert.equal(stoppingAncestor(route, "deep-run", "deep-child", ancestry), "child-6");
	});

	it("applies an accepted child stop when its callback registers, leaving siblings alone", () => {
		const route = createNestedRoute("late-callback");
		routeRoots.push(path.dirname(route.eventSink));
		const control = { runId: route.rootRunId, nestedRoute: route, children: new Map([
			["target-child", { agent: "worker", state: "running", index: 0 }],
			["other-child", { agent: "worker", state: "running", index: 1 }],
		]) } as any;
		const calls: string[] = [];
		registerForegroundInterrupt(control, "other-child", () => { calls.push("other"); return true; });
		assert.equal(stopForegroundTarget(control, "target-child"), true);
		assert.equal(stopForegroundTarget(control, "target-child"), true);
		assert.deepEqual(calls, []);
		assert.equal(stoppingAncestor(route, control.runId, "target-child"), "target-child");
		const unregister = registerForegroundInterrupt(control, "target-child", () => { calls.push("target"); return true; });
		assert.deepEqual(calls, ["target"]);
		assert.equal(stopForegroundTarget(control, "target-child"), true);
		assert.deepEqual(calls, ["target"]);
		assert.equal(control.children.get("other-child").stopRequested, undefined);
		unregister();
		assert.equal(control.children.get("target-child").interrupt, undefined);
	});

	it("only the owner consumes a shared-inbox child stop", async () => {
		const route = createNestedRun("owner-run");
		setNestedRouteEnv(route);
		const state = createState();
		const calls: string[] = [];
		state.foregroundControls.set("owner-run", { runId: "owner-run", children: new Map([["child-abcd", { state: "running" }]]), interrupt: (id: string) => { calls.push(id); return true; } } as any);
		const wrong = startNestedControlInboxListener({} as any, createState());
		const owner = startNestedControlInboxListener({} as any, state);
		try {
			const file = writeNestedControlRequest(route, { ts: Date.now(), requestId: "owner-request", targetId: "child-abcd", action: "interrupt" });
			await waitFor(() => readNestedControlResults(route).length === 1);
			assert.deepEqual(calls, ["child-abcd"]);
			assert.equal(readNestedControlResults(route)[0].ok, true);
			assert.equal(fs.existsSync(file), false);
		} finally { clearInterval(wrong); clearInterval(owner); }
	});

	it("sweeps only recorded background descendants and closes their late-launch race", () => {
		const route = createNestedRoute("sweep-root");
		routeRoots.push(path.dirname(route.eventSink));
		const dirs: string[] = [];
		const kill = mock.method(process, "kill", () => true);
		try {
			for (const [id, childId] of [["nested-match", "target-child"], ["nested-sibling", "sibling-child"]]) {
				const asyncDir = path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", route.rootRunId, id);
				dirs.push(asyncDir);
				fs.mkdirSync(asyncDir, { recursive: true });
				fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "running", pid: 98765 }));
				writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0, child: {
					id, state: "running", agent: "worker", parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1,
					path: [{ runId: route.rootRunId, childId }], asyncDir,
				} });
			}
			recordStop(route, "target-child");
			sweepBackgroundDescendants(route, "target-child");
			assert.ok(fs.existsSync(path.join(dirs[0], "interrupt-request-nested-match.json")));
			assert.equal(fs.existsSync(path.join(dirs[1], "interrupt-request-nested-sibling.json")), false);
			assert.equal(kill.mock.calls.filter((call) => call.arguments[1] !== 0).length, 1);
			assert.equal(stoppingAncestor(route, "late-background", undefined, [{ runId: route.rootRunId, childId: "target-child" }]), "target-child");
		} finally {
			kill.mock.restore();
			for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("nested control routing", () => {
	it("routes interrupt to an explicit nested id through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
		try {
			const route = createNestedRun();
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested control request");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetId: request.targetId, ok: true, message: "nested interrupt accepted" });
			}, 50);

			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-live" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested interrupt accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes a headless nested owner's live child id and preserves both sibling outputs", async () => {
		const route = createNestedRoute(`headless-${Date.now()}`);
		routeRoots.push(path.dirname(route.eventSink));
		const ownerState = createState();
		const rootState = createState();
		rootState.foregroundControls.set("root-owner", { runId: "root-owner", mode: "single", startedAt: 1, updatedAt: 1, nestedRoute: route } as any);
		setNestedRouteEnv(route, "root-owner");
		const runtimePi = createMockPi();
		runtimePi.install();
		for (const index of [0, 1, 2]) runtimePi.onCall({ taskIncludes: `Headless child ${index}`, delay: index === 1 ? 60_000 : 1_500, output: `Headless output ${index}` });
		const owner = createExecutor(ownerState, [{ name: "worker", systemPrompt: "help", completionGuard: false }], false, undefined, runtimePi.captureRuntime);
		const root = createExecutor(rootState, [], true, undefined, runtimePi.captureRuntime);
		const controller = new AbortController();
		const stopNonOwner = startNestedControlInboxListener({} as any, createState());
		const stopOwner = startNestedControlInboxListener({} as any, ownerState);
		const pending = owner.execute("headless-nested", { tasks: [0, 1, 2].map((index) => ({ agent: "worker", task: `Headless child ${index}` })), async: false, clarify: false }, controller.signal, undefined, ctx(path.dirname(route.eventSink)));
		try {
			await waitFor(() => runtimePi.callCount() === 3, 5_000);
			const published = projectNestedEvents(route).children;
			assert.equal(published.length, 1);
			const nested = published[0];
			assert.equal(nested.steps?.length, 3);
			assert.ok(nested.steps?.every((step) => step.id && step.status === "running"));
			const response = await root.execute("headless-stop", { action: "interrupt", id: nested.steps![1].id!.slice(0, 6) }, undefined, undefined, ctx(os.tmpdir()));
			assert.notEqual(response.isError, true, text(response));
			const result = await pending;
			assert.equal(controller.signal.aborted, false, "stopping a nested child does not abort its waiting parent");
			assert.deepEqual(result.details.results.map((child) => child.id), nested.steps!.map((step) => step.id));
			assert.equal(result.details.results[1].interrupted, true);
			for (const index of [0, 2]) {
				assert.equal(result.details.results[index].finalOutput, `Headless output ${index}`);
				assert.notEqual(result.details.results[index].interrupted, true);
				assert.match(text(result), new RegExp(`Headless output ${index}`));
			}
			assert.match(text(result), /2\/3 succeeded/);
			assert.notEqual(result.isError, true);
			const final = projectNestedEvents(route).children[0];
			assert.deepEqual(final.steps!.map((step) => step.status), ["completed", "interrupted", "completed"]);
		} finally {
			controller.abort();
			await pending;
			clearInterval(stopOwner); clearInterval(stopNonOwner); runtimePi.uninstall();
		}
	});

	it("renders nested children in foreground status output", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-status-"));
		try {
			const route = createNestedRun("nested-foreground");
			const state = createState();
			state.foregroundControls.set("root-control", {
				runId: "root-control",
				mode: "single",
				startedAt: 1,
				updatedAt: 1,
				currentAgent: "orchestrator",
				currentIndex: 0,
				children: new Map([["abcdef12-1234-4234-8234-123456789abc", { agent: "orchestrator", label: "dispatch", index: 0, state: "running" }]]),
				nestedRoute: route,
			});
			state.lastForegroundControlId = "root-control";

			const result = await createExecutor(state).execute("status", { action: "status", id: "root-control" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Run: root-control/);
			assert.match(text(result), /^abcdef orchestrator - dispatch running$/m);
			assert.match(text(result), /^nested ↳ worker running$/m);
			assert.match(text(result), /Status: subagent\(\{ action: "status", id: "nested-foreground" \}\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("scopes child-safe nested status lookup to the inherited route and child address", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-scope-"));
		try {
			const allowedRoute = createNestedRun("shared-nested");
			setNestedRouteEnv(allowedRoute, "root-control");
			const outsideRoute = createNestedRoute("root-outside");
			routeRoots.push(path.dirname(outsideRoute.eventSink));
			writeNestedEvent(outsideRoute, {
				type: "subagent.nested.updated",
				ts: 100,
				parentRunId: "root-outside",
				parentStepIndex: 0,
				child: { id: "shared-nested", parentRunId: "root-outside", parentStepIndex: 0, depth: 1, path: [{ runId: "root-outside", stepIndex: 0 }], state: "running", agent: "outside" },
			});

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status", id: "shared-nested" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Nested run: shared-nested/);
			assert.match(text(result), /Root: root-control/);
			assert.doesNotMatch(text(result), /root-outside/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires an id for child-safe status instead of listing unrelated top-level async runs", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-child-safe-status-"));
		const runId = `child-safe-unrelated-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, runId);
		try {
			fs.mkdirSync(asyncDir, { recursive: true });
			fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({
				runId,
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "outside", status: "running", startedAt: 100 }],
			}, null, 2), "utf-8");

			const result = await createExecutor(createState(), [], false).execute("status", { action: "status" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /requires an id/);
			assert.doesNotMatch(text(result), new RegExp(runId));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(asyncDir, { recursive: true, force: true });
		}
	});

	it("does not let bare interrupt target hidden nested descendants", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-bare-interrupt-"));
		try {
			createNestedRun("nested-only");
			const result = await createExecutor().execute("interrupt", { action: "interrupt" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /No interrupt-capable run found/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("times out owner-gone nested control and ignores late results", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-timeout-"));
		try {
			const route = createNestedRun("nested-timeout");
			const executor = createExecutor(stateWithNestedRoute(route));
			const otherRequest = writeNestedControlRequest(route, { ts: Date.now(), requestId: "unrelated-request", targetId: "unrelated-run", action: "interrupt" });
			const kill = mock.method(process, "kill", () => true);
			try {
				const pending = executor.execute("interrupt", { action: "interrupt", id: "nested-timeout" }, new AbortController().signal, undefined, ctx(root));
				await waitFor(() => readNestedControlRequests(route).length === 2);
				const request = readNestedControlRequests(route).find((entry) => entry.targetId === "nested-timeout")!;
				const result = await pending;
				assert.equal(result.isError, true);
				assert.equal(text(result), "The owner of nested did not confirm the stop within 1000 ms; the stop may still take effect.");
				assert.deepEqual(readNestedControlRequests(route).map((entry) => entry.requestId), ["unrelated-request"]);
				assert.equal(fs.existsSync(otherRequest), true);
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetId: request.targetId, ok: true, message: "late success" });
				assert.doesNotMatch(text(result), /late success/);
				assert.equal(kill.mock.callCount(), 0);
				assert.equal(fs.readdirSync(path.dirname(route.eventSink), { recursive: true }).some((file) => String(file).includes("interrupt-request-")), false);
			} finally { kill.mock.restore(); }
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	for (const fault of ["delayed", "failed"] as const) {
		it(`keeps accepted stop effects when the reply is ${fault} past the caller deadline`, async () => {
			const route = createNestedRun("reply-owner", "running", { steps: [
				{ id: "reply-child", index: 0, agent: "worker", status: "running" },
			] });
			setNestedRouteEnv(route);
			const ownerState = createState();
			const control = { runId: "reply-owner", nestedRoute: route, children: new Map([
				["reply-child", { agent: "worker", index: 0, state: "running" }],
			]) } as any;
			control.interrupt = (id: string) => stopForegroundTarget(control, id);
			ownerState.foregroundControls.set(control.runId, control);
			let stops = 0;
			registerForegroundInterrupt(control, "reply-child", () => { stops++; return true; });
			const rename = fs.renameSync;
			let held: [fs.PathLike, fs.PathLike] | undefined;
			let released = false;
			const renameMock = mock.method(fs, "renameSync", (from, to) => {
				if (!released && path.dirname(String(to)) === route.eventSink && JSON.parse(fs.readFileSync(from, "utf8")).type === "subagent.nested.control-result") {
					if (fault === "failed") throw new Error("reply write unavailable");
					held = [from, to];
					return;
				}
				rename(from, to);
			});
			const errors = mock.method(console, "error", () => {});
			const kill = mock.method(process, "kill", () => true);
			syncBuiltinESMExports();
			const timer = startNestedControlInboxListener({} as any, ownerState);
			try {
				const result = await createExecutor(stateWithNestedRoute(route)).execute("stop", { action: "interrupt", id: "reply-child" }, undefined, undefined, ctx(os.tmpdir()));
				assert.equal(result.isError, true);
				assert.equal(text(result), "The owner of reply- did not confirm the stop within 1000 ms; the stop may still take effect.");
				assert.equal(stops, 1);
				assert.equal(control.children.get("reply-child").stopRequested, true);
				assert.equal(stoppingAncestor(route, control.runId, "reply-child"), "reply-child");
				assert.deepEqual(readNestedControlRequests(route), []);
				assert.deepEqual(readNestedControlResults(route), []);
				assert.equal(kill.mock.callCount(), 0);
				assert.equal(fs.readdirSync(path.dirname(route.eventSink), { recursive: true }).some((file) => String(file).includes("interrupt-request-")), false);
				released = true;
				if (held) rename(...held);
				await waitFor(() => readNestedControlResults(route).some((entry) => entry.targetId === "reply-child" && entry.ok), 1_500);
				assert.equal(stops, 1, "late reply retries never repeat the stop");
				assert.equal(result.isError, true, "late success cannot rewrite the returned outcome");
			} finally {
				clearInterval(timer);
				renameMock.mock.restore(); errors.mock.restore(); kill.mock.restore(); syncBuiltinESMExports();
			}
		});
	}

	it("rejects resume for live nested runs through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-live-resume-"));
		try {
			const route = createNestedRun("nested-live-resume");
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested resume request");
				assert.equal(request.action, "resume");
				assert.equal(request.message, "continue please");
				const controlResult = { ts: Date.now(), requestId: request.requestId, targetId: request.targetId, ok: false, message: `Nested run ${request.targetId} is still active; wait for completion, then resume.` };
				assert.equal(controlResult.ok, false);
				assert.match(controlResult.message, /is still active; wait for completion, then resume\./);
				writeNestedControlResult(route, controlResult);
			}, 50);

			const result = await executor.execute("resume", { action: "resume", id: "nested-live-resume", message: "continue please" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /is still active; wait for completion, then resume\./);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates terminal nested resume session files before revive", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-resume-"));
		try {
			const route = createNestedRun("nested-terminal-resume", "complete", { sessionFile: path.join(root, "missing-session.jsonl") });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-terminal-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, true);
			assert.match(text(result), /session file does not exist/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files outside trusted roots", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-untrusted-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const attackerSessionFile = path.join(root, "outside", "session.jsonl");
			fs.mkdirSync(path.dirname(attackerSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(attackerSessionFile, "");
			const route = createNestedRun("nested-untrusted-resume", "complete", { sessionFile: attackerSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-untrusted-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /outside trusted nested session roots/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects terminal nested resume session files from sibling run directories", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-terminal-sibling-"));
		try {
			const parentSessionFile = path.join(root, "parent.jsonl");
			const siblingSessionFile = path.join(root, "parent", "other-run", "run-0", "session.jsonl");
			fs.mkdirSync(path.dirname(siblingSessionFile), { recursive: true });
			fs.writeFileSync(parentSessionFile, "");
			fs.writeFileSync(siblingSessionFile, "");
			const route = createNestedRun("nested-sibling-resume", "complete", { sessionFile: siblingSessionFile });

			const result = await createExecutor(stateWithNestedRoute(route), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("resume", { action: "resume", id: "nested-sibling-resume", message: "continue" }, new AbortController().signal, undefined, ctx(root, parentSessionFile));

			assert.equal(result.isError, true);
			assert.match(text(result), /not under that nested run's session directory/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	for (const scenario of ["valid", "outside", "symlink", "directory", "capability", "relative-root", "missing-runtime", "root-symlink", "noncanonical-root"] as const) {
		it(`authorizes stamped nested resume: ${scenario}`, async () => {
			const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nested-origin-")));
			try {
				const originalRoot = path.join(root, "custom-base", "12345678-1234-4234-8234-123456789abc");
				fs.mkdirSync(originalRoot, { recursive: true });
				const original = path.join(originalRoot, "history.jsonl");
				fs.writeFileSync(original, "original bytes\n");
				let sessionFile = original;
				if (scenario === "outside") { sessionFile = path.join(root, "outside.jsonl"); fs.writeFileSync(sessionFile, "outside\n"); }
				if (scenario === "symlink") { sessionFile = path.join(originalRoot, "link.jsonl"); fs.symlinkSync(original, sessionFile); }
				if (scenario === "directory") { sessionFile = path.join(originalRoot, "directory.jsonl"); fs.mkdirSync(sessionFile); }
				const route = createNestedRun(`stamped-${scenario}`, "complete", {
					sessionFile, ownerState: "gone",
					...(scenario === "missing-runtime" ? {} : { runtime: mockPi.runtime }),
					sessionRoot: originalRoot,
					...(scenario === "capability" ? { capabilityToken: "wrong-capability" } : {}),
				});
				if (["capability", "relative-root", "root-symlink", "noncanonical-root"].includes(scenario)) {
					const registry = projectNestedEvents(route);
					if (scenario === "capability") registry.children[0].capabilityToken = "wrong-capability";
					else if (scenario === "root-symlink") { const link = path.join(root, "root-link"); fs.symlinkSync(originalRoot, link); registry.children[0].sessionRoot = link; }
					else if (scenario === "noncanonical-root") registry.children[0].sessionRoot = originalRoot + "/.";
					else registry.children[0].sessionRoot = "relative";
					fs.writeFileSync(path.join(path.dirname(route.eventSink), "registry.json"), JSON.stringify(registry));
				}
				const executor = createExecutor(stateWithNestedRoute(route), [{ name: "worker" }]);
				const operation = executor.execute("resume", { action: "resume", id: `stamped-${scenario}`, message: "continue" }, new AbortController().signal, undefined, {
					...ctx(root), modelRegistry: { getAvailable() { throw new Error("reached authorized session"); } },
				});
				if (scenario === "valid") {
					const result = await operation;
					assert.equal(result.isError, true);
					assert.match(text(result), /reached authorized session/);
				}
				else {
					const result = await operation;
					assert.equal(result.isError, true);
					assert.match(text(result), scenario === "outside" ? /outside.*stamped/ : scenario === "symlink" || scenario === "directory" ? /regular file/ : scenario === "capability" ? /capability/ : scenario === "missing-runtime" ? /original runtime was not recorded/ : scenario === "root-symlink" || scenario === "noncanonical-root" ? /stamped session root/ : /not found/);
				}
				assert.equal(fs.readFileSync(original, "utf8"), "original bytes\n");
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		});
	}

	for (const scenario of ["missing", "partial", "malformed", "conflict", "valid", "selected-child"] as const) {
		it(`uses authoritative nested async status: ${scenario}`, async () => {
			const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nested-status-")));
			routeRoots.push(root);
			const id = `nested-status-${scenario}`;
			const asyncDir = path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", "root-control", id);
			routeRoots.push(asyncDir);
			fs.mkdirSync(asyncDir, { recursive: true });
			const sessionFile = path.join(root, "history.jsonl");
			fs.writeFileSync(sessionFile, "history\n");
			const route = createNestedRun(id, "complete", { asyncDir, sessionFile, sessionRoot: root, runtime: mockPi.runtime });
			const resultPath = nestedResultsPath("root-control", id);
			fs.mkdirSync(path.dirname(resultPath), { recursive: true });
			routeRoots.push(resultPath);
			fs.writeFileSync(resultPath, JSON.stringify({ runId: id, runtime: mockPi.runtime, agent: "worker", sessionFile, success: true }));
			fs.writeFileSync(path.join(asyncDir, "status.json"), scenario === "malformed" ? "{" : JSON.stringify({
				runId: id, state: "complete", steps: scenario === "selected-child" ? [{ agent: "other", status: "complete" }, { agent: "worker", sessionFile, status: "complete" }] : [{ agent: "worker", sessionFile, status: "complete" }],
				...(scenario === "missing" ? {} : { runtime: scenario === "partial" ? { nodeExecPath: process.execPath } : scenario === "conflict" ? { ...mockPi.runtime, piPackageRoot: root } : mockPi.runtime }),
			}));
			const executor = createExecutor(stateWithNestedRoute(route), [{ name: "worker" }]);
			const result = await executor.execute("resume", { action: "resume", id, index: scenario === "selected-child" ? 1 : undefined, message: "continue" }, new AbortController().signal, undefined, {
				...ctx(root), modelRegistry: { getAvailable() { throw new Error("validated authoritative status"); } },
			});
			assert.equal(result.isError, true);
			assert.match(text(result), scenario === "valid" || scenario === "selected-child" ? /validated authoritative status/ : scenario === "conflict" ? /identities conflict/ : scenario === "malformed" ? /parse async status/ : scenario === "partial" ? /invalid runtime piEntryPath/ : /original runtime was not recorded/);
		});
	}

	for (const summaryState of ["complete", "running", "queued"] as const) {
		it(`repeatedly revives authoritative async origin under the new parent's base: ${summaryState}`, async () => {
			const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "nested-revival-")));
			routeRoots.push(root);
			const originalRoot = path.join(root, "async-original");
			fs.mkdirSync(originalRoot);
			const sessionFile = path.join(originalRoot, "history.jsonl");
			fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", cwd: root })}\n`);
			const originId = `repeat-origin-${summaryState}`;
			const originAsyncDir = path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", "root-control", originId);
			routeRoots.push(originAsyncDir);
			fs.mkdirSync(originAsyncDir, { recursive: true });
			fs.writeFileSync(path.join(originAsyncDir, "status.json"), JSON.stringify({ runId: originId, state: "complete", runtime: mockPi.runtime, steps: [{ agent: "worker", sessionFile, status: "complete" }] }));
			const runtimeB = { ...mockPi.runtime, piPackageRoot: root };
			const route = createNestedRun(originId, summaryState, { asyncDir: originAsyncDir, runtime: runtimeB, sessionRoot: originalRoot, sessionFile });
			let captures = 0;
			const executor = createExecutor(stateWithNestedRoute(route), [{ name: "worker" }], true, undefined, () => { captures++; if (summaryState === "complete") throw new Error("parent capture failed"); return runtimeB; });
			process.env.MOCK_PI_QUEUE_DIR = mockPi.dir;
			const parentFile = path.join(root, "parent-b.jsonl");
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await executor.execute("resume", { action: "resume", id: originId, message: "continue", artifacts: false }, new AbortController().signal, undefined, ctx(root, parentFile));
				assert.notEqual(result.isError, true, text(result));
				const asyncDir = result.details!.asyncDir!;
				routeRoots.push(asyncDir);
				const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
				assert.equal(path.dirname(status.sessionDir), path.join(root, "parent-b"));
				assert.match(path.basename(status.sessionDir), /^async-[0-9a-f-]{36}$/);
				assert.deepEqual(status.runtime, mockPi.runtime);
				assert.equal(status.steps[0].sessionFile, sessionFile);
				const waitStartedAt = Date.now();
				try {
					await waitFor(() => ["complete", "failed"].includes(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")).state), 30_000);
				} catch (error) {
					assert.fail(`Detached resume did not reach terminal status after ${Date.now() - waitStartedAt}ms: ${fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")}\nrunner.log:\n${fs.readFileSync(path.join(asyncDir, "runner.log"), "utf8")}\n${error}`);
				}
				assert.equal(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")).state, "complete", `${fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")}\nrunner.log:\n${fs.readFileSync(path.join(asyncDir, "runner.log"), "utf8")}`);
			}
			assert.equal(captures, 1);
		});
	}

	it("aborts foreground launch when the origin stamp cannot be written", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-stamp-failure-"));
		try {
			const route = createNestedRoute("stamp-failure");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "stamp-failure");
			fs.rmSync(route.eventSink, { recursive: true });
			fs.writeFileSync(route.eventSink, "not a directory");
			let modelLookups = 0;
			const result = await createExecutor(createState(), [{ name: "worker" }]).execute("launch", { agent: "worker", task: "go" }, new AbortController().signal, undefined, {
				...ctx(root), modelRegistry: { getAvailable() { modelLookups++; throw new Error("launch reached"); } },
			});
			assert.equal(result.isError, true);
			assert.match(text(result), /EEXIST|ENOTDIR/);
			assert.equal(modelLookups, 0);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("emits a failed completed nested event when foreground execution throws after start", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-foreground-throw-"));
		try {
			const route = createNestedRoute("root-parent");
			routeRoots.push(path.dirname(route.eventSink));
			setNestedRouteEnv(route, "root-parent");
			const throwingCtx = {
				...ctx(root),
				modelRegistry: { getAvailable() { throw new Error("model registry exploded"); } },
			};

			const result = await createExecutor(createState(), [{ name: "worker", description: "Worker", prompt: "Do work" }])
				.execute("run", { agent: "worker", task: "go" }, new AbortController().signal, undefined, throwingCtx);

			assert.equal(result.isError, true);
			assert.match(text(result), /model registry exploded/);
			const registry = projectNestedEvents(route);
			assert.equal(registry.children.length, 1);
			assert.equal(registry.children[0]?.state, "failed");
			assert.match(registry.children[0]?.error ?? "", /model registry exploded/);
			assert.deepEqual(registry.children[0]?.runtime, mockPi.runtime);
			assert.equal(fs.realpathSync.native(registry.children[0]!.sessionRoot!), registry.children[0]?.sessionRoot);
			assert.match(registry.children[0]!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the fanout child control listener alive after control inbox polling errors", async () => {
		const route = createNestedRoute("root-poll-error");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-poll-error");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.controlInbox, { recursive: true, force: true });
		fs.writeFileSync(route.controlInbox, "not a directory", "utf-8");
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		const state = createState();
		state.foregroundControls.set("owned-run", { runId: "owned-run", children: new Map(), interrupt: () => false } as any);
		const timer = startNestedControlInboxListener(pi, state);
		try {
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes(route.controlInbox) && String(entry[0] ?? "").includes("root-poll-error")));

			fs.rmSync(route.controlInbox, { force: true });
			fs.mkdirSync(route.controlInbox, { recursive: true });
			const requestPath = writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: "poll-error-recovers",
				targetId: "owned-run",
				action: "interrupt",
			});

			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "poll-error-recovers" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			clearInterval(timer);
			console.error = originalError;
		}
	});

	it("keeps fanout child control requests when result writing fails and retries after recovery", async () => {
		const route = createNestedRoute("root-result-write-fails");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-result-write-fails");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		fs.rmSync(route.eventSink, { recursive: true, force: true });
		fs.writeFileSync(route.eventSink, "not a directory", "utf-8");
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "result-write-fails",
			targetId: "owned-run",
			action: "interrupt",
		});
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		const state = createState();
		let calls = 0;
		state.foregroundControls.set("owned-run", { runId: "owned-run", children: new Map(), interrupt: () => { calls++; return false; } } as any);
		const timer = startNestedControlInboxListener(pi, state);
		try {
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes("result-write-fails") && /keeping request for retry/.test(String(entry[0] ?? ""))));
			assert.equal(fs.existsSync(requestPath), true);

			fs.rmSync(route.eventSink, { force: true });
			fs.mkdirSync(route.eventSink, { recursive: true });
			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "result-write-fails" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
			assert.equal(calls, 1, "an acknowledgement retry never repeats the stop");
		} finally {
			clearInterval(timer);
			console.error = originalError;
		}
	});

	it("leaves ownerless fanout requests unanswered and unconsumed", async () => {
		const route = createNestedRoute("root-ownerless");
		routeRoots.push(path.dirname(route.eventSink));
		setNestedRouteEnv(route, "root-ownerless");
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		const pi = {
			events: { emit() {}, on() { return () => {}; } },
			registerTool() {},
			getSessionName() { return "child"; },
		} as any;
		const requestPath = writeNestedControlRequest(route, {
			ts: Date.now(),
			requestId: "ownerless-request",
			targetId: "missing-run",
			action: "interrupt",
		});

		registerFanoutChildSubagentExtension(pi);
		await new Promise((resolve) => setTimeout(resolve, 450));
		assert.equal(fs.existsSync(requestPath), true);
		assert.deepEqual(readNestedControlResults(route), []);
	});
});
