/**
 * Integration test for backend launch options in a child's settings override.
 *
 * Proves `subagents.executionBackendOptions.<backend>` in a `settings` override,
 * from the call or the agent config, reaches that child's launch request as
 * `awareness.options` and no other, through foreground and async dispatch. The
 * fixture backend records each launch's options; the scripted pi answers
 * without model calls.
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

interface ExecuteResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details: { asyncId?: string };
}

interface ExecutorModule {
	createSubagentExecutor(deps: Record<string, unknown>): {
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: unknown): Promise<ExecuteResult>;
	};
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
const BACKEND = "fixture-detached";
const SPLIT = { subagents: { executionBackendOptions: { [BACKEND]: { placement: "split" } } } };
const TAB = { subagents: { executionBackendOptions: { [BACKEND]: { placement: "tab" } } } };

describe("backend launch options in a child settings override", { skip }, () => {
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

	async function execute(id: string, params: Record<string, unknown>): Promise<void> {
		const executor = executorMod!.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("scout"), makeAgent("watched", { settings: { ...SPLIT, theme: "light" } })] }),
		});
		const result = await executor.execute(id, { clarify: false, ...params }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		if (!params.async) return;
		assert.ok(result.details.asyncId, result.content[0]?.text);
		const resultPath = path.join(typesMod!.RESULTS_DIR, `${result.details.asyncId}.json`);
		const deadline = Date.now() + 30_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).success, true);
	}

	/** Each launch request's `awareness.options`, ordered by the child's index in the call. */
	function launchedOptions(): unknown[] {
		return fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; childId: string; options?: unknown })
			.filter((event) => event.type === "launch")
			.sort((a, b) => Number(a.childId.split("-").at(-1)) - Number(b.childId.split("-").at(-1)))
			.map((event) => event.options);
	}

	for (const mode of ["foreground", "background"] as const) {
		const run = mode === "background" ? { async: true } : {};
		describe(mode, { skip: mode === "background" && !asyncAvailable ? "jiti not available" : undefined }, () => {
			it("gives a task's options to that child's launch and not to its sibling's", async () => {
				await execute(`${mode}-parallel`, { tasks: [{ agent: "scout", task: "PARALLEL a", settings: SPLIT }, { agent: "scout", task: "PARALLEL b" }], ...run });
				assert.deepEqual(launchedOptions(), [{ placement: "split" }, undefined]);
			});

			it("gives an agent's options to every launch of that agent", async () => {
				await execute(`${mode}-agent`, { tasks: [{ agent: "watched", task: "PARALLEL a" }, { agent: "scout", task: "PARALLEL b" }, { agent: "watched", task: "PARALLEL c" }], ...run });
				assert.deepEqual(launchedOptions(), [{ placement: "split" }, undefined, { placement: "split" }]);
			});

			it("lets the call's value win over the agent's", async () => {
				await execute(`${mode}-call`, { agent: "watched", task: "SINGLE", settings: TAB, ...run });
				assert.deepEqual(launchedOptions(), [{ placement: "tab" }]);
			});

			it("gives a chain step's options to that step's launch", async () => {
				await execute(`${mode}-chain`, { chain: [{ agent: "scout", task: "CHAIN-FIRST", settings: SPLIT }, { agent: "scout", task: "CHAIN-SECOND" }], ...run });
				assert.deepEqual(launchedOptions(), [{ placement: "split" }, undefined]);
			});
		});
	}
});
