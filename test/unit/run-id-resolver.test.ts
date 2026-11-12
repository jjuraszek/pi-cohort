import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";
import { listStopTargets, resolveSubagentRunId, updateBackgroundStopInventory } from "../../src/runs/background/run-id-resolver.ts";
import { createNestedRoute, nestedRouteEnv, projectNestedEvents, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { registerForegroundInterrupt, stopForegroundTarget, type ForegroundControl } from "../../src/runs/shared/stop-control.ts";
import { startNestedControlInboxListener } from "../../src/extension/fanout-child.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";

const routeRoots: string[] = [];

afterEach(() => {
	for (const root of routeRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function stateWithForeground(id: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundRuns: new Map(),
		foregroundControls: new Map([[id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 }]]),
		lastForegroundControlId: id,
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

function nested(rootRunId: string, id: string) {
	const route = createNestedRoute(rootRunId);
	routeRoots.push(path.dirname(route.eventSink));
	writeNestedChild(route, rootRunId, id, 0);
	return route;
}

function writeNestedChild(route: ReturnType<typeof createNestedRoute>, parentRunId: string, id: string, parentStepIndex?: number) {
	writeNestedEvent(route, {
		type: "subagent.nested.updated",
		ts: 100,
		parentRunId,
		...(parentStepIndex !== undefined ? { parentStepIndex } : {}),
		child: { id, parentRunId, ...(parentStepIndex !== undefined ? { parentStepIndex } : {}), depth: 1, path: [{ runId: parentRunId, ...(parentStepIndex !== undefined ? { stepIndex: parentStepIndex } : {}) }], state: "running", agent: "worker" },
	});
}

function stateWithNestedRoute(route: ReturnType<typeof createNestedRoute>): SubagentState {
	const state = stateWithForeground("foreground-only");
	state.foregroundControls.set(route.rootRunId, { runId: route.rootRunId, mode: "single", startedAt: 1, updatedAt: 1, nestedRoute: route });
	return state;
}

describe("subagent run id resolver", () => {
	it("deduplicates full IDs with persistent precedence but rejects distinct cross-root prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-two-roots-"));
		try {
			const roots = [path.join(root, "persistent"), path.join(root, "legacy")];
			for (const dir of roots) fs.mkdirSync(dir, { recursive: true });
			fs.mkdirSync(path.join(roots[0], "run-one"));
			fs.symlinkSync(root, path.join(roots[1], "run-one"));
			const deps = { asyncDirRoot: roots, resultsDir: path.join(root, "results"), nested: { routes: [] } };
			const exact = resolveSubagentRunId("run-one", deps);
			assert.equal(exact?.kind, "async");
			if (exact?.kind === "async") assert.equal(exact.location.asyncDir, path.join(roots[0], "run-one"));
			assert.equal(resolveSubagentRunId("run-", deps)?.id, "run-one");
			fs.mkdirSync(path.join(roots[1], "run-two"));
			assert.throws(() => resolveSubagentRunId("run-", deps), /Ambiguous/);
			assert.equal(resolveSubagentRunId("run-two", { ...deps, asyncDirRoot: roots[0] }), undefined);
			fs.rmSync(path.join(roots[0], "run-one"), { recursive: true });
			fs.symlinkSync(root, path.join(roots[0], "run-one"));
			assert.throws(() => resolveSubagentRunId("run-one", deps), /must be inside/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("prefers exact foreground, then exact async, then exact nested before prefix matches", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-resolver-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "shared-id"), { recursive: true });
			nested("root-shared", "shared-id");
			nested("root-prefix", "shared-id-child");

			assert.equal(resolveSubagentRunId("shared-id", { state: stateWithForeground("shared-id"), asyncDirRoot: asyncRoot, resultsDir })?.kind, "foreground");
			assert.equal(resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir })?.kind, "async");
			fs.rmSync(path.join(asyncRoot, "shared-id"), { recursive: true, force: true });
			const resolved = resolveSubagentRunId("shared-id", { asyncDirRoot: asyncRoot, resultsDir });
			assert.equal(resolved?.kind, "nested");
			assert.equal(resolved?.id, "shared-id");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports one combined ambiguity for prefixes across namespaces", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "fanout-async"), { recursive: true });
			nested("root-fanout", "fanout-nested");
			assert.throws(
				() => resolveSubagentRunId("fanout", { asyncDirRoot: asyncRoot, resultsDir }),
				/Ambiguous subagent run id prefix 'fanout' matched: async:fanout-async, nested:fanout-nested/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("limits nested lookup to active state routes when state is provided", () => {
		const allowed = nested("root-allowed", "shared-nested");
		nested("root-outside", "shared-nested");

		assert.throws(
			() => resolveSubagentRunId("shared-nested"),
			/ambiguous across authorized registries|ambiguous across registries/i,
		);
		assert.throws(() => resolveSubagentRunId("shared-"), /Ambiguous subagent run id prefix/);
		assert.equal(resolveSubagentRunId("shared-nested", { state: stateWithForeground("foreground-only") }), undefined);
		const resolved = resolveSubagentRunId("shared-nested", { state: stateWithNestedRoute(allowed) });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.kind === "nested" ? resolved.match.rootRunId : undefined, "root-allowed");
	});

	it("limits nested lookup to descendants of a scoped child address", () => {
		const route = createNestedRoute("root-scoped");
		routeRoots.push(path.dirname(route.eventSink));
		writeNestedChild(route, "root-scoped", "same-child-zero", 0);
		writeNestedChild(route, "root-scoped", "same-child-one", 1);

		assert.throws(
			() => resolveSubagentRunId("same-child", { nested: { routes: [route] } }),
			/Ambiguous subagent run id prefix 'same-child'/,
		);
		const resolved = resolveSubagentRunId("same-child", { nested: { routes: [route], descendantOf: { parentRunId: "root-scoped", parentStepIndex: 0 } } });
		assert.equal(resolved?.kind, "nested");
		assert.equal(resolved?.id, "same-child-zero");
		assert.equal(resolved?.kind === "nested" ? resolved.match.run.parentStepIndex : undefined, 0);
	});

	it("reports async prefix ambiguity without parsing resolver error text", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-run-id-async-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(path.join(asyncRoot, "dupe-one"), { recursive: true });
			fs.mkdirSync(path.join(asyncRoot, "dupe-two"), { recursive: true });

			assert.throws(
				() => resolveSubagentRunId("dupe", { asyncDirRoot: asyncRoot, resultsDir }),
				/Ambiguous subagent run id prefix 'dupe' matched: async:dupe-one, async:dupe-two/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves and stops all 17 maximum-field projected children without stopping siblings", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-ids-"));
		const route = nested("projection-root", "projection-run");
		const env = nestedRouteEnv(route);
		const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
		Object.assign(process.env, env);
		const ids = Array.from({ length: 17 }, (_, index) => `child-${String(index).padStart(2, "0")}`);
		const sessionFile = "s".repeat(2048);
		const currentPath = "p".repeat(2048);
		const stops = ids.map(() => 0);
		const control: ForegroundControl = { runId: "projection-run", mode: "parallel", startedAt: 1, updatedAt: 1,
			nestedRoute: route, children: new Map(ids.map((id, index) => [id, { agent: "worker", index, state: "running" }])) };
		control.interrupt = (id) => stopForegroundTarget(control, id);
		for (const [index, id] of ids.entries()) registerForegroundInterrupt(control, id, () => {
			stops[index]++;
			control.children.get(id)!.state = "interrupted";
			return true;
		});
		const ownerState = stateWithForeground(control.runId);
		ownerState.foregroundControls.set(control.runId, control);
		const timer = startNestedControlInboxListener({} as any, ownerState);
		const state = stateWithNestedRoute(route);
		const executor = createSubagentExecutor({ state, captureRuntime: () => { throw new Error("stop routing must not launch a child"); },
			pi: { events: { emit() {}, on() { return () => {}; } }, getSessionName: () => "parent" } as any,
			resolveConfig: () => ({ maxSubagentDepth: 2, control: {} } as any), tempArtifactsDir: root,
			getSubagentSessionRoot: () => root, expandTilde: (value) => value, discoverAgents: () => ({ agents: [] }),
		});
		try {
			assert.ok(timer, "the owned child control listener must be active");
			const deps = { state, target: "interrupt" as const, asyncDirRoot: root, nested: { routes: [route] } };
			for (const [index, id] of ids.entries()) {
				writeNestedEvent(route, { type: "subagent.nested.child", ts: 200 + index, runId: control.runId,
					index, id, agent: "worker", status: "running", sessionFile, currentPath });
				if (index === 15) assert.equal(resolveSubagentRunId(ids[0], deps)?.id, ids[0]);
			}
			const steps = projectNestedEvents(route).children[0].steps!;
			assert.deepEqual(steps.map((step) => step.id), ids);
			for (const step of steps) {
				assert.equal(step.sessionFile, sessionFile);
				assert.equal(step.currentPath, currentPath);
				assert.equal(step.status, "running");
			}
			assert.throws(() => resolveSubagentRunId("child-", deps), /Ambiguous stop id.*child:/);
			for (const [index, id] of ids.entries()) {
				const resolved = resolveSubagentRunId(id, deps)!;
				assert.equal(resolved.id, id);
				assert.equal(resolved.kind, "child");
				assert.equal(resolved.owner.kind, "nested", "the caller must route through the projection, not the owner's live map");
				const result = await executor.execute(`stop-${index}`, { action: "interrupt", id }, undefined, undefined, {
					cwd: root, hasUI: false,
					sessionManager: { getSessionId: () => "test", getSessionFile: () => undefined, getSessionName: () => undefined },
				} as any);
				assert.notEqual(result.isError, true, JSON.stringify(result.content));
				assert.equal(stops[index], 1, `${id} must stop`);
				assert.deepEqual(stops, ids.map((_, sibling) => sibling <= index ? 1 : 0), `${id} must not stop unrelated siblings`);
				for (const [sibling, siblingId] of ids.entries()) {
					assert.equal(control.children.get(siblingId)!.state, sibling <= index ? "interrupted" : "running");
					assert.equal(Boolean(control.children.get(siblingId)!.stopRequested), sibling <= index);
				}
				assert.notEqual(control.stopping, true);
			}
		} finally {
			if (timer) clearInterval(timer);
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key]; else process.env[key] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers a live nested async owner over its event projection without duplicate matches", () => {
		const route = nested("async-root", "nested-async");
		const dir = path.join(TEMP_ROOT_DIR, "nested-subagent-runs", route.rootRunId, "nested-async");
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running", pid: process.pid,
				steps: [{ id: "async-leaf", agent: "worker", status: "running" }] }));
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: 200, parentRunId: route.rootRunId,
				child: { id: "nested-async", parentRunId: route.rootRunId, depth: 1, path: [{ runId: route.rootRunId }],
					state: "running", agent: "worker", asyncDir: dir,
					steps: [{ id: "async-leaf", index: 0, agent: "worker", status: "running" }] } });
			const targets = listStopTargets({ state: stateWithNestedRoute(route), asyncDirRoot: path.dirname(dir) }, true);
			assert.equal(targets.filter((entry) => entry.id === "async-leaf").length, 1);
			assert.equal(targets.find((entry) => entry.id === "async-leaf")?.owner.kind, "async");
		} finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
	});

	it("keeps settled collisions and exact winners in the stop namespace, not status/resume", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-prefix-"));
		try {
			const state = stateWithForeground("abcd-run");
			state.foregroundControls.get("abcd-run")!.children = new Map([
				["abcd", { agent: "scout", state: "running" }],
				["abcd-settled", { agent: "reviewer", state: "completed" }],
			]);
			const deps = { state, asyncDirRoot: root, resultsDir: root };
			assert.equal(resolveSubagentRunId("abcd", { ...deps, target: "interrupt" })?.kind, "child");
			assert.throws(() => resolveSubagentRunId("abcd-", { ...deps, target: "interrupt" }), /run:.*child:/);
			assert.throws(() => resolveSubagentRunId("abc", { ...deps, target: "interrupt" }), /too short/);
			assert.throws(() => resolveSubagentRunId("missing", { ...deps, target: "interrupt" }), /No running subagent matches 'missing'/);
			assert.equal(resolveSubagentRunId("a", deps)?.id, "abcd-run");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const route of ["foreground", "background"] as const) {
		for (const mode of ["parallel", "chain"] as const) {
			it(`names ${route} ${mode} run collisions by the displayed mode, not the active agent`, () => {
				const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-run-name-"));
				try {
					const runId = "abcdef-run";
					const childId = "abcdef-child";
					const state = stateWithForeground(runId);
					if (route === "foreground") {
						Object.assign(state.foregroundControls.get(runId)!, { mode, currentAgent: "scout",
							children: new Map([[childId, { agent: "scout", label: "Inspect", state: "running" }]]) });
					} else {
						state.foregroundControls.clear();
						const dir = path.join(root, runId);
						fs.mkdirSync(dir);
						fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ mode, state: "running", pid: process.pid,
							steps: [{ id: childId, agent: "scout", label: "Inspect", status: "running" }] }));
					}
					assert.throws(() => resolveSubagentRunId("abcdef", { state, target: "interrupt", asyncDirRoot: root, nested: { routes: [] } }),
						{ message: `Ambiguous stop id 'abcdef': run:abcdef-r ${mode}, child:abcdef-c scout. Provide a longer id.` });
				} finally { fs.rmSync(root, { recursive: true, force: true }); }
			});
		}
	}

	it("uses a tracked background run's displayed name instead of reconstructing it from status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-tracked-name-"));
		try {
			const state = stateWithForeground("unused-root");
			const dir = path.join(root, "abcdef-run");
			fs.mkdirSync(dir);
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ mode: "single", state: "running", pid: process.pid,
				steps: [{ id: "abcdef-child", agent: "scout", label: "Inspect", status: "running" }] }));
			state.asyncJobs.set("abcdef-run", { asyncId: "abcdef-run", asyncDir: dir, status: "running", mode: "single", agents: ["displayed-agent"] });
			assert.throws(() => resolveSubagentRunId("abcdef", { state, target: "interrupt", asyncDirRoot: root, nested: { routes: [] } }),
				{ message: "Ambiguous stop id 'abcdef': run:abcdef-r displayed-agent, child:abcdef-c scout. Provide a longer id." });
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const { name, run, displayed } of [
		{ name: "single agent", run: { agent: "scout" }, displayed: "scout" },
		{ name: "repeated agents", run: { agents: ["scout", "scout"] }, displayed: "scout ×2" },
		{ name: "many agents", run: { agents: ["scout", "planner", "worker", "reviewer"] }, displayed: "scout, planner +2 more" },
		{ name: "mode fallback", run: { mode: "chain" as const }, displayed: "chain" },
	]) {
		it(`names nested run collisions by the displayed ${name} and child collisions by agent only`, () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-nested-name-"));
			const route = createNestedRoute("name-root");
			routeRoots.push(path.dirname(route.eventSink));
			try {
				writeNestedEvent(route, { type: "subagent.nested.updated", ts: 100, parentRunId: route.rootRunId,
					child: { id: "abcdef-run", parentRunId: route.rootRunId, depth: 1, path: [{ runId: route.rootRunId }],
						state: "running", ...run, steps: [{ id: "abcdef-child", index: 0, agent: "scout", label: "Inspect", status: "running" }] } });
				assert.throws(() => resolveSubagentRunId("abcdef", { target: "interrupt", asyncDirRoot: root, nested: { routes: [route] } }),
					{ message: `Ambiguous stop id 'abcdef': run:abcdef-r ${displayed}, child:abcdef-c scout. Provide a longer id.` });
			} finally { fs.rmSync(root, { recursive: true, force: true }); }
		});
	}

	it("reads terminal status once, refreshes changed live status and reuses tracker-fed status", (t) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-cache-"));
		try {
			const dir = path.join(root, "cache-run"); fs.mkdirSync(dir);
			const file = path.join(dir, "status.json");
			const write = (state: string, agent: string) => fs.writeFileSync(file, JSON.stringify({ state, pid: process.pid, steps: [{ id: "cache-child", agent, status: state }] }));
			write("running", "scout");
			const read = t.mock.method(fs, "readFileSync"); syncBuiltinESMExports();
			t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
			const resolve = () => resolveSubagentRunId("cache-child", { target: "interrupt", asyncDirRoot: root, nested: { routes: [] } });
			const reads = () => read.mock.calls.filter((call) => call.arguments[0] === file).length;
			assert.equal(resolve()?.name, "scout"); assert.equal(resolve()?.name, "scout");
			assert.equal(reads(), 1);
			write("complete", "reviewer"); fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
			assert.equal(resolve()?.name, "reviewer"); assert.equal(resolve()?.state, "completed");
			assert.equal(reads(), 2);
			updateBackgroundStopInventory(dir, { state: "running", pid: process.pid, steps: [{ id: "cache-child", agent: "fed", status: "running" }] }, fs.statSync(file).mtimeMs);
			assert.equal(resolve()?.name, "fed"); assert.equal(reads(), 2);
			assert.ok(listStopTargets({ asyncDirRoot: root }, false).some((target) => target.id === "cache-child"));
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects unsafe nested id tokens before lookup", () => {
		assert.throws(() => resolveSubagentRunId("../run"), /safe id token/);
		assert.throws(() => resolveSubagentRunId("a/b"), /safe id token/);
		assert.throws(() => resolveSubagentRunId(""), /safe id token/);
	});
});
