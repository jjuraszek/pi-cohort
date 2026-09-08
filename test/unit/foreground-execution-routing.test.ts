import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ExecutionBackendSelectionResult } from "../../src/execution-backend/selection.ts";
import type { ExecutionBackend, ExecutionSurfaceHandle } from "../../src/execution-backend/types.ts";
import { runSync, type RunSyncDependencies } from "../../src/runs/foreground/execution.ts";
import type { ExternalForegroundExecution, ExternalForegroundExecutionOptions } from "../../src/runs/foreground/external-execution.ts";
import type { RunExternalSingleAttemptInput } from "../../src/runs/foreground/external-single-attempt.ts";
import { snapshotResult } from "../../src/runs/foreground/attempt-finalization.ts";
import type { SingleResult } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

const handle: ExecutionSurfaceHandle = {
	protocolVersion: 1,
	backend: "fake",
	surface: { kind: "test", id: "surface-1" },
	display: { label: "safe surface", hint: "safe hint" },
	data: null,
};

const backend: ExecutionBackend = {
	name: "fake",
	protocolVersion: 1,
	async detect() { return { available: true, version: "1", capabilities: [] }; },
	async launch() { throw new Error("unused"); },
	async reattach() { return { status: "gone" }; },
	async close() {},
};

function result(agent: AgentConfig, task: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		finalOutput: "done",
		...overrides,
	};
}

function dependencies(selection: ExecutionBackendSelectionResult) {
	const selected: Array<{ cwd: string; userConfig: { executionBackend?: string } }> = [];
	const ownerOptions: ExternalForegroundExecutionOptions[] = [];
	const attempts: RunExternalSingleAttemptInput[] = [];
	const finishes: string[] = [];
	let nativeCalls = 0;
	const owner: ExternalForegroundExecution = {
		surface: handle,
		ready: Promise.resolve(),
		async runAttempt() { throw new Error("unused"); },
		async finish(disposition) {
			finishes.push(disposition);
			return { handle, retained: disposition === "retained" };
		},
	};
	const deps: RunSyncDependencies = {
		async selectBackend(input) { selected.push(input); return selection; },
		async createExternalOwner(options) { ownerOptions.push(options); return owner; },
		async runNativeAttempt(_runtimeCwd, agent, task) { nativeCalls++; return result(agent, task); },
		async runExternalAttempt(input) { attempts.push(input); return result(input.agent, input.task); },
	};
	return { deps, selected, ownerOptions, attempts, finishes, nativeCalls: () => nativeCalls, owner };
}

const nativeSelection: ExecutionBackendSelectionResult = { selection: { kind: "native" }, diagnostics: [] };
const externalSelection: ExecutionBackendSelectionResult = {
	selection: { kind: "external", backend, detection: { available: true, version: "1", capabilities: [] } },
	diagnostics: [],
};
const noAcceptance = { level: "none" as const, reason: "routing test" };

describe("runSync execution backend routing", () => {
	it("keeps explicit native and auto/no-adapter on the native attempt path without an owner", async () => {
		for (const executionBackend of ["native", "auto"]) {
			const h = dependencies(nativeSelection);
			const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: `run-${executionBackend}`, cwd: "/exact", executionBackend, acceptance: noAcceptance,
			}, h.deps);
			assert.equal(output.exitCode, 0);
			assert.equal(h.nativeCalls(), 1);
			assert.equal(h.ownerOptions.length, 0);
			assert.deepEqual(h.selected, [{ cwd: "/exact", userConfig: { executionBackend } }]);
		}
	});

	it("returns the safe selector error before spawning", async () => {
		let nativeCalls = 0;
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
			runId: "run", executionBackend: "missing", acceptance: noAcceptance,
		}, {
			async selectBackend() { throw new Error("Execution backend 'missing' is not registered"); },
			async runNativeAttempt() { nativeCalls++; throw new Error("must not spawn"); },
		});
		assert.equal(nativeCalls, 0);
		assert.equal(output.exitCode, 1);
		assert.equal(output.error, "Execution backend 'missing' is not registered");
	});

	it("creates one owner and reuses it across uniquely identified fallback attempts", async () => {
		const h = dependencies(externalSelection);
		h.deps.runExternalAttempt = async input => {
			h.attempts.push(input);
			return result(input.agent, input.task, h.attempts.length === 1
				? { exitCode: 1, error: "rate limit exceeded" }
				: {});
		};
		const agent = makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"], completionGuard: false });
		const output = await runSync("/runtime", [agent], "worker", "Task", {
			runId: "run-7", index: 3, cwd: "/exact", sessionFile: "/tmp/external-session", acceptance: noAcceptance,
		}, h.deps);
		assert.equal(output.exitCode, 0);
		assert.equal(h.ownerOptions.length, 1);
		assert.equal(h.ownerOptions[0].childId, "child-3");
		assert.equal(h.ownerOptions[0].cwd, "/exact");
		assert.equal(h.ownerOptions[0].title, "worker");
		assert.deepEqual(h.attempts.map(call => call.attemptId), ["child-3-attempt-0", "child-3-attempt-1"]);
		assert.ok(h.attempts.every(call => call.owner === h.owner));
		assert.deepEqual(h.finishes, ["delivered"]);
		assert.deepEqual(output.executionSurface, { handle, retained: false });
	});

	it("retains failed, blocked, interrupted, and acceptance-rejected surfaces", async t => {
		const cases: Array<{ name: string; overrides: Partial<SingleResult>; acceptance?: typeof noAcceptance }> = [
			{ name: "failed", overrides: { exitCode: 1, error: "failed" } },
			{ name: "blocked", overrides: { exitCode: 1, error: "BLOCKED: approval required" } },
			{ name: "interrupted", overrides: { interrupted: true, finalOutput: "partial" } },
		];
		for (const scenario of cases) await t.test(scenario.name, async () => {
			const h = dependencies(externalSelection);
			h.deps.runExternalAttempt = async input => result(input.agent, input.task, scenario.overrides);
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId: scenario.name, sessionFile: `/tmp/${scenario.name}`, acceptance: noAcceptance,
			}, h.deps);
			assert.deepEqual(h.finishes, ["retained"]);
			assert.equal(output.executionSurface?.retained, true);
		});

		const h = dependencies(externalSelection);
		h.deps.runExternalAttempt = async input => result(input.agent, input.task);
		const rejected = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
			runId: "rejected", sessionFile: "/tmp/rejected", acceptance: { level: "claimed", reason: "test", criteria: ["must report"] },
		}, h.deps);
		assert.equal(rejected.exitCode, 1);
		assert.deepEqual(h.finishes, ["retained"]);
	});

	it("retains the safe handle and safe phase errors for startup, attempt, and finish failures", async t => {
		for (const phase of ["startup", "attempt", "finish"] as const) await t.test(phase, async () => {
			const h = dependencies(externalSelection);
			if (phase === "startup") Object.defineProperty(h.owner, "ready", { value: Promise.reject(new Error("secret startup details")) });
			if (phase === "attempt") h.deps.runExternalAttempt = async () => { throw new Error("secret attempt details"); };
			if (phase === "finish") h.owner.finish = async () => { throw new Error("secret finish details"); };
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId: phase, sessionFile: `/tmp/${phase}`, acceptance: noAcceptance,
			}, h.deps);
			assert.equal(output.exitCode, 1);
			assert.equal(output.executionSurface?.retained, true);
			assert.ok(output.error?.includes(`External execution ${phase} failed`));
			assert.ok(!output.error?.includes("secret"));
		});
	});

	it("preserves executionSurface through snapshots and JSON serialization", () => {
		const value = result(makeAgent("worker"), "Task", { executionSurface: { handle, retained: true } });
		const progress = { status: "completed" as const, startTime: 1, durationMs: 1, toolCount: 0, turnCount: 1, tokens: 2, recentTools: [], recentOutput: [] };
		const snapshot = snapshotResult(value, progress);
		assert.deepEqual(snapshot.executionSurface, { handle, retained: true });
		assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).executionSurface, { handle, retained: true });
	});
});
