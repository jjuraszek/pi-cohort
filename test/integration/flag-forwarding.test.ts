/**
 * Hermetic integration test for parent CLI flag forwarding.
 *
 * Proves `forwardedFlags` threads through the real dispatch code into the
 * spawned child's argv: foreground (runSync -> buildPiArgs) and async
 * (executeAsyncSingle -> subagent-runner -> buildPiArgs). Uses the mock pi
 * binary; no real model calls.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	tryImport,
} from "../support/helpers.ts";
import { deriveForwardedFlags } from "../../src/runs/shared/forward-flags.ts";

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
}

interface TypesModule {
	RESULTS_DIR: string;
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const available = !!(execution && asyncMod && typesMod);

const runSync = execution?.runSync;
const isAsyncAvailable = asyncMod?.isAsyncAvailable;
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
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
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
		const savedArgv = process.argv;
		try {
			process.argv = ["/node", "/pi", "--no-autofix", "--model", "x/y"];
			const derived = deriveForwardedFlags(process.argv, {});
			assert.deepEqual(derived, ["--no-autofix"]);

			const result = await runSync!(tempDir, agents, "echo", "do it", {
				runId: "fwd-derive",
				forwardedFlags: derived,
			});

			assert.equal(result.exitCode, 0);
			const args = readCallArgs();
			assert.ok(args.includes("--no-autofix"));
			assert.ok(!args.includes("--model"));
		} finally {
			process.argv = savedArgv;
		}
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
