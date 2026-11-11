import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it, mock as testMock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { ASYNC_DIR, LEGACY_ASYNC_DIR, RUN_STATE_ROOT_DIR, TEMP_ROOT_DIR, type AsyncJobState, type AsyncStatus, type SubagentState } from "../../src/shared/types.ts";
import {
	createNestedRoute,
	applyNestedEvent,
	findNestedRun,
	NESTED_EVENTS_DIR,
	findNestedRunMatchesById,
	isTopLevelAsyncDir,
	nestedRouteEnv,
	nestedSummaryFromAsyncStatus,
	projectNestedRegistryForRoot,
	readNestedRegistry,
	resolveNestedAsyncDir,
	sanitizeSummary,
	hasLiveNestedDescendants,
	parseNestedEventRecords,
	projectNestedEvents,
	resolveNestedParentAddressFromEnv,
	resolveNestedRouteFromEnv,
	updateAsyncJobNestedProjection,
	updateForegroundNestedProjection,
	writeNestedEvent,
	readNestedControlRequests,
	readNestedControlResults,
	writeNestedControlRequest,
	writeNestedControlResult,
} from "../../src/runs/shared/nested-events.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createMockPi } from "../support/mock-pi.ts";
import { runSingleStep } from "../../src/runs/background/subagent-runner.ts";
import { encodeNestedPathEnv, parseNestedPathEnv } from "../../src/runs/shared/nested-path.ts";

const routes: Array<{ eventSink: string }> = [];
const savedEnv = {
	[SUBAGENT_PARENT_EVENT_SINK_ENV]: process.env[SUBAGENT_PARENT_EVENT_SINK_ENV],
	[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV],
	[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV],
	[SUBAGENT_PARENT_RUN_ID_ENV]: process.env[SUBAGENT_PARENT_RUN_ID_ENV],
	[SUBAGENT_PARENT_CHILD_INDEX_ENV]: process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV],
	[SUBAGENT_PARENT_DEPTH_ENV]: process.env[SUBAGENT_PARENT_DEPTH_ENV],
	[SUBAGENT_PARENT_PATH_ENV]: process.env[SUBAGENT_PARENT_PATH_ENV],
	[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV],
};

afterEach(() => {
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function trackRoute(rootRunId = "root-run") {
	const route = createNestedRoute(rootRunId);
	routes.push(route);
	return route;
}

function child(id: string, state: "queued" | "running" | "complete" | "failed" | "paused", ts: number, parentRunId = "root-run") {
	return {
		id,
		parentRunId,
		parentStepIndex: 1,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 1 }],
		mode: "single" as const,
		state,
		agent: "reviewer",
		agents: ["reviewer"],
		startedAt: 10,
		lastUpdate: ts,
		steps: [{ id: `${id}-leaf`, agent: "leaf", status: state === "running" ? "running" as const : "complete" as const }],
	};
}

describe("child identities", () => {
	it("round-trips complete child-bearing ancestry and rejects unsafe ids", () => {
		const ancestry = Array.from({ length: 6 }, (_, index) => ({ runId: `run-${index}`, childId: `child-${index}`, stepIndex: index }));
		assert.deepEqual(parseNestedPathEnv(encodeNestedPathEnv(ancestry)), ancestry);
		assert.deepEqual(sanitizeSummary({ ...child("nested-run", "running", 1), path: ancestry })?.path, ancestry);
		assert.deepEqual(parseNestedPathEnv(JSON.stringify([{ runId: "../unsafe" }, { runId: "safe", childId: "../unsafe" }])), []);
	});

	it("omits legacy id-less steps while retaining identified steps, runs and descendants", () => {
		const route = trackRoute();
		const steps = ["pending", "running", "completed"].flatMap((status, index) => [
			{ agent: "legacy", status }, { id: `owned-${index}`, agent: "leaf", status, index },
		]);
		const run = { ...child("legacy-run", "running", 1), steps };
		assert.deepEqual(sanitizeSummary(run)?.steps?.map((step) => step.id), ["owned-0", "owned-1", "owned-2"]);
		// Stored pre-upgrade records remain readable without inventing child identities.
		const legacyFile = path.join(route.eventSink, "legacy.json");
		fs.writeFileSync(legacyFile, JSON.stringify({ type: "subagent.nested.started", ts: 1, rootRunId: route.rootRunId, capabilityToken: route.capabilityToken, parentRunId: route.rootRunId, child: run }));
		writeNestedEvent(route, { type: "subagent.nested.started", ts: 2, parentRunId: "legacy-run", child: child("descendant", "running", 2, "legacy-run") });
		const registry = projectNestedEvents(route);
		assert.deepEqual(findNestedRun(registry.children, "legacy-run")?.steps?.map((step) => step.id), ["owned-0", "owned-1", "owned-2"]);
		assert.ok(findNestedRun(registry.children, "descendant"));
		assert.ok(fs.existsSync(legacyFile));
	});

	it("retains live records beyond settled depth, step and sibling caps", () => {
		const route = trackRoute();
		let parent = route.rootRunId;
		for (let depth = 1; depth <= 6; depth++) {
			const id = `depth-${depth}`;
			writeNestedEvent(route, { type: "subagent.nested.started", ts: depth, parentRunId: parent, child: { ...child(id, "complete", depth, parent), depth, steps: [] } });
			parent = id;
		}
		for (let index = 0; index < 17; index++) {
			writeNestedEvent(route, { type: "subagent.nested.started", ts: 10 + index, parentRunId: parent, child: { ...child(`live-${index}`, "running", 10 + index, parent), depth: 7 } });
		}
		const registry = projectNestedEvents(route);
		assert.equal(findNestedRun(registry.children, parent)?.children?.length, 17);
		assert.equal(findNestedRun(readNestedRegistry(route).children, "live-16")?.depth, 7);
		const settled = sanitizeSummary({ ...child("settled", "complete", 1), steps: Array.from({ length: 17 }, (_, index) => ({ id: `step-${index}`, agent: "leaf", status: "completed" })), children: Array.from({ length: 20 }, (_, index) => child(`settled-${index}`, "complete", 1)) });
		assert.equal(settled?.steps?.length, 12);
		assert.equal(settled?.children?.length, 16);
	});

	it("publishes bounded child records, defers orphans, and merges by identity without regression", () => {
		const route = trackRoute();
		for (let index = 16; index >= 0; index--) {
			writeNestedEvent(route, { type: "subagent.nested.child", ts: 100 + index, runId: "nested-a", id: `owned-${index}`, agent: "leaf", label: `label-${index}`, status: "running", index, sessionFile: "s".repeat(2048), currentPath: "p".repeat(2048) });
		}
		assert.equal(projectNestedEvents(route).processedEvents.length, 0);
		writeNestedEvent(route, { type: "subagent.nested.started", ts: 200, parentRunId: route.rootRunId, child: { ...child("nested-a", "running", 200), steps: [] } });
		let registry = projectNestedEvents(route);
		assert.equal(registry.children[0].steps?.length, 17);
		assert.deepEqual(registry.children[0].steps?.map((step) => step.id), Array.from({ length: 17 }, (_, index) => `owned-${index}`));
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 300, runId: "nested-a", id: "owned-0", agent: "leaf", status: "interrupted", index: 0 });
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 400, runId: "nested-a", id: "owned-0", agent: "leaf", status: "running", index: 0 });
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 50, runId: "nested-a", id: "owned-1", agent: "older", status: "running", index: 1 });
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 500, runId: "nested-a", id: "owned-2", agent: "leaf", status: "running", index: 2, currentPath: "x".repeat(70_000) });
		const oversizedChildren = Array.from({ length: 17 }, (_, index) => ({
			...child(`descendant-${index}`, "running", 500),
			path: Array.from({ length: 100 }, (_, depth) => ({ runId: `ancestor-${depth}`, childId: `owner-${depth}` })),
		}));
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 500, runId: "nested-a", id: "owned-3", agent: "leaf", status: "running", index: 3, label: "identity label", children: oversizedChildren });
		registry = projectNestedEvents(route);
		assert.equal(registry.children[0].steps?.[0].status, "interrupted");
		assert.equal(registry.children[0].steps?.[1].agent, "leaf");
		assert.equal(registry.children[0].steps?.[2].id, "owned-2");
		assert.equal(registry.children[0].steps?.[2].currentPath, "x".repeat(2048));
		assert.equal(registry.children[0].steps?.[3].id, "owned-3");
		assert.equal(registry.children[0].steps?.[3].label, "identity label");
		assert.equal(registry.children[0].steps?.[3].children, undefined);
		assert.deepEqual(projectNestedEvents(route), registry);
		for (const name of fs.readdirSync(route.eventSink)) assert.ok(fs.statSync(path.join(route.eventSink, name)).size <= 64 * 1024);
	});

	it("publishes background terminal updates beyond the settled display cap", () => {
		const route = trackRoute();
		const status: AsyncStatus = {
			runId: "nested", mode: "chain", state: "running", startedAt: 1, lastUpdate: 10,
			steps: Array.from({ length: 13 }, (_, index) => ({
				id: `leaf-${index}`, agent: "worker", status: index < 12 ? "completed" : "running",
			})),
		};
		const publish = () => writeNestedEvent(route, { type: "subagent.nested.updated", ts: status.lastUpdate!,
			parentRunId: route.rootRunId,
			child: nestedSummaryFromAsyncStatus(status, path.dirname(route.eventSink), {
				id: status.runId, parentRunId: route.rootRunId, depth: 1, ts: status.lastUpdate!,
			}),
		});
		publish();
		assert.equal(projectNestedEvents(route).children[0].steps?.at(-1)?.status, "running");
		status.steps![12].status = "completed";
		status.lastUpdate = 20;
		publish();
		const settled = projectNestedEvents(route).children[0].steps!;
		assert.equal(settled.length, 12);
		assert.equal(settled.some((step) => step.status === "running"), false);
	});

	it("preserves child terminal guards after display eviction and event-cache rollover", () => {
		const route = trackRoute();
		const run = { ...child("nested", "running", 10, route.rootRunId), steps: Array.from({ length: 13 }, (_, index) => ({
			id: `leaf-${index}`, agent: "worker", status: "running" as const,
		})) };
		writeNestedEvent(route, { type: "subagent.nested.started", ts: 10, parentRunId: route.rootRunId, child: run });
		projectNestedEvents(route);
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 20, parentRunId: route.rootRunId,
			child: { ...run, lastUpdate: 20, steps: run.steps.map((step) => ({ ...step, status: "completed", lastUpdate: 20 })) } });
		const settled = projectNestedEvents(route);
		assert.equal(settled.children[0].steps?.length, 12);
		const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
		// Model cache rollover without publishing a thousand unrelated events.
		const terminalEvents = settled.processedEvents.filter((name) =>
			parseNestedEventRecords(fs.readFileSync(path.join(route.eventSink, name), "utf8"), route)[0].ts >= 20);
		fs.writeFileSync(registryPath, JSON.stringify({ ...settled, processedEvents: terminalEvents }));
		assert.deepEqual(projectNestedEvents(route).children, settled.children);
		assert.deepEqual(projectNestedEvents(route).children, settled.children);
		writeNestedEvent(route, { type: "subagent.nested.child", ts: 30, runId: "nested",
			id: "leaf-12", index: 12, agent: "worker", status: "pending" });
		assert.deepEqual(projectNestedEvents(route).children, settled.children);
	});

	it("uses targetId on capability-checked control requests and results", () => {
		const route = trackRoute();
		writeNestedControlRequest(route, { ts: 1, requestId: "request", targetId: "child-id", action: "interrupt" });
		writeNestedControlResult(route, { ts: 2, requestId: "request", targetId: "child-id", ok: true, message: "stopped" });
		assert.equal(readNestedControlRequests(route)[0]?.targetId, "child-id");
		assert.equal(readNestedControlResults(route)[0]?.targetId, "child-id");
	});
});

it("publishes nested foreground identities without a UI callback and preserves them in results", async () => {
	const route = trackRoute();
	const mock = createMockPi();
	mock.install();
	const env = {
		PI_SUBAGENT_PARENT_EVENT_SINK: route.eventSink,
		PI_SUBAGENT_PARENT_CONTROL_INBOX: route.controlInbox,
		PI_SUBAGENT_PARENT_ROOT_RUN_ID: route.rootRunId,
		PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: route.capabilityToken,
		PI_SUBAGENT_PARENT_RUN_ID: route.rootRunId,
		PI_SUBAGENT_PARENT_PATH: JSON.stringify([{ runId: route.rootRunId }]),
		PI_SUBAGENT_PARENT_DEPTH: "1",
		PI_SUBAGENT_PARENT_CHILD_INDEX: "0",
	};
	const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);
	const root = path.dirname(route.eventSink);
	try {
		for (const params of [
			{ agent: "worker", task: "go", label: "single" },
			{ tasks: [{ agent: "worker", task: "go", label: "task", count: 2 }], concurrency: 1 },
			{ chain: [{ agent: "worker", task: "go", label: "sequential" }] },
			{ chain: [{ parallel: [{ agent: "worker", task: "go", label: "static" }], label: "group" }] },
			{ chain: [
				{ agent: "worker", task: "invalid seed", as: "seed", label: "seed", outputSchema: { type: "object" } },
				{ expand: { from: { output: "seed", path: "/items" }, maxItems: 1 }, parallel: { agent: "worker", task: "use {item}", label: "invalid-reference" }, collect: { as: "collected" } },
			] },
			{ chain: [
				{ agent: "worker", task: "seed", label: "seed", as: "seed", outputSchema: { type: "object" } },
				{ expand: { from: { output: "seed", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "go {item}", label: "dynamic {item}" }, collect: { as: "collected" }, label: "group" },
			] },
		]) {
			const invalidReference = params.chain?.[0]?.task === "invalid seed";
			mock.onCall({ output: "done", delay: 150, structuredOutput: { items: invalidReference ? ["{outputs.missing}"] : ["one", "two"] } });
			const state: any = { foregroundControls: new Map(), foregroundRuns: new Map(), retainedNestedRoutes: new Map(), asyncJobs: new Map(),
				grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, cleanupTimers: new Map() };
			const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime, state,
				pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
				resolveConfig: () => ({ maxSubagentDepth: 3, control: {} } as any), tempArtifactsDir: root,
				getSubagentSessionRoot: () => root, expandTilde: (value) => value,
				discoverAgents: () => ({ agents: [{ name: "worker", source: "user", systemPrompt: "help" }] as any }),
			});
			const running = executor.execute("launch", params, new AbortController().signal, undefined, { cwd: root, hasUI: false,
				sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined }, modelRegistry: { getAvailable: () => [] } } as any);
			let live: NestedRunSummary | undefined;
			for (let i = 0; i < 80; i++) {
				live = projectNestedEvents(route).children.find((run) => run.state === "running" && run.steps?.some((step) => step.status === "running"));
				if (live) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const owner = live && state.foregroundControls.get(live.id);
			const result = await running;
			assert.equal(Boolean(result.isError), invalidReference);
			assert.ok(live, JSON.stringify(result.content));
			assert.ok(owner?.children.size);
			if (params.tasks) {
				assert.equal(live.steps?.length, 2);
				assert.equal(live.steps?.filter((step) => step.status === "pending").length, 1);
			}
			const settled = projectNestedEvents(route).children.find((run) => run.id === live.id)!;
			assert.equal(settled.steps?.length, result.details?.results.length);
			assert.equal(new Set(result.details!.results.map((child) => child.id)).size, result.details!.results.length);
			for (const child of result.details!.results) {
				assert.match(child.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
				assert.notEqual(child.id, live.id);
				const expectedState = child.exitCode === 0 ? "completed" : "failed";
				if (expectedState === "failed") {
					assert.equal(child.label, "invalid-reference");
					assert.match(child.error, /missing/);
				}
				assert.equal(owner.children.get(child.id)?.state, expectedState);
				assert.equal(settled.steps?.find((step) => step.id === child.id)?.label, child.label);
				assert.equal(settled.steps?.find((step) => step.id === child.id)?.status, expectedState);
				assert.ok(child.label);
				assert.notEqual(child.label, "group");
			}
			assert.ok(result.details!.results.some((child) => child.id === live.steps![0].id));
		}
	} finally {
		mock.uninstall();
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
});

it("preserves task labels when clarification launches in the background", async () => {
	const mock = createMockPi();
	mock.install();
	const route = trackRoute();
	const root = path.dirname(route.eventSink);
	let config: any;
	const originalWrite = fs.writeFileSync;
	const write = testMock.method(fs, "writeFileSync", (file: any, data: any, ...args: any[]) => {
		if (String(file).includes("async-cfg-")) {
			config = JSON.parse(String(data));
			throw new Error("stop before runner launch");
		}
		return originalWrite(file, data, ...args);
	});
	syncBuiltinESMExports();
	try {
		const state: any = { foregroundControls: new Map(), foregroundRuns: new Map(), retainedNestedRoutes: new Map(), asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, cleanupTimers: new Map() };
		const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime, state,
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName() { return "parent"; } } as any,
			resolveConfig: () => ({ maxSubagentDepth: 3, control: {} } as any), tempArtifactsDir: root,
			getSubagentSessionRoot: () => root, expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [{ name: "worker", source: "user", systemPrompt: "help" }] as any }),
		});
		const result = await executor.execute("launch", { clarify: true, tasks: [{ agent: "worker", task: "go", label: "retained label" }] },
			new AbortController().signal, undefined, { cwd: root, hasUI: true,
				ui: { custom: async () => ({ confirmed: true, templates: ["edited task"], behaviorOverrides: [{}], runInBackground: true }) },
				sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined },
				modelRegistry: { getAvailable: () => [] } } as any);
		assert.match(result.content[0].text, /stop before runner launch/);
		assert.equal(config.steps[0].parallel[0].label, "retained label");
		assert.match(config.steps[0].parallel[0].task, /edited task/);
	} finally {
		write.mock.restore();
		syncBuiltinESMExports();
		mock.uninstall();
	}
});

it("keeps the dispatch-owned identity across background fallback attempts", async () => {
	const mock = createMockPi();
	mock.install();
	const route = trackRoute();
	const root = path.dirname(route.eventSink);
	try {
		mock.onCall({ stderr: "429 rate limit", exitCode: 1, remaining: 1 });
		mock.onCall({ output: "done" });
		const result = await runSingleStep({ agent: "worker", task: "go", label: "background", modelCandidates: ["provider/first", "provider/second"] }, {
			childId: "12345678-1234-1234-1234-123456789abc", id: route.rootRunId,
			previousOutput: "", placeholder: "{previous}", cwd: root, sessionEnabled: false,
			outputs: {}, runtime: mock.captureRuntime(), flatIndex: 0, flatStepCount: 1,
			outputFile: path.join(root, "output.log"),
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.id, "12345678-1234-1234-1234-123456789abc");
		assert.equal(result.label, "background");
		assert.equal(result.modelAttempts.length, 2);
	} finally { mock.uninstall(); }
});

describe("nested event route validation", () => {
	it("resolves nested parent addresses with full inherited path", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "nested-parent";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "3";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([
			{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
			{ runId: "../unsafe", stepIndex: 1, agent: "bad" },
			{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
		]);

		assert.deepEqual(resolveNestedParentAddressFromEnv(), {
			parentRunId: "nested-parent",
			parentStepIndex: 2,
			depth: 3,
			path: [
				{ runId: "root-run", stepIndex: 0, agent: "root-agent" },
				{ runId: "nested-parent", stepIndex: 2, agent: "nested-agent" },
			],
		});
	});

	it("ignores unsafe nested parent ids from env", () => {
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "../unsafe";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "2";

		assert.equal(resolveNestedParentAddressFromEnv(), undefined);
	});

	it("resolves only matching contained routes from env", () => {
		const route = trackRoute();
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;

		assert.deepEqual(resolveNestedRouteFromEnv(), route);

		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "wrong-token";
		assert.throws(() => resolveNestedRouteFromEnv(), /capability token/);
	});
});

describe("nested event parsing and projection", () => {
	it("projects pending legacy events in memory while keeping active projection mutating by default", () => {
		const created = trackRoute("readonly-root");
		const legacyRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-events", path.basename(path.dirname(created.eventSink)));
		fs.mkdirSync(path.dirname(legacyRoot), { recursive: true });
		fs.renameSync(path.dirname(created.eventSink), legacyRoot);
		const route = { ...created, eventSink: path.join(legacyRoot, "events"), controlInbox: path.join(legacyRoot, "controls") };
		routes.push(route);
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 100, parentRunId: route.rootRunId, child: child("readonly-child", "running", 100, route.rootRunId) });
		assert.equal(projectNestedRegistryForRoot(route.rootRunId, { readOnlyLegacy: true })?.children[0].state, "running");
		assert.equal(fs.existsSync(path.join(legacyRoot, "registry.json")), false);
		assert.equal(projectNestedEvents(route).children[0].state, "running");
		assert.equal(readNestedRegistry(route).children[0].state, "running");
	});
	it("projects started, updated, and completed records into async and foreground parent state", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.started",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "running", 100),
		});
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 200,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-a", "running", 200), currentTool: "read" },
		});
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-a", "complete", 300),
		});

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.length, 1);
		assert.equal(registry.children[0]?.id, "nested-a");
		assert.equal(registry.children[0]?.state, "complete");
		assert.equal(registry.children[0]?.steps?.[0]?.agent, "leaf");

		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-0", status: "running", index: 0 },
				{ agent: "owner-1", status: "running", index: 1 },
			],
		};
		updateAsyncJobNestedProjection(job);
		assert.equal(job.nestedChildren?.[0]?.id, "nested-a");
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-a");

		const control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never = {
			runId: "root-run",
			mode: "single",
			startedAt: 1,
			updatedAt: 1,
			nestedRoute: route,
		};
		updateForegroundNestedProjection(control);
		assert.equal(control.nestedChildren?.[0]?.id, "nested-a");
	});

	it("attaches root children to visible step slices by original step index", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 3,
			child: { ...child("nested-visible", "running", 100), parentStepIndex: 3, path: [{ runId: "root-run", stepIndex: 3 }] },
		});
		const job: AsyncJobState = {
			asyncId: "root-run",
			asyncDir: "/tmp/root-run",
			status: "running",
			nestedRoute: route,
			steps: [
				{ agent: "owner-2", status: "running", index: 2 },
				{ agent: "owner-3", status: "running", index: 3 },
			],
		};

		updateAsyncJobNestedProjection(job);

		assert.equal(job.steps?.[0]?.children, undefined);
		assert.equal(job.steps?.[1]?.children?.[0]?.id, "nested-visible");
	});

	it("ignores corrupt, partial, wrong-token, duplicate, and stale records while preserving terminal state", () => {
		const route = trackRoute();
		fs.writeFileSync(path.join(route.eventSink, "0000000000001-corrupt.json"), "{not json", "utf-8");
		fs.writeFileSync(
			path.join(route.eventSink, "0000000000002-partial.jsonl"),
			`${JSON.stringify({
				type: "subagent.nested.started",
				ts: 50,
				rootRunId: route.rootRunId,
				parentRunId: "root-run",
				parentStepIndex: 1,
				capabilityToken: route.capabilityToken,
				child: child("partial-good", "running", 50),
			})}\n{"type":"subagent.nested.started"`,
			"utf-8",
		);
		writeNestedEvent(route, {
			type: "subagent.nested.completed",
			ts: 300,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: child("nested-terminal", "complete", 300),
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000400-stale.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 400,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("nested-terminal", "running", 100),
		})}\n`, "utf-8");
		fs.writeFileSync(path.join(route.eventSink, "0000000000500-wrong-token.json"), `${JSON.stringify({
			type: "subagent.nested.started",
			ts: 500,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: "wrong",
			child: child("wrong-token", "running", 500),
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);
		assert.equal(registry.children.find((item) => item.id === "partial-good")?.state, "running");
		assert.equal(registry.children.find((item) => item.id === "nested-terminal")?.state, "complete");
		assert.equal(registry.children.some((item) => item.id === "wrong-token"), false);
		assert.equal(hasLiveNestedDescendants(registry.children), true);
	});

	it("detects live descendants attached to terminal step children", () => {
		assert.equal(hasLiveNestedDescendants([{
			...child("terminal-parent", "complete", 300),
			steps: [{
				agent: "owner-step",
				status: "complete",
				children: [{
					...child("running-step-child", "running", 310, "terminal-parent"),
					parentStepIndex: 0,
					path: [{ runId: "terminal-parent", stepIndex: 0 }],
				}],
			}],
		}]), true);
	});

	it("accepts only complete numeric token usage at the nested event boundary", () => {
		const route = trackRoute();
		writeNestedEvent(route, {
			type: "subagent.nested.updated",
			ts: 100,
			parentRunId: "root-run",
			parentStepIndex: 1,
			child: { ...child("nested-valid-tokens", "running", 100), totalTokens: { input: 10, output: 15, total: 25 } },
		});
		fs.writeFileSync(path.join(route.eventSink, "0000000000200-invalid-tokens.json"), `${JSON.stringify({
			type: "subagent.nested.updated",
			ts: 200,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: { ...child("nested-invalid-tokens", "running", 200), totalTokens: { input: 1, output: "bad", total: 1 } },
		})}\n`, "utf-8");

		const registry = projectNestedEvents(route);

		assert.deepEqual(registry.children.find((item) => item.id === "nested-valid-tokens")?.totalTokens, { input: 10, output: 15, total: 25 });
		assert.equal(registry.children.find((item) => item.id === "nested-invalid-tokens")?.totalTokens, undefined);
	});

	it("parses only complete jsonl records", () => {
		const route = trackRoute();
		const records = parseNestedEventRecords(`${JSON.stringify({
			type: "subagent.nested.started",
			ts: 100,
			rootRunId: route.rootRunId,
			parentRunId: "root-run",
			parentStepIndex: 1,
			capabilityToken: route.capabilityToken,
			child: child("jsonl-good", "running", 100),
		})}\n{"type":"subagent.nested.started"`, route);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.child.id, "jsonl-good");
	});
});

describe("durable nested origins", () => {
	it("creates persistent routes and retains private origins through authenticated projection only", () => {
		const route = trackRoute();
		assert.equal(path.dirname(path.dirname(route.eventSink)), NESTED_EVENTS_DIR);
		assert.equal(NESTED_EVENTS_DIR, path.join(RUN_STATE_ROOT_DIR, "nested-subagent-events"));
		const runtime = { nodeExecPath: process.execPath, piEntryPath: path.resolve("pi.js"), piPackageRoot: path.resolve("package") };
		const origin = { ...child("origin", "running", 100), runtime, sessionRoot: path.resolve("sessions/origin") };
		writeNestedEvent(route, { type: "subagent.nested.started", ts: 100, parentRunId: "root-run", child: origin });
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: 200, parentRunId: "root-run", child: child("origin", "running", 200) });
		const projected = projectNestedRegistryForRoot("root-run")!.children[0];
		assert.deepEqual(projected.runtime, runtime);
		assert.equal(projected.sessionRoot, origin.sessionRoot);
		assert.deepEqual(readNestedRegistry(route).children[0].runtime, runtime);
		assert.equal(sanitizeSummary(projected)!.runtime, undefined);
		assert.equal(sanitizeSummary(projected)!.sessionRoot, undefined);
	});

	for (const update of ["runtime-only", "root-only", "complete-pair", "public-progress"] as const) {
		it(`preserves a stamped origin atomically across ${update} updates`, () => {
			const route = trackRoute();
			const runtime = { nodeExecPath: process.execPath, piEntryPath: path.resolve("pi.js"), piPackageRoot: path.resolve("package") };
			const sessionRoot = path.resolve("sessions/origin");
			const replacementRuntime = { ...runtime, piEntryPath: path.resolve("other-pi.js") };
			const metadata = update === "runtime-only" ? { runtime: replacementRuntime }
				: update === "root-only" ? { sessionRoot: path.resolve("sessions/other") }
				: update === "complete-pair" ? { runtime: replacementRuntime, sessionRoot: path.resolve("sessions/other") }
				: {};
			writeNestedEvent(route, { type: "subagent.nested.started", ts: 100, parentRunId: "root-run", child: { ...child("origin", "running", 100), runtime, sessionRoot } });
			projectNestedEvents(route);
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: 200, parentRunId: "root-run", child: { ...child("origin", "running", 200), ...metadata, currentTool: "read", turnCount: 2 } });
			const projected = projectNestedRegistryForRoot("root-run")!.children[0];
			assert.deepEqual(projected.runtime, runtime);
			assert.equal(projected.sessionRoot, sessionRoot);
			assert.equal(projected.currentTool, "read");
			assert.equal(projected.turnCount, 2);
			assert.equal(projected.lastUpdate, 200);
			const stored = readNestedRegistry(route).children[0];
			assert.deepEqual(stored.runtime, runtime);
			assert.equal(stored.sessionRoot, sessionRoot);
			assert.equal(sanitizeSummary(stored)!.runtime, undefined);
			assert.equal(sanitizeSummary(stored)!.sessionRoot, undefined);
		});
	}

	for (const container of ["children", "steps", "children-to-steps", "steps-to-children", "step-position", "deep-children"] as const) {
		it(`preserves embedded origins by ID across ${container} snapshots`, () => {
			const runtime = { nodeExecPath: process.execPath, piEntryPath: path.resolve("pi.js"), piPackageRoot: path.resolve("package") };
			const sessionRoot = path.resolve("sessions/origin");
			const origin = { ...child("origin", "running", 100, "parent"), runtime, sessionRoot };
			const inSteps = container === "steps" || container === "steps-to-children" || container === "step-position";
			const parent = { ...child("parent", "running", 100), ...(inSteps ? { steps: [{ id: "owner-id", agent: "owner", status: "running" as const, children: [origin] }] } : { children: container === "deep-children" ? [{ ...child("middle", "running", 100, "parent"), children: [origin] }] : [origin] }) };
			const registry = { rootRunId: "root-run", updatedAt: 100, children: [parent], processedEvents: [] };
			const before = structuredClone(registry);
			for (const metadata of [{}, { runtime: { ...runtime, piEntryPath: path.resolve("other-pi.js") } }, { sessionRoot: path.resolve("sessions/other") }, { runtime: { ...runtime, piEntryPath: path.resolve("other-pi.js") }, sessionRoot: path.resolve("sessions/other") }]) {
				const snapshot = { ...child("origin", "complete", 200, "parent"), ...metadata, currentTool: "read", turnCount: 2 };
				const toSteps = container === "steps" || container === "children-to-steps" || container === "step-position";
				const steps = [{ id: "owner-id", agent: "owner", status: "complete" as const, children: [snapshot] }];
				if (container === "step-position") steps.unshift({ id: "other-id", agent: "other", status: "complete", children: [] });
				const event = { type: "subagent.nested.updated" as const, ts: 200, rootRunId: "root-run", parentRunId: "root-run", capabilityToken: "token", child: { ...child("parent", "running", 200), children: toSteps ? [] : container === "deep-children" ? [{ ...child("middle", "running", 200, "parent"), children: [snapshot] }] : [snapshot], steps: toSteps ? steps : [] } };
				const eventBefore = structuredClone(event);
				const result = applyNestedEvent(registry, event);
				const stored = findNestedRun(result.children, "origin")!;
				assert.deepEqual(stored.runtime, runtime);
				assert.equal(stored.sessionRoot, sessionRoot);
				assert.equal(stored.currentTool, "read");
				assert.equal(stored.turnCount, 2);
				assert.equal(stored.state, "complete");
				assert.equal(findNestedRun([sanitizeSummary(result.children[0])!], "origin")!.runtime, undefined);
				assert.equal(findNestedRun([sanitizeSummary(result.children[0])!], "origin")!.sessionRoot, undefined);
				assert.deepEqual(registry, before);
				assert.deepEqual(event, eventBefore);
			}
		});
	}

	it("rejects present malformed private metadata instead of accepting it as legacy", () => {
		const route = trackRoute();
		for (const metadata of [{ runtime: null }, { runtime: {} }, { sessionRoot: "relative" }, { sessionRoot: null }]) {
			assert.throws(() => writeNestedEvent(route, { type: "subagent.nested.started", ts: 100, parentRunId: "root-run", child: { ...child("bad", "running", 100), ...metadata } as any }), /validation/);
		}
		assert.ok(sanitizeSummary(child("legacy", "running", 100)));
		const forged = { type: "subagent.nested.started", ts: 100, rootRunId: route.rootRunId, parentRunId: "root-run", capabilityToken: "forged", child: { ...child("forged", "running", 100), sessionRoot: RUN_STATE_ROOT_DIR } };
		assert.deepEqual(parseNestedEventRecords(JSON.stringify(forged), route), []);
	});

	it("preserves authorized legacy routes and deduplicates IDs with persistent precedence", () => {
		const persistent = trackRoute();
		const legacyRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-events", `root-run-${persistent.capabilityToken}`);
		fs.cpSync(path.dirname(persistent.eventSink), legacyRoot, { recursive: true });
		const legacy = { ...persistent, eventSink: path.join(legacyRoot, "events"), controlInbox: path.join(legacyRoot, "controls") };
		routes.push(legacy);
		assert.deepEqual(resolveNestedRouteFromEnv(nestedRouteEnv(legacy)), legacy);
		for (const route of [persistent, legacy]) writeNestedEvent(route, { type: "subagent.nested.started", ts: 100, parentRunId: "root-run", child: child("same-id", "running", 100) });
		writeNestedEvent(legacy, { type: "subagent.nested.started", ts: 101, parentRunId: "root-run", child: child("same-other", "running", 101) });
		assert.equal(findNestedRunMatchesById("same-id").length, 1);
		assert.equal(findNestedRunMatchesById("same-id")[0].route.eventSink, persistent.eventSink);
		assert.equal(findNestedRunMatchesById("same", { prefix: true }).length, 2);
		for (const ordered of [[persistent, legacy], [legacy, persistent]]) {
			const matches = findNestedRunMatchesById("same-id", { scope: { routes: ordered } });
			assert.equal(matches.length, 1);
			assert.equal(matches[0].route.eventSink, persistent.eventSink);
		}
		writeNestedEvent(persistent, { type: "subagent.nested.updated", ts: 200, parentRunId: "sibling", child: child("same-id", "running", 200, "sibling") });
		assert.equal(findNestedRunMatchesById("same-id", { scope: { routes: [legacy, persistent], descendantOf: { parentRunId: "root-run" } } }).length, 0);
		assert.equal(findNestedRunMatchesById("same", { prefix: true, scope: { routes: [legacy], descendantOf: { parentRunId: "sibling" } } }).length, 0);
		assert.throws(() => resolveNestedRouteFromEnv(nestedRouteEnv({ ...legacy, eventSink: path.resolve("outside/events") })), /outside/);
	});

	for (const scenario of ["different-root", "different-token", "same-store-copy", "duplicate-record"] as const) {
		it(`preserves ambiguous matches for ${scenario}`, () => {
			const first = trackRoute();
			writeNestedEvent(first, { type: "subagent.nested.started", ts: 100, parentRunId: "root-run", child: child("duplicate-id", "running", 100) });
			projectNestedEvents(first);
			let second = first;
			if (scenario === "duplicate-record") {
				const file = path.join(path.dirname(first.eventSink), "registry.json");
				const registry = JSON.parse(fs.readFileSync(file, "utf-8"));
				registry.children.push(registry.children[0]);
				fs.writeFileSync(file, JSON.stringify(registry));
			} else if (scenario === "same-store-copy") {
				const copyRoot = `${path.dirname(first.eventSink)}-copy`;
				fs.cpSync(path.dirname(first.eventSink), copyRoot, { recursive: true });
				second = { ...first, eventSink: path.join(copyRoot, "events"), controlInbox: path.join(copyRoot, "controls") };
				routes.push(second);
			} else {
				second = trackRoute(scenario === "different-root" ? "other-root" : "root-run");
				writeNestedEvent(second, { type: "subagent.nested.started", ts: 100, parentRunId: second.rootRunId, child: child("duplicate-id", "running", 100, second.rootRunId) });
				const legacyRoot = path.join(TEMP_ROOT_DIR, "nested-subagent-events", `${second.rootRunId}-${second.capabilityToken}`);
				fs.renameSync(path.dirname(second.eventSink), legacyRoot);
				second = { ...second, eventSink: path.join(legacyRoot, "events"), controlInbox: path.join(legacyRoot, "controls") };
				routes.push(second);
			}
			for (const ordered of scenario === "duplicate-record" ? [[first]] : [[first, second], [second, first]]) {
				assert.equal(findNestedRunMatchesById("duplicate-id", { scope: { routes: ordered } }).length, 2);
				assert.equal(findNestedRunMatchesById("duplicate", { prefix: true, scope: { routes: ordered } }).length, 2);
			}
		});
	}

	it("contains explicit nested directories in either run-specific root and rejects siblings", () => {
		for (const root of [RUN_STATE_ROOT_DIR, TEMP_ROOT_DIR]) {
			const runRoot = path.join(root, "nested-subagent-runs", "root-run", "nested-a");
			assert.equal(resolveNestedAsyncDir("root-run", { ...child("nested-a", "running", 100), asyncDir: runRoot }), runRoot);
			assert.equal(resolveNestedAsyncDir("root-run", { ...child("nested-a", "running", 100), asyncDir: path.join(runRoot, "..", "sibling") }), undefined);
		}
		assert.equal(resolveNestedAsyncDir("../escape", { ...child("nested-a", "running", 100), asyncDir: path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs/../escape/nested-a") }), undefined);
		assert.equal(isTopLevelAsyncDir(path.join(ASYNC_DIR, "top")), true);
		assert.equal(isTopLevelAsyncDir(path.join(LEGACY_ASYNC_DIR, "top")), true);
		assert.equal(isTopLevelAsyncDir(path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs/root-run/nested-a")), false);
		const route = trackRoute();
		const escape = path.join(route.eventSink, "escape");
		fs.symlinkSync(TEMP_ROOT_DIR, escape, "dir");
		assert.equal(resolveNestedAsyncDir("root-run", { ...child("nested-a", "running", 100), asyncDir: escape }), undefined);
		assert.throws(() => resolveNestedRouteFromEnv(nestedRouteEnv({ ...route, eventSink: path.join(escape, "events") })), /outside/);
		assert.throws(() => resolveNestedRouteFromEnv(nestedRouteEnv({ ...route, controlInbox: path.join(NESTED_EVENTS_DIR, "other/controls") })), /share one route root/);
	});
});
