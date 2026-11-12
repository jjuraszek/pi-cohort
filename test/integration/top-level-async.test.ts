import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR, RUN_STATE_ROOT_DIR } from "../../src/shared/types.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { stoppingAncestor } from "../../src/runs/shared/stop-control.ts";
import { inspectSubagentStatus } from "../../src/runs/background/run-status.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";

async function waitFor(predicate: () => boolean, message: string, timeout = 75_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

for (const scenario of ["parallel", "static", "dynamic", "single", "early", "fallback", "overlap", "mixed", "later-target", "later-whole", "empty", "last-settled", "whole", "legacy", "malformed", "unknown", "structured-static", "structured-dynamic", "mutation", "hidden-error", "runtime-cap"]) {
it(scenario === "runtime-cap" ? "async child is not capped by maxRuntimeMs" : `async stop by UUID pauses only that child (${scenario})`, { skip: process.platform === "win32" ? "requires POSIX signals" : undefined }, async () => {
	const mock = createMockPi();
	const cwd = createTempDir();
	mock.install();
	let resultPath: string | undefined;
	let pid: number | undefined;
	try {
		const runtimeCap = scenario === "runtime-cap";
		const completes = scenario === "empty" || runtimeCap;
		const single = scenario === "single" || runtimeCap;
		const validation = ["structured-static", "structured-dynamic", "mutation", "hidden-error"].includes(scenario);
		const structured = scenario.startsWith("structured-");
		const staticChain = scenario === "static" || (validation && scenario !== "structured-dynamic");
		const offset = scenario === "dynamic" || scenario === "structured-dynamic" ? 1 : 0;
		const target = single ? 0 : offset + 1;
		const whole = ["mixed", "later-whole", "last-settled", "whole"].includes(scenario);
		const noOp = ["runtime-cap", "empty", "legacy", "malformed", "unknown"].includes(scenario);
		const stopped = noOp ? [] : scenario === "last-settled" ? [0, 1]
			: whole ? [0, 1, 2] : single ? [0]
			: scenario === "overlap" ? [0, 1] : scenario === "later-target" ? [1, 0]
			: [1 + offset];
		if (offset) mock.onCall({ taskIncludes: "Seed items", output: "Seed", structuredOutput: { items: [0, 1, 2] } });
		if (scenario === "fallback") mock.onCall({ taskIncludes: "Child task 1", steps: [{ delay: 150, stderr: "rate limit exceeded\n" }], exitCode: 1 });
		for (const index of single ? [0] : [0, 1, 2]) mock.onCall({ taskIncludes: `Child task ${index}`, steps: [
			{ jsonl: [events.messageStart(), ...(scenario === "hidden-error" && index === 1 ? [events.toolResult("read", "rate limit exceeded", true)] : [])] },
			{ delay: stopped.includes(index + offset) ? 5_000 : scenario === "last-settled" && index === 2 ? 100 : 1_500,
				jsonl: [events.assistantMessage(`Completed child ${index}`)],
				...(structured && index !== 1 ? { structuredOutput: { done: true } } : {}) },
		] });
		const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
			foregroundControls: new Map(), lastForegroundControlId: null };
		const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			resolveConfig: () => ({ control: runtimeCap ? { enabled: true, maxRuntimeMs: 100 } : { enabled: false } }), tempArtifactsDir: cwd,
			getSubagentSessionRoot: () => cwd, expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: scenario === "mutation",
				...(scenario === "fallback" || scenario === "hidden-error" ? { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] } : {}),
			})] }),
		});
		const ctx = makeMinimalCtx(cwd);
		const tasks = [0, 1, 2].map((index) => ({ agent: "echo", task: `${scenario === "mutation" && index === 1 ? "Implement code for " : ""}Child task ${index}`,
			...(structured ? { outputSchema: { type: "object" } } : {}),
		}));
		const chain = offset ? [
			{ agent: "echo", task: "Seed items", as: "seed", outputSchema: { type: "object" } },
			{ expand: { from: { output: "seed", path: "/items" }, maxItems: 3 }, parallel: { agent: "echo", task: "Child task {item}", ...(structured ? { outputSchema: { type: "object" } } : {}) }, collect: { as: "collected" },
				...(validation ? { concurrency: 2, failFast: true } : {}) },
		] : [{ parallel: tasks, failFast: true, ...(validation ? { concurrency: 2 } : {}) }];
		const started = await executor.execute("async-index", { async: true, clarify: false,
			acceptance: { level: "none", reason: "Observe interrupt routing and sibling lifecycle" },
			...(single ? tasks[0] : staticChain || offset ? { chain: [...chain, { agent: "echo", task: "Must not run" }] } : { tasks }),
		}, undefined, undefined, ctx);
		assert.ok(started.details.asyncId, JSON.stringify(started));
		const id = started.details.asyncId;
		const dir = path.join(ASYNC_DIR, id);
		state.asyncJobs.set(id, { asyncId: id, asyncDir: dir, status: "running" });
		resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const status = () => JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
		await waitFor(() => status().steps.slice(offset, offset + (single ? 1 : validation ? 2 : 3)).every((step) => step.status === "running")
			&& (scenario === "early" || mock.callCount() >= (single ? 1 : (validation ? 2 : 3) + offset)), "children running");
		pid = status().pid;
		const signal = () => process.kill(pid!, process.platform === "win32" ? "SIGBREAK" : "SIGUSR2");
		const childId = (index: number) => status().steps[index].id;
		const request = (targetId: string) => writeAtomicJson(path.join(dir, `interrupt-request-${targetId}.json`), { targetId, requestedAt: Date.now() });
		const stop = async (index?: number) => {
			const targetId = index === undefined ? id : childId(index);
			const response = await executor.execute("stop", { action: "interrupt", id: targetId }, undefined, undefined, ctx);
			assert.equal(response.isError, undefined, response.content[0].text);
			assert.match(response.content[0].text, /Interrupt requested/);
		};
		if (scenario === "hidden-error") await waitFor(() => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes("rate limit exceeded"), "retryable hidden error observed");
		// The stop races the failed attempt's exit and the fallback's registration; the outcome below holds wherever it lands.
		if (scenario === "fallback") await waitFor(() => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes("rate limit exceeded"), "first attempt failure visible");
		if (scenario === "parallel") {
			const invalid = await executor.execute("invalid", { action: "interrupt", id, index: 99 }, undefined, undefined, ctx);
			assert.equal(invalid.isError, true);
			assert.match(invalid.content[0].text, /no longer takes an index/i);
			assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), false);
		}
		if (runtimeCap) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(status().steps[0].status, "running", "async child stays running past the 100 ms cap");
		} else if (noOp) {
			if (scenario === "legacy") {
				writeAtomicJson(path.join(dir, "interrupt-request-all.json"), { requestedAt: Date.now() });
				writeAtomicJson(path.join(dir, "interrupt-request-1.json"), { requestedAt: Date.now() });
			} else if (scenario === "malformed") fs.writeFileSync(path.join(dir, `interrupt-request-${id}.json`), "{");
			else if (scenario === "unknown") request("unknown-child");
			signal();
		} else if (scenario === "last-settled") {
			await waitFor(() => status().steps[2].status === "complete", "last child settled");
			request(childId(2));
			signal();
			await waitFor(() => !fs.existsSync(path.join(dir, `interrupt-request-${childId(2)}.json`)), "stale request deleted");
			assert.equal(status().steps[0].status, "running");
			await stop();
		} else if (scenario === "overlap" || scenario === "mixed") {
			request(scenario === "overlap" ? childId(0) : id);
			request(childId(1));
			signal();
			await waitFor(() => !fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), "requests consumed together");
		} else if (scenario === "whole") {
			await stop();
		} else {
			await stop(target);
			if (scenario.startsWith("later-")) {
				await waitFor(() => status().steps[target].status === "paused", "first child paused");
				await new Promise((resolve) => setTimeout(resolve, 100));
				await stop(scenario === "later-target" ? 0 : undefined);
			}
		}
		await waitFor(() => {
			if (!whole) for (const index of single ? [0] : [offset, offset + 1, offset + 2]) {
				if (!stopped.includes(index)) assert.notEqual(status().steps[index].status, "paused");
			}
			return fs.existsSync(resultPath!);
		}, "result file");
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.equal(result.state, noOp ? "complete" : "paused");
		assert.equal(status().state, result.state, "final status matches the recorded result");
		assert.equal(status().stopping, whole ? true : undefined, "only a whole-run stop publishes run stopping state");
		if (!noOp) assert.equal(result.summary, "Paused after interrupt. Waiting for explicit next action.");
		if (runtimeCap) {
			assert.equal(result.exitCode, 0);
			assert.equal(result.results[0].success, true);
			assert.equal(result.results[0].error, undefined);
			assert.ok(status().steps[0].durationMs >= 1_500, "mock child completes its full script past maxRuntimeMs");
		}
		if (staticChain || offset) {
			assert.equal(mock.callCount(), 3 + offset, "later chain steps must not run");
			assert.equal(status().steps.at(-1).status, "pending");
		}
		for (const index of single ? [0] : [offset, offset + 1, offset + 2]) {
			assert.equal(status().steps[index].status, stopped.includes(index) ? "paused" : "complete");
			if (stopped.includes(index)) {
				assert.equal(result.results[index].interrupted, true);
				if (result.results[index].modelAttempts?.length) assert.equal(result.results[index].modelAttempts.at(-1).exitCode, 0);
				if (validation) {
					assert.equal(result.results[index].error, undefined);
					assert.equal(result.results[index].modelAttempts.length, 1, "interrupted attempts must not select model fallback");
				}
			}
			else {
				assert.equal(result.results[index].output, `Completed child ${index - offset}`);
				assert.notEqual(result.results[index].interrupted, true);
			}
		}
		assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), false);
		if (scenario === "parallel") {
			const inspected = await executor.execute("status", { action: "status", id }, undefined, undefined, ctx);
			assert.match(inspected.content[0].text, /echo paused/);
			assert.equal((inspected.content[0].text.match(/echo complete/g) ?? []).length, 2);
		}
	} finally {
		if (pid && resultPath && !fs.existsSync(resultPath)) {
			// Failed assertions must not leave the detached fixture running.
			try { process.kill(pid, "SIGTERM"); } catch {}
		}
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

it("publishes background sweep failures in the paused result and status without losing sibling output", async () => {
	const mock = createMockPi();
	const cwd = createTempDir();
	const id = "background-sweep";
	const route = createNestedRoute(id);
	const descendantRoot = path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", id);
	mock.install();
	mock.onCall({ taskIncludes: "Stopped child", delay: 60_000, output: "must be stopped" });
	mock.onCall({ taskIncludes: "Sibling child", delay: 1_500, output: "Sibling output retained" });
	const statusPath = path.join(cwd, "status.json");
	const resultPath = path.join(cwd, "result.json");
	const signalsPath = path.join(cwd, "signals.jsonl");
	const childId = "stopped-child";
	const status = () => JSON.parse(fs.readFileSync(statusPath, "utf8"));
	writeAtomicJson(statusPath, { steps: [{ id: childId }, { id: "sibling-child" }] });
	const ts = Date.now();
	for (const [index, descendantId] of ["denied-descendant", "later-descendant"].entries()) {
		const asyncDir = path.join(descendantRoot, descendantId);
		fs.mkdirSync(asyncDir, { recursive: true });
		writeAtomicJson(path.join(asyncDir, "status.json"), { runId: descendantId, state: "running", pid: 98765 + index });
		writeNestedEvent(route, { type: "subagent.nested.updated", ts: ts + index, parentRunId: id, parentStepIndex: 0, child: {
			id: descendantId, state: "running", agent: "worker", parentRunId: id, parentStepIndex: 0, depth: 1,
			path: [{ runId: id, childId }], asyncDir,
		} });
	}
	const configPath = path.join(cwd, "config.json");
	writeAtomicJson(configPath, {
		id, runtime: mock.runtime, cwd, asyncDir: cwd, resultPath, nestedRoute: route, resultMode: "parallel", placeholder: "{previous}",
		steps: [{ parallel: ["Stopped child", "Sibling child"].map((task) => ({ agent: "worker", task, completionGuard: false })), concurrency: 2 }],
	});
	const runnerPath = path.resolve("src/runs/background/subagent-runner.ts");
	const entry = path.join(cwd, "runner.mjs");
	fs.writeFileSync(entry, `import fs from "node:fs";
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
 if (pid !== 98765 && pid !== 98766) return kill(pid, signal);
 if (signal !== 0) {
  fs.appendFileSync(${JSON.stringify(signalsPath)}, JSON.stringify([pid, signal]) + "\\n");
  if (pid === 98765) throw Object.assign(new Error("descendant signal failed"), { code: "EPERM" });
 }
 return true;
};
process.argv[1] = ${JSON.stringify(runnerPath)};
process.argv[2] = ${JSON.stringify(configPath)};
await import(${JSON.stringify(pathToFileURL(runnerPath).href)});
`);
	const runner = spawn(process.execPath, [entry], { cwd, stdio: ["ignore", "ignore", "pipe"] });
	const exited = once(runner, "exit");
	let stderr = "";
	runner.stderr.on("data", (data) => { stderr += data; });
	const watchdog = setTimeout(() => runner.kill("SIGKILL"), 15_000);
	try {
		await waitFor(() => mock.callCount() === 2 && status().steps.every((step) => step.status === "running"), "native children launched", 5_000);
		writeAtomicJson(path.join(cwd, `interrupt-request-${childId}.json`), { targetId: childId });
		runner.kill("SIGUSR2");
		const [code] = await exited;
		assert.equal(code, 0, stderr);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
		assert.deepEqual(fs.readFileSync(signalsPath, "utf8").trim().split("\n").map(JSON.parse), [[98765, "SIGUSR2"], [98766, "SIGUSR2"]]);
		assert.ok(fs.existsSync(path.join(descendantRoot, "later-descendant", "interrupt-request-later-descendant.json")));
		assert.equal(stoppingAncestor(route, id, childId), childId);
		assert.equal(status().stopping, undefined);
		assert.equal(result.state, "paused");
		assert.equal(result.exitCode, 0);
		assert.equal(result.success, false);
		assert.deepEqual(status().steps.map((step) => step.status), ["paused", "complete"]);
		assert.equal(result.results[0].interrupted, true);
		assert.equal(result.results[1].output, "Sibling output retained");
		assert.equal(result.results[1].success, true);
		const diagnostic = /Stop of .* is incomplete.*denied-descendant.*descendant signal failed/;
		assert.match(result.summary, /^Paused after interrupt\./);
		assert.match(result.summary, diagnostic);
		assert.match(result.error, diagnostic);
		assert.equal(result.error, status().error);
		const inspected = inspectSubagentStatus({ dir: cwd }, { asyncDirRoot: path.dirname(cwd) });
		assert.match(inspected.content[0].text, diagnostic);
	} finally {
		if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGTERM");
		await exited;
		clearTimeout(watchdog);
		mock.uninstall();
		removeTempDir(cwd);
		removeTempDir(descendantRoot);
		removeTempDir(path.dirname(route.eventSink));
	}
});

interface TopLevelAsyncModule {
	applyForceTopLevelAsyncOverride<T extends { async?: boolean; clarify?: boolean }>(
		params: T,
		depth: number,
		forceTopLevelAsync: boolean,
	): T;
}

const mod = await tryImport<TopLevelAsyncModule>("./src/runs/background/top-level-async.ts");
const available = !!mod;

describe("force top-level async helper", { skip: !available ? "pi packages not available" : undefined }, () => {
	it("forces top-level calls async and disables clarify", () => {
		const params = { async: false, clarify: true, agent: "worker" };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 0, true);
		assert.notEqual(next, params);
		assert.equal(next.async, true);
		assert.equal(next.clarify, false);
		assert.equal(next.agent, "worker");
	});

	it("leaves nested calls unchanged", () => {
		const params = { async: false, clarify: true };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 1, true);
		assert.equal(next, params);
	});

	it("leaves top-level calls unchanged when the feature is off", () => {
		const params = { async: false, clarify: true };
		const next = mod!.applyForceTopLevelAsyncOverride(params, 0, false);
		assert.equal(next, params);
	});
});
