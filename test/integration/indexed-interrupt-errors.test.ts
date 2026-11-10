import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createNestedRoute, readNestedControlRequests, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
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
		foregroundControls: new Map(), lastForegroundControlId: null };
	const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime,
		pi: { events: createEventBus(), getSessionName: () => undefined }, state,
		resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd, expandTilde: (p: string) => p,
		discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
	});
	return { mock, cwd, state, execute: (params) => executor.execute("index-errors", params, undefined, undefined, makeMinimalCtx(cwd)) };
}

for (const async of [false, true]) {
	it(`interrupt rejects absent, pending, finished and repeated indices without stopping siblings (async=${async})`, async (t) => {
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
			const reject = async (index: number) => {
				const before = signals.mock.callCount();
				const response = await execute({ action: "interrupt", id, index });
				assert.equal(signals.mock.callCount(), before, "invalid indices must not send a signal");
				assert.equal(response.isError, true, `index ${index} must be rejected`);
				assert.equal(response.content[0].text, `${async ? "Async" : "Foreground"} run ${id} has no running child at index ${index}.`);
				if (dir) assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), false);
			};
			for (const index of [99, 2, 3]) await reject(index);
			await waitFor(() => async ? status().steps[0].status === "complete" : !control.childInterrupts.has(0), "first child completed");
			await waitFor(() => mock.callCount() === 3, "queued child started");
			await reject(0);
			const stopped = await execute({ action: "interrupt", id, index: 1 });
			assert.notEqual(stopped.isError, true);
			await waitFor(() => async ? status().steps[1].status === "paused" : !control.childInterrupts.has(1), "target paused");
			await reject(1);
			if (async) await waitFor(() => fs.existsSync(resultPath!), "async result");
			const result = async ? JSON.parse(fs.readFileSync(resultPath!, "utf8")) : await pending;
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
			assert.equal(result.content[0].text, `Interrupt by index is not supported for nested run ${id}.`);
			assert.deepEqual(readNestedControlRequests(route), [], "no whole-run request may reach the nested owner");
		} finally {
			removeTempDir(path.dirname(route.eventSink));
			removeTempDir(cwd);
		}
	});
}

it("a completed foreground run owns the indexed error without signaling an unrelated async job", async (t) => {
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
					assert.equal(result.content[0].text, `${row.label} ${row.target} has no running child at index 0.`);
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

it("a foreground control without a callback owns the indexed error instead of falling through to async", async (t) => {
	const { cwd, state, execute } = fixture();
	try {
		const id = "foreground-not-started";
		state.foregroundControls.set(id, { runId: id, mode: "single", startedAt: 1, updatedAt: 1 });
		state.asyncJobs.set("other-async", { asyncId: "other-async", asyncDir: cwd, status: "running" });
		fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: "running", pid: process.pid, steps: [{ status: "running" }] }));
		const kill = t.mock.method(process, "kill", () => true);
		const result = await execute({ action: "interrupt", id, index: 0 });
		assert.equal(result.isError, true);
		assert.equal(result.content[0].text, `Foreground run ${id} has no running child at index 0.`);
		assert.equal(kill.mock.callCount(), 0);
		assert.equal(fs.existsSync(path.join(cwd, "interrupt-request-0.json")), false);
	} finally { removeTempDir(cwd); }
});

for (const settled of ["complete", "paused"] as const) {
	it(`interrupt with index on a ${settled} async run names the index and sends nothing`, async (t) => {
		const { cwd, state, execute } = fixture();
		try {
			const id = `settled-async-${settled}`;
			state.asyncJobs.set(id, { asyncId: id, asyncDir: cwd, status: settled });
			fs.writeFileSync(path.join(cwd, "status.json"), JSON.stringify({ state: settled, pid: process.pid, steps: [{ status: settled }] }));
			const kill = t.mock.method(process, "kill", () => true);
			const result = await execute({ action: "interrupt", id, index: 0 });
			assert.equal(result.isError, true);
			assert.equal(result.content[0].text, `Async run ${id} has no running child at index 0.`);
			assert.equal(kill.mock.callCount(), 0);
			assert.equal(fs.readdirSync(cwd).some((name) => name.startsWith("interrupt-request-")), false);
			const whole = await execute({ action: "interrupt", id });
			assert.equal(whole.content[0].text, `No running async run with an interrupt-capable pid was found for '${id}'.`);
			assert.equal(kill.mock.callCount(), 0);
		} finally { removeTempDir(cwd); }
	});
}
