import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ASYNC_DIR, LEGACY_ASYNC_DIR, RUN_STATE_ROOT_DIR, TEMP_ROOT_DIR, type AsyncJobState, type SubagentState } from "../../src/shared/types.ts";
import {
	createNestedRoute,
	applyNestedEvent,
	findNestedRun,
	NESTED_EVENTS_DIR,
	findNestedRunMatchesById,
	isTopLevelAsyncDir,
	nestedRouteEnv,
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
		steps: [{ agent: "leaf", status: state === "running" ? "running" as const : "complete" as const }],
	};
}

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
			const parent = { ...child("parent", "running", 100), ...(inSteps ? { steps: [{ agent: "owner", status: "running" as const, children: [origin] }] } : { children: container === "deep-children" ? [{ ...child("middle", "running", 100, "parent"), children: [origin] }] : [origin] }) };
			const registry = { rootRunId: "root-run", updatedAt: 100, children: [parent], processedEvents: [] };
			const before = structuredClone(registry);
			for (const metadata of [{}, { runtime: { ...runtime, piEntryPath: path.resolve("other-pi.js") } }, { sessionRoot: path.resolve("sessions/other") }, { runtime: { ...runtime, piEntryPath: path.resolve("other-pi.js") }, sessionRoot: path.resolve("sessions/other") }]) {
				const snapshot = { ...child("origin", "complete", 200, "parent"), ...metadata, currentTool: "read", turnCount: 2 };
				const toSteps = container === "steps" || container === "children-to-steps" || container === "step-position";
				const steps = [{ agent: "owner", status: "complete" as const, children: [snapshot] }];
				if (container === "step-position") steps.unshift({ agent: "other", status: "complete", children: [] });
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
