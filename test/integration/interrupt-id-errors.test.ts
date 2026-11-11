import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, readNestedControlRequests, writeNestedControlResult, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 75_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function fixture() {
	const mock = createMockPi();
	const cwd = createTempDir();
	const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundControls: new Map(), retainedNestedRoutes: new Map(), lastForegroundControlId: null };
	const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime,
		pi: { events: createEventBus(), getSessionName: () => undefined }, state,
		resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd, expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
	});
	return { mock, cwd, state, execute: (params) => executor.execute("id-errors", params, undefined, undefined, makeMinimalCtx(cwd)) };
}

for (const async of [false, true]) {
	it(`interrupt rejects invalid ids and settled children without stopping siblings (async=${async})`, { skip: async && process.platform === "win32" ? "requires POSIX signals" : undefined }, async (t) => {
		const { mock, cwd, state, execute } = fixture();
		const signals = t.mock.method(process, "kill");
		mock.install();
		let pending;
		let resultPath: string | undefined;
		let pid: number | undefined;
		try {
			for (const index of [0, 1, 2]) mock.onCall({ taskIncludes: `Child task ${index}`, steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: index === 0 ? 1_000 : index === 1 ? 5_000 : 1_500, jsonl: [events.assistantMessage(`Completed child ${index}`)] },
			] });
			pending = execute({ async, clarify: false, acceptance: { level: "none", reason: "Observe invalid interrupt routing" }, chain: [
				{ parallel: [0, 1, 2].map((index) => ({ agent: "echo", task: `Child task ${index}` })), concurrency: 2 },
				{ agent: "echo", task: "Must not run" },
			] });
			let id: string;
			let dir: string | undefined;
			let status;
			if (async) {
				const started = await pending;
				assert.ok(started.details.asyncId, JSON.stringify(started));
				id = started.details.asyncId;
				dir = path.join(ASYNC_DIR, id);
				resultPath = path.join(RESULTS_DIR, `${id}.json`);
				state.asyncJobs.set(id, { asyncId: id, asyncDir: dir, status: "running" });
				status = () => JSON.parse(fs.readFileSync(path.join(dir!, "status.json"), "utf8"));
				await waitFor(() => typeof status().pid === "number", "runner pid");
				pid = status().pid;
			}
			await waitFor(() => mock.callCount() >= 2, "first two children started");
			id ??= [...state.foregroundControls.keys()][0];
			const control = state.foregroundControls.get(id);
			const childIds = async ? status().steps.map((step) => step.id) : [...control.children.keys()];
			const reject = async (target: string, message: RegExp, index?: number) => {
				const before = signals.mock.callCount();
				const response = await execute({ action: "interrupt", id: target, ...(index !== undefined ? { index } : {}) });
				assert.equal(signals.mock.calls.slice(before).filter((call) => call.arguments[1] !== 0).length, 0, "invalid targets must not send a stop signal");
				assert.equal(response.isError, true);
				assert.match(response.content[0].text, message);
				if (dir) assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), false);
			};
			await reject(id, /interrupt no longer takes an index/, 1);
			await reject("abc", /Stop id 'abc' is too short/);
			await reject("missing-child", /No running subagent matches 'missing-child'/);
			await reject(childIds[2], /has not started; stop its run/);
			await waitFor(() => async ? status().steps[0].status === "complete" : control.children.get(childIds[0])?.state === "completed", "first child completed");
			await waitFor(() => mock.callCount() === 3, "queued child started");
			await reject(childIds[0], /is no longer running: completed/);
			const stopped = await execute({ action: "interrupt", id: childIds[1] });
			assert.notEqual(stopped.isError, true);
			const duplicate = await execute({ action: "interrupt", id: childIds[1] });
			assert.notEqual(duplicate.isError, true, "duplicate stop before settlement succeeds");
			await waitFor(() => async ? status().steps[1].status === "paused" : control.children.get(childIds[1])?.state === "interrupted", "target paused");
			await reject(childIds[1], /is no longer running: interrupted/);
			if (async) await waitFor(() => fs.existsSync(resultPath!), "async result");
			const result = async ? JSON.parse(fs.readFileSync(resultPath!, "utf8")) : await pending;
			if (!async) await reject(childIds[0], /No running subagent matches/);
			const results = async ? result.results : result.details.results;
			assert.equal(results.length, 3, "later chain step must not run");
			assert.equal(results[1].interrupted, true);
			for (const index of [0, 2]) {
				assert.notEqual(results[index].interrupted, true);
				assert.equal(async ? results[index].output : results[index].finalOutput, `Completed child ${index}`);
				if (async) assert.equal(status().steps[index].status, "complete");
			}
		} finally {
			if (resultPath) await waitFor(() => fs.existsSync(resultPath!), "fixture result cleanup");
			else if (pending) await pending;
			if (pid) await waitFor(() => {
				try { process.kill(pid!, 0); return false; } catch (error) {
					if (error.code !== "ESRCH") throw error;
					return true;
				}
			}, "fixture runner exit");
			mock.uninstall();
			removeTempDir(cwd);
		}
	});
}

it("pending, failed, settled, ambiguous and missing ids do not signal or write requests", async (t) => {
	const { cwd, state, execute } = fixture();
	try {
		state.asyncJobs.set("invalid-targets", { asyncId: "invalid-targets", asyncDir: cwd, status: "running" });
		fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [
			{ id: "pending-child", agent: "worker", status: "pending" },
			{ id: "failed-child", agent: "worker", status: "failed" },
			{ id: "collide-running", agent: "worker", status: "running" },
			{ id: "collide-settled", agent: "worker", status: "complete" },
		] }));
		const kill = t.mock.method(process, "kill", () => true);
		for (const [id, error] of [
			["pending-child", /has not started; stop its run/],
			["failed-child", /is no longer running: failed/],
			["collide-settled", /is no longer running: completed/],
			["collide-", /Ambiguous stop id.*child:/],
			["missing-child", /No running subagent matches/],
		] as const) {
			const result = await execute({ action: "interrupt", id });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, error);
			assert.equal(kill.mock.calls.filter((call) => call.arguments[1] !== 0).length, 0);
			assert.equal(fs.readdirSync(cwd).some((name) => name.startsWith("interrupt-request-")), false);
		}
	} finally { removeTempDir(cwd); }
});

it("a returned foreground root retains its live nested child's stop route", async () => {
	const { mock, cwd, state, execute } = fixture();
	mock.install();
	let route;
	let pending;
	let responder;
	try {
		mock.onCall({ steps: [{ delay: 500, jsonl: [events.assistantMessage("Root done")] }] });
		pending = execute({ agent: "echo", task: "Return before nested child", async: false, clarify: false, acceptance: { level: "none", reason: "Observe retained routing" } });
		await waitFor(() => state.foregroundControls.size === 1, "foreground route");
		const control = [...state.foregroundControls.values()][0];
		route = control.nestedRoute;
		assert.ok(route);
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: control.runId,
			child: { id: "surviving-child", parentRunId: control.runId, depth: 1, path: [{ runId: control.runId }], state: "running", agent: "echo" } });
		await pending;
		assert.equal(state.foregroundControls.size, 0);
		assert.equal(state.retainedNestedRoutes.get(control.runId), route);
		responder = setInterval(() => {
			for (const request of readNestedControlRequests(route)) writeNestedControlResult(route, {
				ts: Date.now(), requestId: request.requestId, targetId: request.targetId, ok: true, message: "Nested child stopped",
			});
		}, 10);
		const stopped = await execute({ action: "interrupt", id: "surviving-child" });
		assert.notEqual(stopped.isError, true);
		assert.equal(stopped.content[0].text, "Nested child stopped");
	} finally {
		if (responder) clearInterval(responder);
		if (pending) await pending;
		mock.uninstall();
		if (route) removeTempDir(path.dirname(route.eventSink));
		removeTempDir(cwd);
	}
});

for (const nestedState of ["running", "complete", "failed", "paused"] as const) {
	it(`interrupt with index on a ${nestedState} nested run is rejected before routing`, async () => {
		const { cwd, state, execute } = fixture();
		const route = createNestedRoute(`root-${nestedState}`);
		const id = `nested-${nestedState}`;
		try {
			writeNestedEvent(route, { type: "subagent.nested.updated", ts: Date.now(), parentRunId: route.rootRunId, parentStepIndex: 0,
				child: { id, parentRunId: route.rootRunId, parentStepIndex: 0, depth: 1, path: [{ runId: route.rootRunId, stepIndex: 0 }],
					state: nestedState, agent: "echo", ownerState: "live", capabilityToken: route.capabilityToken } });
			state.foregroundControls.set(route.rootRunId, { runId: route.rootRunId, mode: "single", startedAt: 1, updatedAt: 1, nestedRoute: route });
			const result = await execute({ action: "interrupt", id, index: 0 });
			assert.equal(result.isError, true);
			assert.equal(result.content[0].text, "interrupt no longer takes an index; pass the id at the start of the child's row.");
			assert.deepEqual(readNestedControlRequests(route), [], "no whole-run request may reach the nested owner");
		} finally {
			removeTempDir(path.dirname(route.eventSink));
			removeTempDir(cwd);
		}
	});
}

it("legacy index rejection does not consult retained foreground history or unrelated async jobs", async (t) => {
	const { mock, cwd, state, execute } = fixture();
	mock.install();
	try {
		mock.onCall({ output: "Completed foreground child" });
		await execute({ agent: "echo", task: "Finish foreground", async: false, clarify: false });
		const [id] = state.foregroundRuns.keys();
		assert.ok(id);
		assert.equal(state.foregroundControls.has(id), false);
		state.asyncJobs.set("other-async", { asyncId: "other-async", asyncDir: cwd, status: "running" });
		fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [{ status: "running" }] }));
		const kill = t.mock.method(process, "kill", () => true);
		for (const row of [
			{ name: "retained exact id", target: id, retained: true, label: "Foreground run" },
			{ name: "completed run prefix", target: id.slice(0, -1), retained: true, label: "Run" },
			{ name: "id removed from retained history", target: id, retained: false, label: "Run" },
		]) {
			await t.test(row.name, async () => {
				if (!row.retained) state.foregroundRuns.delete(id);
				const before = kill.mock.callCount();
				try {
					const result = await execute({ action: "interrupt", id: row.target, index: 0 });
					assert.equal(kill.mock.callCount(), before, "completed foreground requests must not signal another run");
					assert.equal(fs.existsSync(path.join(cwd, "interrupt-request-0.json")), false);
					assert.equal(result.isError, true);
					assert.equal(result.content[0].text, "interrupt no longer takes an index; pass the id at the start of the child's row.");
				} finally {
					fs.rmSync(path.join(cwd, "interrupt-request-0.json"), { force: true });
				}
			});
		}
	} finally {
		mock.uninstall();
		removeTempDir(cwd);
	}
});

it("legacy index rejection does not fall through from an inactive foreground control to async", async (t) => {
	const { cwd, state, execute } = fixture();
	try {
		const id = "foreground-not-started";
		state.foregroundControls.set(id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 });
		state.asyncJobs.set("other-async", { asyncId: "other-async", asyncDir: cwd, status: "running" });
		fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [{ status: "running" }] }));
		const kill = t.mock.method(process, "kill", () => true);
		const result = await execute({ action: "interrupt", id, index: 0 });
		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, "interrupt no longer takes an index; pass the id at the start of the child's row.");
		assert.equal(kill.mock.callCount(), 0);
		assert.equal(fs.existsSync(path.join(cwd, "interrupt-request-0.json")), false);
	} finally { removeTempDir(cwd); }
});

for (const settled of ["complete", "paused"] as const) {
	it(`interrupt with index on a ${settled} async run gives migration guidance and sends nothing`, async (t) => {
		const { cwd, state, execute } = fixture();
		try {
			const id = `settled-async-${settled}`;
			state.asyncJobs.set(id, { asyncId: id, asyncDir: cwd, status: settled });
			fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: settled, pid: process.pid, steps: [{ status: settled }] }));
			const kill = t.mock.method(process, "kill", () => true);
			const result = await execute({ action: "interrupt", id, index: 0 });
			assert.equal(result.isError, true);
			assert.equal(result.content[0].text, "interrupt no longer takes an index; pass the id at the start of the child's row.");
			assert.equal(kill.mock.callCount(), 0);
			assert.equal(fs.readdirSync(cwd).some((name) => name.startsWith("interrupt-request-")), false);
			const whole = await execute({ action: "interrupt", id });
			assert.equal(whole.content[0].text, "No running async run with an interrupt-capable pid was found.");
			assert.equal(kill.mock.callCount(), 0);
		} finally { removeTempDir(cwd); }
	});
}
