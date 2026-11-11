import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { TEMP_ROOT_DIR, type SubagentState } from "../../src/shared/types.ts";
import { listStopTargets, resolveSubagentRunId, updateBackgroundStopInventory } from "../../src/runs/background/run-id-resolver.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";

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

	it("resolves every child from event projection, including the seventeenth row", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stop-ids-"));
		const route = nested("projection-root", "projection-run");
		try {
			for (let index = 0; index < 16; index++) writeNestedEvent(route, {
				type: "subagent.nested.child", ts: 200 + index, runId: "projection-run", index,
				id: `child-${String(index).padStart(2, "0")}`, agent: "worker", status: "running",
			});
			const deps = { target: "interrupt" as const, asyncDirRoot: root, nested: { routes: [route] } };
			assert.equal(resolveSubagentRunId("child-00", deps)?.id, "child-00");
			writeNestedEvent(route, { type: "subagent.nested.child", ts: 216, runId: "projection-run", index: 16,
				id: "child-16", agent: "worker", status: "running" });
			for (let index = 0; index < 17; index++) {
				const id = `child-${String(index).padStart(2, "0")}`;
				assert.equal(resolveSubagentRunId(id, deps)?.id, id);
			}
			assert.throws(() => resolveSubagentRunId("child-", deps), /Ambiguous stop id.*child:/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
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
