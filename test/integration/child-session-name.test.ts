/**
 * Hermetic integration test for child session naming.
 *
 * Proves the executor names each child `<agent> <run id prefix>[/<index>] from
 * <parent session>` through foreground (runSync -> buildPiArgs) and async
 * (executeAsyncSingle -> subagent-runner -> buildPiArgs) dispatch. Uses the
 * mock pi binary; no real model calls.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

interface ExecuteResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details: { runId?: string; asyncId?: string };
}

interface ExecutorModule {
	createSubagentExecutor(deps: Record<string, unknown>): {
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: unknown): Promise<ExecuteResult>;
	};
}

interface AsyncExecutionModule {
	isAsyncAvailable(runtime: unknown): boolean;
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<{ RESULTS_DIR: string }>("./src/shared/types.ts");
const available = !!(executorMod && asyncMod && typesMod);
const availabilityMock = createMockPi();
const asyncAvailable = available && asyncMod!.isAsyncAvailable(availabilityMock.runtime);

async function waitForAsyncResultFile(id: string, timeoutMs = 30_000): Promise<void> {
	const resultPath = path.join(typesMod!.RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

function recordedSessionNames(mockPi: MockPi): string[] {
	return fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.map((name) => {
			const { args } = JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")) as { args: string[] };
			assert.ok(args.includes("--name"), `expected --name in ${JSON.stringify(args)}`);
			return args[args.indexOf("--name") + 1];
		});
}

function sessionCtx(cwd: string, sessionName: string | undefined) {
	const ctx = makeMinimalCtx(cwd);
	return { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionName: () => sessionName } };
}

describe("child session naming", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeExecutor() {
		return executorMod!.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("scout")] }),
		});
	}

	it("names a foreground child after its agent, run, and named parent", async () => {
		mockPi.onCall({ output: "ok" });
		const result = await makeExecutor().execute("fg", { agent: "scout", task: "look" }, new AbortController().signal, undefined, sessionCtx(tempDir, "P"));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(recordedSessionNames(mockPi), [`scout ${result.details.runId!.slice(0, 8)} from P`]);
	});

	it("identifies an unnamed parent by its session id", async () => {
		mockPi.onCall({ output: "ok" });
		const result = await makeExecutor().execute("fg-unnamed", { agent: "scout", task: "look" }, new AbortController().signal, undefined, sessionCtx(tempDir, undefined));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(recordedSessionNames(mockPi), [`scout ${result.details.runId!.slice(0, 8)} from session-123`]);
	});

	it("distinguishes the children of one parallel run by index", async () => {
		mockPi.onCall({ output: "ok" });
		const result = await makeExecutor().execute("fg-parallel", { tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b" }], clarify: false }, new AbortController().signal, undefined, sessionCtx(tempDir, "P"));
		assert.equal(result.isError, undefined, result.content[0]?.text);
		const run = result.details.runId!.slice(0, 8);
		assert.deepEqual(recordedSessionNames(mockPi).sort(), [`scout ${run} from P`, `scout ${run}/1 from P`]);
	});

	it("names concurrent async children distinguishably", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async done" });
		const executor = makeExecutor();
		const launches = await Promise.all(["first", "second"].map((label) =>
			executor.execute(`async-${label}`, { agent: "scout", task: label, async: true, clarify: false }, new AbortController().signal, undefined, sessionCtx(tempDir, "P"))));
		const ids = launches.map((launch) => {
			assert.ok(launch.details.asyncId, launch.content[0]?.text);
			return launch.details.asyncId!;
		});
		await Promise.all(ids.map((id) => waitForAsyncResultFile(id)));
		assert.deepEqual(recordedSessionNames(mockPi).sort(), ids.map((id) => `scout ${id.slice(0, 8)} from P`).sort());
	});
});
