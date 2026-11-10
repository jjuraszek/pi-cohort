import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../src/shared/types.ts";
import { writeAtomicJson } from "../../src/shared/atomic-json.ts";

async function waitFor(predicate: () => boolean, message: string, timeout = 75_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, message);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

for (const scenario of ["parallel", "static", "dynamic", "single", "early", "fallback", "overlap", "mixed", "later-target", "later-whole", "empty", "last-settled", "whole", "structured-static", "structured-dynamic", "mutation", "hidden-error"]) {
it(`async stop by index pauses only that child (${scenario})`, async () => {
	const mock = createMockPi();
	const cwd = createTempDir();
	mock.install();
	let resultPath: string | undefined;
	let pid: number | undefined;
	try {
		const single = scenario === "single";
		const validation = ["structured-static", "structured-dynamic", "mutation", "hidden-error"].includes(scenario);
		const structured = scenario.startsWith("structured-");
		const staticChain = scenario === "static" || (validation && scenario !== "structured-dynamic");
		const offset = scenario === "dynamic" || scenario === "structured-dynamic" ? 1 : 0;
		const target = single ? 0 : offset + 1;
		const whole = ["mixed", "later-whole", "last-settled", "whole"].includes(scenario);
		const stopped = scenario === "empty" || scenario === "last-settled" ? []
			: scenario === "whole" ? [2] : single ? [0]
			: scenario === "overlap" ? [0, 1] : scenario === "later-target" ? [1, 0]
			: scenario === "mixed" ? [1, 2] : [1 + offset];
		if (offset) mock.onCall({ taskIncludes: "Seed items", output: "Seed", structuredOutput: { items: [0, 1, 2] } });
		// The failing first attempt reports its error, then lingers: the stop lands before any fallback attempt can start.
		if (scenario === "fallback") mock.onCall({ taskIncludes: "Child task 1", steps: [{ delay: 150, stderr: "rate limit exceeded\n" }, { delay: 30_000 }], exitCode: 1 });
		for (const index of single ? [0] : [0, 1, 2]) mock.onCall({ taskIncludes: `Child task ${index}`, steps: [
			{ jsonl: [events.messageStart(), ...(scenario === "hidden-error" && index === 1 ? [events.toolResult("read", "rate limit exceeded", true)] : [])] },
			{ delay: stopped.includes(index + offset) ? 60_000 : scenario === "last-settled" && index === 2 ? 100 : 1_500,
				jsonl: [events.assistantMessage(`Completed child ${index}`)],
				...(structured && index !== 1 ? { structuredOutput: { done: true } } : {}) },
		] });
		const state = { baseCwd: cwd, currentSessionId: null, asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
			foregroundControls: new Map(), lastForegroundControlId: null };
		const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: cwd,
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
		const request = (index: number | "all") => writeAtomicJson(path.join(dir, `interrupt-request-${index}.json`), { requestedAt: Date.now() });
		const stop = async (index?: number) => {
			const response = await executor.execute("stop", { action: "interrupt", id, index }, undefined, undefined, ctx);
			assert.match(response.content[0].text, new RegExp(index === undefined ? "Interrupt requested for async run" : `Interrupt requested for child ${index} of async run`));
		};
		if (scenario === "hidden-error") await waitFor(() => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes("rate limit exceeded"), "retryable hidden error observed");
		const fallbackNotStarted = () => {
			assert.equal(status().steps[target].model, "openai/gpt-5-mini");
			assert.equal(mock.callCount(), 3, "fallback attempt must not have started");
		};
		if (scenario === "fallback") {
			await waitFor(() => fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").includes("rate limit exceeded"), "first attempt failure visible");
			fallbackNotStarted();
		}
		if (scenario === "parallel") {
			const invalid = await executor.execute("invalid", { action: "interrupt", id, index: 99 }, undefined, undefined, ctx);
			assert.equal(invalid.isError, true);
			assert.match(invalid.content[0].text, /no running child at index 99/);
			assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), false);
		}
		if (scenario === "empty") {
			signal();
		} else if (scenario === "last-settled") {
			await waitFor(() => status().steps[2].status === "complete", "last child settled");
			request(2);
			signal();
			await waitFor(() => !fs.existsSync(path.join(dir, "interrupt-request-2.json")), "stale request deleted");
			assert.equal(status().steps[0].status, "running");
			await stop();
		} else if (scenario === "overlap" || scenario === "mixed") {
			request(scenario === "overlap" ? 0 : "all");
			request(1);
			signal();
			await waitFor(() => !fs.readdirSync(dir).some((name) => name.startsWith("interrupt-request-")), "requests consumed together");
			signal();
		} else if (scenario === "whole") {
			await stop();
		} else {
			await stop(target);
			if (scenario === "fallback") fallbackNotStarted();
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
		assert.equal(result.state, scenario === "empty" ? "complete" : "paused");
		if (scenario !== "empty") assert.equal(result.summary, "Paused after interrupt. Waiting for explicit next action.");
		if (staticChain || offset) {
			assert.equal(mock.callCount(), 3 + offset, "later chain steps must not run");
			assert.equal(status().steps.at(-1).status, "pending");
		}
		for (const index of single ? [0] : [offset, offset + 1, offset + 2]) {
			assert.equal(status().steps[index].status, stopped.includes(index) ? "paused" : "complete");
			if (stopped.includes(index)) {
				assert.equal(result.results[index].interrupted, true);
				assert.equal(result.results[index].modelAttempts.at(-1).exitCode, 0);
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
		if (scenario === "fallback") {
			assert.equal(result.results[target].modelAttempts.length, 1, "a stop sent before the fallback attempt must not start it");
			assert.equal(mock.callCount(), 3);
		}
		if (scenario === "parallel") {
			const inspected = await executor.execute("status", { action: "status", id }, undefined, undefined, ctx);
			assert.match(inspected.content[0].text, /echo paused/);
			assert.equal((inspected.content[0].text.match(/echo complete/g) ?? []).length, 2);
		}
	} finally {
		if (resultPath) await waitFor(() => fs.existsSync(resultPath!), "fixture result cleanup");
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
