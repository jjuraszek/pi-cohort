/**
 * Integration tests for chain execution (sequential and parallel steps).
 *
 * Uses the local createMockPi() harness to simulate subagent processes.
 * Tests the full chain pipeline: template resolution → spawn → output capture
 * → {previous} passing.
 *
 * Requires pi packages to be importable. Skips gracefully if unavailable.
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
	createEventBus,
	removeTempDir,
	makeAgent,
	makeMinimalCtx,
	makeParentSessionCtx,
	tryImport,
	events,
} from "../support/helpers.ts";

interface TestSequentialStep {
	stopOn?: { path: string; in: string[] };
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

interface TestParallelTask {
	agent: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: Record<string, unknown>;
	model?: string;
	output?: string | false;
	outputMode?: "inline" | "file-only";
	reads?: string[] | false;
	skill?: string | string[] | false;
	progress?: boolean;
	cwd?: string;
	acceptance?: unknown;
}

type TestChainStep = TestSequentialStep | {
	parallel: TestParallelTask[];
	concurrency?: number;
	stopOn?: { path: string; in: string[] };
	failFast?: boolean;
	worktree?: boolean;
	cwd?: string;
} | {
	expand: {
		from: { output: string; path: string };
		item?: string;
		key?: string;
		maxItems?: number;
		onEmpty?: "skip" | "fail";
	};
	parallel: TestParallelTask;
	collect: { as: string; outputSchema?: Record<string, unknown> };
	concurrency?: number;
	stopOn?: { path: string; in: string[] };
	failFast?: boolean;
	label?: string;
	acceptance?: unknown;
};

interface ChainResultItem {
	outputSaveError?: string;
	agent: string;
	exitCode: number;
	finalOutput?: string;
	structuredOutput?: unknown;
	task?: string;
	attemptedModels?: string[];
	skills?: string[];
	acceptance?: { status?: string; verifyRuns?: Array<{ status?: string }>; childReport?: unknown; runtimeChecks?: Array<{ status?: string; id?: string }> };
}

interface ChainExecutionResult {
	isError?: boolean;
	content: Array<{ text: string }>;
	details: {
		results: ChainResultItem[];
		chainAgents?: string[];
		totalSteps?: number;
		workflowGraph?: {
			nodes: Array<{ kind?: string; outputName?: string; status?: string; error?: string; acceptanceStatus?: string; children?: Array<{ itemKey?: string; label?: string; status?: string; acceptanceStatus?: string }> }>;
		};
		currentStepIndex?: number;
		stop?: unknown;
		outputs?: Record<string, { text: string; structured?: unknown; patchPath?: string; treePath?: string; taskIndex?: number; baseCommit?: string; repoCwd?: string }>;
	};
}

interface ChainExecutionModule {
	executeChain(params: Record<string, unknown>): Promise<ChainExecutionResult>;
}

const chainMod = await tryImport<ChainExecutionModule>("./src/runs/foreground/chain-execution.ts");
const available = !!chainMod;
const executeChain = chainMod?.executeChain;

describe("chain execution — sequential", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;
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
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runtime: mockPi.runtime,
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	function acceptanceReport(overrides: Record<string, unknown> = {}): string {
		return [
			"done",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "integration test evidence" }],
				changedFiles: ["src/a.ts"],
				testsAddedOrUpdated: ["test/a.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
				validationOutput: ["validation passed"],
				residualRisks: [],
				noStagedFiles: true,
				notes: "complete",
				...overrides,
			}),
			"```",
		].join("\n");
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

	it("runs a 2-step chain", async () => {
		mockPi.onCall({ output: "Analysis complete: found 3 issues" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze the code" }, { agent: "reporter" }],
				agents,
				{ onUpdate(update: ChainExecutionResult) { assert.ok(update.details.results.length > 0, "updates come from child execution, not step boundaries"); } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.equal(result.details.results[0].agent, "analyst");
		assert.equal(result.details.results[1].agent, "reporter");
	});

	for (const outputMode of [undefined, "inline"] as const) {
		for (const saveError of [false, true]) {
			it(`passes exact raw inline reply through {previous} (${outputMode ?? "unset"}, save ${saveError ? "error" : "success"})`, async () => {
				const reply = "Complete analysis\nwith details";
				const parent = path.join(tempDir, "reports");
				if (saveError) fs.writeFileSync(parent, "not a directory");
				const outputPath = path.join(parent, "analysis.md");
				mockPi.onCall({ output: reply });
				const result = await executeChain(makeChainParams(
					[
						{ agent: "analyst", task: "Analyze", output: outputPath, outputMode },
						{ agent: "reporter", task: "{previous}", acceptance: { level: "none", reason: "test: isolate previous output" } },
					],
					[makeAgent("analyst"), makeAgent("reporter")],
					{ chainDir: tempDir },
				));
				assert.ok(!result.isError, JSON.stringify(result.content));
				assert.equal(result.details.results[0].finalOutput, reply);
				const secondTaskArg = readCallArgs(1).at(-1) ?? "";
				assert.equal(secondTaskArg, `Task: ${reply}`);
				assert.doesNotMatch(secondTaskArg, /Output saved to:|Output file error:/);
				if (saveError) {
					assert.ok(result.details.results[0].outputSaveError);
				} else {
					assert.equal(fs.readFileSync(outputPath, "utf-8"), reply);
				}
			});
		}
	}

	it("passes file-only save-error pointers through {previous}", async () => {
		const parent = path.join(tempDir, "blocker");
		fs.writeFileSync(parent, "not a directory");
		mockPi.onCall({ output: "PRIVATE chain reply" });
		const result = await executeChain(makeChainParams([
			{ agent: "analyst", task: "Analyze", output: path.join(parent, "report.md"), outputMode: "file-only" },
			{ agent: "reporter", task: "{previous}", acceptance: { level: "none", reason: "isolate previous" } },
		], [makeAgent("analyst"), makeAgent("reporter")], { chainDir: tempDir, artifactConfig: { enabled: true } }));
		const first = result.details.results[0] as any;
		const expected = `Output file error: ${path.join(parent, "report.md")}\n${first.outputSaveError}\n\nFull reply preserved at ${first.artifactPaths.outputPath}`;
		assert.equal(first.exitCode, 0);
		assert.equal(first.finalOutput, expected);
		assert.equal(readCallArgs(1).at(-1), `Task: ${expected}`);
		assert.equal(fs.readFileSync(first.artifactPaths.outputPath, "utf8"), "PRIVATE chain reply");
	});

	for (const shape of ["sequential", "parallel", "blocked"] as const) {
		it(`keeps failed ${shape} chain summaries unchanged`, async () => {
			const blocked = "\n\nBLOCKED: approval needed\nDone: inspected\nRemaining: deploy";
			mockPi.onCall({ output: shape === "blocked" ? blocked : "PRIVATE failed reply", exitCode: shape === "blocked" ? 0 : 1, stderr: shape === "blocked" ? "" : "plain failure" });
			const step = { agent: "analyst", task: "Analyze", output: "report.md", outputMode: "file-only" as const };
			const chain = shape === "parallel" ? [{ parallel: [step] }] : [step];
			const result = await executeChain(makeChainParams(chain, [makeAgent("analyst")], { runId: "failed-chain", chainDir: tempDir, artifactConfig: { enabled: true } }));
			const first = result.details.results[0] as any;
			const error = shape === "blocked" ? blocked : "plain failure";
			assert.equal(first.exitCode, 1);
			assert.equal(first.error, error);
			assert.equal(first.finalOutput, shape === "blocked" ? blocked : `Full reply preserved at ${first.artifactPaths.outputPath}`);
			const { buildChainSummary } = await import("../../src/shared/formatters.ts");
			assert.equal(result.content[0].text, buildChainSummary(chain, result.details.results, path.join(tempDir, "failed-chain"), "failed", {
				index: 0, error: shape === "parallel" ? "Parallel step 1 failed:\n- Task 1 (analyst): plain failure" : error,
			}));
			assert.doesNotMatch(result.content[0].text, /PRIVATE|Full reply preserved at/);
		});
	}

	it("passes file-only saved-output references through {previous}", async () => {
		mockPi.onCall({ output: "full chain output\nwith details" });
		const agents = [makeAgent("analyst"), makeAgent("reporter")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "analyst", task: "Analyze", output: "analysis.md", outputMode: "file-only" },
					{ agent: "reporter" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full chain output/);
		const secondTaskArg = readCallArgs(1).at(-1) ?? "";
		assert.match(secondTaskArg, /Output saved to:/);
		assert.match(secondTaskArg, /2 lines/);
		assert.doesNotMatch(secondTaskArg, /full chain output/);
	});

	it("persists explicit checked acceptance and rejects missing evidence", async () => {
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
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", output: "accepted.md", outputMode: "file-only", acceptance: { level: "checked", criteria: ["Patch bug"] } }],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.match(result.details.results[0]?.finalOutput ?? "", /Output saved to:/);
		assert.equal(result.details.results[0]?.acceptance?.status, "checked");
		assert.ok(result.details.results[0]?.acceptance?.childReport);

		mockPi.onCall({
			output: [
				"implemented",
				"```acceptance-report",
				JSON.stringify({
					criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
					changedFiles: ["src/file.ts"],
					commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
					residualRisks: [],
					noStagedFiles: true,
				}),
				"```",
			].join("\n"),
		});

		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "checked" } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.match(failed.details.results[0]?.error ?? "", /tests-added evidence missing/);
	});

	it("runs explicit verified acceptance commands and does not trust child command claims as verification", async () => {
		const acceptanceReport = [
			"implemented",
			"```acceptance-report",
			JSON.stringify({
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "patched" }],
				changedFiles: ["src/file.ts"],
				testsAddedOrUpdated: ["test/file.test.ts"],
				commandsRun: [{ command: "npm test", result: "passed", summary: "child claimed pass" }],
				validationOutput: ["child output"],
				residualRisks: [],
				noStagedFiles: true,
			}),
			"```",
		].join("\n");
		mockPi.onCall({ output: acceptanceReport });
		const agents = [makeAgent("worker", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-pass", command: "node -e \"process.exit(0)\"" }] } }],
				agents,
			),
		);
		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0]?.acceptance?.status, "verified");
		assert.equal(result.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "passed");

		mockPi.onCall({ output: acceptanceReport });
		const failed = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Implement fix", acceptance: { level: "verified", verify: [{ id: "runtime-fail", command: "node -e \"process.exit(5)\"" }] } }],
				agents,
			),
		);
		assert.equal(failed.isError, true);
		assert.equal(failed.details.results[0]?.acceptance?.status, "rejected");
		assert.equal(failed.details.results[0]?.acceptance?.verifyRuns?.[0]?.status, "failed");
		assert.match(failed.details.results[0]?.error ?? "", /runtime-fail/);
	});

	it("stops a sequential chain on blocker output and keeps the full decision", async () => {
		const blocked = "BLOCKED: choose the migration\nDone: inspected schema\nRemaining: migrate";
		mockPi.onCall({ output: blocked });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams([{ agent: "step1", task: "Implement migration" }, { agent: "step2", task: "Continue" }], agents),
		);

		assert.equal(result.isError, true);
		assert.equal(result.details.results.length, 1);
		assert.equal(result.details.results[0]?.exitCode, 1);
		assert.equal(result.details.results[0]?.finalOutput, blocked);
		assert.match(result.content[0]?.text ?? "", /BLOCKED: choose the migration/);
		assert.match(result.content[0]?.text ?? "", /Done: inspected schema/);
		assert.match(result.content[0]?.text ?? "", /Remaining: migrate/);
		assert.equal(mockPi.callCount(), 1);
	});

	it("stops after a blocked child in a parallel chain step", async () => {
		const blocked = "BLOCKED: choose a target\nDone: compared\nRemaining: decide";
		mockPi.onCall({ output: blocked });
		mockPi.onCall({ output: "Sibling completed" });
		const result = await executeChain(makeChainParams([
			{ parallel: [{ agent: "blocked", task: "Implement" }, { agent: "sibling", task: "Review" }] },
			{ agent: "later", task: "Must not run" },
		], [makeAgent("blocked"), makeAgent("sibling"), makeAgent("later")]));

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /BLOCKED: choose a target/);
		assert.equal(result.details.results.length, 2);
		assert.ok(result.details.results.some((item) => item.finalOutput === blocked));
		assert.ok(result.details.results.some((item) => item.finalOutput === "Sibling completed"));
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries chain steps with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "provider unavailable",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Step 1 recovered" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [
			makeAgent("step1", { model: "openai/gpt-5-mini", fallbackModels: ["anthropic/claude-sonnet-4"] }),
			makeAgent("step2"),
		];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
		assert.deepEqual(result.details.results[0].attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(mockPi.callCount(), 3);
	});

	it("prefers the parent session provider for ambiguous bare chain step models", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		mockPi.onCall({ output: "Step 2 ran" });
		const agents = [makeAgent("step1", { model: "gpt-5-mini" }), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { agent: "step2" }],
				agents,
				{
					ctx: {
						...makeMinimalCtx(tempDir),
						model: { provider: "github-copilot" },
						modelRegistry: {
							getAvailable: () => [
								{ provider: "openai", id: "gpt-5-mini" },
								{ provider: "github-copilot", id: "gpt-5-mini" },
							],
						},
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.details.results[0].attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("sequential and parallel-in-chain steps inherit the parent session model and thinking", async () => {
		mockPi.onCall({ output: "Step 1 ran" });
		mockPi.onCall({ output: "Parallel a ran" });
		mockPi.onCall({ output: "Parallel b ran" });
		const agents = [makeAgent("step1"), makeAgent("pa"), makeAgent("pb")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do step 1" }, { parallel: [{ agent: "pa", task: "a" }, { agent: "pb", task: "b" }] }],
				agents,
				{ ctx: makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "low") },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results[0].model, "github-copilot/gpt-6:low");
		for (const index of [0, 1, 2]) {
			const args = readCallArgs(index);
			assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6:low");
		}
	});

	it("suppresses progress for {task} chain templates when the top-level task is review-only", async () => {
		mockPi.onCall({ output: "Review done" });
		const agents = [makeAgent("reviewer", { defaultProgress: true })];

		await executeChain(
			makeChainParams(
				[{ agent: "reviewer" }],
				agents,
				{ task: "Review-only. Do not edit files. Return findings." },
			),
		);

		const taskArg = readCallArgs(0).at(-1) ?? "";
		assert.doesNotMatch(taskArg, /progress\.md/);
		assert.equal(fs.existsSync(path.join(tempDir, "progress.md")), false);
	});

	it("passes {previous} between steps (step 2 receives step 1 output)", async () => {
		mockPi.onCall({ output: "Step 1 unique output: MARKER_ABC_123" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Produce output" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const step2Task = result.details.results[1].task;
		assert.ok(
			step2Task.includes("MARKER_ABC_123"),
			`step 2 task should contain step 1 output via {previous}: ${step2Task.slice(0, 200)}`,
		);
	});

	it("passes named sequential outputs through {outputs.name}", async () => {
		mockPi.onCall({ output: "Context marker: CTX_123" });
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("context"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "context", task: "Gather context", as: "contextOutput" },
					{ agent: "writer", task: "Use {outputs.contextOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.match(readCallArgs(1).at(-1) ?? "", /CTX_123/);
		assert.equal(result.details.workflowGraph?.nodes[0]?.outputName, "contextOutput");
	});

	it("expands structured named output into dynamic parallel children and collects results", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ output: "synthesized" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
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
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 4);
		assert.match(readCallArgs(1).at(-1) ?? "", /Review src\/a\.ts/);
		assert.match(readCallArgs(2).at(-1) ?? "", /Review src\/b\.ts/);
		assert.match(readCallArgs(3).at(-1) ?? "", /"key":"src\/a\.ts"/);
		const collected = result.details.outputs?.reviews?.structured as Array<{ key: string; structured: unknown }>;
		assert.deepEqual(collected.map((item) => item.key), ["src/a.ts", "src/b.ts"]);
		assert.deepEqual(collected.map((item) => item.structured), [{ ok: "a" }, { ok: "b" }]);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.kind, "dynamic-parallel-group");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("persists checked acceptance status for dynamic fanout materialized children and aggregate group", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/a.ts"] }), structuredOutput: { ok: "a" }, requireAcceptanceStructuredOrder: true });
		mockPi.onCall({ output: acceptanceReport({ changedFiles: ["src/b.ts"] }), structuredOutput: { ok: "b" }, requireAcceptanceStructuredOrder: true });
		const agents = [makeAgent("scout"), makeAgent("reviewer", { completionGuard: false })];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" }, acceptance: { level: "checked" } },
						collect: { as: "reviews" },
						acceptance: { level: "checked" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		const dynamicNode = result.details.workflowGraph?.nodes[1];
		assert.equal(dynamicNode?.acceptanceStatus, "checked");
		assert.deepEqual(dynamicNode?.children?.map((child) => child.acceptanceStatus), ["checked", "checked"]);
	});

	it("preserves collected dynamic output when a child fails", async () => {
		mockPi.onCall({
			output: "targets",
			structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
		});
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ exitCode: 1, stderr: "review-b failed" });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 3);
		assert.equal((result.details.outputs?.reviews?.structured as unknown[]).length, 2);
		assert.equal(result.details.results.some((entry) => entry.exitCode === 1), true);
	});

	it("fails dynamic fanout before spawning children for invalid source arrays", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "a" }, { path: "b" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 1 },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /exceeding maxItems 1/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /exceeding maxItems 1/);
	});

	it("marks dynamic file-only validation failures as failed graph groups before spawning children", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputMode: "file-only" },
						collect: { as: "reviews" },
					},
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 1);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /outputMode: "file-only"/);
	});

	it("marks empty dynamic fanout skip as a completed graph group", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [] } });
		mockPi.onCall({ output: "used empty reviews" });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4, onEmpty: "skip" },
						parallel: { agent: "reviewer", task: "Review {item.path}" },
						collect: { as: "reviews" },
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(mockPi.callCount(), 2);
		assert.deepEqual(result.details.outputs?.reviews?.structured, []);
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "completed");
		assert.deepEqual(result.details.workflowGraph?.nodes[1]?.children, []);
	});

	it("marks dynamic collect schema failures as failed graph groups", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		const agents = [makeAgent("scout"), makeAgent("reviewer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews", outputSchema: { type: "object" } },
					},
				],
				agents,
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /Collected output validation failed/);
		assert.ok(Array.isArray(result.details.outputs?.reviews?.structured));
		assert.equal(result.details.workflowGraph?.nodes[1]?.status, "failed");
		assert.match(result.details.workflowGraph?.nodes[1]?.error ?? "", /Collected output validation failed/);
		assert.equal(result.details.workflowGraph?.nodes[1]?.children?.[0]?.status, "completed");
	});

	it("keeps materialized dynamic children in live graph updates for later sequential steps", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "review-a", structuredOutput: { ok: "a" } });
		mockPi.onCall({ output: "review-b", structuredOutput: { ok: "b" } });
		mockPi.onCall({ steps: [{ jsonl: [events.assistantMessage("writer started")] }] });
		const agents = [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")];
		let writerUpdateChildren: Array<{ itemKey?: string; status?: string }> | undefined;

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
						concurrency: 1,
					},
					{ agent: "writer", task: "Use {outputs.reviews}" },
				],
				agents,
				{
					onUpdate(update: { details?: ChainExecutionResult["details"] }) {
						if (update.details?.currentStepIndex !== 2) return;
						writerUpdateChildren = update.details.workflowGraph?.nodes[1]?.children;
					},
				},
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(writerUpdateChildren?.map((child) => child.itemKey), ["src/a.ts", "src/b.ts"]);
	});

	it("fails duplicate and unknown named outputs before spawning children", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];

		const duplicate = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "A", as: "same" }, { agent: "b", task: "B", as: "same" }],
				agents,
			),
		);
		assert.equal(duplicate.isError, true);
		assert.match(duplicate.content[0]?.text ?? "", /Duplicate chain output name 'same'/);
		assert.equal(mockPi.callCount(), 0);

		const unknown = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.missing}" }],
				agents,
			),
		);
		assert.equal(unknown.isError, true);
		assert.match(unknown.content[0]?.text ?? "", /Unknown chain output reference/);
		assert.equal(mockPi.callCount(), 0);

		const malformed = await executeChain(
			makeChainParams(
				[{ agent: "b", task: "Use {outputs.bad-name}" }],
				agents,
			),
		);
		assert.equal(malformed.isError, true);
		assert.match(malformed.content[0]?.text ?? "", /Invalid chain output reference '\{outputs\.bad-name\}'/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("requires schema-valid structured_output when outputSchema is set", async () => {
		const schema = {
			type: "object",
			required: ["ok"],
			properties: { ok: { type: "boolean" }, note: { type: "string" } },
		};
		mockPi.onCall({ output: "prose", structuredOutput: { ok: true, note: "captured" } });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.results[0]?.structuredOutput, { ok: true, note: "captured" });

		mockPi.reset();
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("prose only")] },
			{ jsonl: [events.assistantMessage("still no call"), { type: "agent_settled", aborted: false }] },
		] });
		const missing = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.equal(missing.isError, true);
		assert.match(missing.details.results[0]?.error ?? "", /Missing structured_output call/);
		assert.equal(missing.details.results[0]?.structuredOutput, undefined);
		assert.equal(mockPi.callCount(), 1);

		mockPi.reset();
		mockPi.onCall({ steps: [
			{ structuredOutputError: "Expected boolean at /ok", jsonl: [
				events.assistantMessage("invalid"),
				{ type: "agent_settled", aborted: false },
			] },
		] });
		const invalid = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema, phase: "Validate", label: "Structured worker", as: "result" }], agents),
		);
		assert.equal(invalid.isError, true);
		assert.match(invalid.details.results[0]?.error ?? "", /Structured output validation failed/);
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.status, "failed");
		assert.equal(invalid.details.workflowGraph?.nodes[0]?.outputName, "result");
		assert.match(invalid.details.workflowGraph?.nodes[0]?.error ?? "", /Structured output validation failed/);
		assert.equal(invalid.details.results[0]?.structuredOutput, undefined);
		assert.equal(mockPi.callCount(), 1);

		mockPi.reset();
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("prose before follow-up")] },
			{ structuredOutputError: "Expected boolean at /ok", jsonl: [{ type: "agent_settled", aborted: false }] },
		] });
		const invalidFollowUp = await executeChain(
			makeChainParams([{ agent: "worker", task: "Return structured", outputSchema: schema }], agents),
		);
		assert.equal(invalidFollowUp.isError, true);
		assert.equal(invalidFollowUp.details.results[0]?.error, "Structured output validation failed: Expected boolean at /ok");
		assert.equal(invalidFollowUp.details.results[0]?.structuredOutput, undefined);
		assert.equal(mockPi.callCount(), 1);
	});

	for (const scenario of [
		{ name: "sequential status", parallel: false, value: { status: "DONE" } },
		{ name: "sequential envelope-shaped value", parallel: false, value: { status: "success", value: { status: "DONE" } } },
		{ name: "parallel status", parallel: true, value: { status: "DONE" } },
	]) {
		it(`passes delayed structured ${scenario.name} to a named-output consumer`, async () => {
			mockPi.onCall({ steps: [
				{ jsonl: [events.assistantMessage("Review report before capture")] },
				{ delay: 1500, structuredOutput: scenario.value, jsonl: [{ type: "agent_settled", aborted: false }] },
			] });
			mockPi.onCall({ output: "Consumed review" });
			const review = {
				agent: "reviewer", task: "Review", as: "review",
				outputSchema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
			};
			const result = await executeChain(makeChainParams([
				scenario.parallel ? { parallel: [review] } : review,
				{ agent: "writer", task: "Use {outputs.review}" },
			], [makeAgent("reviewer"), makeAgent("writer")]));

			assert.ok(!result.isError, JSON.stringify(result.content));
			assert.equal(mockPi.callCount(), 2);
			assert.deepEqual(result.details.results[0]?.structuredOutput, scenario.value);
			assert.equal(result.details.results[0]?.finalOutput, "Review report before capture");
			assert.equal(result.details.outputs?.review?.text, JSON.stringify(scenario.value));
			assert.equal(result.details.results[1]?.task?.split("\n")[0], `Use ${JSON.stringify(scenario.value)}`);
		});
	}

	it("substitutes {task} in templates", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Review {task} carefully" }],
				agents,
				{ task: "the authentication module" },
			),
		);

		assert.ok(!result.isError);
		const workerTask = result.details.results[0].task;
		assert.ok(
			workerTask.includes("the authentication module"),
			`should substitute {task}: ${workerTask.slice(0, 200)}`,
		);
	});

	it("creates and uses chain_dir", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Write to {chain_dir}" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		const summary = result.content[0].text;
		assert.ok(summary.includes("✅ Chain completed:"), `missing completion marker: ${summary}`);
		assert.ok(summary.includes("📁 Artifacts:"), `missing artifacts marker: ${summary}`);
	});

	it("stops chain on step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Agent crashed" });
		const agents = [makeAgent("step1"), makeAgent("step2")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "step1", task: "Do first thing" }, { agent: "step2" }],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail");
		assert.equal(result.details.results.length, 1, "only step1 should have run");
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("runs a 3-step chain end-to-end", async () => {
		mockPi.onCall({ output: "Step output" });
		const agents = [makeAgent("scout"), makeAgent("planner"), makeAgent("executor")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Survey the codebase" },
					{ agent: "planner" },
					{ agent: "executor" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		assert.ok(result.details.results.every((r) => r.exitCode === 0));
	});

	it("returns error for unknown agent in chain", async () => {
		const agents = [makeAgent("scout")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "scout", task: "Start" }, { agent: "nonexistent" }],
				agents,
			),
		);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Unknown agent"));
	});

	it("resolves relative step cwd values against the chain cwd for skills", async () => {
		mockPi.onCall({ output: "ok" });
		const chainCwd = path.join(tempDir, "worktree");
		const stepPackageDir = path.join(chainCwd, "packages", "app");
		writePackageSkill(stepPackageDir, "chain-step-skill");
		const agents = [makeAgent("analyst", { skills: ["chain-step-skill"] })];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "analyst", task: "Analyze", cwd: "packages/app" }],
				agents,
				{ cwd: chainCwd },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.deepEqual(result.details.results[0]?.skills, ["chain-step-skill"]);
	});

	it("tracks chain metadata (chainAgents, totalSteps)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[{ agent: "a", task: "Start" }, { agent: "b" }],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.deepEqual(result.details.chainAgents, ["a", "b"]);
		assert.equal(result.details.totalSteps, 2);
	});

	it("uses custom chainDir when provided", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("worker")];
		const customChainDir = path.join(tempDir, "my-chain");

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Use {chain_dir}" }],
				agents,
				{ chainDir: customChainDir },
			),
		);

		assert.ok(!result.isError);
		assert.ok(fs.existsSync(customChainDir), "custom chainDir should exist");
	});

	it("tightens child recursion depth per agent without relaxing the inherited chain max", async () => {
		const originalDepth = process.env.PI_SUBAGENT_DEPTH;
		const originalMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
			const agents = [makeAgent("worker", { maxSubagentDepth: 1 })];

			const result = await executeChain(
				makeChainParams(
					[{ agent: "worker", task: "Inspect env" }],
					agents,
					{ maxSubagentDepth: 3 },
				),
			);

			assert.ok(!result.isError);
			assert.deepEqual(JSON.parse(result.details.results[0].finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (originalDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = originalDepth;
			if (originalMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = originalMaxDepth;
		}
	});
});

describe("chain execution — parallel steps", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runtime: mockPi.runtime,
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir: path.join(tempDir, "artifacts"),
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	it("applies parallel cwd defaults with task overrides and run fallback", async () => {
		for (const name of ["group", "leaf"]) fs.mkdirSync(path.join(tempDir, name));
		for (let i = 0; i < 3; i++) mockPi.onCall({ echoCwd: true });
		const result = await executeChain(makeChainParams([
			{ parallel: [{ agent: "reviewer", task: "default" }, { agent: "reviewer", task: "override", cwd: "leaf" }], cwd: "group", concurrency: 1 },
			{ parallel: [{ agent: "reviewer", task: "fallback" }] },
		], [makeAgent("reviewer")]));
		assert.ok(!result.isError, result.content[0].text);
		assert.deepEqual(result.details.results.map((r) => JSON.parse(r.finalOutput!.trim()).cwd), [path.join(tempDir, "group"), path.join(tempDir, "leaf"), tempDir].map((dir) => fs.realpathSync(dir)));
	});

	for (const ending of ["normal", "stop", "failFast", "throw", "corrupt", "absent", "sequentialAbsent", "dynamic", "attested", "checked"]) {
		it(`runs output trees and cleans up on ${ending}`, { skip: process.platform === "win32" }, async () => {
			const repoDir = path.join(tempDir, "repo");
			fs.mkdirSync(path.join(repoDir, "nested"), { recursive: true });
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" }).toString().trim();
			git("init");
			git("config", "user.email", "tests@example.com");
			git("config", "user.name", "Tree Tests");
			fs.writeFileSync(path.join(repoDir, "nested", "input.md"), "input\n");
			git("add", "-A");
			git("commit", "-m", "initial");
			const baseCommit = git("rev-parse", "HEAD");
			const hook = path.join(tempDir, "hook.sh");
			const absent = ending === "absent" || ending === "sequentialAbsent";
			fs.writeFileSync(hook, '#!/bin/sh\ncat > /dev/null\n' + (absent ? "" : 'echo patched >> nested/input.md\n') + 'echo "{}"\n');
			fs.chmodSync(hook, 0o755);
			const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
			const report = "```acceptance-report\n" + JSON.stringify({ criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "reviewed" }], changedFiles: [], testsAddedOrUpdated: [], commandsRun: [{ command: "review", result: "passed", summary: "reviewed" }], validationOutput: ["reviewed"], residualRisks: [], noStagedFiles: true, notes: "done" }) + "\n```";
			mockPi.onCall({ output: "implemented", structuredOutput: { items: ["a", "b"] } });
			if (ending === "corrupt") mockPi.onCall({ output: "inspect captured patch" });
			const acceptance = ending === "attested" || ending === "checked";
			mockPi.onCall(absent || ending === "corrupt" ? { output: "sibling finished" } : acceptance
				? { output: report, structuredOutput: { verdict: "PASS" }, requireAcceptanceStructuredOrder: true }
				: { echoCwd: true, echoFiles: ["nested/input.md"], structuredOutput: ending === "stop" ? { verdict: "FAIL" } : undefined });
			mockPi.onCall({ echoCwd: true, structuredOutput: ending === "stop" ? { verdict: "PASS" } : undefined });
			mockPi.onCall({ echoCwd: true });
			const treeRef = "{outputs.impl_1.treePath}";
			const reviewer: TestParallelTask = { agent: "reviewer", task: "Review " + treeRef, as: "review", ...(ending === "stop" || acceptance ? { outputSchema: schema } : {}), ...(acceptance ? { acceptance: { level: ending } } : {}) };
			let consumers: TestChainStep[] = [
				{ parallel: [reviewer, { agent: "reviewer", task: "copy", ...(ending === "stop" ? { outputSchema: schema } : {}) }], cwd: treeRef, concurrency: 1, ...(ending === "stop" ? { stopOn: { path: "/verdict", in: ["FAIL"] } } : {}) },
				{ agent: "reviewer", task: "Reuse " + treeRef, cwd: treeRef },
			];
			if (ending === "failFast") consumers = [{ parallel: [reviewer, { agent: "reviewer", task: "bad", cwd: path.join(tempDir, "missing") }, { agent: "reviewer", task: "skipped" }], cwd: treeRef, concurrency: 1, failFast: true }];
			if (ending === "corrupt" || absent) consumers = ending === "sequentialAbsent"
				? [{ agent: "reviewer", task: "review", cwd: treeRef }]
				: [{ parallel: [{ agent: "reviewer", task: "bad", cwd: treeRef }, { agent: "reviewer", task: "sibling" }], concurrency: 1 }];
			if (ending === "corrupt") consumers.unshift({ agent: "reviewer", task: "Inspect captured patch" });
			if (ending === "dynamic") consumers = [{ expand: { from: { output: "impl_1", path: "/items" }, maxItems: 2 }, parallel: { agent: "reviewer", task: "Review {item}", cwd: treeRef }, collect: { as: "reviews" }, concurrency: 1 }];
			let observedTree: string | undefined;
			let corrupted = false;
			const promise = executeChain(makeChainParams([
				{ parallel: [{ agent: "impl", task: "edit", as: "impl_1", outputSchema: { type: "object" } }], worktree: true },
				...consumers,
			], [makeAgent("impl", { completionGuard: false }), makeAgent("reviewer")], {
				cwd: path.join(repoDir, "nested"), ctx: makeMinimalCtx(repoDir), worktreeSetupHook: hook,
				chainDir: path.join(fs.realpathSync(tempDir), "chain"),
				sessionDirForIndex: (index: number) => {
					if (ending === "throw" && index === 3) {
						assert.ok(observedTree, "tree observed before the following child is prepared");
						throw new Error("boundary failure");
					}
					return undefined;
				},
				onUpdate: (update: ChainExecutionResult) => {
					const producer = update.details.outputs?.impl_1;
					if (ending === "corrupt" && producer?.patchPath && !corrupted) { fs.writeFileSync(producer.patchPath, "invalid patch\n"); corrupted = true; }
					if (producer?.treePath) {
						observedTree = producer.treePath;
						assert.ok(fs.existsSync(observedTree));
					}
				},
			}));
			let result: ChainExecutionResult | undefined;
			try {
				if (ending === "throw") await assert.rejects(promise, /boundary failure/);
				else result = await promise;
			} finally {
				assert.doesNotMatch(git("worktree", "list", "--porcelain"), /worktree-trees|pi-cohort-worktrees/);
				if (observedTree) assert.equal(fs.existsSync(observedTree), false);
			}
			if (!result) return;
			const producer = result.details.outputs!.impl_1;
			assert.equal(producer.taskIndex, 0);
			assert.equal(producer.baseCommit, baseCommit);
			assert.equal(producer.repoCwd, fs.realpathSync(repoDir));
			if (absent || ending === "corrupt") {
				assert.equal(result.isError, true);
				assert.match(result.content[0].text, ending === "corrupt" ? /Output 'impl_1' tree build failed:/ : /Output 'impl_1' has no patch/);
				assert.equal(mockPi.callCount(), ending === "sequentialAbsent" ? 1 : ending === "corrupt" ? 3 : 2);
				if (ending === "corrupt") assert.equal(corrupted, true);
				return;
			}
			assert.ok(producer.treePath);
			assert.match(producer.treePath, /worktree-trees\/step-0\/task-0-impl$/);
			assert.equal(fs.existsSync(producer.treePath), false);
			if (acceptance) {
				assert.deepEqual(result.details.results[1].structuredOutput, { verdict: "PASS" });
				if (ending === "attested") {
					assert.equal(result.details.results[1].acceptance?.status, "attested");
					assert.equal(result.details.workflowGraph?.nodes[1]?.children?.[0]?.acceptanceStatus, "attested");
					assert.equal(result.details.outputs?.review?.text, '{"verdict":"PASS"}');
				} else { assert.equal(result.isError, true); assert.match(result.content[0].text, /Staged files present:/); }
			} else {
				const observation = JSON.parse(result.details.results[1].finalOutput!.trim());
				assert.equal(observation.cwd, producer.treePath);
				assert.equal(observation.files["nested/input.md"], "input\npatched\n");
				if (ending === "dynamic") {
					assert.ok(!result.isError, result.content[0].text);
					assert.equal(JSON.parse(result.details.results[2].finalOutput!.trim()).cwd, producer.treePath);
				}
				if (ending === "normal") {
					assert.ok(!result.isError, result.content[0].text);
					for (const r of result.details.results.slice(2)) assert.equal(JSON.parse(r.finalOutput!.trim()).cwd, producer.treePath);
					assert.ok(result.details.results[3].task!.includes(producer.treePath));
				}
				if (ending === "failFast") { assert.equal(result.isError, true); assert.equal(result.details.results.at(-1)!.exitCode, -1); }
				if (ending === "stop") assert.ok(result.details.stop);
			}
		});
	}

	for (const changes of [true, false]) {
		it(changes ? "binds patchPath and resolves it in the next task" : "keeps producers when a missing patch reference fails", { skip: process.platform === "win32" }, async () => {
			const repoDir = path.join(tempDir, "repo");
			fs.mkdirSync(repoDir);
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
			git("init");
			git("config", "user.email", "tests@example.com");
			git("config", "user.name", "Parallel Worktree Tests");
			fs.writeFileSync(path.join(repoDir, "input.md"), "input\n");
			git("add", "-A");
			git("commit", "-m", "initial commit");
			const hook = path.join(tempDir, "hook.sh");
			fs.writeFileSync(hook, changes
				? '#!/bin/sh\ninput=$(cat)\ncase "$input" in *"\\"index\\":0"*) echo patched >> input.md ;; esac\necho "{}"\n'
				: '#!/bin/sh\ncat > /dev/null\necho "{}"\n');
			fs.chmodSync(hook, 0o755);
			mockPi.onCall({ output: "done" });
			mockPi.onCall({ output: "noop" });
			mockPi.onCall({ output: "reviewed" });
			const result = await executeChain(makeChainParams([
				{ parallel: [{ agent: "impl", as: "impl_1", task: "edit" }, { agent: "impl", as: "impl_2", task: "noop" }], worktree: true, concurrency: 1 },
				{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
			], [makeAgent("impl", { completionGuard: false }), makeAgent("reviewer")], { cwd: repoDir, ctx: makeMinimalCtx(repoDir), worktreeSetupHook: hook, chainDir: path.join(tempDir, "chain") }));
			assert.equal(result.details.outputs?.impl_2?.patchPath, undefined);
			if (changes) {
				assert.ok(!result.isError, result.content[0].text);
				const patch = result.details.outputs?.impl_1?.patchPath ?? "";
				assert.match(patch, /worktree-diffs\/step-0\/task-0-impl\.patch$/);
				assert.ok(fs.existsSync(patch));
				assert.ok(readCallArgs(2).at(-1)?.includes(patch));
			} else {
				assert.equal(result.isError, true);
				assert.match(result.content[0].text, /Output 'impl_1' has no patch \(no changes\)./);
				assert.equal(result.details.results.length, 2);
			}
		});
	}

	for (const concurrency of [1, 2]) {
		it(`keeps sibling results when a parallel tree cwd reference fails at concurrency ${concurrency}`, { skip: process.platform === "win32" }, async () => {
			const repoDir = path.join(tempDir, "repo");
			fs.mkdirSync(repoDir);
			const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
			git("init");
			git("config", "user.email", "tests@example.com");
			git("config", "user.name", "Parallel Worktree Tests");
			fs.writeFileSync(path.join(repoDir, "input.md"), "input\n");
			git("add", "-A");
			git("commit", "-m", "initial commit");
			const hook = path.join(tempDir, "hook.sh");
			fs.writeFileSync(hook, '#!/bin/sh\ninput=$(cat)\ncase "$input" in *"\\"index\\":0"*) echo patched >> input.md ;; esac\necho "{}"\n');
			fs.chmodSync(hook, 0o755);
			mockPi.onCall({ output: "done" });
			mockPi.onCall({ output: "noop" });
			mockPi.onCall({ output: "valid consumer finished" });
			const result = await executeChain(makeChainParams([
				{ parallel: [{ agent: "impl", as: "impl_1", task: "edit" }, { agent: "impl", as: "impl_2", task: "noop" }], worktree: true, concurrency: 1 },
				{ parallel: [
					{ agent: "reviewer", as: "review", task: "Review {outputs.impl_1.patchPath}", cwd: "{outputs.impl_1.treePath}" },
					{ agent: "reviewer", task: "Review", cwd: "{outputs.impl_2.treePath}" },
				], concurrency },
			], [makeAgent("impl", { completionGuard: false }), makeAgent("reviewer")], { cwd: repoDir, ctx: makeMinimalCtx(repoDir), worktreeSetupHook: hook, chainDir: path.join(tempDir, "chain") }));
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /Output 'impl_2' has no patch \(no changes\)./);
			assert.equal(result.details.results.length, 4);
			assert.equal(result.details.results[2].finalOutput, "valid consumer finished");
			assert.equal(result.details.results[3].exitCode, 1);
			assert.match(result.details.results[3].finalOutput ?? "", /Output 'impl_2' has no patch/);
			assert.equal(mockPi.callCount(), 3);
			assert.equal(result.details.outputs?.review?.text, "valid consumer finished");
			assert.equal(fs.existsSync(result.details.outputs!.impl_1.treePath!), false);
			assert.doesNotMatch(git("worktree", "list", "--porcelain").toString(), /worktree-trees/);
		});
	}

	it("runs parallel tasks within a chain step", async () => {
		mockPi.onCall({ output: "Parallel task done" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review auth module" },
							{ agent: "reviewer-b", task: "Review data layer" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(result.details.results.length, 2);
	});

	it("aggregates parallel outputs for next sequential step", async () => {
		mockPi.onCall({ output: "Review findings here" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review security" },
							{ agent: "reviewer-b", task: "Review performance" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 3);
		const synthTask = result.details.results[2].task;
		assert.ok(
			synthTask.includes("=== Parallel Task 1 (reviewer-a) ==="),
			"synthesizer should include reviewer-a output block",
		);
		assert.ok(
			synthTask.includes("=== Parallel Task 2 (reviewer-b) ==="),
			"synthesizer should include reviewer-b output block",
		);
	});

	it("passes completed parallel task outputs to later {outputs.name} references", async () => {
		mockPi.onCall({ output: "Alpha named output" });
		mockPi.onCall({ output: "Beta named output" });
		mockPi.onCall({ output: "Final" });
		const agents = [makeAgent("alpha"), makeAgent("beta"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "alpha", task: "Alpha", as: "alphaOutput" },
							{ agent: "beta", task: "Beta", as: "betaOutput" },
						],
					},
					{ agent: "writer", task: "Use {outputs.alphaOutput} and {outputs.betaOutput}" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		const finalTask = readCallArgs(2).at(-1) ?? "";
		assert.match(finalTask, /Alpha named output/);
		assert.match(finalTask, /Beta named output/);
	});

	it("aggregates file-only parallel outputs as file references for the next step", async () => {
		mockPi.onCall({ output: "full parallel chain output\nwith details" });
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b"), makeAgent("synthesizer")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "reviewer-a", task: "Review A", output: "a.md", outputMode: "file-only" },
							{ agent: "reviewer-b", task: "Review B", output: "b.md", outputMode: "file-only" },
						],
					},
					{ agent: "synthesizer" },
				],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.ok(!result.isError, `should succeed: ${JSON.stringify(result.content)}`);
		assert.doesNotMatch(result.details.results[0]?.finalOutput ?? "", /full parallel chain output/);
		assert.doesNotMatch(result.details.results[1]?.finalOutput ?? "", /full parallel chain output/);
		const synthTaskArg = readCallArgs(2).at(-1) ?? "";
		assert.match(synthTaskArg, /Output saved to:/);
		assert.match(synthTaskArg, /2 lines/);
		assert.doesNotMatch(synthTaskArg, /full parallel chain output/);
	});

	it("rejects chain parallel file-only output without spawning siblings", async () => {
		const agents = [makeAgent("reviewer-a"), makeAgent("reviewer-b")];

		const result = await executeChain(
			makeChainParams(
				[{
					parallel: [
						{ agent: "reviewer-a", task: "Review A", outputMode: "file-only" },
						{ agent: "reviewer-b", task: "Review B", output: "b.md" },
					],
				}],
				agents,
				{ chainDir: tempDir },
			),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});


	it("fails chain on parallel step failure", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Parallel task failed" });
		const agents = [makeAgent("a"), makeAgent("b")];

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B" },
						],
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should fail when parallel step fails");
	});

	it("rejects worktree parallel steps that set a different task cwd", async () => {
		const agents = [makeAgent("a"), makeAgent("b")];
		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "a", task: "Task A" },
							{ agent: "b", task: "Task B", cwd: path.join(tempDir, "other") },
						],
						worktree: true,
					},
				],
				agents,
			),
		);

		assert.ok(result.isError, "chain should reject conflicting task cwd under worktree");
		assert.match(result.content[0]?.text ?? "", /worktree isolation uses the shared cwd/i);
		assert.match(result.content[0]?.text ?? "", /task 2 \(b\) sets cwd/i);
	});

	it("sequential → parallel → sequential (mixed chain)", async () => {
		mockPi.onCall({ output: "Step complete" });
		const agents = [makeAgent("scout"), makeAgent("rev-a"), makeAgent("rev-b"), makeAgent("writer")];

		const result = await executeChain(
			makeChainParams(
				[
					{ agent: "scout", task: "Initial scan" },
					{
						parallel: [
							{ agent: "rev-a", task: "Deep review A" },
							{ agent: "rev-b", task: "Deep review B" },
						],
					},
					{ agent: "writer" },
				],
				agents,
			),
		);

		assert.ok(!result.isError);
		assert.equal(result.details.results.length, 4);
		assert.equal(result.details.totalSteps, 3);
	});
});

describe("chain execution - clarify boundary", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let artifactsDir: string;
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
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeClarifySpy() {
		const calls: unknown[][] = [];
		const custom = async (...args: unknown[]) => {
			calls.push(args);
			return { confirmed: false, templates: [], behaviorOverrides: [] };
		};
		return { custom, calls };
	}

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
		ctxOverrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: { ...makeMinimalCtx(tempDir), ...ctxOverrides },
			runtime: mockPi.runtime,
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			...overrides,
		};
	}

	it("seeds the clarify screen with the inherited model and thinking", async () => {
		const agents = [makeAgent("worker")];
		let seeded: string | undefined;
		const custom = async (factory: (...args: unknown[]) => { getEffectiveModel(i: number): string }) => {
			const component = factory({ requestRender() {} }, { fg(_key: string, text: string) { return text; } }, {}, () => {});
			seeded = component.getEffectiveModel(0);
			return { confirmed: false, templates: [], behaviorOverrides: [] };
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{ clarify: true },
				{ ...makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "high"), hasUI: true, ui: { custom } },
			),
		);

		assert.match(result.content[0]?.text ?? "", /Chain cancelled/);
		assert.equal(seeded, "github-copilot/gpt-6:high");
	});

	it("confirms an untouched seed without overriding the inherited dispatch model", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("worker")];
		let confirmed: { confirmed: boolean; templates: string[]; behaviorOverrides: Array<{ model?: string } | undefined> } | undefined;
		const custom = async (factory: (...args: unknown[]) => { handleInput(data: string): void }) => {
			const component = factory(
				{ requestRender() {} },
				{ fg(_key: string, text: string) { return text; } },
				{},
				(result: typeof confirmed) => { confirmed = result; },
			);
			component.handleInput("\r");
			return confirmed;
		};

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{ clarify: true },
				{ ...makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "high"), hasUI: true, ui: { custom } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(confirmed?.confirmed, true);
		assert.equal(confirmed?.behaviorOverrides[0]?.model, undefined);
		const callFiles = fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-") && name.endsWith(".json"));
		assert.equal(callFiles.length, 1);
		const args = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFiles[0]!), "utf8")).args as string[];
		assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6:high");
	});

	it("seeds an explicit per-step thinking suffix instead of the parent's", async () => {
		const agents = [makeAgent("worker")];
		let seeded: string | undefined;
		const custom = async (factory: (...args: unknown[]) => { getEffectiveModel(i: number): string }) => {
			const component = factory({ requestRender() {} }, { fg(_key: string, text: string) { return text; } }, {}, () => {});
			seeded = component.getEffectiveModel(0);
			return { confirmed: false, templates: [], behaviorOverrides: [] };
		};

		await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "x", model: "github-copilot/gpt-6:low" }],
				agents,
				{ clarify: true },
				{ ...makeParentSessionCtx(tempDir, "github-copilot", "gpt-6", "high"), hasUI: true, ui: { custom } },
			),
		);

		assert.equal(seeded, "github-copilot/gpt-6:low");
	});

	it("launches directly when clarify is omitted, without opening the clarify TUI", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("worker")];
		const spy = makeClarifySpy();

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{},
				{ hasUI: true, ui: { custom: spy.custom } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(spy.calls.length, 0, "clarify TUI should not be opened when clarify is omitted");
	});

	it("launches directly when clarify is false", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("worker")];
		const spy = makeClarifySpy();

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{ clarify: false },
				{ hasUI: true, ui: { custom: spy.custom } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(spy.calls.length, 0, "clarify TUI should not be opened when clarify is false");
	});

	it("opens the clarify TUI for a sequential chain when clarify is true", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("worker")];
		const spy = makeClarifySpy();

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{ clarify: true },
				{ hasUI: true, ui: { custom: spy.custom } },
			),
		);

		assert.equal(spy.calls.length, 1, "clarify TUI should be opened when clarify is true");
		assert.match(result.content[0]?.text ?? "", /Chain cancelled/);
	});

	it("skips the clarify TUI for a parallel-step chain even when clarify is true", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("rev-a"), makeAgent("rev-b")];
		const spy = makeClarifySpy();

		const result = await executeChain(
			makeChainParams(
				[
					{
						parallel: [
							{ agent: "rev-a", task: "Review A" },
							{ agent: "rev-b", task: "Review B" },
						],
					},
				],
				agents,
				{ clarify: true },
				{ hasUI: true, ui: { custom: spy.custom } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(spy.calls.length, 0, "clarify TUI should not be opened for a parallel-step chain");
	});

	it("skips the clarify TUI when clarify is true but hasUI is false", async () => {
		mockPi.onCall({ output: "done" });
		const agents = [makeAgent("worker")];
		const spy = makeClarifySpy();

		const result = await executeChain(
			makeChainParams(
				[{ agent: "worker", task: "Do the thing" }],
				agents,
				{ clarify: true },
				{ hasUI: false, ui: { custom: spy.custom } },
			),
		);

		assert.ok(!result.isError, `chain should succeed: ${JSON.stringify(result.content)}`);
		assert.equal(spy.calls.length, 0, "clarify TUI should not be opened when hasUI is false");
	});
});


describe("chain execution - stopOn", { skip: !available }, () => {
	let tempDir: string;
	let artifactsDir: string;
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
		artifactsDir = path.join(tempDir, "artifacts");
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	function makeChainParams(
		chain: TestChainStep[],
		agents: ReturnType<typeof makeAgent>[],
		overrides: Record<string, unknown> = {},
	) {
		return {
			chain,
			agents,
			ctx: makeMinimalCtx(tempDir),
			runtime: mockPi.runtime,
			runId: `test-${Date.now().toString(36)}`,
			shareEnabled: false,
			sessionDirForIndex: () => undefined,
			artifactsDir,
			artifactConfig: { enabled: false },
			clarify: false,
			...overrides,
		};
	}

	function readCallArgs(index: number): string[] {
		const callFiles = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort();
		const callFile = callFiles[index];
		assert.ok(callFile, `expected call ${index}`);
		return JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")).args as string[];
	}

	const verdictSchema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
	const stopRecordOf = (text: string) => JSON.parse(text.slice(text.indexOf("## Stop")).split("```json\n")[1]!.split("\n```")[0]!);

	for (const delayed of [false, true]) {
		it(`stops after a sequential step whose ${delayed ? "delayed" : "first-turn"} structured output matches`, async () => {
			mockPi.onCall(delayed ? { steps: [
				{ jsonl: [events.assistantMessage("Reviewed; missing edge case.")] },
				{ delay: 1500, structuredOutput: { verdict: "FAIL" }, jsonl: [{ type: "agent_settled", aborted: false }] },
			] } : { output: "Reviewed; missing edge case.", structuredOutput: { verdict: "FAIL" } });
			mockPi.onCall({ output: "never runs" });
			const result = await executeChain(makeChainParams([
				{ agent: "reviewer", task: "Review", as: "sr", outputSchema: verdictSchema, stopOn: { path: "/verdict", in: ["FAIL"] } },
				{ agent: "writer", task: "Fix {outputs.sr}" },
			], [makeAgent("reviewer"), makeAgent("writer")]));
			assert.ok(!result.isError);
			assert.equal(mockPi.callCount(), 1);
			const text = result.content[0]!.text;
			assert.match(text, /^⏹ Chain stopped at step 1\/2 by condition \/verdict in \[FAIL\]/);
			assert.deepEqual(stopRecordOf(text), { reason: "condition", stepIndex: 0, condition: { path: "/verdict", in: ["FAIL"] }, matches: [{ stepIndex: 0, as: "sr", agent: "reviewer", value: "FAIL" }] });
			assert.deepEqual(result.details.stop, stopRecordOf(text));
			assert.match(text, /## Outputs\n### Step 1\n#### Task 1 \(reviewer, as sr\)\nReviewed; missing edge case\.\n```json\n\{"verdict":"FAIL"\}\n```/);
			assert.equal(result.details.workflowGraph?.nodes[0]?.status, "completed");
			assert.equal(result.details.workflowGraph?.nodes[1]?.status, "pending");
		});
	}

	it("omits stop sections when a stopOn step fails without a match", async () => {
		mockPi.onCall({ output: "boom", exitCode: 1 });
		const result = await executeChain(makeChainParams([
			{ agent: "reviewer", task: "Review", outputSchema: verdictSchema, stopOn: { path: "/verdict", in: ["FAIL"] } },
		], [makeAgent("reviewer")]));
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /^❌ Chain failed/);
		assert.doesNotMatch(result.content[0]!.text, /## Stop|## Outputs/);
		assert.equal(result.details.stop, undefined);
	});

	it("fails but keeps the record when dynamic group acceptance rejects", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "a bad", structuredOutput: { verdict: "FAIL" } });
		const result = await executeChain(makeChainParams([
			{ agent: "scout", task: "Targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: verdictSchema },
				collect: { as: "reviews" },
				acceptance: { level: "verified", verify: [{ id: "group-fail", command: "node -e \"process.exit(5)\"" }] },
				stopOn: { path: "/verdict", in: ["FAIL"] },
			},
		], [makeAgent("scout"), makeAgent("reviewer")]));
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /^❌ Chain failed/);
		assert.equal((result.details.stop as { matches: unknown[] }).matches.length, 1);
	});

	it("lets all parallel siblings finish, then stops with every output and no following step", async () => {
		mockPi.onCall({ output: "ok one", structuredOutput: { verdict: "PASS" } });
		mockPi.onCall({ steps: [
			{ jsonl: [events.assistantMessage("bad two")] },
			{ delay: 1500, structuredOutput: { verdict: "FAIL" }, jsonl: [{ type: "agent_settled", aborted: false }] },
		] });
		mockPi.onCall({ output: "ok three", structuredOutput: { verdict: "PASS" } });
		const result = await executeChain(makeChainParams([
			{ parallel: [
				{ agent: "reviewer", task: "Review 1", as: "sr_1", label: "task 1 review", outputSchema: verdictSchema },
				{ agent: "reviewer", task: "Review 2", as: "sr_2", label: "task 2 review", outputSchema: verdictSchema },
				{ agent: "reviewer", task: "Review 3", as: "sr_3", outputSchema: verdictSchema },
			], concurrency: 1, stopOn: { path: "/verdict", in: ["FAIL"] } },
			{ agent: "writer", task: "never" },
		], [makeAgent("reviewer"), makeAgent("writer")]));
		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 3);
		const record = stopRecordOf(result.content[0]!.text);
		assert.deepEqual(record.matches, [{ stepIndex: 0, taskIndex: 1, as: "sr_2", label: "task 2 review", agent: "reviewer", value: "FAIL" }]);
		assert.match(result.content[0]!.text, /#### Task 1 \(reviewer, as sr_1\)[\s\S]*#### Task 2 \(reviewer, as sr_2\)[\s\S]*#### Task 3 \(reviewer, as sr_3\)/);
		assert.deepEqual(Object.keys(result.details.outputs ?? {}).sort(), ["sr_1", "sr_2", "sr_3"]);
	});

	it("reports failure but keeps the record and successful siblings' outputs when a sibling crashes", async () => {
		mockPi.onCall({ output: "bad one", structuredOutput: { verdict: "FAIL" } });
		mockPi.onCall({ output: "boom", exitCode: 1 });
		const result = await executeChain(makeChainParams([
			{ parallel: [
				{ agent: "reviewer", task: "Review 1", as: "sr_1", outputSchema: verdictSchema },
				{ agent: "reviewer", task: "Review 2", as: "sr_2", outputSchema: verdictSchema },
			], concurrency: 1, stopOn: { path: "/verdict", in: ["FAIL"] } },
			{ agent: "writer", task: "never" },
		], [makeAgent("reviewer"), makeAgent("writer")]));
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /^❌ Chain failed at step 1/);
		assert.equal((result.details.stop as { matches: unknown[] }).matches.length, 1);
		assert.equal(result.details.outputs?.sr_1?.text, "{\"verdict\":\"FAIL\"}");
		assert.equal(result.details.outputs?.sr_2, undefined);
		assert.match(result.content[0]!.text, /#### Task 2 \(reviewer, as sr_2\) - failed\n/);
	});

	it("renders skipped fail-fast siblings as skipped, not matched", async () => {
		mockPi.onCall({ output: "bad one", structuredOutput: { verdict: "FAIL" } });
		mockPi.onCall({ output: "boom", exitCode: 1 });
		const result = await executeChain(makeChainParams([
			{ parallel: [
				{ agent: "reviewer", task: "Review 1", as: "sr_1", outputSchema: verdictSchema },
				{ agent: "reviewer", task: "Review 2", as: "sr_2", outputSchema: verdictSchema },
				{ agent: "reviewer", task: "Review 3", as: "sr_3", outputSchema: verdictSchema },
			], concurrency: 1, failFast: true, stopOn: { path: "/verdict", in: ["FAIL"] } },
		], [makeAgent("reviewer")]));
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /#### Task 3 \(reviewer, as sr_3\) - skipped \(fail-fast\)\n/);
		assert.equal((result.details.stop as { matches: unknown[] }).matches.length, 1);
	});

	it("stops a dynamic fanout step and labels matches", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] } });
		mockPi.onCall({ output: "a ok", structuredOutput: { verdict: "PASS" } });
		mockPi.onCall({ output: "b bad", structuredOutput: { verdict: "FAIL" } });
		const result = await executeChain(makeChainParams([
			{ agent: "scout", task: "Targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {target.path}", label: "Review {target.path}", outputSchema: verdictSchema },
				collect: { as: "reviews" },
				concurrency: 1,
				stopOn: { path: "/verdict", in: ["FAIL"] },
			},
			{ agent: "writer", task: "never" },
		], [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")]));
		assert.ok(!result.isError);
		assert.equal(mockPi.callCount(), 3);
		const record = stopRecordOf(result.content[0]!.text);
		assert.deepEqual(record.matches, [{ stepIndex: 1, taskIndex: 1, label: "Review src/b.ts", agent: "reviewer", value: "FAIL" }]);
		assert.ok(Array.isArray(result.details.outputs?.reviews?.structured));
	});

	it("keeps the dynamic collection and stop record when an item crashes", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: ["a", "b"] } });
		mockPi.onCall({ output: "needs fixes", structuredOutput: { verdict: "FAIL" } });
		mockPi.onCall({ exitCode: 1, stderr: "review crashed" });
		const result = await executeChain(makeChainParams([
			{ agent: "scout", task: "Targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, maxItems: 2 },
				parallel: { agent: "reviewer", task: "Review {item}", outputSchema: verdictSchema },
				collect: { as: "reviews" }, concurrency: 1,
				stopOn: { path: "/verdict", in: ["FAIL"] },
			},
			{ agent: "writer", task: "never" },
		], [makeAgent("scout"), makeAgent("reviewer"), makeAgent("writer")]));
		assert.equal(result.isError, true);
		assert.equal(mockPi.callCount(), 3);
		assert.equal((result.details.stop as { matches: unknown[] }).matches.length, 1);
		const collected = result.details.outputs?.reviews?.structured as Array<{ exitCode: number; error?: string }>;
		assert.ok(Array.isArray(collected));
		assert.equal(collected.length, 2);
		assert.deepEqual(collected.map((item) => item.exitCode), [0, 1]);
		assert.match(collected[1]!.error ?? "", /review crashed/);
	});

	it("fails but keeps the record when the dynamic collection schema rejects", async () => {
		mockPi.onCall({ output: "targets", structuredOutput: { items: [{ path: "src/a.ts" }] } });
		mockPi.onCall({ output: "a bad", structuredOutput: { verdict: "FAIL" } });
		const result = await executeChain(makeChainParams([
			{ agent: "scout", task: "Targets", as: "targets", outputSchema: { type: "object" } },
			{
				expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
				parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: verdictSchema },
				collect: { as: "reviews", outputSchema: { type: "object" } },
				stopOn: { path: "/verdict", in: ["FAIL"] },
			},
		], [makeAgent("scout"), makeAgent("reviewer")]));
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /^❌ Chain failed at step 2: Collected output validation failed/);
		assert.equal((result.details.stop as { matches: unknown[] }).matches.length, 1);
	});

	it("renders Outputs on ordinary completion when any step carries stopOn, and nothing extra otherwise", async () => {
		mockPi.onCall({ output: "fine", structuredOutput: { verdict: "PASS" } });
		mockPi.onCall({ output: "SHIP" });
		const withStop = await executeChain(makeChainParams([
			{ agent: "reviewer", task: "Review", as: "sr", outputSchema: verdictSchema, stopOn: { path: "/verdict", in: ["FAIL"] } },
			{ agent: "writer", task: "Decide" },
		], [makeAgent("reviewer"), makeAgent("writer")]));
		assert.ok(!withStop.isError);
		assert.equal(withStop.details.stop, undefined);
		assert.match(withStop.content[0]!.text, /^✅ Chain completed[\s\S]*## Outputs\n### Step 1\n#### Task 1 \(reviewer, as sr\)[\s\S]*### Step 2\n#### Task 1 \(writer\)\nSHIP/);
		assert.doesNotMatch(withStop.content[0]!.text, /## Stop/);

		mockPi.onCall({ output: "fine", structuredOutput: { verdict: "PASS" } });
		mockPi.onCall({ output: "SHIP" });
		const plain = await executeChain(makeChainParams([
			{ agent: "reviewer", task: "Review", as: "sr", outputSchema: verdictSchema },
			{ agent: "writer", task: "Decide" },
		], [makeAgent("reviewer"), makeAgent("writer")]));
		assert.match(plain.content[0]!.text, /^✅ Chain completed: reviewer → writer \(2 steps, [^)]*\)\n\n📋 Progress: .*\n📁 Artifacts: .*$/s);
		assert.doesNotMatch(plain.content[0]!.text, /## Outputs|## Stop/);
	});

	it("rejects stopOn without outputSchema before any child runs", async () => {
		const result = await executeChain(makeChainParams([
			{ agent: "reviewer", task: "Review", stopOn: { path: "/verdict", in: ["FAIL"] } },
		], [makeAgent("reviewer")]));
		assert.equal(result.isError, true);
		assert.equal(result.content[0]!.text, "Chain step 1 has stopOn but no outputSchema.");
		assert.equal(mockPi.callCount(), 0);
	});
});
