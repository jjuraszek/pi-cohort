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
import fsSink from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	events,
	makeAgent,
	makeAgentConfigs,
	makeMinimalCtx,
	makeParentSessionCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";
import { resolveExtensionConfig } from "../../src/agents/agents.ts";
import { resolveExpectedWorktreeAgentCwd } from "../../src/runs/shared/worktree.ts";

// Top-level await: try importing pi-dependent modules
const utils = await tryImport<any>("./src/shared/utils.ts");
const execution = await tryImport<any>("./src/runs/foreground/execution.ts");
const executorMod = await tryImport<any>("./src/runs/foreground/subagent-executor.ts");
const typesMod = await tryImport<any>("./src/shared/types.ts");
const piAvailable = !!(execution && utils);
const hookScriptSkip = process.platform === "win32"
	? "Hook script execution differs on Windows CI environments."
	: undefined;

const runSync = execution?.runSync;
const mapConcurrent = utils?.mapConcurrent;
const createSubagentExecutor = executorMod?.createSubagentExecutor;
const TEMP_ARTIFACTS_DIR: string | undefined = typesMod?.TEMP_ARTIFACTS_DIR;

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
	const runSync = (cwd, agents, agent, task, options) => execution!.runSync(cwd, agents, agent, task, { ...options, runtime: mockPi.runtime });
	const createSubagentExecutor = (deps) => executorMod!.createSubagentExecutor({ ...deps, captureRuntime: mockPi.captureRuntime });

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
			resolveConfig: () => ({}),
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

	for (const exitCode of [0, 1]) {
		it(`omits cleanup diagnostics from native parallel exit ${exitCode}`, async () => {
			mockPi.onCall({ output: "Native reply", stderr: exitCode ? "Native failure" : "", exitCode });
			const result = await makeExecutor().execute("native", { tasks: [{ agent: "echo", task: "Task" }] }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.details.results[0].exitCode, exitCode);
			assert.equal(result.isError, undefined);
			assert.doesNotMatch(result.content[0].text, /Child \d+ \(echo\):|paused after interrupt|manual cleanup/);
		});
	}

	for (const diagnostic of ["", "Process termination could not be confirmed; manual cleanup may be required."]) {
		it(`renders every public parallel pause child with ${diagnostic ? "uncertain" : "clean"} cleanup`, async () => {
			// Substitute child results, not the public parallel pause return or its formatter.
			const fixture = path.join(tempDir, "execution.mjs");
			fs.writeFileSync(fixture, `export async function runSync(_cwd, _agents, agent, task, options) {
				const interrupted = options.index > 0;
				return { agent, task, exitCode: 0, interrupted, error: interrupted ? ${JSON.stringify(diagnostic || undefined)} : undefined,
					messages: [], finalOutput: interrupted ? "Interrupted. Waiting for explicit next action." : "Done",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
			}`);
			const sourceUrl = new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url);
			const source = fs.readFileSync(sourceUrl, "utf8").replace(/from "(\.[^"]+)"/g, (_match, specifier) =>
				`from "${specifier === "./execution.ts" ? pathToFileURL(fixture).href : new URL(specifier, sourceUrl).href}"`);
			const entry = path.join(tempDir, "executor.ts");
			fs.writeFileSync(entry, source.replace('from "@earendil-works/pi-coding-agent"', `from "${import.meta.resolve("@earendil-works/pi-coding-agent")}"`));
			const { createSubagentExecutor } = await import(pathToFileURL(entry).href);
			const executor = createSubagentExecutor({
				captureRuntime: mockPi.captureRuntime,
				pi: { events: createEventBus(), getSessionName: () => undefined },
				state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
				resolveConfig: () => ({}), tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir,
				expandTilde: value => value, discoverAgents: () => ({ agents: [makeAgent("echo")] }),
			});
			const result = await executor.execute("pause", { tasks: [0, 1, 2].map(() => ({ agent: "echo", task: "Task" })) }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined);
			assert.equal(result.content[0].text, `Parallel run paused after interrupt (echo). Waiting for explicit next action.${diagnostic ? `\n\nChild 2 (echo): ${diagnostic}\nChild 3 (echo): ${diagnostic}` : ""}`);
			assert.equal(result.details.mode, "parallel");
			assert.equal(result.details.results.length, 3);
			assert.deepEqual(result.details.results.map(child => [child.agent, child.exitCode, child.interrupted, child.error]), [
				["echo", 0, false, undefined], ["echo", 0, true, diagnostic || undefined], ["echo", 0, true, diagnostic || undefined],
			]);
		});
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

	it("keeps sibling results when a parallel child reports a blocker", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const blocked = "BLOCKED: select an API\nDone: compared options\nRemaining: implement";
		mockPi.onCall({ output: blocked });
		mockPi.onCall({ output: "Sibling completed" });
		const executor = makeExecutor([makeAgent("blocked"), makeAgent("sibling")]);

		const result = await executor.execute(
			"parallel-blocked",
			{ tasks: [{ agent: "blocked", task: "Implement API" }, { agent: "sibling", task: "Review docs" }] },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.equal(result.details?.results?.length, 2);
		assert.ok(result.details?.results?.some((item: any) => item.exitCode === 1 && item.error === blocked));
		assert.ok(result.details?.results?.some((item: any) => item.finalOutput === "Sibling completed"));
		assert.match(result.content[0]?.text ?? "", /BLOCKED: select an API/);
		assert.match(result.content[0]?.text ?? "", /Sibling completed/);
	});

	it("parallel tasks inherit the parent session model and thinking", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "Done" });
		const executor = makeExecutor([makeAgent("echo")]);

		const result = await executor.execute(
			"parallel-inherit",
			{ tasks: [{ agent: "echo", task: "Inherit" }] },
			new AbortController().signal,
			undefined,
			makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "high"),
		);

		assert.equal(result.isError, undefined);
		const args = readLastCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6:high");
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

	for (const outputMode of [undefined, "inline"] as const) {
		for (const outcome of ["saved", "save error", "failed"] as const) {
			it(`preserves exact parallel inline output (${outputMode ?? "unset"}, ${outcome})`, { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
				const reply = "Complete parallel reply\nwith details";
				const parent = path.join(tempDir, "reports");
				if (outcome === "save error") fs.writeFileSync(parent, "not a directory");
				const outputPath = path.join(parent, "report.md");
				mockPi.onCall({ output: reply, exitCode: outcome === "failed" ? 1 : 0, stderr: outcome === "failed" ? "child failed" : "" });
				const result = await makeExecutor().execute(
					"parallel-output",
					{ tasks: [{ agent: "echo", task: "Write report", output: outputPath, outputMode }] },
					new AbortController().signal, undefined, makeMinimalCtx(tempDir),
				);
				const child = result.details.results[0];
				assert.equal(child.finalOutput, reply);
				const status = outcome === "failed" ? `FAILED (exit code 1): ${child.error}\n` : "";
				assert.equal(result.content[0].text, `${outcome === "failed" ? 0 : 1}/1 succeeded\n\n=== Task 1: echo ===\n${status}${reply}`);
				assert.doesNotMatch(result.content[0].text, /Output saved to:|Output file error:/);
				assert.equal(result.isError, undefined);
				if (outcome === "saved") {
					assert.equal(child.savedOutputPath, outputPath);
					assert.equal(fs.readFileSync(outputPath, "utf-8"), reply);
				} else if (outcome === "save error") {
					assert.ok(child.outputSaveError);
				} else {
					assert.equal(child.error, "child failed");
				}
			});
		}
	}

	it("projects mixed file-only failures without leaking truncated replies or BLOCKED handoffs", async () => {
		const reply = "PRIVATE prefix\n" + "private detail\n".repeat(100) + "PRIVATE suffix";
		const blocked = "\n\nBLOCKED: approval needed\nDone: inspected\nRemaining: deploy";
		mockPi.onCall({ output: reply, exitCode: 1, stderr: "plain failure" });
		mockPi.onCall({ output: "success report" });
		mockPi.onCall({ output: blocked });
		const results = [];
		for (const [index, name] of ["failed", "success", "blocked"].entries()) {
			results.push(await runSync(tempDir, [makeAgent("echo")], "echo", name, {
				runId: "mixed-file-only", index, outputPath: path.join(tempDir, `${name}.md`), outputMode: "file-only",
				artifactsDir: path.join(tempDir, "artifacts"), artifactConfig: { enabled: true },
				...(name === "failed" ? { maxOutput: { bytes: 64, lines: 2 } } : {}),
			}));
		}
		const [failed, success, stopped] = results;
		const { aggregateParallelOutputs } = await import("../../src/runs/shared/parallel-utils.ts");
		const text = aggregateParallelOutputs(results.map((child, taskIndex) => ({
			agent: child.agent, taskIndex, exitCode: child.exitCode, error: child.error,
			output: utils.getSingleResultOutput(child),
		})));
		const pointer = `Full reply preserved at ${failed.artifactPaths.outputPath}`;
		assert.equal(failed.finalOutput, pointer);
		assert.equal(failed.truncation, undefined);
		assert.equal(fs.readFileSync(failed.artifactPaths.outputPath, "utf8"), reply);
		assert.equal(failed.savedOutputPath, undefined);
		assert.match(success.finalOutput, /^Output saved to:/);
		assert.equal(stopped.exitCode, 1);
		assert.equal(stopped.error, blocked);
		assert.equal(stopped.finalOutput, blocked);
		assert.equal(text, `=== Parallel Task 1 (echo) ===\nFAILED (exit code 1): plain failure\n${pointer}\n\n=== Parallel Task 2 (echo) ===\n${success.finalOutput}\n\n=== Parallel Task 3 (echo) ===\nFAILED (exit code 1): ${blocked}\n${blocked}`);
		assert.doesNotMatch(text, /PRIVATE|private detail|success report/);
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

function makeExecutorForImpl(cwd: string, agents, captureRuntime) {
	const state = {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundControls: new Map(),
		lastForegroundControlId: null,
	};
	const executor = createSubagentExecutor({
		captureRuntime,
		pi: { events: createEventBus(), getSessionName: () => undefined },
		state,
		resolveConfig: () => ({}),
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
	const makeExecutorFor = (cwd, agents = [makeAgent("echo")]) => makeExecutorForImpl(cwd, agents, mockPi.captureRuntime);
	const createSubagentExecutor = (deps) => executorMod!.createSubagentExecutor({ ...deps, captureRuntime: mockPi.captureRuntime });

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

	for (const terminal of ["normal", "error", "abort", "nonzero", "timeout", "empty", "absent", "invalid-path", "invalid-timeout", "invalid-timeout-zero", "invalid-timeout-fraction", "invalid-timeout-string", "invalid-whitespace"]) {
		it(`forwards teardown configuration on ${terminal}`, { skip: ["empty", "absent", "invalid-path", "invalid-timeout", "invalid-timeout-zero", "invalid-timeout-fraction", "invalid-timeout-string", "invalid-whitespace"].includes(terminal) ? undefined : hookScriptSkip }, async () => {
			const repo = createParallelRepo("pi-teardown-parallel-");
			const hooks = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-hooks-"));
			const record = path.join(hooks, "records.jsonl");
			const hook = path.join(hooks, "hook.cjs");
			fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const p = JSON.parse(fs.readFileSync(0, 'utf8')); if (!fs.existsSync(p.worktreePath) || process.cwd() !== fs.realpathSync(p.worktreePath)) process.exit(9); fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(p)+'\\n'); ${terminal === "nonzero" ? "process.exit(7)" : terminal === "timeout" ? "setInterval(() => {}, 1000)" : ""}\n`);
			if (terminal === "timeout") {
				fs.writeFileSync(hook, `#!/bin/sh\npayload=$(cat)\ncheckout=$(printf '%s' "$payload" | sed 's/.*"worktreePath":"\\([^" ]*\\)".*/\\1/')\n[ -d "$checkout" ] && [ "$(pwd -P)" = "$(cd "$checkout" && pwd -P)" ] || exit 9\nprintf '%s\\n' "$payload" >> '${record}'\nwhile :; do :; done\n`);
			}
			fs.chmodSync(hook, 0o755);
			const controller = new AbortController();
			let pending: Promise<any> | undefined;
			const warnings: string[] = [];
			const originalWrite = fsSink.write;
			if (["nonzero", "timeout"].includes(terminal)) {
				fsSink.write = ((...args) => {
					if (args[0] === 2 && typeof args[1] === "string" && args[1].includes("worktree teardown hook")) {
						warnings.push(args[1]);
						queueMicrotask(() => args.at(-1)(null));
						return;
					}
					return originalWrite(...args);
				}) as typeof fsSink.write;
			}
			try {
				mockPi.onCall(terminal === "abort" ? { delay: 10_000 } : terminal === "error" ? { exitCode: 1, stderr: "teardown-task-error" } : { output: "teardown success" });
				const config = {
					worktreeTeardownHook: terminal === "empty" ? "" : terminal === "absent" ? undefined : terminal === "invalid-path" ? "missing-hook" : terminal === "invalid-whitespace" ? "   " : hook,
					worktreeTeardownHookTimeoutMs: terminal === "invalid-timeout-zero" ? 0 : terminal === "invalid-timeout-fraction" ? 1.5 : terminal === "invalid-timeout-string" ? "bad" : ["empty", "absent", "invalid-timeout"].includes(terminal) ? -1 : terminal === "timeout" ? 1500 : 5000,
				};
				fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
				fs.writeFileSync(path.join(repo, ".pi", "settings.json"), JSON.stringify({ subagents: config }));
				gitIn(repo, ["add", ".pi/settings.json"]);
				gitIn(repo, ["commit", "-m", "configure worktree hooks"]);
				const executor = createSubagentExecutor({
					pi: { events: createEventBus(), getSessionName: () => undefined },
					state: { baseCwd: repo, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
					resolveConfig: resolveExtensionConfig, tempArtifactsDir: repo, getSubagentSessionRoot: () => repo,
					expandTilde: (value: string) => value, discoverAgents: () => ({ agents: [makeAgent("worker")] }),
				});
				pending = executor.execute(`teardown-${terminal}`, { tasks: [{ agent: "worker", task: "Work", count: terminal === "normal" ? 2 : 1, output: "report.md" }], worktree: true }, controller.signal, undefined, makeMinimalCtx(repo));
				if (terminal === "abort") {
					const deadline = Date.now() + 5000;
					while (!(mockPi.callCount() > 0 && gitIn(repo, ["worktree", "list", "--porcelain"]).includes("pi-worktree-"))) {
						assert.ok(Date.now() < deadline, "task must start in a real checkout before abort");
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
					controller.abort();
				}
				const result = await pending;
				if (terminal.startsWith("invalid")) {
					assert.equal(result.isError, true);
					assert.match(result.content[0].text, terminal.startsWith("invalid-timeout") ? /worktree teardown hook timeout must be an integer greater than 0/ : /worktree teardown hook/);
					assert.equal(mockPi.callCount(), 0);
				} else {
					assert.equal(result.isError, undefined);
					assert.equal(result.details.results[0].exitCode === 0, terminal !== "error" && terminal !== "abort");
					if (terminal === "error") assert.match(JSON.stringify(result), /teardown-task-error/);
					if (!["error", "abort"].includes(terminal)) assert.match(JSON.stringify(result), /teardown success/);
				}
				if (terminal === "normal") {
					for (const index of [0, 1]) {
						const runDir = path.join(TEMP_ARTIFACTS_DIR!, result.details.runId);
						assert.match(fs.readFileSync(path.join(runDir, `task-${index}`, "report.md"), "utf8"), /teardown success/);
						assert.equal(fs.existsSync(path.join(runDir, "worktree-diffs", `task-${index}-worker.patch`)), true);
					}
				}
				const records = fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
				const expected = ["empty", "absent", "invalid-path", "invalid-timeout", "invalid-timeout-zero", "invalid-timeout-fraction", "invalid-timeout-string", "invalid-whitespace"].includes(terminal) ? 0 : terminal === "normal" ? 2 : 1;
				assert.equal(records.length, expected);
				assert.deepEqual(records.map((p) => p.index).sort(), Array.from({ length: expected }, (_, i) => i));
				for (const p of records) {
					assert.equal(p.version, 1);
					assert.equal(p.repoRoot, fs.realpathSync(repo));
					assert.equal(p.agentCwd, p.worktreePath);
					assert.equal(p.agent, "worker");
					assert.equal(p.runId, result.details.runId);
					assert.equal(p.baseCommit, gitIn(repo, ["rev-parse", "HEAD"]));
					assert.equal(fs.existsSync(p.worktreePath), false);
					assert.equal(gitIn(repo, ["branch", "--list", p.branch]), "");
				}
				if (["nonzero", "timeout"].includes(terminal)) {
					const cause = terminal === "nonzero" ? /exit\s+code\s+7\b/i : /tim(?:ed?\s*out|eout).*\b1500\s*ms\b/i;
					for (const p of records) {
						assert.ok(warnings.some((warning) => warning.split("\n").some((line) =>
							line.includes(p.worktreePath) && cause.test(line))),
							`missing teardown warning with checkout path and ${terminal} cause: ${warnings.join("")}`);
					}
				}
				assert.doesNotMatch(gitIn(repo, ["worktree", "list", "--porcelain"]), /pi-worktree-/);
			} finally {
				fsSink.write = originalWrite;
				controller.abort();
				await pending?.catch(() => {});
				removeTempDir(repo);
				removeTempDir(hooks);
			}
		});
	}

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

	it("keeps the redirected report file out of the captured worktree patch", { skip: hookScriptSkip }, async () => {
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
				resolveConfig: () => ({ worktreeSetupHook: hookPath }),
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



});

describe("effective cwd settings", { skip: !piAvailable ? "pi packages not available" : hookScriptSkip }, () => {
	let mockPi: MockPi;
	let roots: string[];
	before(() => { mockPi = createMockPi(); mockPi.install(); });
	after(() => mockPi.uninstall());
	beforeEach(() => { mockPi.reset(); roots = []; });
	afterEach(() => { for (const root of roots) removeTempDir(root); });

	function project(name: string, backend = "native") {
		const root = createParallelRepo(`pi-settings-${name}-`);
		roots.push(root);
		fs.mkdirSync(path.join(root, ".pi"));
		fs.writeFileSync(path.join(root, ".pi", "settings.json"), JSON.stringify({ subagents: { executionBackend: backend, worktreeSetupHook: "./setup.cjs", worktreeTeardownHook: "./teardown.cjs", worktreeSetupHookTimeoutMs: 5000, worktreeTeardownHookTimeoutMs: 5000 } }));
		for (const kind of ["setup", "teardown"]) {
			const hook = path.join(root, `${kind}.cjs`);
			fs.writeFileSync(hook, `#!${process.execPath}\nconst fs = require('node:fs'); const p = JSON.parse(fs.readFileSync(0, 'utf8')); fs.appendFileSync(${JSON.stringify(path.join(root, "hooks.jsonl"))}, JSON.stringify({kind: ${JSON.stringify(kind)}, repoRoot: p.repoRoot, index: p.index})+'\\n'); ${kind === "setup" ? "fs.appendFileSync(require('node:path').join(p.worktreePath, 'input.md'), 'hook patch\\n'); console.log('{}');" : ""}\n`);
			fs.chmodSync(hook, 0o755);
		}
		fs.writeFileSync(path.join(root, ".gitignore"), "hooks.jsonl\nsessions/\n");
		gitIn(root, ["add", "-A"]);
		gitIn(root, ["commit", "-m", "configure project settings"]);
		return root;
	}

	function executor(root: string, reads: string[]) {
		return createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: (cwd: string) => { reads.push(cwd); return resolveExtensionConfig(cwd); },
			tempArtifactsDir: root, getSubagentSessionRoot: () => path.join(root, "sessions"),
			expandTilde: (value: string) => value, discoverAgents: () => ({ agents: [makeAgent("worker")] }),
		});
	}

	it("reuses single call settings and resolves mixed parallel and chain leaves before backend selection", async () => {
		const a = project("a");
		const b = project("b", "missing-settings-backend");
		const reads: string[] = [];
		const run = executor(a, reads);
		const execute = (params) => run.execute("settings", { async: false, ...params }, new AbortController().signal, undefined, makeMinimalCtx(a));
		mockPi.onCall({ echoCwd: true });
		const single = await execute({ cwd: a, agent: "worker", task: "Work" });
		assert.equal(single.isError, undefined);
		assert.match(JSON.stringify(single), new RegExp(a));
		assert.deepEqual(reads.splice(0), [a]);
		const other = await execute({ cwd: b, agent: "worker", task: "Work" });
		assert.match(JSON.stringify(other), /missing-settings-backend.*not registered/);
		assert.deepEqual(reads.splice(0), [b]);
		mockPi.onCall({ echoCwd: true });
		const parallel = await execute({ tasks: [{ agent: "worker", task: "Work", cwd: a }, { agent: "worker", task: "Work", cwd: b }] });
		assert.equal(parallel.details.results[0].exitCode, 0);
		assert.match(parallel.details.results[1].error, /missing-settings-backend.*not registered/);
		assert.deepEqual(reads.splice(0), [a, a, b]);
		const chain = await execute({ chain: [{ agent: "worker", task: "Work", cwd: b }] });
		assert.match(JSON.stringify(chain), /missing-settings-backend.*not registered/);
		assert.deepEqual(reads, [a, b]);
	});

	it("non-worktree group resolves settings only at task cwd", async () => {
		const a = project("call");
		const group = project("group");
		const task = project("task");
		fs.writeFileSync(path.join(group, ".pi", "settings.json"), JSON.stringify({ subagents: { executionBackend: 42 } }));
		const reads: string[] = [];
		mockPi.onCall({ output: "done" });
		mockPi.onCall({ output: "done" });
		const result = await executor(a, reads).execute("group", {
			async: false,
			chain: [{ parallel: [{ agent: "worker", task: "Work", cwd: task }, { agent: "worker", task: "Work", cwd: task }], cwd: group }],
		}, new AbortController().signal, undefined, makeMinimalCtx(a));
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.equal(result.details.results.length, 2);
		assert.ok(result.details.results.every((result) => result.exitCode === 0));
		assert.equal(reads.includes(group), false);
	});

	it("resolves settings at the interpolated group cwd before the clean-tree check rejects a staged materialized tree", async () => {
		const a = project("source");
		const b = project("target");
		const reads: string[] = [];
		mockPi.onCall({ output: b });
		mockPi.onCall({ output: "done" });
		mockPi.onCall({ output: "done" });
		const result = await executor(a, reads).execute("group", {
			async: false,
			chain: [{ parallel: [{ agent: "worker", task: "Select project", as: "target", output: false }], cwd: b, worktree: true }, { parallel: [{ agent: "worker", task: "Work" }, { agent: "worker", task: "Work" }], cwd: "{outputs.target.treePath}", worktree: true }],
		}, new AbortController().signal, undefined, makeMinimalCtx(a));
		assert.equal(result.isError, true, JSON.stringify(result));
		assert.match(result.content[0].text, /worktree isolation requires a clean git working tree/);
		assert.equal(result.details.results.length, 1);
		assert.equal(fs.existsSync(path.join(a, "hooks.jsonl")), false);
		const records = fs.readFileSync(path.join(b, "hooks.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((r) => r.kind), ["setup", "teardown"]);
		assert.ok(records.every((r) => r.repoRoot === fs.realpathSync(b) && r.index === 0));
		assert.deepEqual(reads.slice(0, 2), [a, b]);
		assert.match(reads[3], /worktree-trees/);
		assert.equal(reads[3], result.details.outputs.target.treePath);
		assert.equal(reads.length, 4);
	});
});
