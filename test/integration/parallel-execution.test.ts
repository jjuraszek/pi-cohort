/**
 * Integration tests for parallel execution.
 *
 * Tests the mapConcurrent utility and parallel agent spawning via runSync.
 * The top-level parallel mode (params.tasks) lives in index.ts and uses
 * mapConcurrent + runSync — we test both pieces here.
 *
 * mapConcurrent tests always run. runSync tests require pi packages.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";
import { resolveExpectedWorktreeAgentCwd } from "../../src/runs/shared/worktree.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const typesMod = await tryImport<any>("./src/shared/types.ts");
const piAvailable = !!(execution && utils);

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const TEMP_ARTIFACTS_DIR: string | undefined = typesMod?.TEMP_ARTIFACTS_DIR;
const INTERCOM_DETACH_REQUEST_EVENT: string | undefined = typesMod?.INTERCOM_DETACH_REQUEST_EVENT;

// ---------------------------------------------------------------------------
// mapConcurrent — always runs (pure logic, no pi deps beyond utils.ts)
// ---------------------------------------------------------------------------

describe("mapConcurrent", { skip: !mapConcurrent ? "utils not importable" : undefined }, () => {
	it("processes all items", async () => {
		const items = [1, 2, 3, 4, 5];
		const results = await mapConcurrent(items, 2, async (item: number) => item * 2);
		assert.deepEqual(results, [2, 4, 6, 8, 10]);
	});

	it("preserves order regardless of completion time", async () => {
		const items = [80, 10, 40]; // delays in ms
		const results = await mapConcurrent(items, 3, async (ms: number, i: number) => {
			await new Promise((r) => setTimeout(r, ms));
			return i;
		});
		assert.deepEqual(results, [0, 1, 2], "results should be in original order");
	});

	it("respects concurrency limit", async () => {
		let running = 0;
		let maxRunning = 0;
		const items = [1, 2, 3, 4, 5, 6];

		await mapConcurrent(items, 2, async () => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20));
			running--;
		});

		assert.ok(maxRunning <= 2, `max concurrent should be ≤ 2, got ${maxRunning}`);
	});

	it("handles empty array", async () => {
		const results = await mapConcurrent([], 4, async (item: unknown) => item);
		assert.deepEqual(results, []);
	});

	it("propagates errors", async () => {
		await assert.rejects(
			() =>
				mapConcurrent([1, 2, 3], 2, async (item: number) => {
					if (item === 2) throw new Error("boom");
					return item;
				}),
			/boom/,
		);
	});
});

// ---------------------------------------------------------------------------
// Parallel agent execution via runSync
// ---------------------------------------------------------------------------

describe("parallel agent execution", { skip: !piAvailable ? "pi packages not available" : undefined }, () => {
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

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			config: {},
			asyncByDefault: false,
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	function readLastCallArgs(): string[] {
		const callFile = fs.readdirSync(mockPi.dir).find((name) => name.startsWith("call-"));
		assert.ok(callFile, "expected a recorded mock pi call");
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("runs multiple agents concurrently via mapConcurrent + runSync", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["agent-a", "agent-b", "agent-c"]);
		const tasks = ["Task A", "Task B", "Task C"];

		const results = await mapConcurrent(
			tasks.map((task, i) => ({ agent: agents[i].name, task, index: i })),
			3,
			async ({ agent, task, index }: any) => {
				return runSync(tempDir, agents, agent, task, { index });
			},
		);

		assert.equal(results.length, 3);
		assert.ok(results.every((r: any) => r.exitCode === 0));
		assert.equal(results[0].agent, "agent-a");
		assert.equal(results[1].agent, "agent-b");
		assert.equal(results[2].agent, "agent-c");
	});

	it("all agents get independent results", async () => {
		mockPi.onCall({ output: "Result" });
		const agents = makeAgentConfigs(["a", "b"]);

		const results = await mapConcurrent(
			[
				{ agent: "a", task: "Task A" },
				{ agent: "b", task: "Task B" },
			],
			2,
			async ({ agent, task }: any, i: number) => runSync(tempDir, agents, agent, task, { index: i }),
		);

		assert.equal(results.length, 2);
		assert.equal(results[0].agent, "a");
		assert.equal(results[1].agent, "b");
		const ok = results.filter((r: any) => r.exitCode === 0).length;
		assert.equal(ok, 2);
	});

	it("top-level parallel defaults require explicit output and progress", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Omitted" });
		mockPi.onCall({ output: "Explicit" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md", defaultProgress: true, defaultReads: ["input.md"] })]);

		await executor.execute(
			"parallel-defaults-opt-in",
			{
				tasks: [
					{ agent: "echo", task: "Omitted" },
					{ agent: "echo", task: "Explicit", output: true, progress: true },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), true);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
		const calls = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).sort();
		const taskArgs = calls.map((call) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, call), "utf-8")).args.at(-1) as string);
		const omittedTask = taskArgs.find((task) => task.includes("\n\nOmitted\n"));
		assert.ok(omittedTask);
		assert.ok(omittedTask.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
		assert.doesNotMatch(omittedTask, /Write your findings to:|Update progress at:/);
	});

	it("top-level parallel omitted tasks leave configured artifacts absent", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "First omitted result" });
		mockPi.onCall({ output: "Second omitted result" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md", defaultProgress: true, defaultReads: ["input.md"] })]);

		const result = await executor.execute(
			"parallel-all-omitted-defaults",
			{
				tasks: [
					{ agent: "echo", task: "First omitted task" },
					{ agent: "echo", task: "Second omitted task" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
		const taskArgs = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-"))
			.map((call) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, call), "utf-8")).args.at(-1) as string);
		for (const task of taskArgs) {
			assert.ok(task.includes(`[Read from: ${path.join(tempDir, "input.md")}]`));
			assert.doesNotMatch(task, /Write your findings to:|Update progress at:/);
		}
	});

	it("passes disabled parallel output and progress to clarify when omitted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "clarified parallel report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md", defaultProgress: true })]);
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: { custom: async () => ({ confirmed: true, templates: ["Review"], behaviorOverrides: [{}], runInBackground: false }) },
		};

		await executor.execute("parallel-clarify-defaults", { tasks: [{ agent: "echo", task: "Review" }], clarify: true }, new AbortController().signal, undefined, ctx as any);

		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
		assert.doesNotMatch(readLastCallArgs().at(-1) ?? "", /Write your findings to:|Update progress at:/);
	});

	it("executes clarify-selected parallel output and progress overrides", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const outputPath = path.join(tempDir, "clarified-selected.md");
		mockPi.onCall({ output: "parallel clarified result" });
		mockPi.onCall({ output: "parallel clarified result" });
		const executor = makeExecutor();
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => ({
					confirmed: true,
					templates: ["Unselected task", "Selected task"],
					behaviorOverrides: [undefined, { output: outputPath, progress: true }],
					runInBackground: false,
				}),
			},
		};

		const result = await executor.execute(
			"parallel-clarify-artifact-overrides",
			{ tasks: [{ agent: "echo", task: "First" }, { agent: "echo", task: "Second" }], clarify: true },
			new AbortController().signal,
			undefined,
			ctx as any,
		);

		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "parallel clarified result");
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
		const taskArgs = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")).args.at(-1) as string);
		const unselected = taskArgs.find((task) => task.includes("Unselected task"));
		const selected = taskArgs.find((task) => task.includes("Selected task"));
		assert.ok(unselected);
		assert.ok(selected);
		assert.doesNotMatch(unselected, /Write your findings to:|Update progress at:/);
		assert.ok(selected.includes(`Write your findings to: ${outputPath}`));
		assert.ok(selected.includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
	});

	it("top-level parallel output saves use per-task output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Saved report" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-output.md" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-output.md");
		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Saved report");
		assert.equal(result.details?.results?.[0]?.savedOutputPath, outputPath);
	});

	it("top-level parallel file-only output aggregates concise file references", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Parallel full report\nwith details" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-output",
			{ tasks: [{ agent: "echo", task: "Write report", output: "parallel-file-only.md", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const outputPath = path.join(tempDir, "parallel-file-only.md");
		const text = result.content[0]?.text ?? "";
		assert.equal(result.isError, undefined);
		assert.match(text, /Output saved to:/);
		assert.match(text, /2 lines/);
		assert.doesNotMatch(text, /Parallel full report/);
		assert.match(result.details?.results?.[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details?.results?.[0]?.finalOutput ?? "", /Parallel full report/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "Parallel full report\nwith details");
	});

	it("rejects top-level parallel file-only output without an output path", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-file-only-missing-output",
			{ tasks: [{ agent: "echo", task: "Write report", outputMode: "file-only" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("rejects duplicate top-level parallel output paths", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-duplicate-output",
			{
				tasks: [
					{ agent: "echo", task: "Write A", output: "same.md" },
					{ agent: "echo", task: "Write B", output: "same.md" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /same path/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("treats string false as disabled output in top-level parallel runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor();

		const result = await executor.execute(
			"parallel-string-false-output",
			{
				tasks: [
					{ agent: "echo", task: "Review A", output: "false" },
					{ agent: "echo", task: "Review B", output: "false" },
				],
			},
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(mockPi.callCount(), 2);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
	});

	it("top-level parallel reads are injected once with chain-style prefix", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Read done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-reads",
			{ tasks: [{ agent: "echo", task: "Inspect", reads: ["a.md", "b.md"] }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		const taskArg = args.at(-1) ?? "";
		assert.ok(taskArg.startsWith(`Task: [Read from: ${path.join(tempDir, "a.md")}, ${path.join(tempDir, "b.md")}]

Inspect

## Acceptance Contract`));
	});

	it("top-level parallel progress emits the existing progress instruction style", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Progress done" });
		const executor = makeExecutor();

		await executor.execute(
			"parallel-progress",
			{ tasks: [{ agent: "echo", task: "Track work", progress: true }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const args = readLastCallArgs();
		assert.ok((args.at(-1) ?? "").includes(`Update progress at: ${path.join(tempDir, "progress.md")}`));
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), true);
	});

	it("top-level parallel suppresses progress when the task is review-only", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Review done" });
		const executor = makeExecutor([makeAgent("reviewer", { defaultProgress: true })]);

		await executor.execute(
			"parallel-read-only-progress",
			{ tasks: [{ agent: "reviewer", task: "Review-only. Do not edit files. Return findings." }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		const taskArg = readLastCallArgs().at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});
});

// ---------------------------------------------------------------------------
// Run-scoped worktree artifacts (gh-8) — per-task output leaves + patch capture
// ---------------------------------------------------------------------------

function gitIn(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createParallelRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	gitIn(repoDir, ["init"]);
	gitIn(repoDir, ["config", "user.email", "tests@example.com"]);
	gitIn(repoDir, ["config", "user.name", "Parallel Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, "input.md"), "input\n", "utf-8");
	gitIn(repoDir, ["add", "-A"]);
	gitIn(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function taskArgsForAllCalls(mockPi: MockPi): string[] {
	return fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort()
		.map((name) => JSON.parse(fs.readFileSync(path.join(mockPi.dir, name), "utf-8")).args.at(-1) as string);
}

function makeExecutorFor(cwd: string, agents = [makeAgent("echo")]) {
	const state = {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundControls: new Map(),
		lastForegroundControlId: null,
	};
	const executor = createSubagentExecutor({
		pi: { events: createEventBus(), getSessionName: () => undefined },
		state,
		config: {},
		asyncByDefault: false,
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents }),
	});
	return { executor, state };
}

function createTrackedFileMutatingSetupHook(): string {
	const hookDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-parallel-worktree-hook-"));
	const hookPath = path.join(hookDir, "hook.sh");
	fs.writeFileSync(hookPath, "#!/bin/sh\ncat > /dev/null\necho 'hook-modified' >> input.md\necho '{}'\n", "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

describe("parallel worktree artifact scoping", { skip: !piAvailable || !createSubagentExecutor || !TEMP_ARTIFACTS_DIR ? "pi packages or executor not available" : undefined }, () => {
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		mockPi.reset();
	});

	it("run-scoped patch directories differ across two dispatches", async () => {
		const repoA = createParallelRepo("pi-parallel-worktree-a-");
		const repoB = createParallelRepo("pi-parallel-worktree-b-");
		try {
			mockPi.onCall({ output: "Worktree A" });
			const { executor: executorA } = makeExecutorFor(repoA, [makeAgent("worker")]);
			const resultA = await executorA.execute(
				"worktree-run-a",
				{ tasks: [{ agent: "worker", task: "Do work A" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoA),
			);
			assert.equal(resultA.isError, undefined);
			const runIdA = resultA.details?.runId;
			assert.ok(runIdA, "expected a runId on the parallel result");
			const diffsDirA = path.join(TEMP_ARTIFACTS_DIR!, runIdA, "worktree-diffs");
			assert.equal(fs.existsSync(diffsDirA), true);
			const patchPathA = path.join(diffsDirA, "task-0-worker.patch");
			assert.equal(fs.existsSync(patchPathA), true, "expected run A's patch file inside its own worktree-diffs directory");
			const patchBytesABefore = fs.readFileSync(patchPathA);

			mockPi.onCall({ output: "Worktree B" });
			const { executor: executorB } = makeExecutorFor(repoB, [makeAgent("worker")]);
			const resultB = await executorB.execute(
				"worktree-run-b",
				{ tasks: [{ agent: "worker", task: "Do work B" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoB),
			);
			assert.equal(resultB.isError, undefined);
			const runIdB = resultB.details?.runId;
			assert.ok(runIdB, "expected a runId on the parallel result");
			const diffsDirB = path.join(TEMP_ARTIFACTS_DIR!, runIdB, "worktree-diffs");
			assert.equal(fs.existsSync(diffsDirB), true);
			const patchPathB = path.join(diffsDirB, "task-0-worker.patch");
			assert.equal(fs.existsSync(patchPathB), true, "expected run B's patch file inside its own worktree-diffs directory");

			assert.notEqual(diffsDirA, diffsDirB);
			assert.deepEqual(fs.readFileSync(patchPathA), patchBytesABefore, "run A's patch bytes must be unchanged after run B completes");
		} finally {
			removeTempDir(repoA);
			removeTempDir(repoB);
		}
	});

	it("redirects a relative worktree output outside the checkout into the run-scoped leaf", async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-output-");
		try {
			mockPi.onCall({ output: "Report body" });
			const { executor } = makeExecutorFor(repoDir, [makeAgent("worker")]);

			const result = await executor.execute(
				"worktree-output",
				{ tasks: [{ agent: "worker", task: "Write report", output: "report.md", reads: ["input.md"] }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, undefined);
			const runId = result.details?.runId;
			assert.ok(runId, "expected a runId on the parallel result");
			const taskArg = taskArgsForAllCalls(mockPi).at(-1) ?? "";
			const writeMatch = taskArg.match(/Write your findings to: (.+)/);
			const readMatch = taskArg.match(/\[Read from: (.+)\]/);
			assert.ok(writeMatch, "expected an output instruction in the task text");
			assert.ok(readMatch, "expected a read instruction in the task text");
			assert.ok(writeMatch![1]!.includes(path.join(runId, "task-0", "report.md")));
			assert.doesNotMatch(writeMatch![1]!, /pi-worktree-/);
			assert.match(readMatch![1]!, /pi-worktree-/);

			const reportPath = path.join(TEMP_ARTIFACTS_DIR!, runId, "task-0", "report.md");
			assert.equal(fs.existsSync(reportPath), true, "expected the redirected report file to survive on disk after the run returns");
			const worktreePath = resolveExpectedWorktreeAgentCwd(repoDir, runId, 0);
			assert.equal(fs.existsSync(worktreePath), false, "expected the worktree checkout to be torn down after the run returns");
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("gives each fan-out leaf a distinct run-scoped output path", async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-fanout-");
		try {
			mockPi.onCall({ output: "Fan-out body" });
			const { executor } = makeExecutorFor(repoDir, [makeAgent("worker")]);

			const result = await executor.execute(
				"worktree-fanout",
				{ tasks: [{ agent: "worker", task: "Write report", output: "report.md", count: 3 }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, undefined);
			const taskArgs = taskArgsForAllCalls(mockPi);
			assert.equal(taskArgs.length, 3);
			const writePaths = new Set(
				taskArgs.map((taskArg) => taskArg.match(/Write your findings to: (.+)/)?.[1]),
			);
			assert.equal(writePaths.size, 3, "expected three distinct resolved output paths");
			for (const leaf of ["task-0", "task-1", "task-2"]) {
				assert.ok([...writePaths].some((writePath) => writePath?.includes(leaf)), `expected ${leaf} among resolved output paths`);
			}
			for (const writePath of writePaths) {
				assert.ok(writePath, "expected a resolved output path");
				assert.equal(fs.existsSync(writePath!), true, `expected fan-out report file to exist on disk at ${writePath}`);
			}
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("rejects a relative worktree output that escapes its per-task directory", async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-escape-");
		try {
			const { executor } = makeExecutorFor(repoDir, [makeAgent("worker")]);

			const result = await executor.execute(
				"worktree-escape",
				{ tasks: [{ agent: "worker", task: "Write report", output: "../escape.md" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /resolves outside its per-task directory/);
			assert.equal(mockPi.callCount(), 0);
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("keeps the redirected report file out of the captured worktree patch", async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-purity-");
		const hookPath = createTrackedFileMutatingSetupHook();
		try {
			mockPi.onCall({ output: "Report body" });
			const state = {
				baseCwd: repoDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			};
			const executor = createSubagentExecutor({
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state,
				config: { worktreeSetupHook: hookPath },
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({ agents: [makeAgent("worker")] }),
			});

			const result = await executor.execute(
				"worktree-purity",
				{ tasks: [{ agent: "worker", task: "Write report", output: "report.md", reads: ["input.md"] }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, undefined);
			const runId = result.details?.runId;
			assert.ok(runId, "expected a runId on the parallel result");
			const patchPath = path.join(TEMP_ARTIFACTS_DIR!, runId, "worktree-diffs", "task-0-worker.patch");
			assert.equal(fs.existsSync(patchPath), true);
			const patchContent = fs.readFileSync(patchPath, "utf-8");
			assert.match(patchContent, /hook-modified/, "expected the setup hook's tracked-file mutation to appear in the captured patch");
			assert.doesNotMatch(patchContent, /report\.md/, "the redirected report file must never appear in the captured worktree patch");
		} finally {
			removeTempDir(repoDir);
			removeTempDir(path.dirname(hookPath));
		}
	});

	it("captures the run-scoped patch directory before an interrupted run returns", async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-interrupt-");
		try {
			mockPi.onCall({ delay: 10_000 });
			const { executor, state } = makeExecutorFor(repoDir, [makeAgent("worker")]);

			const resultPromise = executor.execute(
				"worktree-interrupt",
				{ tasks: [{ agent: "worker", task: "Slow work" }], worktree: true },
				new AbortController().signal,
				undefined,
				makeMinimalCtx(repoDir),
			);

			const deadline = Date.now() + 5_000;
			let control: { interrupt?: () => boolean } | undefined;
			while (Date.now() < deadline) {
				const runId = state.lastForegroundControlId;
				control = runId ? state.foregroundControls.get(runId) : undefined;
				if (control?.interrupt) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.ok(control?.interrupt, "expected a foreground control with an interrupt handle");
			control!.interrupt!();

			const result = await resultPromise;
			const runId = result.details?.runId;
			assert.ok(runId, "expected a runId on the parallel result");
			const diffsDir = path.join(TEMP_ARTIFACTS_DIR!, runId, "worktree-diffs");
			assert.equal(fs.existsSync(diffsDir), true);
		} finally {
			removeTempDir(repoDir);
		}
	});

	it("captures the run-scoped patch directory before a detached run returns", { skip: !INTERCOM_DETACH_REQUEST_EVENT ? "types module not importable" : undefined }, async () => {
		const repoDir = createParallelRepo("pi-parallel-worktree-detach-");
		try {
			mockPi.onCall({
				steps: [
					{ jsonl: [events.toolStart("intercom", { action: "send", to: "orchestrator" })] },
					{ delay: 1000, jsonl: [events.assistantMessage("after handoff")] },
				],
			});
			mockPi.onCall({ output: "other done" });

			const eventsApi = createEventBus();
			const state = {
				baseCwd: repoDir,
				currentSessionId: null,
				asyncJobs: new Map(),
				grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
				foregroundControls: new Map(),
				lastForegroundControlId: null,
			};
			const executor = createSubagentExecutor({
				pi: { events: eventsApi, getSessionName: () => undefined },
				state,
				config: {},
				asyncByDefault: false,
				tempArtifactsDir: repoDir,
				getSubagentSessionRoot: () => repoDir,
				expandTilde: (value: string) => value,
				discoverAgents: () => ({
					agents: [
						makeAgent("echo", { systemPrompt: "Intercom orchestration channel:" }),
						makeAgent("second", { systemPrompt: "Intercom orchestration channel:" }),
					],
				}),
			});

			let detachEmitted = false;
			const result = await executor.execute(
				"worktree-detach",
				{
					tasks: [
						{ agent: "echo", task: "send handoff" },
						{ agent: "second", task: "continue" },
					],
					worktree: true,
				},
				new AbortController().signal,
				(update: { details?: { progress?: Array<{ currentTool?: string }> } }) => {
					if (detachEmitted) return;
					if (!update.details?.progress?.some((entry) => entry.currentTool === "intercom")) return;
					detachEmitted = true;
					eventsApi.emit(INTERCOM_DETACH_REQUEST_EVENT!, { requestId: "worktree-detach" });
				},
				makeMinimalCtx(repoDir),
			);

			assert.equal(result.isError, undefined);
			assert.match(result.content[0]?.text ?? "", /Parallel run detached for intercom coordination/);
			assert.equal(detachEmitted, true);
			const runId = result.details?.runId;
			assert.ok(runId, "expected a runId on the parallel result");
			const diffsDir = path.join(TEMP_ARTIFACTS_DIR!, runId, "worktree-diffs");
			assert.equal(fs.existsSync(diffsDir), true);
		} finally {
			removeTempDir(repoDir);
		}
	});

	describe("intercom-receipt branch", () => {
		let homeDir: string;
		let originalHome: string | undefined;
		let originalUserProfile: string | undefined;

		before(() => {
			originalHome = process.env.HOME;
			originalUserProfile = process.env.USERPROFILE;
			homeDir = createTempDir("pi-parallel-worktree-receipt-home-");
			process.env.HOME = homeDir;
			process.env.USERPROFILE = homeDir;
			fs.mkdirSync(path.join(homeDir, ".pi", "agent", "extensions", "pi-intercom"), { recursive: true });
			fs.mkdirSync(path.join(homeDir, ".pi", "agent", "intercom"), { recursive: true });
			fs.writeFileSync(path.join(homeDir, ".pi", "agent", "intercom", "config.json"), JSON.stringify({ enabled: true }), "utf-8");
		});

		after(() => {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
			if (originalUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = originalUserProfile;
			removeTempDir(homeDir);
		});

		function createAcknowledgingEventBus() {
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const bus = {
				on(channel: string, handler: (payload: unknown) => void) {
					const channelListeners = listeners.get(channel) ?? new Set();
					channelListeners.add(handler);
					listeners.set(channel, channelListeners);
					return () => {
						channelListeners.delete(handler);
						if (channelListeners.size === 0) listeners.delete(channel);
					};
				},
				emit(channel: string, payload: unknown) {
					for (const handler of listeners.get(channel) ?? []) handler(payload);
					if (channel === "subagent:result-intercom") {
						const requestId = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : undefined;
						if (typeof requestId === "string") {
							setImmediate(() => bus.emit("subagent:result-intercom-delivery", { requestId, delivered: true }));
						}
					}
				},
			};
			return bus;
		}

		it("captures the run-scoped patch directory before an intercom-receipt run returns", async () => {
			const repoDir = createParallelRepo("pi-parallel-worktree-receipt-");
			try {
				mockPi.onCall({ output: "Parallel child output" });
				mockPi.onCall({ output: "Parallel child output" });

				const state = {
					baseCwd: repoDir,
					currentSessionId: null,
					asyncJobs: new Map(),
					grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
					foregroundControls: new Map(),
					lastForegroundControlId: null,
				};
				const executor = createSubagentExecutor({
					pi: { events: createAcknowledgingEventBus(), getSessionName: () => "orchestrator", setSessionName: () => {} },
					state,
					config: { intercomBridge: { mode: "always" } },
					asyncByDefault: false,
					tempArtifactsDir: repoDir,
					getSubagentSessionRoot: () => repoDir,
					expandTilde: (value: string) => value,
					discoverAgents: () => ({ agents: [makeAgent("a"), makeAgent("b")] }),
				});

				const result = await executor.execute(
					"worktree-receipt",
					{
						tasks: [
							{ agent: "a", task: "task-a" },
							{ agent: "b", task: "task-b" },
						],
						worktree: true,
					},
					new AbortController().signal,
					undefined,
					makeMinimalCtx(repoDir),
				);

				assert.equal(result.isError, undefined);
				assert.match(result.content[0]?.text ?? "", /Delivered parallel subagent results via intercom\./);
				const runId = result.details?.runId;
				assert.ok(runId, "expected a runId on the parallel result");
				const diffsDir = path.join(TEMP_ARTIFACTS_DIR!, runId, "worktree-diffs");
				assert.equal(fs.existsSync(diffsDir), true);
			} finally {
				removeTempDir(repoDir);
			}
		});
	});
});
