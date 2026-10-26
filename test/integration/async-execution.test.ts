/**
 * Integration tests for async (background) agent execution.
 *
 * Tests the async support utilities: jiti availability check,
 * status file reading/caching.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
 */

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import defaultFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, createMockPi, createTempDir, events, makeAgent, makeMinimalCtx, makeParentSessionCtx, removeTempDir, tryImport } from "../support/helpers.ts";
import type { MockPi } from "../support/helpers.ts";
import { getArtifactPaths } from "../../src/shared/artifacts.ts";
import { formatModelAttemptNote } from "../../src/runs/shared/model-fallback.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";

interface AsyncExecutionResult {
	content: Array<{ text?: string }>;
	isError?: boolean;
	details: { asyncId?: string };
}

interface AsyncResultPayload {
	stop?: unknown;
	success: boolean;
	state?: string;
	exitCode?: number;
	sessionId?: string;
	mode?: string;
	summary?: string;
	results: Array<{ exitCode?: number; artifactPaths?: { outputPath: string }; output?: string; success?: boolean; error?: string; model?: string; attemptedModels?: string[]; modelAttempts?: Array<{ model: string; success: boolean; exitCode?: number | null; error?: string }>; structuredOutput?: unknown; acceptance?: { status?: string; childReport?: unknown } }>;
	outputs?: Record<string, { text?: string; structured?: unknown; patchPath?: string; treePath?: string; repoCwd?: string; baseCommit?: string; taskIndex?: number }>;
	workflowGraph?: { nodes?: Array<{ kind?: string; label?: string; phase?: string; status?: string; error?: string; outputName?: string; structured?: boolean; children?: Array<{ label?: string; outputName?: string; itemKey?: string; status?: string; error?: string }> }> };
}

interface AsyncStatusPayload {
	sessionId?: string;
	activityState?: string;
	currentTool?: string;
	currentPath?: string;
	state?: string;
	error?: string;
	totalTokens?: { total: number };
	parallelGroups?: Array<{ start: number; count: number; stepIndex: number }>;
	steps?: Array<{
		label?: string;
		phase?: string;
		outputName?: string;
		structured?: boolean;
		skills?: string[];
		activityState?: string;
		currentTool?: string;
		currentPath?: string;
		status?: string;
		exitCode?: number;
		error?: string;
		model?: string;
		thinking?: string;
		tokens?: { total: number };
		acceptance?: { status?: string };
	}>;
}

interface AsyncExecutionModule {
	isAsyncAvailable(): boolean;
	executeAsyncSingle(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	executeAsyncChain(id: string, params: Record<string, unknown>): AsyncExecutionResult;
	spawnDetachedWithLog(command: string, args: string[], cwd: string, asyncDir: string): { pid?: number; error?: string };
}

interface ReconcileAsyncRunModule {
	reconcileAsyncRun(asyncDir: string, options?: {
		resultsDir?: string;
		now?: () => number;
		startedRun?: { runId: string; pid?: number; startedAt?: number };
		missingStatusGraceMs?: number;
	}): { status: unknown; repaired: boolean; resultPath?: string; message?: string };
}

interface UtilsModule {
	readStatus(dir: string): { runId: string; state: string; mode: string } | null;
}

interface TypesModule {
	ASYNC_DIR: string;
	RESULTS_DIR: string;
	TEMP_ROOT_DIR: string;
	getAsyncConfigPath(id: string): string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean; details?: { asyncId?: string } }>;
	};
}

const asyncMod = await tryImport<AsyncExecutionModule>("./src/runs/background/async-execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const typesMod = await tryImport<TypesModule>("./src/shared/types.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const reconcilerMod = await tryImport<ReconcileAsyncRunModule>("./src/runs/background/stale-run-reconciler.ts");
const available = !!(asyncMod && utils && typesMod);

const availabilityMock = createMockPi();
const isAsyncAvailable = () => asyncMod!.isAsyncAvailable(availabilityMock.runtime);
const executeAsyncSingle = asyncMod?.executeAsyncSingle;
const executeAsyncChain = asyncMod?.executeAsyncChain;
const spawnDetachedWithLog = asyncMod?.spawnDetachedWithLog;
const readStatus = utils?.readStatus;
const ASYNC_DIR = typesMod?.ASYNC_DIR;
const RESULTS_DIR = typesMod?.RESULTS_DIR;
const TEMP_ROOT_DIR = typesMod?.TEMP_ROOT_DIR;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const reconcileAsyncRun = reconcilerMod?.reconcileAsyncRun;

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf-8",
		env: {
			...process.env,
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "commit.gpgsign",
			GIT_CONFIG_VALUE_0: "false",
		},
	});
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Async Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}

async function waitForAsyncResultFile(id: string, timeoutMs = 30_000): Promise<string> {
	const resultPath = path.join(RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return resultPath;
}

const TIMEOUT_DIAGNOSTIC_MAX_BYTES = 4_096;

function readBoundedDiagnosticFile(filePath: string): { text?: string; truncated?: boolean; error?: string } {
	let fd: number | undefined;
	try {
		const size = fs.statSync(filePath).size;
		const buffer = Buffer.alloc(Math.min(size, TIMEOUT_DIAGNOSTIC_MAX_BYTES));
		fd = fs.openSync(filePath, "r");
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		return { text: buffer.subarray(0, bytesRead).toString("utf-8"), truncated: size > buffer.length };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function formatAsyncTimeoutDiagnostics(asyncDir: string, configPath: string, resultPath: string): string {
	try {
		const statusPath = path.join(asyncDir, "status.json");
		const runnerLogPath = path.join(asyncDir, "runner.log");
		const outputLogPaths = [
			path.join(asyncDir, "output-0.log"),
			path.join(asyncDir, "output-1.log"),
		];
		const files = [
			["status.json", statusPath],
			["runner.log", runnerLogPath],
			["events.jsonl", path.join(asyncDir, "events.jsonl")],
			["config", configPath],
			["result", resultPath],
		].map(([name, filePath]) => `${name}=${fs.existsSync(filePath) ? "present" : "missing"}`);
		const statusFile = readBoundedDiagnosticFile(statusPath);
		let status = "(missing status.json)";
		if (statusFile.text !== undefined && !statusFile.truncated) {
			try {
				const payload = JSON.parse(statusFile.text) as AsyncStatusPayload;
				status = JSON.stringify({
					state: payload.state ?? null,
					error: payload.error ?? null,
					currentTool: payload.currentTool ?? null,
					currentPath: payload.currentPath ?? null,
					steps: payload.steps?.map((step) => ({
						status: step.status ?? null,
						error: step.error ?? null,
						currentTool: step.currentTool ?? null,
						currentPath: step.currentPath ?? null,
					})),
				});
			} catch (error) {
				status = `(unavailable: ${error instanceof Error ? error.message : String(error)})`;
			}
		} else if (statusFile.truncated) {
			status = `(unavailable: status.json exceeds ${TIMEOUT_DIAGNOSTIC_MAX_BYTES} bytes)`;
		} else if (statusFile.error) {
			status = `(unavailable: ${statusFile.error})`;
		}
		const formatLog = (filePath: string): string => {
			const file = readBoundedDiagnosticFile(filePath);
			if (file.text === undefined) return `(unavailable: ${file.error})`;
			return `${file.text}${file.truncated ? `\n[truncated after ${TIMEOUT_DIAGNOSTIC_MAX_BYTES} bytes]` : ""}`;
		};
		return [
			"Async timeout diagnostics:",
			`Files: ${files.join(", ")}`,
			`Status: ${status}`,
			`Runner log:\n${formatLog(runnerLogPath)}`,
			...outputLogPaths.map((outputLogPath) => `Output log ${path.basename(outputLogPath)}:\n${formatLog(outputLogPath)}`),
		].join("\n");
	} catch (error) {
		return `Async timeout diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
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

function readMockPiArgs(mockPi: MockPi, index: number): string[] {
	const callFile = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.at(index);
	assert.ok(callFile, `expected recorded call ${index}`);
	const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
	assert.ok(Array.isArray(payload.args), "expected recorded args");
	return payload.args;
}

describe("async execution utilities", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const createSubagentExecutor = (deps) => executorMod!.createSubagentExecutor({ ...deps, captureRuntime: mockPi.captureRuntime });
	const executeAsyncSingle = (id, params) => asyncMod!.executeAsyncSingle(id, { ...params, ctx: { ...params.ctx, runtime: params.ctx.runtime ?? mockPi.runtime } });
	const executeAsyncChain = (id, params) => asyncMod!.executeAsyncChain(id, { ...params, ctx: { ...params.ctx, runtime: mockPi.runtime } });

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
	it("reports jiti availability as boolean", () => {
		const result = isAsyncAvailable();
		assert.equal(typeof result, "boolean");
	});

	it("readStatus returns null for missing directory", () => {
		const status = readStatus("/nonexistent/path/abc123");
		assert.equal(status, null);
	});

	it("readStatus parses valid status file", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "test-123",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
				lastUpdate: Date.now(),
				steps: [{ agent: "test", status: "running" }],
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const status = readStatus(dir);
			assert.ok(status, "should parse status");
			assert.equal(status.runId, "test-123");
			assert.equal(status.state, "running");
			assert.equal(status.mode, "single");
		} finally {
			removeTempDir(dir);
		}
	});

	it("async launch messages tell the parent not to sleep-poll", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const commonParams = {
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
		};
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_RUN_DIR"] });
		const singleId = `async-handoff-single-${Date.now().toString(36)}`;
		const singleResult = executeAsyncSingle(singleId, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			...commonParams,
		});
		assert.match(singleResult.content[0]?.text ?? "", /Async: worker \[/);
		assert.match(singleResult.content[0]?.text ?? "", /Async dir: /);
		assert.match(singleResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(singleResult.content[0]?.text ?? "", /end your turn now/);
		// First detached spawn in the suite pays the cold jiti-transpile cost; give it a wide budget (slow Windows CI).
		const singleResultPath = await waitForAsyncResultFile(singleId, 30_000);
		const singlePayload = JSON.parse(fs.readFileSync(singleResultPath, "utf-8")) as AsyncResultPayload;
		const observedEnv = JSON.parse(singlePayload.results[0]?.output ?? "{}") as { PI_SUBAGENT_RUN_DIR?: string };
		assert.equal(observedEnv.PI_SUBAGENT_RUN_DIR, path.join(ASYNC_DIR, singleId));

		mockPi.onCall({ output: "parallel one done" });
		mockPi.onCall({ output: "parallel two done" });
		const parallelId = `async-handoff-parallel-${Date.now().toString(36)}`;
		const parallelResult = executeAsyncChain(parallelId, {
			chain: [{ parallel: [{ agent: "worker", task: "Do one" }, { agent: "reviewer", task: "Do two" }] }],
			resultMode: "parallel",
			agents: [makeAgent("worker"), makeAgent("reviewer")],
			...commonParams,
		});
		assert.match(parallelResult.content[0]?.text ?? "", /Async parallel:/);
		assert.match(parallelResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		assert.match(parallelResult.content[0]?.text ?? "", /Pi will deliver the completion/);
		const parallelResultPath = await waitForAsyncResultFile(parallelId, 30_000);
		const parallelPayload = JSON.parse(fs.readFileSync(parallelResultPath, "utf-8")) as { agent?: string; mode?: string };
		assert.equal(parallelPayload.mode, "parallel");
		assert.equal(parallelPayload.agent, "parallel:worker+reviewer");

		mockPi.onCall({ output: "chain done" });
		const chainId = `async-handoff-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do chained work" }],
			agents: [makeAgent("worker")],
			...commonParams,
		});
		assert.match(chainResult.content[0]?.text ?? "", /Async chain:/);
		assert.match(chainResult.content[0]?.text ?? "", /Do not run sleep timers or polling loops/);
		await waitForAsyncResultFile(chainId, 30_000);
	});

	it("a runner that crashes at startup is reconciled to failed with the crash cause in the message", { skip: !isAsyncAvailable() || !spawnDetachedWithLog || !reconcileAsyncRun ? "jiti not available" : undefined }, async () => {
		const asyncDir = path.join(tempDir, "async-crash-run");
		fs.mkdirSync(asyncDir, { recursive: true });
		const crashMessage = "startup crash: Cannot find module";
		const spawnResult = spawnDetachedWithLog!(
			process.execPath,
			["-e", `console.error(${JSON.stringify(crashMessage)}); process.exit(1);`],
			tempDir,
			asyncDir,
		);
		assert.equal(typeof spawnResult.pid, "number");
		const pid = spawnResult.pid!;

		const logPath = path.join(asyncDir, "runner.log");
		const deadline = Date.now() + 10_000;
		let logContainsCrash = false;
		while (!logContainsCrash) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for runner.log to contain the crash message: ${logPath}`);
			if (fs.existsSync(logPath) && fs.readFileSync(logPath, "utf-8").includes(crashMessage)) {
				logContainsCrash = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const pidDeadline = Date.now() + 10_000;
		let pidIsDead = false;
		while (!pidIsDead) {
			if (Date.now() > pidDeadline) assert.fail(`Timed out waiting for crashed runner pid ${pid} to exit`);
			try {
				process.kill(pid, 0);
			} catch {
				pidIsDead = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const runId = "async-crash-run";
		const resultsDir = path.join(tempDir, "async-crash-results");
		fs.mkdirSync(resultsDir, { recursive: true });
		const result = reconcileAsyncRun!(asyncDir, {
			resultsDir,
			startedRun: { runId, pid, startedAt: Date.now() - 60_000 },
			missingStatusGraceMs: 0,
		});

		assert.equal(result.repaired, true);
		assert.equal((result.status as { state?: string } | null)?.state, "failed");
		assert.match(result.message ?? "", /startup crash: Cannot find module/);
	});

	it("top-level async parallel conversion preserves output, reads, and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async top-level report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});

		const result = await executor.execute(
			"async-parallel-fields",
			{
				tasks: [{ agent: "worker", task: "Do async work", output: "async-top-output.md", reads: ["input.md"], progress: true }],
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const statusPath = path.join(ASYNC_DIR, asyncId, "status.json");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.mode, "parallel");
			assert.equal(payload.sessionId, "session-123");
			assert.equal(payload.results[0]?.acceptance?.status, "checked");
			assert.equal(status.sessionId, "session-123");
			assert.equal(status.steps?.[0]?.acceptance?.status, "checked");
		const outputPath = path.join(tempDir, "async-top-output.md");
		const outputDeadline = Date.now() + 5_000;
		while (!fs.existsSync(outputPath)) {
			if (Date.now() > outputDeadline) {
				assert.fail(`Timed out waiting for saved output file: ${outputPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Async top-level report");
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.ok(taskArg.includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.ok(taskArg.includes(`Write your findings to: ${outputPath}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("top-level async and resume inherit the parent's then-current model and thinking", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "First pass" });
		mockPi.onCall({ output: "Resumed pass" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});

		const first = await executor.execute(
			"async-inherit-first",
			{ agent: "worker", task: "Do async work", async: true, clarify: false },
			new AbortController().signal,
			undefined,
			makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "high"),
		);
		const firstId = first.details?.asyncId;
		assert.ok(firstId, "expected asyncId");
		const firstPayload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(firstId, 15_000), "utf-8")) as AsyncResultPayload;
		assert.equal(firstPayload.results[0]?.model, "github-copilot/gpt-6:high");
		assert.deepEqual(firstPayload.results[0]?.attemptedModels, ["github-copilot/gpt-6:high"]);

		const resumed = await executor.execute(
			"async-inherit-resume",
			{ action: "resume", id: firstId, message: "Continue" },
			new AbortController().signal,
			undefined,
			makeParentSessionCtx(tempDir, "anthropic", "claude-sonnet-4", "low"),
		);
		const resumedId = resumed.details?.asyncId;
		assert.ok(resumedId, `expected resumed asyncId: ${JSON.stringify(resumed.content)}`);
		const resumedPayload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(resumedId, 15_000), "utf-8")) as AsyncResultPayload;
		assert.equal(resumedPayload.results[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(resumedPayload.results[0]?.attemptedModels, ["anthropic/claude-sonnet-4:low"]);
	});

	it("top-level async parallel defaults require explicit output and progress", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		fs.writeFileSync(path.join(tempDir, "input.md"), "input\n", "utf-8");
		mockPi.onCall({ output: "Async parallel inline report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}), tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { output: "default-report.md", defaultProgress: true, defaultReads: ["input.md"] })] }),
		});
		const result = await executor.execute(
			"async-parallel-defaults-omitted",
			{ tasks: [{ agent: "worker", task: "Write report" }], async: true, clarify: false },
			new AbortController().signal, undefined, makeMinimalCtx(tempDir),
		);
		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = await waitForAsyncResultFile(asyncId);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.mode, "parallel");
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "Async parallel inline report");
		const taskArg = readLastMockPiArgs(mockPi).at(-1) ?? "";
		assert.ok(taskArg.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.doesNotMatch(taskArg, /Write your findings to:|Update progress at:/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("top-level async single output defaults require explicit opt-in", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async inline report" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}), tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("worker", { output: "default-report.md" })] }),
		});
		const result = await executor.execute(
			"async-single-output-omitted",
			{ agent: "worker", task: "Write report", async: true, clarify: false },
			new AbortController().signal, undefined, makeMinimalCtx(tempDir),
		);
		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		await waitForAsyncResultFile(asyncId);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to:/);
	});

	it("async single rejects explicit reviewed acceptance without a reviewer result", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					testsAddedOrUpdated: ["test/file.test.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					validationOutput: ["passed"],
					residualRisks: [],
					noStagedFiles: true,
					notes: "done",
				}),
				"```",
			].join("\n"),
		});
		const artifactConfig = {
			enabled: false,
			includeInput: false,
			includeOutput: false,
			includeJsonl: false,
			includeMetadata: false,
			cleanupDays: 7,
		};
		const id = `async-acceptance-${Date.now().toString(36)}`;
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement acceptance-covered fix",
			agentConfig: makeAgent("worker", { completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-acceptance" },
			artifactConfig,
			shareEnabled: false,
			maxSubagentDepth: 2,
			acceptance: { level: "reviewed", criteria: ["Patch bug"], review: false },
		});
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const result = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;

		assert.equal(result.success, false);
		assert.equal(result.results[0]?.acceptance?.status, "rejected");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "needs-parent-decision");
		assert.equal(status.steps?.[0]?.acceptance?.status, "rejected");
	});

	it("top-level async chain suppresses progress for {task} review-only tasks", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		mockPi.onCall({ output: "Async review" });
		const executor = createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (p: string) => p,
			discoverAgents: () => ({ agents: [makeAgent("reviewer", { defaultProgress: true })] }),
		});

		const result = await executor.execute(
			"async-chain-read-only-progress",
			{
				chain: [{ agent: "reviewer" }],
				task: "Review-only. Do not edit files. Return findings.",
				async: true,
				clarify: false,
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const asyncId = result.details?.asyncId;
		assert.ok(asyncId, "expected asyncId");
		const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
		assert.doesNotMatch(args.at(-1) ?? "", /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("async chains reject malformed named output references before spawning", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const id = `async-malformed-output-ref-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "consumer", task: "Use {outputs.bad-name}" }],
			agents: [makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-malformed" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("async chains persist structured outputs, named outputs, and graph labels", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const schema = {
			type: "object",
			required: ["value"],
			properties: { value: { type: "string" } },
		};
		mockPi.onCall({ output: "structured prose", structuredOutput: { value: "Alpha structured" } });
		mockPi.onCall({ output: "used named output" });
		const id = `async-structured-chain-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{
					agent: "producer",
					task: "Produce data",
					phase: "Collect",
					label: "Produce structured data",
					as: "data",
					outputSchema: schema,
				},
				{ agent: "consumer", task: "Use {outputs.data}", phase: "Use", label: "Consume data" },
			],
			agents: [makeAgent("producer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-structured" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.deepEqual(payload.results[0]?.structuredOutput, { value: "Alpha structured" });
		assert.deepEqual(payload.outputs?.data?.structured, { value: "Alpha structured" });
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Alpha structured/);
		assert.equal(status.steps?.[0]?.label, "Produce structured data");
		assert.equal(status.steps?.[0]?.phase, "Collect");
		assert.equal(status.steps?.[0]?.outputName, "data");
		assert.equal(status.steps?.[0]?.structured, true);
		assert.equal(payload.workflowGraph?.nodes?.[0]?.label, "Produce structured data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.outputName, "data");
		assert.equal(payload.workflowGraph?.nodes?.[0]?.status, "completed");
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "completed");
	});

	it("async dynamic status shows a placeholder before materialization", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ delay: 800, output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-placeholder-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
					concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-placeholder" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const statusPath = path.join(ASYNC_DIR, id, "status.json");
		const deadline = Date.now() + 5_000;
		let status: AsyncStatusPayload | undefined;
		while (!status) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async status file: ${statusPath}`);
			if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			else await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.deepEqual(status.steps?.map((step) => step.agent), ["producer", "expand:reviewer", "consumer"]);
		assert.equal(status.steps?.[1]?.label, "Review {target.path}");
		assert.equal(status.steps?.[1]?.outputName, "reviews");
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 1, stepIndex: 1 }]);

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const finalStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.deepEqual(finalStatus.steps?.map((step) => step.agent), ["producer", "reviewer", "reviewer", "consumer"]);
		assert.deepEqual(finalStatus.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
	});

	it("async chains expand dynamic fanout and persist collected output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "used reviews" });
		const id = `async-dynamic-chain-${Date.now().toString(36)}`;
		const originSessionRoot = fs.realpathSync.native(tempDir);
		const original = path.join(originSessionRoot, "producer.jsonl");
		fs.writeFileSync(original, "original history\n");
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: {
						agent: "reviewer",
						task: "Review {target.path}",
						label: "Review {target.path}",
						outputSchema: { type: "object" },
				},
				collect: { as: "reviews" },
				concurrency: 1,
				},
				{ agent: "consumer", task: "Use {outputs.reviews}" },
			],
			agents: [makeAgent("producer"), makeAgent("reviewer"), makeAgent("consumer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic" },
			sessionRoot: originSessionRoot,
			originSessionRoot,
			sessionFilesByFlatIndex: [original, undefined],
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(payload.success, true);
		assert.equal(mockPi.callCount(), 4);
		assert.ok(fs.readFileSync(original, "utf8").startsWith("original history\n"));
		assert.equal(readMockPiArgs(mockPi, 0)[readMockPiArgs(mockPi, 0).indexOf("--session") + 1], original);
		const consumerArgs = readMockPiArgs(mockPi, 3);
		assert.equal(consumerArgs.includes("--session"), false);
		assert.equal(consumerArgs.includes("--session-dir"), true);
		const consumerSessionDir = consumerArgs[consumerArgs.indexOf("--session-dir") + 1];
		assert.ok(fs.realpathSync.native(consumerSessionDir).startsWith(`${originSessionRoot}${path.sep}`));
		const consumerSession = payload.results[3].sessionFile;
		assert.ok(fs.existsSync(consumerSession));
		assert.notEqual(consumerSession, original);
		assert.match(readMockPiArgs(mockPi, 1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readMockPiArgs(mockPi, 2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readMockPiArgs(mockPi, 3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = payload.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		assert.equal(status.steps?.length, 4);
		assert.deepEqual(status.parallelGroups, [{ start: 1, count: 2, stepIndex: 1 }]);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.kind, "dynamic-parallel-group");
		assert.deepEqual(payload.workflowGraph?.nodes?.[1]?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
		assert.equal(payload.workflowGraph?.nodes?.[2]?.flatIndex, 3);
	});

	it("async dynamic pre-spawn failures persist failed graph status and error", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		const id = `async-dynamic-prespawn-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 1 },
					parallel: { agent: "reviewer", task: "Review {target.path}" },
					collect: { as: "reviews" },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload & { workflowGraph?: AsyncResultPayload["workflowGraph"]; error?: string };
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /exceeding maxItems 1/);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.state, "failed");
		assert.match(status.error ?? "", /exceeding maxItems 1/);
		assert.equal(status.workflowGraph?.nodes?.[1]?.status, "failed");
	});

	it("async dynamic collect schema failures persist failed graph status and details", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const id = `async-dynamic-collect-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "producer", task: "Produce targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews", outputSchema: { type: "object" } },
				},
			],
			agents: [makeAgent("producer"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-dynamic-collect-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		assert.ok(!result.isError);
		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results.at(-1)?.error ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(payload.results.at(-1)?.structuredOutput), "failed collect result should preserve ordered collection details");
		assert.deepEqual(payload.outputs?.reviews?.structured, payload.results.at(-1)?.structuredOutput);
		assert.equal(payload.workflowGraph?.nodes?.[1]?.status, "failed");
		assert.match(payload.workflowGraph?.nodes?.[1]?.error ?? "", /Collected output validation failed/);
	});

	it("async dynamic item failure keeps the collection and stop record", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: ["a", "b"] } });
		mockPi.onCall({ output: "needs fixes", structuredOutput: { verdict: "FAIL" } });
		mockPi.onCall({ exitCode: 1, stderr: "review crashed" });
		const id = `async-stop-dynamic-fail-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "scout", task: "Targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {item}", outputSchema: { type: "object" } },
					collect: { as: "reviews" }, concurrency: 1,
					stopOn: { path: "/verdict", in: ["FAIL"] },
				},
				{ agent: "writer", task: "never" },
			],
			agents: [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-stop-dynamic-fail" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.ok(!result.isError);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(mockPi.callCount(), 3);
		assert.equal(payload.stop?.matches.length, 1);
		const collected = payload.outputs?.reviews?.structured as Array<{ exitCode: number; error?: string }>;
		assert.ok(Array.isArray(collected));
		assert.equal(collected.length, 2);
		assert.deepEqual(collected.map((item) => item.exitCode), [0, 1]);
		assert.match(collected[1]!.error ?? "", /review crashed/);
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8"));
		assert.deepEqual(status.outputs.reviews.structured, collected);
	});

	it("async sequential stopOn match writes stop into the result file and skips later steps", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Missing edge case.", structuredOutput: { verdict: "FAIL" } });
		mockPi.onCall({ output: "never" });
		const id = `async-stop-seq-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [
				{ agent: "reviewer", task: "Review", as: "sr", outputSchema: { type: "object" }, stopOn: { path: "/verdict", in: ["FAIL"] } },
				{ agent: "writer", task: "Fix {outputs.sr}" },
			],
			agents: [makeAgent("reviewer"), makeAgent("writer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-stop-seq" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.ok(!result.isError);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results.length, 1);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(payload.outputs?.sr?.text, "{\"verdict\":\"FAIL\"}");
		assert.deepEqual(payload.stop, { reason: "condition", stepIndex: 0, condition: { path: "/verdict", in: ["FAIL"] }, matches: [{ stepIndex: 0, as: "sr", agent: "reviewer", value: "FAIL" }] });
	});

	for (const siblingFails of [false, true]) {
		it(`async parallel stopOn finishes siblings and ${siblingFails ? "keeps the stop on failure" : "skips later steps"}`, { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			mockPi.onCall({ output: "one", structuredOutput: { verdict: "FAIL" } });
			mockPi.onCall(siblingFails ? { output: "boom", exitCode: 1 } : { output: "two", structuredOutput: { verdict: "PASS" } });
			const id = `async-stop-par-${siblingFails}-${Date.now().toString(36)}`;
			const result = executeAsyncChain(id, {
				chain: [
					{ parallel: [{ agent: "reviewer", task: "R1", as: "sr_1", outputSchema: { type: "object" } }, { agent: "reviewer", task: "R2", as: "sr_2", outputSchema: { type: "object" } }], concurrency: 1, stopOn: { path: "/verdict", in: ["FAIL"] } },
					{ agent: "writer", task: "never" },
				],
				agents: [makeAgent("reviewer"), makeAgent("writer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-stop-par" },
				artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
				shareEnabled: false,
				maxSubagentDepth: 2,
			});
			assert.ok(!result.isError);
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
			assert.equal(payload.success, !siblingFails);
			assert.equal(payload.state, siblingFails ? "failed" : "complete");
			assert.equal(payload.exitCode, siblingFails ? 1 : 0);
			assert.equal(payload.results.length, 2);
			assert.equal(mockPi.callCount(), 2);
			assert.deepEqual(payload.stop, { reason: "condition", stepIndex: 0, condition: { path: "/verdict", in: ["FAIL"] }, matches: [{ stepIndex: 0, taskIndex: 0, as: "sr_1", agent: "reviewer", value: "FAIL" }] });
			assert.equal(payload.outputs?.sr_1?.text, "{\"verdict\":\"FAIL\"}");
			assert.equal(Boolean(payload.outputs?.sr_2), !siblingFails);
		});
	}

	it("async run rejects stopOn without outputSchema at start", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const result = executeAsyncChain(`async-stop-invalid-${Date.now().toString(36)}`, {
			chain: [{ agent: "reviewer", task: "Review", stopOn: { path: "/verdict", in: ["FAIL"] } }],
			agents: [makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-stop-invalid" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});
		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 0);
		assert.match(result.content[0]!.text, /Chain step 1 has stopOn but no outputSchema\./);
	});

	for (const changes of [true, false]) {
		it(`async patchPath reference ${changes ? "resolves a captured patch" : "fails without changes and keeps producers"}`, { skip: process.platform === "win32" || !isAsyncAvailable() ? "requires shell hooks and jiti" : undefined }, async () => {
			const repoDir = createRepo("pi-subagent-async-patch-");
			try {
				const hookPath = path.join(tempDir, "hook.sh");
				fs.writeFileSync(hookPath, '#!/bin/sh\ninput=$(cat)\ncase "$input" in\n  *"\\"index\\":0"*) echo "patched" >> input.md ;;\nesac\necho "{}"\n');
				fs.chmodSync(hookPath, 0o755);
				mockPi.onCall({ output: "Implemented" });
				mockPi.onCall({ output: "Reviewed" });
				const id = `async-patch-${changes}-${Date.now().toString(36)}`;
				const result = executeAsyncChain(id, {
					chain: [
						{ parallel: [{ agent: "worker", task: "Implement", as: "impl_1", output: false, progress: false }], worktree: true },
						{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
					],
					agents: [makeAgent("worker", { completionGuard: false }), makeAgent("reviewer")],
					ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "session-patch" },
					...(changes ? { worktreeSetupHook: hookPath } : {}),
					artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
					shareEnabled: false,
					maxSubagentDepth: 2,
				});
				assert.ok(!result.isError);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
				assert.equal(payload.results.length, 2, JSON.stringify(payload.results));
				assert.equal(payload.success, changes);
				assert.equal(payload.outputs?.impl_1?.text, "Implemented");
				if (changes) {
					const patchPath = payload.outputs?.impl_1?.patchPath;
					assert.match(patchPath ?? "", /worktree-diffs\/step-0\/task-0-.*\.patch$/);
					assert.ok(fs.existsSync(patchPath!));
					assert.ok((readMockPiArgs(mockPi, 1).at(-1) ?? "").includes(patchPath!));
				} else {
					assert.equal(payload.state, "failed");
					assert.match(payload.results.at(-1)?.error ?? "", /Output 'impl_1' has no patch \(no changes\)./);
					assert.equal(mockPi.callCount(), 1);
				}
			} finally {
				removeTempDir(repoDir);
			}
		});
	}

	it("async parallel cwd uses task then group then run defaults", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		for (const dir of ["group", "leaf"]) fs.mkdirSync(path.join(tempDir, dir));
		for (let i = 0; i < 3; i++) mockPi.onCall({ output: "Inspect", echoCwd: true });
		const id = `async-cwd-defaults-${Date.now().toString(36)}`;
		const started = executeAsyncChain(id, {
			chain: [
				{ parallel: [{ agent: "reviewer", task: "Group default" }, { agent: "reviewer", task: "Task override", cwd: "leaf" }], cwd: "group", concurrency: 1 },
				{ parallel: [{ agent: "reviewer", task: "Run default" }] },
			], agents: [makeAgent("reviewer")], ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "cwd-defaults" },
			artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
		});
		assert.ok(!started.isError);
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload;
		assert.equal(payload.success, true, JSON.stringify(payload));
		for (const [index, expected] of ["group", "leaf", ""].entries()) {
			assert.equal(JSON.parse(payload.results[index]!.output!.split("\n").at(-1)!).cwd, fs.realpathSync(path.join(tempDir, expected)));
		}
	});

	for (const ending of ["normal", "stopOn", "failFast", "checked"] as const) {
		it(`async tree cwd preserves templates, shares snapshots and cleans up after ${ending}`, { skip: process.platform === "win32" || !isAsyncAvailable() ? "requires shell hooks and jiti" : undefined }, async () => {
			const repoDir = createRepo("pi-async-tree-");
			const id = `async-tree-${ending}-${Date.now().toString(36)}`;
			const treeTemplate = "{outputs.impl.treePath}";
			let serialized: any;
			const originalWrite = defaultFs.writeFileSync;
			try {
				const hookPath = path.join(repoDir, "tree-hook.sh");
				fs.writeFileSync(hookPath, '#!/bin/sh\ncat >/dev/null\necho patched >> input.md\necho "{}"\n');
				fs.chmodSync(hookPath, 0o755);
				fs.mkdirSync(path.join(repoDir, ".pi"));
				fs.writeFileSync(path.join(repoDir, ".pi/settings.json"), JSON.stringify({ subagents: { worktreeSetupHook: "./tree-hook.sh" } }));
				fs.writeFileSync(path.join(repoDir, "read.md"), "runner reads");
				writePackageSkill(repoDir, "tree-skill");
				git(repoDir, ["add", "."]);
				git(repoDir, ["commit", "-m", "Add preparation inputs"]);
				mockPi.onCall({ output: "Produced" });
				const report = "```acceptance-report\n" + JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "read patch" }], changedFiles: [], testsAddedOrUpdated: [], commandsRun: [], validationOutput: [], residualRisks: [], noStagedFiles: true, notes: "reviewed" }) + "\n```";
				mockPi.onCall({ output: report, echoCwd: true, echoFiles: ["input.md"], requireAcceptanceStructuredOrder: true, structuredOutput: { verdict: "FAIL" } });
				if (ending === "failFast") mockPi.onCall({ output: "Failed review", exitCode: 1 });
				if (ending === "normal") {
					mockPi.onCall({ output: "Repeated", echoCwd: true, echoFiles: ["input.md"] });
					mockPi.onCall({ output: "Override", echoCwd: true });
				}
				defaultFs.writeFileSync = ((file: any, data: any, ...rest: any[]) => {
					if (file === typesMod!.getAsyncConfigPath(id)) serialized = JSON.parse(String(data));
					return (originalWrite as any)(file, data, ...rest);
				}) as typeof originalWrite;
				let started: AsyncExecutionResult;
				try {
					started = executeAsyncChain(id, {
						chain: [
							{ parallel: [{ agent: "worker", task: "Produce", as: "impl", output: false, progress: false }], worktree: true },
							{ agent: "reviewer", task: `Review ${treeTemplate}`, cwd: treeTemplate, reads: ["read.md"], skill: ["tree-skill"], output: "review.md", progress: false, outputSchema: { type: "object" }, as: "review", acceptance: { level: ending === "checked" ? "checked" : "attested", criteria: ["Read patch"] }, ...(ending === "stopOn" ? { stopOn: { path: "/verdict", in: ["FAIL"] } } : {}) },
							{ parallel: [
								{ agent: "reviewer", task: "Review again", output: false, progress: false },
								{ agent: "reviewer", task: "Review override", cwd: repoDir, output: false, progress: false },
							], cwd: treeTemplate, concurrency: 1, failFast: ending === "failFast" },
						],
						agents: [makeAgent("worker", { completionGuard: false }), makeAgent("reviewer")],
						ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "tree" },
						worktreeSetupHook: hookPath, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
					});
				} finally {
					defaultFs.writeFileSync = originalWrite;
				}
				assert.ok(!started!.isError, started!.content[0]?.text);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
				assert.equal(serialized.steps[1].cwd, treeTemplate);
				assert.equal(serialized.steps[2].cwd, treeTemplate);
				assert.equal(serialized.steps[2].parallel[0].cwd, treeTemplate);
				assert.equal(serialized.steps[2].parallel[1].cwd, repoDir);
				assert.equal(serialized.steps[1].outputPath, path.join(repoDir, "review.md"));
				assert.ok(serialized.steps[1].task.includes(`[Read from: ${path.join(repoDir, "read.md")}]`));
				assert.deepEqual(serialized.steps[1].skills, ["tree-skill"]);
				const tree = payload.outputs?.impl?.treePath;
				assert.ok(tree, JSON.stringify(payload));
				assert.equal(payload.outputs?.impl?.repoCwd, fs.realpathSync(repoDir));
				assert.equal(payload.outputs?.impl?.baseCommit, git(repoDir, ["rev-parse", "HEAD"]));
				assert.equal(payload.outputs?.impl?.taskIndex, 0);
				assert.equal(fs.existsSync(tree), false);
				assert.doesNotMatch(git(repoDir, ["worktree", "list", "--porcelain"]), /worktree-trees/);
				if (ending === "checked") {
					assert.equal(payload.success, false);
					assert.match(payload.results[1]?.error ?? "", /Staged files present:.*input\.md/);
				} else {
					assert.equal(payload.results[1]?.acceptance?.status, "attested", JSON.stringify(payload));
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
					assert.equal(status.workflowGraph.nodes[1].acceptanceStatus, "attested");
					assert.deepEqual(payload.results[1]?.structuredOutput, { verdict: "FAIL" });
					assert.equal(payload.outputs?.review?.text, '{"verdict":"FAIL"}');
				}
				if (ending === "failFast") {
					assert.equal(payload.success, false);
					assert.match(payload.results[3]?.output ?? "", /skipped.*fail-fast/);
					assert.equal(mockPi.callCount(), 3);
				}
				if (ending === "normal") {
					assert.equal(payload.success, true, JSON.stringify(payload));
					assert.ok(payload.results[2]?.output?.includes(tree));
					assert.match(payload.results[2]?.output ?? "", /input\\npatched/);
					assert.ok(payload.results[3]?.output?.includes(fs.realpathSync(repoDir)));
				}
			} finally {
				defaultFs.writeFileSync = originalWrite;
				removeTempDir(repoDir);
			}
		});
	}

	it("runner publishes a pause after tree cleanup before optional finalization", () => {
		const source = fs.readFileSync(new URL("../../src/runs/background/subagent-runner.ts", import.meta.url), "utf8");
		const cleanup = source.indexOf("removeTrees(trees.created);");
		const summary = source.indexOf("let summary = results.map", cleanup);
		const pause = source.indexOf('type: "subagent.run.paused"', cleanup);
		assert.ok(cleanup >= 0 && pause > cleanup && pause < summary, "pause event must follow cleanup and precede summary/share work");
		const publication = source.slice(cleanup, summary);
		assert.match(publication, /statusPayload\.state = "paused"/);
		assert.match(publication, /writeStatusPayload\(\)/);
	});

	for (const fanout of ["count", "dynamic", "interrupt"] as const) {
		it(`async ${fanout} children share a tree and cleanup precedes publication`, { skip: process.platform === "win32" || !isAsyncAvailable() ? "requires POSIX hooks and signals" : undefined }, async () => {
			const repoDir = createRepo("pi-tree-fanout-");
			let runnerPid: number | undefined;
			let runId: string | undefined;
			try {
				const hookPath = path.join(tempDir, "fanout-hook.sh");
				fs.writeFileSync(hookPath, '#!/bin/sh\ncat >/dev/null\necho patched >> input.md\necho "{}"\n');
				fs.chmodSync(hookPath, 0o755);
				mockPi.onCall({ output: "Produced", structuredOutput: { items: ["one", "two"] } });
				mockPi.onCall({ output: "Review", echoCwd: true, echoFiles: ["input.md"], ...(fanout === "interrupt" ? { delay: 30_000 } : {}), requireAcceptanceStructuredOrder: fanout === "dynamic", structuredOutput: { ok: true } });
				if (fanout !== "interrupt") mockPi.onCall({ output: "Review", echoCwd: true, echoFiles: ["input.md"], structuredOutput: { ok: true }, requireAcceptanceStructuredOrder: fanout === "dynamic" });
				const executor = createSubagentExecutor({
					pi: { events: createEventBus(), getSessionName: () => undefined },
					state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
					resolveConfig: () => ({ worktreeSetupHook: hookPath }), tempArtifactsDir: tempDir,
					getSubagentSessionRoot: () => tempDir, expandTilde: (p: string) => p,
					discoverAgents: () => ({ agents: [makeAgent("worker", { completionGuard: false }), makeAgent("reviewer")] }),
				});
				const consumer = fanout === "dynamic" ? {
					expand: { from: { output: "impl", path: "/items" }, item: "target", maxItems: 2 },
					parallel: { agent: "reviewer", task: "Review {target}", cwd: "{outputs.impl.treePath}", output: false, progress: false, outputSchema: { type: "object" }, acceptance: { level: "attested", criteria: ["Inspect input"] } },
					collect: { as: "reviews" }, concurrency: 1,
				} : {
					parallel: [{ agent: "reviewer", task: "Inspect", count: fanout === "count" ? 2 : 1, output: false, progress: false }],
					cwd: "{outputs.impl.treePath}", concurrency: 1,
				};
				const started = await executor.execute("tree-fanout", { chain: [
					{ parallel: [{ agent: "worker", task: "Produce", as: "impl", output: false, progress: false, outputSchema: { type: "object" } }], worktree: true }, consumer,
				], async: true, clarify: false, acceptance: { level: "none", reason: "Only observing cwd and lifecycle" } }, new AbortController().signal, undefined, makeMinimalCtx(repoDir));
				const id = started.details?.asyncId;
				runId = id;
				assert.ok(id, JSON.stringify(started));
				if (fanout === "interrupt") {
					const statusPath = path.join(ASYNC_DIR, id, "status.json");
					const deadline = Date.now() + 10_000;
					while (true) {
						const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, "utf8")) : undefined;
						if (status?.pid) runnerPid = status.pid;
						if (status?.steps?.[1]?.status === "running" && status.outputs?.impl?.treePath && fs.existsSync(status.outputs.impl.treePath) && mockPi.callCount() === 2) break;
						assert.ok(Date.now() < deadline, "Timed out waiting for tree child");
						await new Promise((resolve) => setTimeout(resolve, 25));
					}
					process.kill(runnerPid!, "SIGUSR2");
					while (true) {
						const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
						if (status.state === "paused") {
							assert.equal(fs.existsSync(status.outputs.impl.treePath), false, "terminal status preceded tree cleanup");
							break;
						}
						assert.ok(Date.now() < deadline, "Timed out waiting for paused status");
						await new Promise((resolve) => setTimeout(resolve, 25));
					}
				}
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload;
				runnerPid = undefined;
				const tree = payload.outputs?.impl?.treePath;
				assert.ok(tree, JSON.stringify(payload));
				assert.equal(fs.existsSync(tree), false);
				assert.doesNotMatch(git(repoDir, ["worktree", "list", "--porcelain"]), /worktree-trees/);
				if (fanout === "interrupt") {
					assert.equal(payload.state, "paused");
				} else {
					assert.equal(payload.success, true, JSON.stringify(payload));
					for (const result of payload.results.slice(1)) {
						assert.ok(result.output?.includes(tree), result.output);
						assert.match(result.output ?? "", /input\\npatched/);
						if (fanout === "dynamic") {
							assert.equal(result.acceptance?.status, "attested", JSON.stringify(result));
							assert.deepEqual(result.structuredOutput, { ok: true });
						}
					}
					assert.equal(mockPi.callCount(), 3);
				}
			} finally {
				if (runnerPid) {
					try { process.kill(runnerPid, "SIGUSR2"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
					if (runId) await waitForAsyncResultFile(runId);
				}
				removeTempDir(repoDir);
			}
		});
	}

	for (const source of ["runtime", "schema"] as const) {
		it(`runSingleStep attests a ${source} child without folding its report into structured output`, async () => {
			const runner = await tryImport<typeof import("../../src/runs/background/subagent-runner.ts")>("./src/runs/background/subagent-runner.ts");
			const structured = await tryImport<typeof import("../../src/runs/shared/structured-output.ts")>("./src/runs/shared/structured-output.ts");
			const acceptance = await tryImport<typeof import("../../src/runs/shared/acceptance.ts")>("./src/runs/shared/acceptance.ts");
			assert.ok(runner && structured && acceptance);
			mockPi.onCall({ output: "Inspected", structuredOutput: { verdict: "PASS" }, requireAcceptanceStructuredOrder: true });
			const result = await runner.runSingleStep({
				agent: "reviewer", task: "Inspect the input", inheritProjectContext: true, inheritSkills: true,
				...(source === "runtime"
					? { structuredOutput: structured.createStructuredOutputRuntime({ type: "object" }, path.join(tempDir, "structured")) }
					: { structuredOutputSchema: { type: "object" } }),
				effectiveAcceptance: acceptance.resolveEffectiveAcceptance({ agentName: "reviewer", task: "Inspect", explicit: { level: "attested", criteria: ["Inspect input"] } }),
			}, {
				cwd: tempDir, previousOutput: "", placeholder: "{previous}", sessionEnabled: false, id: "single-schema", flatIndex: 0, flatStepCount: 1,
				outputFile: path.join(tempDir, "output.log"), runtime: mockPi.runtime,
			});
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.acceptance?.status, "attested");
			assert.deepEqual(result.structuredOutput, { verdict: "PASS" });
			assert.doesNotMatch(result.output, /acceptance-report/);
		});
	}

	it("async tree cwd dynamic parallel resolves B instead of serialized A preference", async () => {
		const a = createRepo("pi-dynamic-a-");
		const b = createRepo("pi-dynamic-b-");
		try {
			for (const repo of [a, b]) {
				fs.mkdirSync(path.join(repo, ".pi"));
				fs.writeFileSync(path.join(repo, ".pi/settings.json"), JSON.stringify({ subagents: { executionBackend: repo === a ? "native" : "dynamic-b-probe" } }));
				git(repo, ["add", "."]); git(repo, ["commit", "-m", "Configure backend"]);
			}
			mockPi.onCall({ output: "Produced", echoCwd: true, structuredOutput: { items: ["one", "two"] } });
			const id = `dynamic-matrix-${Date.now().toString(36)}`;
			const started = executeAsyncChain(id, {
				ctx: { pi: { events: { emit() {} } }, cwd: a, currentSessionId: "dynamic-matrix", executionBackend: "native" },
				chain: [
					{ parallel: [{ agent: "worker", task: "Produce", as: "impl", output: false, progress: false, outputSchema: { type: "object" } }], worktree: true },
					{ expand: { from: { output: "impl", path: "/items" }, item: "target", maxItems: 2 }, parallel: { agent: "worker", task: "Inspect {target}", cwd: b, output: false, progress: false, outputSchema: { type: "object" } }, collect: { as: "reviews" }, concurrency: 1 },
				], agents: [makeAgent("worker", { completionGuard: false })], artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
			});
			assert.ok(!started.isError, started.content[0]?.text);
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
			assert.equal(payload.success, false, JSON.stringify(payload));
			assert.equal(mockPi.callCount(), 1);
			assert.equal(payload.results.length, 3);
			assert.ok(payload.results.slice(1).every((r: any) => !r.success && r.error === "Execution backend selection failed."));
			assert.deepEqual(payload.outputs.reviews.structured.map((row: any) => ({ item: row.item, exitCode: row.exitCode, error: row.error })), [{ item: "one", exitCode: 1, error: "Execution backend selection failed." }, { item: "two", exitCode: 1, error: "Execution backend selection failed." }]);
			assert.doesNotMatch(git(a, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
			assert.doesNotMatch(git(b, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
		} finally { removeTempDir(a); removeTempDir(b); }
	});

	for (const source of ["committed", "untracked", "ignored"] as const) {
		it(`async tree cwd nested fanout doctor uses checkout settings (${source})`, async () => {
			const { default: registerFanoutChildSubagentExtension } = await import("../../src/extension/fanout-child.ts");
			const { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV } = await import("../../src/runs/shared/pi-args.ts");
			const { createWorktrees, cleanupWorktrees } = await import("../../src/runs/shared/worktree.ts");
			const { getAgentDir } = await import("../../src/shared/agent-dir.ts");
			const repo = createRepo("pi-nested-settings-");
			const profile = path.join(getAgentDir(), "settings.json");
			const savedProfile = fs.existsSync(profile) ? fs.readFileSync(profile) : undefined;
			const keys = [SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV, SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
			const savedEnv = keys.map(key => process.env[key]);
			const profileMarker = path.join(tempDir, "profile-sessions");
			const committedMarker = path.join(tempDir, "committed-sessions");
			const sourceMarker = path.join(tempDir, "source-only-sessions");
			let setup: ReturnType<typeof createWorktrees> | undefined;
			try {
				fs.mkdirSync(path.dirname(profile), { recursive: true });
				fs.writeFileSync(profile, JSON.stringify({ subagents: { defaultSessionDir: profileMarker } }));
				fs.mkdirSync(path.join(repo, ".pi"));
				const settings = path.join(repo, ".pi/settings.json");
				if (source === "committed") {
					fs.writeFileSync(settings, JSON.stringify({ subagents: { defaultSessionDir: committedMarker } }));
					git(repo, ["add", "."]); git(repo, ["commit", "-m", "Commit nested settings"]);
				} else if (source === "ignored") {
					fs.writeFileSync(path.join(repo, ".gitignore"), ".pi/settings.json\n");
					git(repo, ["add", ".gitignore"]); git(repo, ["commit", "-m", "Ignore local settings"]);
				}
				setup = createWorktrees(repo, `nested-${source}-${Date.now().toString(36)}`, 1);
				const checkout = setup.worktrees[0]!.agentCwd;
				fs.writeFileSync(settings, JSON.stringify({ subagents: { defaultSessionDir: sourceMarker } }));
				let tool: any;
				process.env[SUBAGENT_CHILD_ENV] = "1";
				process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
				delete process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
				registerFanoutChildSubagentExtension({ events: createEventBus(), registerTool(value: any) { tool = value; }, getSessionName() {} } as any);
				assert.ok(tool);
				const result = await tool.execute("checkout-doctor", { action: "doctor", cwd: checkout }, new AbortController().signal, undefined, makeMinimalCtx(checkout));
				assert.equal(result.isError, undefined);
				const text = result.content[0].text;
				assert.ok(text.includes(source === "committed" ? committedMarker : profileMarker), text);
				assert.ok(!text.includes(sourceMarker), text);
				const checkoutSettings = path.join(checkout, ".pi/settings.json");
				if (source === "committed") assert.equal(JSON.parse(fs.readFileSync(checkoutSettings, "utf8")).subagents.defaultSessionDir, committedMarker);
				else assert.equal(fs.existsSync(checkoutSettings), false);
			} finally {
				for (const [index, key] of keys.entries()) { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; }
				if (savedProfile) fs.writeFileSync(profile, savedProfile); else fs.rmSync(profile, { force: true });
				if (setup) cleanupWorktrees(setup);
				assert.doesNotMatch(git(repo, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
				removeTempDir(repo);
			}
		});
	}

	for (const variant of ["warning", "invalid backend"] as const) {
		it(`async tree cwd output-dependent group resolves settings before clean check (${variant})`, { skip: process.platform === "win32" || !isAsyncAvailable() ? "requires shell hooks and jiti" : undefined }, async () => {
			const repo = createRepo("pi-output-settings-");
			const record = path.join(tempDir, "output-settings-hooks.jsonl");
			try {
				const nested = variant === "warning" ? { worktreeTeardownHook: 42 } : { executionBackend: 42 };
				fs.mkdirSync(path.join(repo, ".pi"));
				fs.writeFileSync(path.join(repo, ".pi/settings.json"), JSON.stringify({ subagents: { worktreeSetupHook: "./produce.cjs" } }));
				fs.writeFileSync(path.join(repo, "produce.cjs"), `#!${process.execPath}\nconst fs=require('node:fs'); const p=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync(${JSON.stringify(record)},JSON.stringify(p)+'\\n'); fs.mkdirSync('target/.pi',{recursive:true}); fs.writeFileSync('target/.pi/settings.json',${JSON.stringify(JSON.stringify({ subagents: nested }))}); fs.appendFileSync('input.md','patched\\n'); console.log('{}');\n`);
				fs.chmodSync(path.join(repo, "produce.cjs"), 0o755);
				git(repo, ["add", "."]); git(repo, ["commit", "-m", "Configure producer"]);
				mockPi.onCall({ output: "Produced", echoCwd: true });
				const id = `output-settings-${variant.replaceAll(" ", "-")}-${Date.now().toString(36)}`;
				const leaf = { agent: "worker", task: "Work", output: false, progress: false };
				const started = executeAsyncChain(id, {
					ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "output-settings" },
					chain: [{ parallel: [{ ...leaf, as: "impl" }], worktree: true }, { parallel: [leaf], cwd: "{outputs.impl.treePath}/target", worktree: true }],
					agents: [makeAgent("worker", { completionGuard: false })], artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.ok(!started.isError, started.content[0]?.text);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
				assert.equal(payload.success, false);
				assert.equal(mockPi.callCount(), 1);
				assert.equal(payload.results.length, 2);
				const tree = payload.outputs.impl.treePath;
				assert.ok(tree);
				assert.equal(fs.existsSync(tree), false);
				assert.equal(fs.readFileSync(record, "utf8").trim().split("\n").length, 1);
				const error = payload.results[1].error ?? payload.results[1].output;
				if (variant === "warning") {
					assert.match(error, /Worktree isolation requires a clean git working tree/i);
					const log = fs.readFileSync(path.join(ASYNC_DIR, id, "runner.log"), "utf8");
					assert.ok(log.includes(path.join(tree, "target/.pi/settings.json")), log);
					assert.match(log, /invalid 'worktreeTeardownHook'; expected string/);
				} else {
					assert.ok(error.includes(path.join(tree, "target/.pi/settings.json")), error);
					assert.match(error, /invalid 'executionBackend'; expected a string/);
					assert.doesNotMatch(error, /clean git working tree/i);
				}
				assert.doesNotMatch(git(repo, ["worktree", "list", "--porcelain"]), /pi-worktree-|worktree-trees/);
			} finally { removeTempDir(repo); }
		});
	}

	for (const settings of ["bad backend", "malformed settings"] as const) {
		it(`async tree cwd non-worktree group isolates ${settings} from task cwd override`, async () => {
			const job = createRepo("pi-group-job-");
			const bad = createRepo("pi-group-bad-");
			const clean = createRepo("pi-group-clean-");
			try {
				fs.mkdirSync(path.join(bad, ".pi"));
				fs.writeFileSync(path.join(bad, ".pi/settings.json"), JSON.stringify({ subagents: { executionBackend: settings === "malformed settings" ? 42 : "unknown-group-backend" } }));
				mockPi.onCall({ output: "Clean task ran", echoCwd: true });
				const id = `group-leaf-${settings.replaceAll(" ", "-")}-${Date.now().toString(36)}`;
				const leaf = { agent: "worker", task: "Inspect", output: false, progress: false };
				const started = executeAsyncChain(id, {
					ctx: { pi: { events: { emit() {} } }, cwd: job, currentSessionId: "group-leaf" },
					chain: [{ cwd: bad, parallel: [leaf, { ...leaf, cwd: clean }], concurrency: 1 }],
					agents: [makeAgent("worker", { completionGuard: false })], artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.ok(!started.isError, started.content[0]?.text);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
				assert.deepEqual(payload.results.map((r: any) => r.success), [false, true], JSON.stringify(payload));
				assert.match(payload.results[0].error, /Execution backend selection failed/);
				assert.equal(JSON.parse(payload.results[1].output.split("\n").at(-1)).cwd, fs.realpathSync(clean));
				assert.equal(mockPi.callCount(), 1);
			} finally { removeTempDir(job); removeTempDir(bad); removeTempDir(clean); }
		});
	}

	it("async tree cwd cross-project static groups and leaf backend policy", { skip: process.platform === "win32" || !isAsyncAvailable() ? "requires shell hooks and jiti" : undefined }, async () => {
		const a = createRepo("pi-matrix-a-");
		const b = createRepo("pi-matrix-b-");
		const record = path.join(tempDir, "matrix-hooks.jsonl");
		try {
			for (const [repo, label, timeout] of [[a, "a", 3000], [b, "b", 5000]] as const) {
				fs.mkdirSync(path.join(repo, ".pi"));
				for (const phase of ["setup", "teardown"]) {
					const hook = `${label}-${phase}.cjs`;
					fs.writeFileSync(path.join(repo, hook), `#!${process.execPath}\nconst fs=require('node:fs'); const p=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({label:${JSON.stringify(label)},phase:${JSON.stringify(phase)},...p})+'\\n'); console.log('{}');\n`);
					fs.chmodSync(path.join(repo, hook), 0o755);
				}
				fs.writeFileSync(path.join(repo, ".pi/settings.json"), JSON.stringify({ subagents: { executionBackend: "native", worktreeSetupHook: `./${label}-setup.cjs`, worktreeTeardownHook: `./${label}-teardown.cjs`, worktreeSetupHookTimeoutMs: timeout, worktreeTeardownHookTimeoutMs: timeout + 1000 } }));
				git(repo, ["add", "."]); git(repo, ["commit", "-m", "Configure matrix project"]);
			}
			for (let i = 0; i < 5; i++) mockPi.onCall({ output: "Project ran", echoCwd: true });
			const id = `matrix-static-${Date.now().toString(36)}`;
			const leaf = { agent: "worker", task: "Inspect", output: false, progress: false };
			const started = executeAsyncChain(id, {
				ctx: { pi: { events: { emit() {} } }, cwd: a, currentSessionId: "matrix", executionBackend: "matrix-a-probe" },
				chain: [
					{ cwd: a, parallel: [leaf], worktree: true },
					{ cwd: b, parallel: [leaf], worktree: true },
					{ ...leaf, cwd: b },
					{ cwd: b, parallel: [leaf, { ...leaf, cwd: a }], concurrency: 1 },
				], agents: [makeAgent("worker", { completionGuard: false })],
				artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
			});
			assert.ok(!started.isError, started.content[0]?.text);
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
			assert.deepEqual(payload.results.map((r: any) => r.success), [true, true, true, true, true], JSON.stringify(payload));
			assert.equal(mockPi.callCount(), 5);
			assert.ok(payload.results[4].output.includes(fs.realpathSync(a)));
			for (const index of [2, 3]) assert.ok(payload.results[index].output.includes(fs.realpathSync(b)));
			const records = fs.readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
			assert.equal(records.length, 4);
			for (const [repo, label] of [[a, "a"], [b, "b"]]) {
				const rows = records.filter(p => p.repoRoot === fs.realpathSync(repo));
				assert.equal(rows.length, 2);
				assert.ok(rows.every(p => p.label === label));
				assert.deepEqual(rows.map(p => p.phase), ["setup", "teardown"]);
				assert.equal(new Set(rows.map(p => p.worktreePath)).size, 1);
				assert.ok(rows.every(p => !fs.existsSync(p.worktreePath)));
				assert.doesNotMatch(git(repo, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
			}
			const aSettingsPath = path.join(a, ".pi/settings.json");
			const aSettings = JSON.parse(fs.readFileSync(aSettingsPath, "utf8"));
			aSettings.subagents.executionBackend = "matrix-a-probe";
			fs.writeFileSync(aSettingsPath, JSON.stringify(aSettings));
			mockPi.onCall({ output: "B sequential", echoCwd: true });
			mockPi.onCall({ output: "B parallel", echoCwd: true });
			const policyId = `${id}-leaf-policy`;
			const policyStarted = executeAsyncChain(policyId, {
				ctx: { pi: { events: { emit() {} } }, cwd: a, currentSessionId: "matrix-policy", executionBackend: "matrix-a-probe" },
				chain: [{ ...leaf, cwd: b }, { cwd: b, parallel: [leaf, { ...leaf, cwd: a }], concurrency: 1 }],
				agents: [makeAgent("worker", { completionGuard: false })], artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
			});
			assert.ok(!policyStarted.isError, policyStarted.content[0]?.text);
			const serialized = JSON.parse(fs.readFileSync(typesMod!.getAsyncConfigPath(policyId), "utf8"));
			assert.deepEqual(serialized.executionBackends, { protocolVersion: 1, userPreference: "matrix-a-probe", registrations: [] });
			assert.equal("jobCwd" in serialized, false);
			assert.ok(serialized.steps.every((step: any) => !("jobCwd" in step)));
			const policyPayload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(policyId), "utf8"));
			assert.deepEqual(policyPayload.results.map((r: any) => r.success), [true, true, false], JSON.stringify(policyPayload));
			assert.match(policyPayload.results[2].error, /Execution backend selection failed/);
			assert.equal(mockPi.callCount(), 7);
			assert.equal(fs.readFileSync(record, "utf8").trim().split("\n").length, 4);
		} finally { removeTempDir(a); removeTempDir(b); }
	});

	for (const policy of ["same sparse", "same defined", "other sparse", "other defined", "malformed profile"] as const) {
		it(`async tree cwd backend policy ${policy}`, async () => {
			const runner = await import("../../src/runs/background/subagent-runner.ts");
			const { getAgentDir } = await import("../../src/shared/agent-dir.ts");
			const job = createRepo("pi-policy-job-");
			const other = createRepo("pi-policy-other-");
			const profile = path.join(getAgentDir(), "settings.json");
			const saved = fs.existsSync(profile) ? fs.readFileSync(profile) : undefined;
			try {
				fs.mkdirSync(path.dirname(profile), { recursive: true });
				fs.writeFileSync(profile, policy === "malformed profile" ? "{" : "{}");
				const unit = policy.startsWith("other") ? other : job;
				if (policy.endsWith("defined")) {
					fs.mkdirSync(path.join(unit, ".pi"));
					fs.writeFileSync(path.join(unit, ".pi/settings.json"), JSON.stringify({ subagents: { executionBackend: "unit-probe" } }));
				}
				const preferences: unknown[] = [];
				const result = await runner.runSingleStep({ agent: "worker", task: "Probe", cwd: unit, sessionFile: path.join(tempDir, "policy.jsonl") }, {
					cwd: unit, jobCwd: job, previousOutput: "", placeholder: "{previous}", sessionEnabled: false,
					id: "policy", flatIndex: 0, flatStepCount: 1, outputFile: path.join(tempDir, "policy.log"), runtime: mockPi.runtime,
					executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: "job-probe" },
					executionBackendCoordinator: { async prepare(preference) { preferences.push(preference); throw new Error("probe"); } } as any,
				});
				assert.equal(result.exitCode, 1);
				assert.equal(result.sessionFile, path.join(tempDir, "policy.jsonl"));
				assert.deepEqual(preferences, policy === "malformed profile" ? [] : [policy.endsWith("defined") ? "unit-probe" : policy === "same sparse" ? "job-probe" : "auto"]);
				assert.equal(mockPi.callCount(), 0);
			} finally {
				if (saved) fs.writeFileSync(profile, saved); else fs.rmSync(profile, { force: true });
				removeTempDir(job); removeTempDir(other);
			}
		});
	}

	for (const failure of ["add", "apply", "backend"] as const) {
		it(`async tree cwd runSingleStep resolves trees before ${failure === "backend" ? "backend selection" : `git ${failure} failure`}`, async () => {
			const runner = await tryImport<typeof import("../../src/runs/background/subagent-runner.ts")>("./src/runs/background/subagent-runner.ts");
			const chainOutputs = await tryImport<typeof import("../../src/runs/shared/chain-outputs.ts")>("./src/runs/shared/chain-outputs.ts");
			const worktree = await tryImport<typeof import("../../src/runs/shared/worktree.ts")>("./src/runs/shared/worktree.ts");
			assert.ok(runner && chainOutputs && worktree);
			const repoDir = createRepo("pi-tree-probe-");
			const trees = new chainOutputs.TreeRegistry(tempDir);
			try {
				fs.mkdirSync(path.join(repoDir, ".pi"));
				fs.writeFileSync(path.join(repoDir, ".pi/settings.json"), JSON.stringify({ subagents: { executionBackend: "tree-selection-probe" } }));
				git(repoDir, ["add", "."]);
				git(repoDir, ["commit", "-m", "Configure tree backend"]);
				const baseCommit = git(repoDir, ["rev-parse", "HEAD"]);
				fs.appendFileSync(path.join(repoDir, "input.md"), "patched\n");
				const patchPath = path.join(tempDir, "probe.patch");
				fs.writeFileSync(patchPath, failure === "apply" ? "invalid patch" : git(repoDir, ["diff", "--binary"]) + "\n");
				git(repoDir, ["checkout", "--", "input.md"]);
				const preferences: unknown[] = [];
				const result = await runner.runSingleStep({ agent: "reviewer", task: "Inspect {outputs.impl.treePath}", cwd: "{outputs.impl.treePath}", inheritProjectContext: true, inheritSkills: true, sessionFile: path.join(tempDir, "session.jsonl") }, {
					cwd: tempDir, trees, outputs: { impl: { text: "Produced", agent: "worker", stepIndex: 0, taskIndex: 0, repoCwd: repoDir, baseCommit: failure === "add" ? "invalid-base" : baseCommit, patchPath } },
					previousOutput: "", placeholder: "{previous}", sessionEnabled: false, id: "probe", flatIndex: 0, flatStepCount: 1,
					outputFile: path.join(tempDir, "output.log"), runtime: mockPi.runtime,
					executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: "native" },
					executionBackendCoordinator: { async prepare(preference) { preferences.push(preference); throw new Error("deliberate probe"); } } as any,
				});
				assert.equal(result.exitCode, 1);
				assert.equal(result.output, result.error);
				assert.equal(result.sessionFile, path.join(tempDir, "session.jsonl"));
				assert.equal(mockPi.callCount(), 0);
				if (failure === "backend") {
					assert.deepEqual(preferences, ["tree-selection-probe"]);
					assert.equal(result.error, "Execution backend selection failed.");
				} else {
					assert.match(result.error ?? "", /Output 'impl' tree build failed:/);
					assert.deepEqual(preferences, []);
				}
			} finally {
				worktree.removeTrees(trees.created);
				assert.ok(trees.created.every(({ dir }) => !fs.existsSync(dir)));
				removeTempDir(repoDir);
			}
		});
	}

	for (const concurrency of [1, 2]) {
		it(`async missing tree patch fails only its leaf at concurrency ${concurrency}`, { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const repoDir = createRepo("pi-async-tree-empty-");
			try {
				mockPi.onCall({ output: "No changes" });
				mockPi.onCall({ output: "Sibling completed" });
				const id = `async-tree-empty-${concurrency}-${Date.now().toString(36)}`;
				const started = executeAsyncChain(id, {
					chain: [
						{ parallel: [{ agent: "worker", task: "Produce", as: "impl", output: false, progress: false }], worktree: true },
						{ parallel: [{ agent: "worker", task: "Review", cwd: "{outputs.impl.treePath}" }, { agent: "worker", task: "Sibling" }], concurrency },
					], agents: [makeAgent("worker", { completionGuard: false })],
					ctx: { pi: { events: { emit() {} } }, cwd: repoDir, currentSessionId: "empty" },
					artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.ok(!started.isError);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf-8")) as AsyncResultPayload;
				assert.match(payload.results[1]?.error ?? "", /Output 'impl' has no patch \(no changes\)\./);
				assert.equal(payload.results[2]?.output, "Sibling completed");
				assert.equal(mockPi.callCount(), 2);
			} finally { removeTempDir(repoDir); }
		});
	}

	for (const policy of ["same sparse", "other sparse", "other hooks", "other invalid"] as const) {
		it(`async teardown group policy ${policy}`, { skip: process.platform === "win32" || !isAsyncAvailable() }, async () => {
			const job = createRepo("pi-group-job-");
			const other = createRepo("pi-group-other-");
			const unit = policy === "same sparse" ? job : other;
			const record = path.join(tempDir, "group-hooks.jsonl");
			const hook = path.join(unit, "hook.cjs");
			fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const p = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(p)+'\\n'); console.log('{}');\n`);
			fs.chmodSync(hook, 0o755);
			fs.mkdirSync(path.join(unit, ".pi"));
			fs.writeFileSync(path.join(unit, ".pi/settings.json"), JSON.stringify({ subagents: policy === "other hooks" || policy === "other invalid" ? {
				worktreeSetupHook: "./hook.cjs", worktreeTeardownHook: "./hook.cjs",
				worktreeSetupHookTimeoutMs: policy === "other invalid" ? 0 : 5000,
			} : {} }));
			git(unit, ["add", "."]); git(unit, ["commit", "-m", "Configure group hooks"]);
			try {
				mockPi.onCall({ output: "first" }); mockPi.onCall({ output: "second" });
				const id = `group-policy-${policy.replaceAll(" ", "-")}-${Date.now().toString(36)}`;
				const started = executeAsyncChain(id, {
					ctx: { pi: { events: { emit() {} } }, cwd: job, currentSessionId: "group-policy" },
					chain: [{ cwd: unit, parallel: [{ agent: "worker", task: "One", progress: false }, { agent: "worker", task: "Two", progress: false }], worktree: true }],
					agents: [makeAgent("worker")], worktreeSetupHook: hook, worktreeTeardownHook: hook,
					artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				});
				assert.ok(!started.isError, started.content[0]?.text);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
				assert.equal(payload.success, policy !== "other invalid", JSON.stringify(payload));
				if (policy === "other invalid") {
					assert.equal(mockPi.callCount(), 0);
					assert.match(payload.results[0].output, /timeout must be an integer greater than 0/);
				}
				const records = fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
				assert.equal(records.length, ["same sparse", "other hooks"].includes(policy) ? 4 : 0);
				for (const p of records) { assert.equal(p.repoRoot, fs.realpathSync(unit)); assert.equal(fs.existsSync(p.worktreePath), false); }
				assert.doesNotMatch(git(unit, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
			} finally { removeTempDir(job); removeTempDir(other); }
		});
	}

	for (const mode of ["normal", "nonzero", "timeout", "empty", "single"]) {
		it(`async teardown settings survive serialization (${mode})`, { skip: (!["empty", "single"].includes(mode) && process.platform === "win32") || !isAsyncAvailable() }, async () => {
			const repo = createRepo("pi-teardown-async-");
			const record = path.join(tempDir, "teardown.jsonl");
			const hook = path.join(repo, "teardown.cjs");
			fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const p = JSON.parse(fs.readFileSync(0, 'utf8')); if (!fs.existsSync(p.worktreePath) || process.cwd() !== fs.realpathSync(p.worktreePath)) process.exit(9); fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(p)+'\\n'); ${mode === "nonzero" ? "process.exit(7)" : mode === "timeout" ? "setInterval(() => {}, 1000)" : ""}\n`);
			fs.chmodSync(hook, 0o755);
			fs.mkdirSync(path.join(repo, ".pi"));
			fs.writeFileSync(path.join(repo, ".pi/settings.json"), JSON.stringify({ subagents: {
				worktreeTeardownHook: mode === "empty" ? "" : "./teardown.cjs", worktreeTeardownHookTimeoutMs: mode === "timeout" ? 500 : 5000,
			} }));
			git(repo, ["add", "."]);
			git(repo, ["commit", "-m", "Configure project hooks"]);
			const id = `teardown-${mode}-${Date.now().toString(36)}`;
			try {
				mockPi.onCall({ output: "async teardown success" });
				const params = {
					ctx: { pi: { events: { emit() {} } }, cwd: repo, currentSessionId: "teardown" },
					worktreeTeardownHook: mode === "single" ? hook : "./missing-serialized-hook",
					worktreeTeardownHookTimeoutMs: 5000,
					artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				};
				const started = mode === "single"
					? executeAsyncSingle(id, { ...params, agent: "worker", task: "Work", agentConfig: makeAgent("worker") })
					: executeAsyncChain(id, { ...params, chain: [{ parallel: [{ agent: "worker", task: "Work" }], worktree: true }], agents: [makeAgent("worker")] });
				assert.ok(!started.isError);
				const config = JSON.parse(fs.readFileSync(typesMod!.getAsyncConfigPath(id), "utf8"));
				assert.equal(config.worktreeTeardownHook, params.worktreeTeardownHook);
				assert.equal(config.worktreeTeardownHookTimeoutMs, params.worktreeTeardownHookTimeoutMs);
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8"));
				assert.equal(payload.success, true);
				assert.equal(payload.results[0].output, "async teardown success");
				const deadline = Date.now() + 5000;
				while (git(repo, ["worktree", "list", "--porcelain"]).includes("pi-worktree-")) {
					assert.ok(Date.now() < deadline, "checkout removal must finish");
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				if (["empty", "single"].includes(mode)) assert.equal(fs.existsSync(record), false);
				else {
					const records = fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line));
					assert.equal(records.length, 1);
					const p = records[0];
					assert.equal(p.version, 1); assert.equal(p.index, 0); assert.equal(p.agent, "worker");
					assert.equal(p.repoRoot, fs.realpathSync(repo)); assert.equal(p.agentCwd, p.worktreePath);
					assert.equal(p.runId, `${id}-s0`); assert.equal(p.baseCommit, git(repo, ["rev-parse", "HEAD"]));
					assert.equal(fs.existsSync(p.worktreePath), false); assert.equal(git(repo, ["branch", "--list", p.branch]), "");
					if (mode === "nonzero" || mode === "timeout") {
						const logPath = path.join(ASYNC_DIR!, id, "runner.log");
						let log = "";
						while (!log.split("\n").some((line) =>
							line.includes("worktree teardown hook") && line.includes(p.worktreePath) && (mode === "nonzero" ? /exit\s+code\s+7\b/i : /timed out/i).test(line))) {
							assert.ok(Date.now() < deadline, `missing teardown warning: ${log}`);
							await new Promise((resolve) => setTimeout(resolve, 20));
							log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
						}
					}
				}
			} finally { removeTempDir(repo); }
		});
	}

	it("top-level async worktree parallel keeps reads in the worktree and output in the run dir", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-");
		try {
			mockPi.onCall({ output: "Worktree report" });
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
				resolveConfig: () => ({}),
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"async-parallel-worktree-fields",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "report.md", reads: ["input.md"] }],
					async: true,
					clarify: false,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			const asyncId = result.details?.asyncId;
			assert.ok(asyncId, "expected asyncId");
			const resultPath = path.join(RESULTS_DIR, `${asyncId}.json`);
			const asyncDir = result.details?.asyncDir;
			const deadline = Date.now() + 30_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					const statusPath = asyncDir ? path.join(asyncDir, "status.json") : undefined;
					const eventsPath = asyncDir ? path.join(asyncDir, "events.jsonl") : undefined;
					const status = statusPath && fs.existsSync(statusPath) ? fs.readFileSync(statusPath, "utf-8") : "(missing status.json)";
					const events = eventsPath && fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "(missing events.jsonl)";
					assert.fail(`Timed out waiting for async result file: ${resultPath}\nStatus: ${status}\nEvents: ${events}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const worktreeCwd = path.join(os.tmpdir(), `pi-worktree-${asyncId}-s0-0`);
			const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
			assert.ok(callFile, "expected a recorded mock pi call");
			const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
			const taskArg = args.at(-1) ?? "";
			const durableOutput = path.join(asyncDir!, "step-0", "task-0", "report.md");
			assert.ok(taskArg.includes(`[Read from: ${path.join(worktreeCwd, "input.md")}]`));
			assert.ok(taskArg.includes(`Write your findings to: ${durableOutput}`), `unexpected output path in: ${taskArg}`);
			assert.equal(fs.existsSync(worktreeCwd), false, "worktree must be torn down");
			assert.equal(fs.existsSync(asyncDir!), true, "run dir holding the report must outlive the worktree");
			assert.equal(fs.existsSync(durableOutput), true, "report file must exist at its durable per-task path after teardown");
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("top-level async worktree parallel rejects an output that escapes its per-task directory", { skip: !isAsyncAvailable() || !createSubagentExecutor ? "jiti or executor not available" : undefined }, async () => {
		const repoDir = createRepo("pi-subagent-async-worktree-escape-");
		try {
			const executor = createSubagentExecutor!({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: repoDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
				resolveConfig: () => ({}),
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (p: string) => p,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"async-parallel-worktree-escape",
				{
					tasks: [{ agent: "worker", task: "Do worktree work", output: "../escape.md", reads: ["input.md"] }],
					async: true,
					clarify: false,
					worktree: true,
				},
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /resolves outside its per-task directory/);
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("readStatus caches by mtime (second call uses cache)", () => {
		const dir = createTempDir();
		try {
			const statusData = {
				runId: "cache-test",
				state: "running",
				mode: "single",
				startedAt: Date.now(),
			};
			fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(statusData));

			const s1 = readStatus(dir);
			const s2 = readStatus(dir);
			assert.ok(s1);
			assert.ok(s2);
			assert.equal(s1.runId, s2.runId);
		} finally {
			removeTempDir(dir);
		}
	});

	it("readStatus throws for malformed status files", () => {
		const dir = createTempDir();
		try {
			fs.writeFileSync(path.join(dir, "status.json"), "{bad-json", "utf-8");
			assert.throws(() => readStatus(dir), /Failed to parse async status file/);
		} finally {
			removeTempDir(dir);
		}
	});

	for (const mode of [undefined, "inline", "file-only"] as const) {
		for (const scenario of ["failure", "save-error"] as const) {
			it(`background ${mode ?? "unset"} ${scenario} preserves its output contract`, async () => {
				const reply = "PRIVATE_BACKGROUND_REPLY";
				mockPi.onCall({ output: "primary failed", stderr: "rate limit exceeded", exitCode: 1 });
				mockPi.onCall({ output: reply, exitCode: scenario === "failure" ? 1 : 0, stderr: scenario === "failure" ? "child failed" : undefined });
				const id = `contract-${mode}-${scenario}-${Date.now().toString(36)}`;
				const parent = path.join(tempDir, "parent");
				if (scenario === "save-error") fs.writeFileSync(parent, "not a directory");
				const output = path.join(parent, "requested.md");
				const artifactsDir = path.join(tempDir, "artifacts");
				executeAsyncSingle(id, {
					agent: "worker", task: "Summarize", agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }), output, outputMode: mode,
					ctx: { cwd: tempDir, pi: { events: { emit() {} } } }, artifactsDir,
					artifactConfig: { enabled: true, includeOutput: true, includeInput: false, includeJsonl: false, includeMetadata: false },
					shareEnabled: false, maxSubagentDepth: 2,
				});
				const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload;
				const result = payload.results[0];
				assert.equal(payload.exitCode, 1);
				const saveBlock = scenario === "save-error" ? `Output file error: ${output}\n${result.error}` : "";
				const pointer = `Full reply preserved at ${getArtifactPaths(artifactsDir, id, "worker").outputPath}`;
				assert.equal(result.modelAttempts?.length, 2);
				const note = formatModelAttemptNote(result.modelAttempts![0], "anthropic/claude-sonnet-4");
				assert.equal(result.output, `${note}\n\n` + (mode === "file-only" ? [saveBlock, pointer].filter(Boolean).join("\n\n") : reply + (saveBlock ? `\n\n${saveBlock}` : "")));
				assert.equal(fs.readFileSync(result.artifactPaths!.outputPath, "utf8"), reply);
				if (scenario === "failure") {
					assert.equal(result.error, "child failed");
					assert.equal(fs.existsSync(output), false);
				}
				if (mode === "file-only") assert.equal(payload.summary, `worker:\n${result.output}`);
			});
		}
	}

	for (const gate of ["disabled", "include-output", "no-directory", "combined-write-error"] as const) {
		it(`background file-only failure handles ${gate}`, async () => {
			const id = `gate-${gate}-${Date.now().toString(36)}`;
			const artifactsDir = path.join(tempDir, "artifacts");
			const artifact = getArtifactPaths(artifactsDir, id, "worker").outputPath;
			const output = path.join(tempDir, "parent", "requested.md");
			let writeError = "";
			if (gate === "combined-write-error") {
				fs.mkdirSync(artifact, { recursive: true });
				fs.writeFileSync(path.dirname(output), "not a directory");
				try { fs.writeFileSync(artifact, "reply", "utf-8"); } catch (error) { writeError = (error as Error).message; }
			}
			mockPi.onCall({ output: "PRIVATE_GATE_REPLY", exitCode: gate === "combined-write-error" ? 0 : 1 });
			executeAsyncSingle(id, {
				agent: "worker", task: "Summarize", agentConfig: makeAgent("worker"), output, outputMode: "file-only",
				ctx: { cwd: tempDir, pi: { events: { emit() {} } } }, artifactsDir: gate === "no-directory" ? undefined : artifactsDir,
				artifactConfig: { enabled: gate !== "disabled", includeOutput: gate !== "include-output", includeInput: false, includeJsonl: false, includeMetadata: false },
				shareEnabled: false, maxSubagentDepth: 2,
			});
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload;
			const result = payload.results[0];
			assert.equal(payload.exitCode, 1);
			if (writeError) {
				assert.ok(result.error?.endsWith(writeError));
				const saveError = result.error!.slice(0, -(writeError.length + 1));
				assert.equal(result.output, `Output file error: ${output}\n${saveError}\n\nFull reply not preserved (artifact write failed: ${writeError})`);
			} else assert.equal(result.output, "Full reply not preserved (artifact output disabled)");
			assert.equal(payload.summary, `worker:\n${result.output}`);
		});
	}

	it("background failed fallback preserves empty reply and existing requested file", async () => {
		mockPi.onCall({ output: "primary failed", stderr: "rate limit exceeded", exitCode: 1 });
		mockPi.onCall({ output: "", stderr: "final failure", exitCode: 1 });
		const id = `failed-fallback-empty-${Date.now().toString(36)}`;
		const output = path.join(tempDir, "requested.md");
		fs.writeFileSync(output, "previous result");
		const artifactsDir = path.join(tempDir, "artifacts");
		executeAsyncSingle(id, {
			agent: "worker", task: "Summarize", agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }), output, outputMode: "file-only",
			ctx: { cwd: tempDir, pi: { events: { emit() {} } } }, artifactsDir,
			artifactConfig: { enabled: true, includeOutput: true, includeInput: false, includeJsonl: false, includeMetadata: false }, shareEnabled: false, maxSubagentDepth: 2,
		});
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id), "utf8")) as AsyncResultPayload;
		const result = payload.results[0];
		assert.equal(payload.exitCode, 1);
		assert.equal(result.error, "final failure");
		const note = formatModelAttemptNote(result.modelAttempts![0], "anthropic/claude-sonnet-4");
		assert.equal(result.output, `${note}\n\nFull reply preserved at ${result.artifactPaths!.outputPath}`);
		assert.equal(fs.readFileSync(result.artifactPaths!.outputPath, "utf8"), "");
		assert.equal(payload.summary, `worker:\n${result.output}`);
		assert.equal(fs.readFileSync(output, "utf8"), "previous result");
	});

	it("background runs record fallback attempts and final model", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered asynchronously" });
		const id = `async-fallback-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", {
				model: "openai/gpt-5-mini:high",
				fallbackModels: ["anthropic/claude-sonnet-4:low"],
			}),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "anthropic", id: "claude-sonnet-4", fullId: "anthropic/claude-sonnet-4" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);

		const started = Date.now();
		while (!fs.existsSync(resultPath)) {
			if (Date.now() - started > 15000) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "anthropic/claude-sonnet-4:low");
		assert.deepEqual(payload.results[0].attemptedModels, ["openai/gpt-5-mini:high", "anthropic/claude-sonnet-4:low"]);
		assert.equal(payload.results[0].modelAttempts.length, 2);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.steps[0]?.model, "anthropic/claude-sonnet-4:low");
		assert.equal(statusPayload.steps[0]?.thinking, "low");
		assert.ok(statusPayload.totalTokens!.total > 0);
		assert.ok(statusPayload.steps[0]?.tokens!.total > 0);
		assert.match(fs.readFileSync(path.join(asyncDir, "output-0.log"), "utf-8"), /Recovered asynchronously/);
		assert.equal(mockPi.callCount(), 2);
	});

	it("background runs fail zero-exit provider errors when no fallback succeeds", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const id = `async-zero-exit-provider-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.match(payload.results[0]?.error ?? "", /429 quota exceeded/);
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.match(statusPayload.steps?.[0]?.error ?? "", /429 quota exceeded/);
	});

	it("background runs treat recovered child errors as successful", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage("Recovered asynchronously"),
			],
		});
		const id = `async-recovered-child-error-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.state, "complete");
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0]?.success, true);
		assert.equal(payload.results[0]?.error, undefined);
		assert.equal(payload.results[0]?.output, "Recovered asynchronously");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "complete");
		assert.equal(statusPayload.steps?.[0]?.status, "complete");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 0);
	});

	it("background runs keep provider errors failed when followed only by empty assistant output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "temporary provider failure" }],
						model: "openai/gpt-5-mini",
						stopReason: "error",
						errorMessage: "provider transport failed",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				},
				events.assistantMessage(""),
			],
		});
		const id = `async-provider-error-empty-stop-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.state, "failed");
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.success, false);
		assert.match(payload.results[0]?.error ?? "", /provider transport failed/);
		assert.equal(payload.results[0]?.output, "");
		const statusPayload = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(statusPayload.state, "failed");
		assert.equal(statusPayload.steps?.[0]?.status, "failed");
		assert.equal(statusPayload.steps?.[0]?.exitCode, 1);
	});

	it("background file-only runs write full output but return only a file reference", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async full output\nwith details" });
		const id = `async-file-only-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const outputPath = path.join(tempDir, "async-file-only.md");
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: outputPath,
			outputMode: "file-only",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.match(payload.summary ?? "", /Output saved to:/);
		assert.match(payload.summary ?? "", /2 lines/);
		assert.doesNotMatch(payload.summary ?? "", /async full output/);
		assert.match(payload.results[0]?.output ?? "", /Output saved to:/);
		assert.doesNotMatch(payload.results[0]?.output ?? "", /async full output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "async full output\nwith details");
	});

	it("background single runs treat string false as disabled output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "async inline report" });
		const id = `async-string-false-output-${Date.now().toString(36)}`;
		const run = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { output: "default-report.md" }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			output: "false",
			maxSubagentDepth: 2,
		});

		assert.equal(run.details.asyncId, id);
		const resultPath = await waitForAsyncResultFile(id);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, true);
		assert.equal(payload.results[0]?.output, "async inline report");
		assert.doesNotMatch(payload.summary ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readLastMockPiArgs(mockPi).at(-1) ?? "", /Write your findings to:/);
	});

	it("background runs detect hidden tool failures even when the child exits 0", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "connection refused")],
		});

		const id = `async-hidden-failure-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Deploy app",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
	});

	it("background runs preserve blocker output and do not try fallback models", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const blocked = "BLOCKED: need approval to rotate the api key\nDone: inspected secret store\nRemaining: deploy";
		mockPi.onCall({ output: blocked });
		const id = `async-blocked-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement deployment", output: path.join(tempDir, "blocked.md"), outputMode: "file-only",
			agentConfig: makeAgent("worker", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0]?.error, blocked);
		assert.equal(payload.results[0]?.output, blocked);
		assert.equal(payload.results[0]?.modelAttempts?.length, 1);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /fallback/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background structured runs preserve blocker output", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const blocked = "BLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		mockPi.onCall({ output: blocked });
		const id = `async-blocked-structured-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Implement key rotation", outputSchema: { type: "object" } }], agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" }, artifactConfig: { enabled: false }, shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
		});
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.error, blocked);
		assert.doesNotMatch(payload.results[0]?.error ?? "", /structured output missing/);
	});

	it("background sequential chains stop after a blocked step", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const blocked = "BLOCKED: need approval to rotate the api key\nDone: traced callers\nRemaining: rotation";
		mockPi.onCall({ output: blocked });
		mockPi.onCall({ output: "Rotation completed" });
		const id = `async-sequential-blocked-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Trace callers", output: path.join(tempDir, "blocked.md"), outputMode: "file-only" }, { agent: "reviewer", task: "Rotate key" }], agents: [makeAgent("worker"), makeAgent("reviewer")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" }, artifactConfig: { enabled: false }, shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
		});
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results[0]?.error, blocked);
		assert.equal(payload.results[0]?.output, blocked);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("background parallel runs retain blocked and successful results", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		const blocked = "BLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		mockPi.onCall({ output: blocked });
		mockPi.onCall({ output: "Sibling completed" });
		const id = `async-parallel-blocked-${Date.now().toString(36)}`;
		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "blocked", task: "Review", output: path.join(tempDir, "blocked.md"), outputMode: "file-only" }, { agent: "sibling", task: "Review", output: path.join(tempDir, "sibling.md"), outputMode: "file-only" }] }], resultMode: "parallel", agents: [makeAgent("blocked"), makeAgent("sibling")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" }, artifactConfig: { enabled: false }, shareEnabled: false, sessionRoot: path.join(tempDir, "sessions"), maxSubagentDepth: 2,
		});
		const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 10_000), "utf-8")) as AsyncResultPayload;
		assert.equal(payload.success, false);
		assert.equal(payload.results.length, 2);
		assert.ok(payload.results.some((item) => item.error === blocked && item.output === blocked));
		assert.equal(payload.exitCode, 1);
		const succeeded = payload.results.find((item) => item.success);
		assert.match(succeeded?.output ?? "", /^Output saved to:/);
		assert.doesNotMatch(succeeded?.output ?? "", /Sibling completed/);
		assert.equal(fs.readFileSync(path.join(tempDir, succeeded === payload.results[0] ? "blocked.md" : "sibling.md"), "utf8"), "Sibling completed");
	});

	it("background implementation runs fail when no mutation attempt occurred", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });

		const id = `async-no-mutation-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.match(String(payload.results[0].error ?? ""), /completed without making edits/);
		assert.match(String(payload.results[0].modelAttempts?.[0]?.error ?? ""), /completed without making edits/);

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.match(eventsText, /"reason":"completion_guard"/);
		assert.match(eventsText, /Subagent failed: worker/);
		assert.doesNotMatch(eventsText, /Status:/);
		assert.doesNotMatch(eventsText, /Interrupt:/);
	});

	it("background bash-enabled non-implementation agents can opt out of the completion guard", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "cold start test after patch" });

		const id = `async-completion-guard-optout-${Date.now().toString(36)}`;
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "test-runner",
			task: "Run cold start test after patch",
			agentConfig: makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const resultPath = await waitForAsyncResultFile(id, 10_000);
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "cold start test after patch");

		const eventsPath = path.join(ASYNC_DIR, id, "events.jsonl");
		const eventsText = fs.readFileSync(eventsPath, "utf-8");
		assert.doesNotMatch(eventsText, /"reason":"completion_guard"/);
	});

	it("background runs prefer the parent session provider for ambiguous bare model ids", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });

		const id = `async-provider-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { model: "gpt-5-mini" }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
			},
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(payload.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("background single runs inherit the parent model and thinking, including fallbacks", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "github-copilot/gpt-6",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Done asynchronously" });
		const id = `async-inherit-${Date.now().toString(36)}`;

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker", { fallbackModels: ["anthropic/claude-sonnet-4"] }),
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				currentModelProvider: "github-copilot",
				parentModel: "github-copilot/gpt-6",
				parentThinking: "max",
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const resultFile = await waitForAsyncResultFile(id, 15_000);
		const payload = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.results[0]?.model, "anthropic/claude-sonnet-4:max");
		const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf-8")) as AsyncStatusPayload;
		assert.equal(status.steps?.[0]?.model, "anthropic/claude-sonnet-4:max");
		assert.equal(status.steps?.[0]?.thinking, "max");
		assert.deepEqual(payload.results[0]?.attemptedModels, ["github-copilot/gpt-6:max", "anthropic/claude-sonnet-4:max"]);
		const args = readLastMockPiArgs(mockPi);
		assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4:max");
	});

	it("background chain steps inherit the parent model and emit :off", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Step done" });
		const id = `async-chain-inherit-${Date.now().toString(36)}`;

		executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: {
				pi: { events: { emit() {} } },
				cwd: tempDir,
				currentSessionId: "session-1",
				parentModel: "github-copilot/gpt-6",
				parentThinking: "off",
			},
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			maxSubagentDepth: 2,
		});

		const resultFile = await waitForAsyncResultFile(id, 15_000);
		const payload = JSON.parse(fs.readFileSync(resultFile, "utf-8")) as AsyncResultPayload;
		assert.equal(payload.results[0]?.model, "github-copilot/gpt-6:off");
		const args = readLastMockPiArgs(mockPi);
		assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6:off");
	});

	it("background runs resolve skills from the effective task cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const taskCwd = createTempDir("pi-subagent-async-task-cwd-");
		const id = `async-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(taskCwd, "async-task-cwd-skill");
			executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker", { skills: ["async-task-cwd-skill"] }),
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: taskCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.deepEqual(status.steps?.[0]?.skills, ["async-task-cwd-skill"]);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("background single runs report unavailable pi-cohort skill requests", () => {
		const id = `async-pi-cohort-skill-${Date.now().toString(36)}`;
		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			skills: ["pi-cohort"],
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-cohort/);
	});

	it("background chains report unavailable pi-cohort skill requests", () => {
		const id = `async-chain-pi-cohort-skill-${Date.now().toString(36)}`;
		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work", skill: ["pi-cohort"] }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: tempDir,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Skills not found: pi-cohort/);
	});

	it("background chains resolve relative step cwd values against the shared cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({ output: "Done asynchronously" });
		const chainCwd = createTempDir("pi-subagent-async-chain-cwd-");
		const id = `async-chain-skill-cwd-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const statusPath = path.join(asyncDir, "status.json");

		try {
			writePackageSkill(path.join(chainCwd, "packages", "app"), "async-chain-step-skill");
			executeAsyncChain(id, {
				chain: [{ agent: "worker", task: "Do work", cwd: "packages/app", skill: ["async-chain-step-skill"] }],
				agents: [makeAgent("worker")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				cwd: chainCwd,
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(resultPath)) {
				if (Date.now() > deadline) {
					assert.fail(`Timed out waiting for async result file: ${resultPath}`);
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as AsyncResultPayload;
			const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
			assert.equal(payload.success, true);
			assert.equal(payload.sessionId, "session-1");
			assert.equal(status.sessionId, "session-1");
			assert.deepEqual(status.steps?.[0]?.skills, ["async-chain-step-skill"]);
		} finally {
			removeTempDir(chainCwd);
		}
	});

	it("keeps top-level current tool/path aligned with still-running parallel children", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "README.md" })] },
				{ delay: 900, jsonl: [events.toolEnd("read"), events.toolResult("read", "done"), events.assistantMessage("reader done")] },
			],
		});
		mockPi.onCall({
			steps: [
				{ delay: 100, jsonl: [events.toolStart("edit", { path: "docs.md" })] },
				{ delay: 100, jsonl: [events.toolEnd("edit"), events.toolResult("edit", "ok")] },
				{ delay: 700, jsonl: [events.assistantMessage("editor done")] },
			],
		});

		const id = `async-parallel-tool-sync-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const configPath = path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`);

		executeAsyncChain(id, {
			chain: [{ parallel: [{ agent: "reader", task: "Read" }, { agent: "editor", task: "Edit" }] }],
			agents: [makeAgent("reader"), makeAgent("editor")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const statusPath = path.join(asyncDir, "status.json");
		// Detached runner + two parallel child spawns can exceed 10s on slow Windows CI.
		const doneDeadline = Date.now() + 30_000;
		let sawRunningTool = false;
		let invariantViolated = false;
		while (!fs.existsSync(resultPath) && Date.now() < doneDeadline) {
			if (fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				const runningTools = (status.steps ?? [])
					.filter((step) => step.status === "running" && typeof step.currentTool === "string")
					.map((step) => step.currentTool as string);
				if (runningTools.length > 0) {
					sawRunningTool = true;
					if (!status.currentTool || !runningTools.includes(status.currentTool)) {
						invariantViolated = true;
						break;
					}
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (!fs.existsSync(resultPath)) {
			assert.fail(`Timed out waiting for async result file: ${resultPath}\n${formatAsyncTimeoutDiagnostics(asyncDir, configPath, resultPath)}`);
		}
		assert.equal(sawRunningTool, true, "expected at least one polling interval with a running step tool");
		assert.equal(invariantViolated, false, "top-level currentTool drifted from running step tools");
	});

	it("returns a tool error when the detached runner config cannot be written", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	it("returns a tool error when an async run uses a missing cwd", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-missing-cwd-${Date.now().toString(36)}`;
		const missingCwd = path.join(tempDir, "missing-cwd");

		const singleResult = executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(singleResult.isError, true);
		assert.match(singleResult.content[0]?.text ?? "", /Failed to start async run/);
		assert.match(singleResult.content[0]?.text ?? "", /cwd does not exist/);

		const chainId = `async-missing-cwd-chain-${Date.now().toString(36)}`;
		const chainResult = executeAsyncChain(chainId, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			cwd: missingCwd,
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(chainResult.isError, true);
		assert.match(chainResult.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(chainResult.content[0]?.text ?? "", /cwd does not exist/);
	});

	it("returns a tool error when the async runner process cannot spawn", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const runtime = { ...mockPi.runtime, nodeExecPath: path.join(tempDir, "missing-node") };
		{
			const id = `async-spawn-fail-${Date.now().toString(36)}`;
			const result = executeAsyncSingle(id, {
				agent: "worker",
				task: "Do work",
				agentConfig: makeAgent("worker"),
				ctx: { runtime, pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
				artifactConfig: {
					enabled: false,
					includeInput: false,
					includeOutput: false,
					includeJsonl: false,
					includeMetadata: false,
					cleanupDays: 7,
				},
				shareEnabled: false,
				sessionRoot: path.join(tempDir, "sessions"),
				maxSubagentDepth: 2,
			});

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /Failed to start async run/);
			assert.match(result.content[0]?.text ?? "", /missing-node.*ENOENT/);
		}
	});

	it("returns a tool error when an async chain cannot write its detached runner config", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, () => {
		const id = `async-chain-write-fail-${Date.now().toString(36)}`;
		assert.ok(TEMP_ROOT_DIR, "TEMP_ROOT_DIR should be available for async tests");
		fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
		fs.mkdirSync(path.join(TEMP_ROOT_DIR, `async-cfg-${id}.json`), { recursive: true });

		const result = executeAsyncChain(id, {
			chain: [{ agent: "worker", task: "Do work" }],
			agents: [makeAgent("worker")],
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Failed to start async chain/);
		assert.match(result.content[0]?.text ?? "", /async-cfg-/);
	});

	for (const scenario of ["delayed", "tool-only", "corrected", "unrelated-error", "missing-settlement", "activity", "silent-tool", "aborted", "provider-error", "cancelled"] as const) {
		it(`background structured settlement: ${scenario}`, { skip: !isAsyncAvailable() ? "jiti not available" : scenario === "cancelled" && process.platform === "win32" ? "requires POSIX signals" : undefined }, async (t) => {
			const runRoot = fs.mkdtempSync(path.join(ASYNC_DIR, `settlement-${scenario}-`));
			const id = path.basename(runRoot);
			fs.rmdirSync(runRoot);
			t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
			const settlement = { type: "agent_settled", aborted: scenario === "aborted" };
			const corrected = [
				events.toolResult("structured_output", 'Validation failed for tool "structured_output": value: must be object', true),
				events.toolResult("structured_output", "Structured output captured."),
			];
			const success = { structuredOutput: { verdict: "FAIL" }, jsonl: [settlement] };
			mockPi.onCall({
				steps: scenario === "tool-only" ? [{ ...success, jsonl: [events.toolResult("structured_output", "Structured output captured."), settlement] }]
					: scenario === "corrected" || scenario === "unrelated-error" ? [
						{ jsonl: [...(scenario === "unrelated-error" ? [events.toolResult("read", "unrelated failure", true)] : []), ...corrected] }, success,
					]
					: scenario === "silent-tool" ? [
						{ jsonl: [events.toolStart("bash", { command: "silent work" })] },
						{ ...success, delay: 1500 },
					]
					: [
						{ ...(scenario === "missing-settlement" ? { structuredOutput: { verdict: "FAIL" } } : {}), jsonl: [scenario === "provider-error" ? { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "stop", errorMessage: "provider exploded" } } : events.assistantMessage("Initial report")] },
						...(scenario === "activity" ? [
							{ delay: 200, jsonl: ["stdout activity"] },
							{ delay: 200, stderr: "stderr activity\n" },
							{ delay: 200, jsonl: [events.toolStart("read", { path: "input.md" })] },
						] : []),
						...(scenario === "missing-settlement" || scenario === "cancelled" ? [] : [{ ...success, delay: scenario === "delayed" ? 1500 : scenario === "activity" ? 200 : 0 }]),
					],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const startedAt = Date.now();
			const result = executeAsyncChain(id, {
				chain: [{ agent: "reviewer", task: "Review", as: "review", outputSchema: { type: "object" }, stopOn: { path: "/verdict", in: ["FAIL"] } }, { agent: "reviewer", task: "never" }],
				agents: [makeAgent("reviewer")],
				ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: id },
				artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
				...(scenario === "missing-settlement" || scenario === "activity" || scenario === "silent-tool" ? { controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled: false, inFlightSilenceCeilingMs: 500, inFlightSilenceKillMs: 800 } } : {}),
			});
			assert.ok(!result.isError);
			if (scenario === "cancelled") {
				const deadline = Date.now() + 5000;
				while (!fs.existsSync(path.join(runRoot, "output-0.log")) || !fs.readFileSync(path.join(runRoot, "output-0.log"), "utf8").includes("Initial report")) {
					assert.ok(Date.now() < deadline, "Timed out waiting for prose before cancellation");
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				const status = JSON.parse(fs.readFileSync(path.join(runRoot, "status.json"), "utf8"));
				process.kill(status.pid, "SIGUSR2");
			}
			const payload = JSON.parse(fs.readFileSync(await waitForAsyncResultFile(id, 6000), "utf8")) as AsyncResultPayload;
			const succeeds = !["missing-settlement", "aborted", "provider-error", "unrelated-error", "cancelled"].includes(scenario);
			assert.equal(payload.success, succeeds, JSON.stringify(payload));
			assert.equal(mockPi.callCount(), 1);
			assert.ok(Date.now() - startedAt < 6000);
			if (succeeds) {
				assert.equal(payload.exitCode, 0);
				assert.deepEqual(payload.results[0].structuredOutput, { verdict: "FAIL" });
				assert.equal(payload.outputs?.review?.text, '{"verdict":"FAIL"}');
				assert.ok(payload.stop);
				assert.doesNotMatch(JSON.stringify(payload), /Forcing termination/);
				assert.doesNotMatch(fs.readFileSync(path.join(ASYNC_DIR, id, "output-0.log"), "utf8"), /Forcing termination/);
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				assert.equal(status.steps[0].status, "complete");
			} else if (scenario === "cancelled") assert.equal(payload.state, "paused");
			else if (scenario === "provider-error") assert.match(payload.results[0].error ?? "", /provider exploded/);
			else if (scenario === "unrelated-error") assert.match(payload.results[0].error ?? "", /unrelated failure/);
			else if (scenario === "missing-settlement") assert.match(payload.results[0].error ?? "", /settlement.*silence/i);
		});
	}

	it("background forced drain after final assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("async-done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "async-done-before-drain");
	});

	it("background forced drain after empty terminal assistant output is cleanup success", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("")],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-empty-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		const start = Date.now();
		executeAsyncSingle(id, {
			agent: "scout",
			task: "Inspect something",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const elapsed = Date.now() - start;
		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.ok(elapsed < 4000, `should clean up async child shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(payload.success, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.results[0].success, true);
		assert.equal(payload.results[0].output, "");
	});

	it("background final-drain cleanup preserves explicit assistant errors", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "failed" }],
					model: "mock/test-model",
					stopReason: "stop",
					errorMessage: "provider exploded",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});

		const id = `async-final-drain-error-${Date.now().toString(36)}`;
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Do work",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
		});

		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, false);
		assert.equal(payload.exitCode, 1);
		assert.equal(payload.results[0].success, false);
		assert.equal(payload.results[0].error, "provider exploded");
	});

	it("background runs emit active-long-running control events from child turns", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.assistantMessage("still working")] },
				{ delay: 2_000, jsonl: [events.assistantMessage("done")] },
			],
		});

		const id = `async-active-long-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "scout",
			task: "Investigate behavior",
			agentConfig: makeAgent("scout"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 1,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "active_long_running" && status.steps?.[0]?.activityState === "active_long_running") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"type":"active_long_running"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed active_long_running");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"active_long_running"/);
		assert.match(eventText, /"reason":"turn_threshold"/);
		assert.ok(statusDuringEvent, "expected status.json to expose active_long_running while the run is still active");
		assert.equal(statusDuringEvent.activityState, "active_long_running");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "active_long_running");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs escalate repeated mutating tool failures", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ jsonl: [events.toolStart("edit", { path: "src/runs/background/subagent-runner.ts" }), events.toolEnd("edit"), events.toolResult("edit", "No exact match found for subagent-runner.ts", true)] },
				{ delay: 2_000, jsonl: [events.assistantMessage("I need another attempt.")] },
			],
		});

		const id = `async-tool-failures-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Implement the approved fixes",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(tempDir, "sessions"),
			maxSubagentDepth: 2,
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 999_999,
				activeNoticeAfterTurns: 999_999,
				activeNoticeAfterMs: 999_999,
				activeNoticeAfterTokens: 999_999,
				failedToolAttemptsBeforeAttention: 3,
				notifyOn: ["active_long_running", "needs_attention"],
				notifyChannels: ["event", "async"],
			},
		});

		const statusPath = path.join(asyncDir, "status.json");
		const deadline = Date.now() + 10_000;
		let eventText = "";
		let statusDuringEvent: AsyncStatusPayload | undefined;
		while (Date.now() < deadline) {
			if (fs.existsSync(eventsPath)) {
				eventText = fs.readFileSync(eventsPath, "utf-8");
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(statusPath)) {
				const status = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as AsyncStatusPayload;
				if (status.activityState === "needs_attention" && status.steps?.[0]?.activityState === "needs_attention") {
					statusDuringEvent = status;
					break;
				}
			}
			if (eventText.includes('"reason":"tool_failures"') && fs.existsSync(resultPath)) {
				assert.fail("run completed before status.json exposed needs_attention");
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.match(eventText, /"type":"needs_attention"/);
		assert.match(eventText, /"reason":"tool_failures"/);
		assert.match(eventText, /subagent-runner\.ts/);
		assert.ok(statusDuringEvent, "expected status.json to expose needs_attention while the run is still active");
		assert.equal(statusDuringEvent.activityState, "needs_attention");
		assert.equal(statusDuringEvent.steps?.[0]?.activityState, "needs_attention");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	it("background runs stream child events and live output while active", { skip: !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
		mockPi.onCall({
			steps: [
				{ delay: 200, jsonl: [events.toolStart("bash", { command: "ls" })] },
				{ delay: 600, jsonl: [events.toolEnd("bash"), events.toolResult("bash", "file-a\nfile-b")] },
				{ delay: 600, jsonl: [events.assistantMessage("Done streaming")], stderr: "warning: mock stderr\n" },
			],
		});

		const id = `async-stream-${Date.now().toString(36)}`;
		const asyncDir = path.join(ASYNC_DIR, id);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const outputPath = path.join(asyncDir, "output-0.log");
		const resultPath = path.join(RESULTS_DIR, `${id}.json`);
		const sessionRoot = path.join(tempDir, "sessions");

		executeAsyncSingle(id, {
			agent: "worker",
			task: "Stream detailed progress",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "session-1" },
			artifactConfig: {
				enabled: false,
				includeInput: false,
				includeOutput: false,
				includeJsonl: false,
				includeMetadata: false,
				cleanupDays: 7,
			},
			shareEnabled: false,
			sessionRoot,
			maxSubagentDepth: 2,
		});

		const liveDeadline = Date.now() + 10_000;
		let sawChildEvent = false;
		let sawLiveOutput = false;
		while (Date.now() < liveDeadline && (!sawChildEvent || !sawLiveOutput)) {
			if (fs.existsSync(eventsPath)) {
				const content = fs.readFileSync(eventsPath, "utf-8");
				sawChildEvent = content.includes('"type":"tool_execution_start"')
					&& content.includes('"subagentSource":"child"');
			}
			if (fs.existsSync(outputPath)) {
				const content = fs.readFileSync(outputPath, "utf-8");
				sawLiveOutput = content.includes("bash: ls") || content.includes("file-a") || content.includes("warning: mock stderr");
			}
			if (sawChildEvent && sawLiveOutput) break;
			assert.equal(fs.existsSync(resultPath), false, "run finished before live observability was written");
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.equal(sawChildEvent, true, "expected child JSON events to be streamed into events.jsonl");
		assert.equal(sawLiveOutput, true, "expected output-0.log to receive live child output");

		const doneDeadline = Date.now() + 10_000;
		while (!fs.existsSync(resultPath)) {
			if (Date.now() > doneDeadline) {
				assert.fail(`Timed out waiting for async result file: ${resultPath}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const payload = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		assert.equal(payload.success, true);
		assert.equal(payload.results[0].output, "Done streaming");

		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
		assert.deepEqual(status.steps[0].recentTools.map((tool: { tool: string; args: string }) => ({ tool: tool.tool, args: tool.args })), [{ tool: "bash", args: "ls" }]);
		assert.deepEqual(status.steps[0].recentOutput, ["file-a", "file-b", "Done streaming"]);
	});
});
