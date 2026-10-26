import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
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
import { RUN_STATE_ROOT_DIR, ASYNC_DIR, type SubagentState } from "../../src/shared/types.ts";

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
		cwd: root, hasUI: false, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "parent" },
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
		sessionManager: { getSessionId() { return "session"; }, getSessionFile() { return sessionFile; } },
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

describe("nested control routing", () => {
	it("routes interrupt to an explicit nested id through the control inbox", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nested-control-"));
		try {
			const route = createNestedRun();
			const executor = createExecutor(stateWithNestedRoute(route));
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				assert.ok(request, "expected a nested control request");
				writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "nested interrupt accepted" });
			}, 50);

			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-live" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, undefined);
			assert.match(text(result), /nested interrupt accepted/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
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
				nestedRoute: route,
			});
			state.lastForegroundControlId = "root-control";

			const result = await createExecutor(state).execute("status", { action: "status", id: "root-control" }, new AbortController().signal, undefined, ctx(root));

			assert.equal(result.isError, undefined);
			assert.match(text(result), /Run: root-control/);
			assert.match(text(result), /↳ worker \[nested-foreground\] running/);
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
			setTimeout(() => {
				const request = readNestedControlRequests(route)[0];
				if (request) writeNestedControlResult(route, { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: true, message: "late success" });
			}, 1_200);
			const result = await executor.execute("interrupt", { action: "interrupt", id: "nested-timeout" }, new AbortController().signal, undefined, ctx(root));
			assert.equal(result.isError, true);
			assert.match(text(result), /owner is not reachable/);
			assert.doesNotMatch(text(result), /late success/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

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
				const controlResult = { ts: Date.now(), requestId: request.requestId, targetRunId: request.targetRunId, ok: false, message: `Nested run ${request.targetRunId} is still active; wait for completion, then resume.` };
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
			fs.writeFileSync(sessionFile, "history\n");
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
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes(route.controlInbox) && String(entry[0] ?? "").includes("root-poll-error")));

			fs.rmSync(route.controlInbox, { force: true });
			fs.mkdirSync(route.controlInbox, { recursive: true });
			const requestPath = writeNestedControlRequest(route, {
				ts: Date.now(),
				requestId: "poll-error-recovers",
				targetRunId: "missing-run",
				action: "interrupt",
			});

			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "poll-error-recovers" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
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
			targetRunId: "missing-run",
			action: "interrupt",
		});
		const originalError = console.error;
		const logged: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			logged.push(args);
		};
		try {
			registerFanoutChildSubagentExtension(pi);
			await waitFor(() => logged.some((entry) => String(entry[0] ?? "").includes("result-write-fails") && /keeping request for retry/.test(String(entry[0] ?? ""))));
			assert.equal(fs.existsSync(requestPath), true);

			fs.rmSync(route.eventSink, { force: true });
			fs.mkdirSync(route.eventSink, { recursive: true });
			await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "result-write-fails" && result.ok === false));
			assert.equal(fs.existsSync(requestPath), false);
		} finally {
			console.error = originalError;
		}
	});

	it("negatively acknowledges ownerless fanout child control requests and removes them", async () => {
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
			targetRunId: "missing-run",
			action: "interrupt",
		});

		registerFanoutChildSubagentExtension(pi);
		await waitFor(() => readNestedControlResults(route).some((result) => result.requestId === "ownerless-request" && result.ok === false));

		assert.equal(fs.existsSync(requestPath), false);
		const result = readNestedControlResults(route).find((item) => item.requestId === "ownerless-request");
		assert.match(result?.message ?? "", /not active/);
	});
});
