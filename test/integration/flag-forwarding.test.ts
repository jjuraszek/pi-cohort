/**
 * Hermetic integration test for parent CLI flags and project trust.
 *
 * Follows flags through foreground execution and detached single/chain runners,
 * and project trust from the executor's session context into the child's argv.
 * Uses the mock pi binary; no real model calls.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	createEventBus,
	tryImport,
} from "../support/helpers.ts";
import { deriveForwardedFlags } from "../../src/runs/shared/forward-flags.ts";
import { emptyGrandTotal } from "../../src/extension/grand-total.ts";

interface RunSyncResult {
	exitCode: number;
}

interface ExecutionModule {
	runSync(
		runtimeCwd: string,
		agents: ReturnType<typeof makeAgentConfigs>,
		agentName: string,
		task: string,
		options: Record<string, unknown>,
	): Promise<RunSyncResult>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): { content: Array<{ text?: string }>; isError?: boolean; details: { asyncId?: string } };
	executeAsyncChain: AsyncExecutionModule["executeAsyncSingle"];
}

interface TypesModule {
	RESULTS_DIR: string;
}

const executorMod = await tryImport<typeof import("../../src/runs/foreground/subagent-executor.ts")>("./src/runs/foreground/subagent-executor.ts");
const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const available = !!(executorMod && execution && asyncMod && typesMod);

const runSync = execution?.runSync;
const availabilityMock = createMockPi();
const isAsyncAvailable = () => asyncMod!.isAsyncAvailable(availabilityMock.runtime);
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const RESULTS_DIR = typesMod?.RESULTS_DIR;

async function waitForAsyncResultFile(id: string, timeoutMs = 30_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR!, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

function readLastMockPiArgs(mockPi: MockPi): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(-1);
	assert.ok(callFile, "expected a recorded mock pi call");
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

describe("parent flag forwarding", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const runSync = (cwd, agents, agent, task, options) => execution!.runSync(cwd, agents, agent, task, { ...options, runtime: mockPi.runtime });

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

	function readCallArgs(): string[] {
		return readLastMockPiArgs(mockPi);
	}

	it("forwards a parent CLI flag into the child argv (foreground)", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync!(tempDir, agents, "echo", "do it", {
			runId: "fwd-fg",
			forwardedFlags: ["--no-autofix"],
		});

		assert.equal(result.exitCode, 0);
		assert.ok(readCallArgs().includes("--no-autofix"));
	});

	it("does not forward flags when the agent restricts extensions", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = [makeAgent("restricted", { extensions: [] })];

		const result = await runSync!(tempDir, agents, "restricted", "do it", {
			runId: "fwd-gate",
			forwardedFlags: ["--no-autofix"],
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		assert.ok(args.includes("--no-extensions"));
		assert.ok(!args.includes("--no-autofix"));
	});

	it("omits forwarded flags entirely when none are provided", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync!(tempDir, agents, "echo", "do it", {
			runId: "fwd-none",
		});

		assert.equal(result.exitCode, 0);
		assert.ok(!readCallArgs().includes("--no-autofix"));
	});

	for (const trusted of [true, false]) {
		it(`reads isProjectTrusted()=${trusted} at dispatch and passes it into the child argv`, async () => {
			execFileSync("git", ["init", "-q", tempDir], { timeout: 10_000 });
			fs.mkdirSync(path.join(tempDir, ".pi"));
			fs.writeFileSync(path.join(tempDir, ".pi", "settings.json"), "{}");
			mockPi.onCall({ output: "ok" });
			const executor = executorMod!.createSubagentExecutor({
				captureRuntime: mockPi.captureRuntime,
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: emptyGrandTotal() },
				resolveConfig: () => ({ forwardParentFlags: false }),
				tempArtifactsDir: tempDir,
				getSubagentSessionRoot: () => tempDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("restricted", { extensions: [] })] }),
			});

			const result = await executor.execute(
				"trust-dispatch",
				{ agent: "restricted", task: "do it", async: false, artifacts: false },
				new AbortController().signal,
				undefined,
				{ ...makeMinimalCtx(tempDir), isProjectTrusted: () => trusted },
			);

			assert.ok(!result.isError, JSON.stringify(result));
			assert.equal(result.details?.results[0]?.exitCode, 0);
			assert.equal(mockPi.callCount(), 1);
			const args = readCallArgs();
			assert.ok(args.includes("--no-extensions"));
			assert.deepEqual(args.filter((arg) => arg === "--approve" || arg === "--no-approve"), [trusted ? "--approve" : "--no-approve"]);
		});
	}

	for (const mode of ["single", "chain"] as const) {
		it(`passes the parent's project trust through the async detached ${mode} runner into the child argv`, async () => {
			assert.ok(isAsyncAvailable(), "jiti must be available for detached trust coverage");
			mockPi.onCall({ output: "async done" });
			const id = `trust-async-${mode}-${Date.now().toString(36)}`;
			const params = {
				ctx: { runtime: mockPi.runtime, pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
				projectTrust: { trusted: false, root: tempDir },
			};
			const started = mode === "single"
				? executeAsyncSingle!(id, { ...params, agent: "worker", task: "Do work", agentConfig: makeAgent("worker") })
				: asyncMod!.executeAsyncChain(id, { ...params, chain: [{ agent: "worker", task: "Do work" }], agents: [makeAgent("worker")] });
			assert.ok(!started.isError, JSON.stringify(started));

			const resultPath = await waitForAsyncResultFile(id, 30_000);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(result.success, true, JSON.stringify(result));
			assert.equal(result.results.length, 1);
			assert.equal(result.results[0]?.success, true);
			assert.equal(mockPi.callCount(), 1);
			assert.deepEqual(readCallArgs().filter((arg) => arg === "--approve" || arg === "--no-approve"), ["--no-approve"]);
		});
	}

	it("forwards a parent CLI flag through the async detached runner into the child argv", { skip: !isAsyncAvailable?.() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async done" });
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `fwd-async-${Date.now().toString(36)}`;

		executeAsyncSingle!(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { runtime: mockPi.runtime, pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			forwardedFlags: ["--no-autofix"],
		});

		await waitForAsyncResultFile(id, 30_000);
		assert.ok(readLastMockPiArgs(mockPi).includes("--no-autofix"));
	});

	it("derivation composes with runSync end-to-end (real deriveForwardedFlags -> child argv)", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);
		const derived = deriveForwardedFlags(["/node", "/pi", "--no-autofix", "--model", "x/y"], {});
		assert.deepEqual(derived, ["--no-autofix=true"]);

		const result = await runSync!(tempDir, agents, "echo", "do it", {
			runId: "fwd-derive",
			forwardedFlags: derived,
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		assert.ok(args.includes("--no-autofix=true"));
		assert.ok(!args.includes("--model"));
	});

	it("kill-switch: forwardParentFlags:false yields no forwarded flags end-to-end", async () => {
		mockPi.onCall({ output: "ok" });
		const agents = makeAgentConfigs(["echo"]);

		const derived = deriveForwardedFlags(["/node", "/pi", "--no-autofix"], { forwardParentFlags: false });
		assert.deepEqual(derived, []);

		const result = await runSync!(tempDir, agents, "echo", "do it", {
			runId: "fwd-kill",
			forwardedFlags: derived,
		});

		assert.equal(result.exitCode, 0);
		assert.ok(!readCallArgs().includes("--no-autofix"));
	});

	it("detached runner is a pure consumer (never re-derives)", () => {
		const src = fs.readFileSync(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url), "utf8");
		assert.ok(!src.includes("deriveForwardedFlags"), "detached runner must consume cfg.forwardedFlags, never derive");
	});

	it("pi-lens --no-autofix observable effect (manual smoke test)", { skip: "manual: see doc/configuration.md#manually-verifying-flag-forwarding" }, () => {});
});
