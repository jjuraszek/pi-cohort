/**
 * Integration test for the start deadline on external execution backends.
 *
 * Proves a child whose pi never reports that its session started is ended at
 * `control.startDeadlineMs`, through foreground and async dispatch: the backend
 * is asked to close the surface, no further model attempt starts, siblings
 * finish, and the call's value wins over the settings value. The fixture
 * backend records each launch and close; the scripted pi stays silent for the
 * task `NEVER-READY` and answers every other task without model calls.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import type { ExecutionBackend } from "../../src/execution-backend/types.ts";
import { createFixtureExecutionBackend } from "../fixtures/detached-execution-backend/src/backend.ts";

interface ChildResult {
	exitCode?: number;
	error?: string;
	output?: string;
	finalOutput?: string;
}

interface ExecuteResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details: { asyncId?: string; results?: ChildResult[] };
}

interface ExecutorModule {
	createSubagentExecutor(deps: Record<string, unknown>): {
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: unknown): Promise<ExecuteResult>;
	};
}

interface TraceEvent {
	type: string;
	reason?: string;
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const asyncMod = await tryImport<{ isAsyncAvailable(runtime: unknown): boolean }>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<{ RESULTS_DIR: string }>("./src/shared/types.ts");
const available = !!(executorMod && asyncMod && typesMod);
const asyncAvailable = available && asyncMod!.isAsyncAvailable(createMockPi().runtime);
const skip = !available
	? "pi packages not available"
	: process.platform === "win32" ? "external child-host transport uses Unix domain sockets" : undefined;

const fixturePackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/detached-execution-backend");
const notStarted = (ms: number) => new RegExp(`pi did not start its session within the start deadline \\(startDeadlineMs=${ms}ms\\)`);

describe("start deadline on an external execution backend", { skip }, () => {
	let tempDir: string;
	let tracePath: string;
	let mockPi: MockPi;
	let dispose: () => void;
	const savedTrace = process.env.PI_COHORT_FIXTURE_TRACE;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
		fs.copyFileSync(path.join(fixturePackage, "scripted-pi.mjs"), mockPi.runtime.piEntryPath);
		dispose = registerExecutionBackend(createFixtureExecutionBackend() as unknown as ExecutionBackend, {
			reload: {
				protocolVersion: 1,
				packageJsonUrl: pathToFileURL(path.join(fixturePackage, "package.json")).href,
				publicSubpath: "./backend",
				factoryExport: "createFixtureExecutionBackend",
			},
		});
	});

	after(() => {
		dispose();
		mockPi.uninstall();
		if (savedTrace === undefined) delete process.env.PI_COHORT_FIXTURE_TRACE;
		else process.env.PI_COHORT_FIXTURE_TRACE = savedTrace;
	});

	beforeEach(() => {
		tempDir = createTempDir();
		tracePath = path.join(tempDir, "trace.jsonl");
		process.env.PI_COHORT_FIXTURE_TRACE = tracePath;
	});

	afterEach(() => removeTempDir(tempDir));

	/** Runs one call to its end and returns each child's result, in call order. */
	async function execute(id: string, params: Record<string, unknown>, settingsControl?: Record<string, unknown>): Promise<ChildResult[]> {
		const executor = executorMod!.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => (settingsControl ? { control: settingsControl } : {}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("scout"), makeAgent("backed", { model: "first/model", fallbackModels: ["second/model"] })] }),
		});
		const result = await executor.execute(id, { clarify: false, ...params }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		if (!params.async) return result.details.results ?? [];
		assert.ok(result.details.asyncId, result.content[0]?.text);
		const resultPath = path.join(typesMod!.RESULTS_DIR, `${result.details.asyncId}.json`);
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return (JSON.parse(fs.readFileSync(resultPath, "utf-8")) as { results: ChildResult[] }).results;
	}

	function trace(type: string): TraceEvent[] {
		return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as TraceEvent)
			.filter((event) => event.type === type);
	}

	for (const mode of ["foreground", "background"] as const) {
		const run = mode === "background" ? { async: true } : {};
		describe(mode, { skip: mode === "background" && !asyncAvailable ? "jiti not available" : undefined }, () => {
			it("closes the surface and fails a child whose pi never reports ready", async () => {
				const [child] = await execute(`${mode}-single`, { agent: "scout", task: "NEVER-READY", control: { startDeadlineMs: 400 }, ...run });
				assert.match(child?.error ?? "", notStarted(400));
				assert.notEqual(child?.exitCode, 0);
				assert.deepEqual(trace("close").map((event) => event.reason), ["explicit_cleanup"]);
			});

			it("starts no further model attempt after the deadline ends one", async () => {
				const [child] = await execute(`${mode}-fallback`, { agent: "backed", task: "NEVER-READY", control: { startDeadlineMs: 400 }, ...run });
				assert.match(child?.error ?? "", notStarted(400));
				assert.deepEqual(trace("close").map((event) => event.reason), ["explicit_cleanup"]);
				assert.equal(trace("attempt-start").length, 1);
			});

			it("ends the child at the call's value when settings set another", async () => {
				const [child] = await execute(`${mode}-call`, { agent: "scout", task: "NEVER-READY", control: { startDeadlineMs: 400 }, ...run }, { startDeadlineMs: 60_000 });
				assert.match(child?.error ?? "", notStarted(400));
			});

			it("ends the child at the settings value when the call sets only other limits", async () => {
				const [child] = await execute(`${mode}-settings`, { agent: "scout", task: "NEVER-READY", control: { needsAttentionAfterMs: 30_000 }, ...run }, { startDeadlineMs: 400 });
				assert.match(child?.error ?? "", notStarted(400));
			});
		});
	}

	it("lets the siblings of an ended child finish with their own results", async () => {
		const results = await execute("foreground-siblings", {
			tasks: [{ agent: "scout", task: "PARALLEL a" }, { agent: "scout", task: "NEVER-READY" }, { agent: "scout", task: "PARALLEL c" }],
			control: { startDeadlineMs: 400 },
		});
		assert.match(results[1]?.error ?? "", notStarted(400));
		assert.deepEqual([results[0], results[2]].map((child) => child?.exitCode), [0, 0]);
		assert.match(results[0]?.finalOutput ?? results[0]?.output ?? "", /reply:PARALLEL a/);
		assert.match(results[2]?.finalOutput ?? results[2]?.output ?? "", /reply:PARALLEL c/);
	});
});
