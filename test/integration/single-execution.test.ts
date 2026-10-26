/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses the local createMockPi() helper to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { DEFAULT_CONTROL_CONFIG } from "../../src/runs/shared/subagent-control.ts";
import {
	createMockPi,
	createTempDir,
	createEventBus,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	makeMinimalCtx,
	events,
	tryImport,
} from "../support/helpers.ts";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";

interface ModelAttempt {
	success?: boolean;
	exitCode?: number;
	error?: string;
}

interface ProgressSummary {
	agent: string;
	index: number;
	status: string;
	activityState?: string;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	durationMs: number;
	toolCount: number;
}

interface ArtifactPaths {
	outputPath: string;
}

interface RunSyncResult {
	exitCode: number;
	agent: string;
	messages: unknown[];
	error?: string;
	model?: string;
	skills?: string[];
	skillsWarning?: string;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	usage: { turns: number; input: number; output: number };
	progress: ProgressSummary;
	controlEvents?: Array<{ type?: string; message: string; reason?: string; turns?: number; tokens?: number; currentPath?: string; recentFailureSummary?: string }>;
	artifactPaths?: ArtifactPaths;
	finalOutput?: string;
	interrupted?: boolean;
	savedOutputPath?: string;
	outputMode?: "inline" | "file-only";
	outputReference?: { path: string; bytes: number; lines: number; message: string };
	outputSaveError?: string;
	sessionFile?: string;
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

interface UtilsModule {
	getFinalOutput(messages: unknown[]): string;
	getSingleResultOutput(result: { finalOutput?: string }): string;
}

interface ExecutorModule {
	createSubagentExecutor?: (...args: unknown[]) => {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
	};
}

const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const utils = await tryImport<UtilsModule>("./src/shared/utils.ts");
const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;
const createSubagentExecutor = executorMod?.createSubagentExecutor;

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

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	function readCallArgs(index = -1): string[] {
		const callFile = fs.readdirSync(mockPi.dir)
			.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
			.sort()
			.at(index);
		assert.ok(callFile, "expected a recorded mock pi call");
		const payload = JSON.parse(fs.readFileSync(path.join(mockPi.dir, callFile), "utf-8")) as { args?: string[] };
		assert.ok(Array.isArray(payload.args), "expected recorded args");
		return payload.args;
	}

	function makeExecutor(agents = [makeAgent("echo")]) {
		return createSubagentExecutor!({
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents }),
		});
	}

	it("captures once and allocates full-UUID roots beneath an explicit base", async () => {
		let captures = 0;
		const state = { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null };
		const base = path.join(tempDir, "explicit-base");
		fs.mkdirSync(base);
		fs.writeFileSync(path.join(base, "existing.jsonl"), "keep existing\n");
		const executor = executorMod!.createSubagentExecutor({
			captureRuntime: () => { captures++; return mockPi.captureRuntime(); },
			pi: { events: createEventBus(), getSessionName: () => undefined }, state, resolveConfig: () => ({}),
			tempArtifactsDir: tempDir, getSubagentSessionRoot: () => tempDir,
			expandTilde: value => value, discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const roots = new Set<string>();
		for (let index = 0; index < 2; index++) {
			mockPi.onCall({ output: "ok" });
			const result = await executor.execute("launch", { agent: "echo", task: "go", sessionDir: base }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined);
			assert.match(result.details.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			const assigned = path.join(fs.realpathSync.native(base), result.details.runId);
			roots.add(assigned);
			assert.equal(path.dirname(path.dirname(result.details.results[0].sessionFile)), assigned);
			assert.deepEqual(state.foregroundRuns.get(result.details.runId).runtime, mockPi.runtime);
			assert.equal(state.foregroundRuns.get(result.details.runId).sessionRoot, assigned);
		}
		assert.equal(captures, 1);
		assert.equal(roots.size, 2);
		assert.equal(fs.readFileSync(path.join(base, "existing.jsonl"), "utf8"), "keep existing\n");
	});

	it("creates a private default no-parent run root under umask 022", { skip: process.platform === "win32" ? "POSIX directory modes required" : undefined }, async () => {
		const previousUmask = process.umask(0o022);
		try {
			mockPi.onCall({ output: "ok" });
			const result = await makeExecutor().execute("launch", { agent: "echo", task: "go" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined);
			const sessionRoot = path.dirname(path.dirname(result.details.results[0].sessionFile));
			assert.equal(sessionRoot, path.join(fs.realpathSync.native(tempDir), result.details.runId));
			assert.equal(fs.statSync(sessionRoot).mode & 0o777, 0o700);
		} finally {
			process.umask(previousUmask);
		}
	});

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const sessionFile = path.join(tempDir, "child-session.jsonl");
		const result = await runSync(tempDir, agents, "echo", "Say hello", { sessionFile });

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.equal(result.sessionFile, sessionFile);
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("classifies blocker output as a failed result before mutation checks and model fallback", async () => {
		const blocked = "BLOCKED: need approval to rotate the api key\nDone: inspected config\nRemaining: deploy";
		mockPi.onCall({ output: blocked });
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved deployment", {
			runId: "blocked-run",
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, blocked);
		assert.equal(result.finalOutput, blocked);
		assert.equal(result.progress.status, "failed");
		assert.equal(result.modelAttempts?.length, 1);
		assert.doesNotMatch(result.error ?? "", /fallback/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("classifies a blocker split across multiple text blocks as a failed result", async () => {
		const blockedLine = "BLOCKED: need approval to rotate the api key";
		const restLine = "Done: inspected config\nRemaining: deploy";
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: blockedLine },
						{ type: "text", text: restLine },
					],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0 },
				},
			}],
		});
		const agents = [makeAgent("worker", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved deployment", {
			runId: "blocked-multipart-run",
			acceptance: { level: "none", reason: "test: acceptance unrelated to this regression" },
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, `${blockedLine}\n${restLine}`);
		assert.equal(result.progress.status, "failed");
		assert.equal(result.modelAttempts?.length, 1);
		assert.doesNotMatch(result.error ?? "", /fallback/i);
		assert.equal(mockPi.callCount(), 1);
	});

	it("completes a fresh foreground follow-up after a blocker decision", async () => {
		const blocked = "BLOCKED: need approval to rotate the api key\nDone: inspected config\nRemaining: deploy";
		mockPi.onCall({ output: blocked });
		mockPi.onCall({ output: "Deployment completed" });
		const agents = makeAgentConfigs(["echo"]);

		const first = await runSync(tempDir, agents, "echo", "Deploy the service", { runId: "blocked-run" });
		const followUp = await runSync(tempDir, agents, "echo", "Deploy the service. Decision: rotate the api key is approved.", { runId: "follow-up-run" });

		assert.equal(first.exitCode, 1);
		assert.equal(followUp.exitCode, 0);
		assert.equal(getFinalOutput(followUp.messages), "Deployment completed");
		assert.equal(mockPi.callCount(), 2);
		assert.match(readCallArgs().at(-1) ?? "", /Decision: rotate the api key is approved/);
	});

	it("preserves blocker output when a structured result is configured", async () => {
		const blocked = "BLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		mockPi.onCall({ output: blocked });
		const result = await makeExecutor([makeAgent("worker")]).execute(
			"blocked-structured", { agent: "worker", task: "Implement key rotation", outputSchema: { type: "object" } },
			new AbortController().signal, undefined, makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, true);
		assert.match(result.content[0]?.text ?? "", /BLOCKED: need approval/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /structured output missing/);
	});

	it("fails implementation runs that complete without mutation attempts",  async () => {
		mockPi.onCall({ output: "Validation:\nlet rawFilename = params.filename.trim();" });
		const agents = [makeAgent("worker")];
		const controlEvents: Array<{ message: string }> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-run",
			onControlEvent: (event: { message: string }) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
		assert.equal(result.finalOutput, "Validation:\nlet rawFilename = params.filename.trim();");
		assert.equal(result.progress.status, "failed");
		assert.deepEqual(controlEvents.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
		assert.deepEqual(result.controlEvents?.map((event) => event.message), [
			"worker completed without making edits for an implementation task",
		]);
	});

	it("fails future-tense implementation summaries when no mutation attempt occurred", async () => {
		mockPi.onCall({ output: "I’ll do that now and report back after implementing." });
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "guard-future-tense",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows declared read-only agents to mention implementation words without edits", async () => {
		mockPi.onCall({ output: "Validation report after the patch" });
		const agents = [makeAgent("architect", { tools: ["read", "grep", "find", "ls"] })];

		const result = await runSync(tempDir, agents, "architect", "Produce a proposal that implements the approved fix", {
			runId: "guard-readonly-tools",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Validation report after the patch");
	});

	it("keeps bash-enabled agents conservative unless completion guard is disabled", async () => {
		mockPi.onCall({ output: "cold start test after patch" });
		mockPi.onCall({ output: "cold start test after patch" });
		const agents = [
			makeAgent("test-runner", { tools: ["read", "grep", "bash", "ls"] }),
			makeAgent("test-runner-optout", { tools: ["read", "grep", "bash", "ls"], completionGuard: false }),
		];

		const withoutOptOut = await runSync(tempDir, agents, "test-runner", "Run cold start test after patch", {
			runId: "guard-bash-conservative",
		});
		assert.equal(withoutOptOut.exitCode, 1);
		assert.match(withoutOptOut.error ?? "", /completed without making edits/);

		const withOptOut = await runSync(tempDir, agents, "test-runner-optout", "Run cold start test after patch", {
			runId: "guard-bash-optout",
		});
		assert.equal(withOptOut.exitCode, 0);
		assert.equal(withOptOut.progress.status, "completed");
	});

	it("allows implementation runs when parsed messages include a real edit tool call", async () => {
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
						model: "mock/test-model",
						stopReason: "toolUse",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
				events.assistantMessage("Applied edit"),
			],
		});
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved file changes", {
			runId: "guard-success",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.status, "completed");
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});


	it("emits an active-long-running notice after the turn threshold", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-active",
			controlConfig: { enabled: true, needsAttentionAfterMs: 999_999, activeNoticeAfterTurns: 2, activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 999_999, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(controlEvents.length, 1);
		assert.equal(controlEvents[0]?.type, "active_long_running");
		assert.equal(controlEvents[0]?.reason, "turn_threshold");
		assert.equal(controlEvents[0]?.turns, 2);
		assert.equal(result.controlEvents?.[0]?.type, "active_long_running");
		assert.equal(result.progress.activityState, "active_long_running");
	});

	it("escalates repeated mutating tool failures to needs attention", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.toolStart("edit", { path: "src/runs/background/async-status.ts" }),
				events.toolEnd("edit"),
				events.toolResult("edit", "No exact match found for async-status.ts", true),
				events.assistantMessage("I need to retry the same edit."),
			],
		});
		const agents = [makeAgent("worker")];
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "worker", "Implement the approved fixes", {
			runId: "run-failures",
			controlConfig: { enabled: true, failedToolAttemptsBeforeAttention: 3, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		const failureEvent = controlEvents.find((event) => event.reason === "tool_failures");
		assert.equal(failureEvent?.type, "needs_attention");
		assert.equal(failureEvent?.currentPath, "src/runs/background/async-status.ts");
		assert.match(failureEvent?.recentFailureSummary ?? "", /No exact match/);
		assert.equal(result.progress.activityState, "needs_attention");
	});

	it("does not surface control state or events when control is disabled", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage("first update"),
				events.assistantMessage("second update"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];

		const result = await runSync(tempDir, agents, "echo", "Investigate behavior", {
			runId: "run-control-disabled",
			controlConfig: { enabled: false, activeNoticeAfterTurns: 1, activeNoticeAfterMs: 1, activeNoticeAfterTokens: 1, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.progress.activityState, undefined);
		assert.equal(result.controlEvents, undefined);
		assert.equal(controlEvents.length, 0);
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("prefers the parent session provider for ambiguous bare model ids", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			availableModels: [
				{ provider: "openai", id: "gpt-5-mini", fullId: "openai/gpt-5-mini" },
				{ provider: "github-copilot", id: "gpt-5-mini", fullId: "github-copilot/gpt-5-mini" },
			],
			preferredModelProvider: "github-copilot",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-5-mini");
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-5-mini"]);
	});

	it("inherits the parent session model and thinking when neither call nor agent sets one", async () => {
		mockPi.onCall({ output: "Done" });
		const result = await runSync(tempDir, [makeAgent("echo")], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "high",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "github-copilot/gpt-6:high");
		const args = readCallArgs();
		assert.equal(args[args.indexOf("--model") + 1], "github-copilot/gpt-6:high");
	});

	it("emits no --model when the parent has no model", async () => {
		mockPi.onCall({ output: "Done" });
		const result = await runSync(tempDir, [makeAgent("echo")], "echo", "Task", { parentThinking: "high" });

		assert.equal(result.exitCode, 0);
		assert.ok(!readCallArgs().includes("--model"));
	});

	it("per-call and agent models beat the parent model", async () => {
		mockPi.onCall({ output: "Done" });
		mockPi.onCall({ output: "Done" });
		const pinned = await runSync(tempDir, [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "xhigh",
		});
		const pinnedArgs = readCallArgs();
		const overridden = await runSync(tempDir, [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })], "echo", "Task", {
			modelOverride: "openai/gpt-4o",
			parentModel: "github-copilot/gpt-6",
		});

		assert.equal(pinned.model, "anthropic/claude-sonnet-4:xhigh");
		assert.ok(pinnedArgs.includes("--model"));
		assert.equal(pinnedArgs[pinnedArgs.indexOf("--model") + 1], "anthropic/claude-sonnet-4:xhigh");
		assert.equal(overridden.model, "openai/gpt-4o");
	});

	it("agent thinking beats parent thinking; parent off and max are emitted; an existing suffix wins", async () => {
		mockPi.onCall({ output: "Done" });
		mockPi.onCall({ output: "Done" });
		mockPi.onCall({ output: "Done" });
		mockPi.onCall({ output: "Done" });
		const agentLow = await runSync(tempDir, [makeAgent("echo", { thinking: "low" })], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "high",
		});
		const agentLowArgs = readCallArgs();
		const parentOff = await runSync(tempDir, [makeAgent("echo")], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "off",
		});
		const parentMax = await runSync(tempDir, [makeAgent("echo")], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "max",
		});
		const callMax = await runSync(tempDir, [makeAgent("echo")], "echo", "Task", {
			modelOverride: "github-copilot/gpt-6:max",
			parentModel: "github-copilot/gpt-6",
			parentThinking: "high",
		});

		assert.equal(agentLow.model, "github-copilot/gpt-6:low");
		assert.ok(agentLowArgs.includes("--model"));
		assert.equal(agentLowArgs[agentLowArgs.indexOf("--model") + 1], "github-copilot/gpt-6:low");
		assert.equal(parentOff.model, "github-copilot/gpt-6:off");
		assert.equal(parentMax.model, "github-copilot/gpt-6:max");
		assert.equal(callMax.model, "github-copilot/gpt-6:max");
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("applies parent thinking to the inherited model and fallback candidates", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "github-copilot/gpt-6",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });

		const result = await runSync(tempDir, [makeAgent("echo", { fallbackModels: ["openai/gpt-4o"] })], "echo", "Task", {
			parentModel: "github-copilot/gpt-6",
			parentThinking: "high",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.attemptedModels, ["github-copilot/gpt-6", "openai/gpt-4o"]);
		const firstArgs = readCallArgs(0);
		const secondArgs = readCallArgs(1);
		assert.ok(firstArgs.includes("--model"));
		assert.equal(firstArgs[firstArgs.indexOf("--model") + 1], "github-copilot/gpt-6:high");
		assert.ok(secondArgs.includes("--model"));
		assert.equal(secondArgs[secondArgs.indexOf("--model") + 1], "openai/gpt-4o:high");
	});

	it("retries with fallback models on retryable provider failures", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "temporary provider failure" }],
					model: "openai/gpt-5-mini",
					errorMessage: "rate limit exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-sync",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.attemptedModels, ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]);
		assert.equal(result.modelAttempts?.length, 2);
		assert.equal(result.modelAttempts?.[0]?.success, false);
		assert.equal(result.modelAttempts?.[1]?.success, true);
		assert.equal(result.usage.turns, 2);
		assert.equal(mockPi.callCount(), 2);
	});

	it("retries with fallback models when provider errors exit zero", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 you have reached your weekly usage limit / quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		mockPi.onCall({ output: "Recovered on fallback" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-zero-exit-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "anthropic/claude-sonnet-4");
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, true]);
	});

	it("fails zero-exit provider errors when no fallback succeeds", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "weekly quota hit" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", { model: "openai/gpt-5-mini" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-no-fallback",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /429 quota exceeded/);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false]);
	});

	it("treats recovered child tool errors as successful foreground runs", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolResult("read", "EISDIR: illegal operation on a directory", true),
				events.assistantMessage("Done"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Inspect files", {
			runId: "recovered-tool-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Done");
		assert.equal(getFinalOutput(result.messages), "Done");
		assert.equal(result.progress.status, "completed");
	});

	it("treats recovered assistant provider errors as successful foreground runs", async () => {
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
				events.assistantMessage("Recovered"),
			],
		});
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "recovered-provider-error",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "Recovered");
		assert.equal(getFinalOutput(result.messages), "Recovered");
		assert.equal(result.progress.status, "completed");
	});

	it("keeps provider errors failed when followed only by empty assistant output", async () => {
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
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Recover from provider error", {
			runId: "provider-error-empty-stop",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /provider transport failed/);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "failed");
	});

	it("fails when all fallback model attempts report provider errors", async () => {
		for (const model of ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"]) {
			mockPi.onCall({
				jsonl: [{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: `${model} quota hit` }],
						model,
						errorMessage: "429 quota exceeded",
						usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}],
				exitCode: 0,
			});
		}
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "zero-exit-provider-error-all-fallbacks-fail",
		});

		assert.equal(result.exitCode, 1);
		assert.deepEqual(result.modelAttempts?.map((attempt) => attempt.success), [false, false]);
		assert.match(result.error ?? "", /429 quota exceeded/);
	});

	it("baselines output files per fallback attempt", async () => {
		const outputPath = path.join(tempDir, "fallback-output.md");
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary failed" }],
					model: "openai/gpt-5-mini",
					errorMessage: "429 quota exceeded",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 0,
			delay: 100,
		});
		mockPi.onCall({ output: "fallback assistant output" });
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "fallback-output-per-attempt",
			outputPath,
		});
		setTimeout(() => {
			fs.writeFileSync(outputPath, "stale partial output from failed primary", "utf-8");
		}, 20);

		const result = await runPromise;

		assert.equal(result.exitCode, 0);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fallback assistant output");
	});

	it("does not retry on ordinary task/tool failures", async () => {
		mockPi.onCall({
			jsonl: [events.toolResult("bash", "process exited with code 127")],
			exitCode: 0,
		});
		const agents = [makeAgent("echo", {
			model: "openai/gpt-5-mini",
			fallbackModels: ["anthropic/claude-sonnet-4"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "no-fallback-task-failure",
		});

		assert.equal(result.exitCode, 127);
		assert.equal(result.modelAttempts?.length, 1);
		assert.equal(mockPi.callCount(), 1);
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("tracks live activity updates and exposes artifact paths while running", async () => {
		const updates: Array<{ details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }> = [];
		mockPi.onCall({
			steps: [
				{ jsonl: [events.toolStart("read", { path: "package.json" })], delay: 20 },
				{ jsonl: [events.toolEnd("read"), events.toolResult("read", "{\"name\":\"pkg\"}")], delay: 20 },
				{ jsonl: [events.assistantMessage("Done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "live-progress",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
			onUpdate: (update: { details?: { results?: Array<{ artifactPaths?: ArtifactPaths }>; progress?: ProgressSummary[] } }) => {
				updates.push(update);
			},
		});

		assert.ok(updates.length > 0, "expected at least one live progress update");
		assert.equal(
			updates.some((update) => update.details?.results?.[0]?.artifactPaths?.outputPath.endsWith("_output.md") === true),
			true,
		);
		const runningToolUpdate = updates.find((update) => update.details?.progress?.[0]?.currentTool === "read");
		assert.ok(runningToolUpdate, "expected a live progress update for the running tool");
		assert.equal(runningToolUpdate?.details?.progress?.[0]?.currentTool, "read");
		assert.equal(typeof runningToolUpdate?.details?.progress?.[0]?.currentToolStartedAt, "number");
		assert.equal(typeof result.progress.lastActivityAt, "number");
		assert.equal(result.progress.currentToolStartedAt, undefined);
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("resolves skills from the effective task cwd", async () => {
		const taskCwd = createTempDir("pi-subagent-task-cwd-");
		try {
			writePackageSkill(taskCwd, "task-cwd-skill");
			mockPi.onCall({ output: "Done" });
			const agents = [makeAgent("echo", { skills: ["task-cwd-skill"] })];

			const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.skills, ["task-cwd-skill"]);
			assert.equal(result.skillsWarning, undefined);
		} finally {
			removeTempDir(taskCwd);
		}
	});

	it("falls back to the runtime cwd when the task cwd lacks a skill", async () => {
		const taskCwd = path.join(tempDir, "nested");
		fs.mkdirSync(taskCwd, { recursive: true });
		writePackageSkill(tempDir, "runtime-fallback-skill");
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { skills: ["runtime-fallback-skill"] })];

		const result = await runSync(tempDir, agents, "echo", "Task", { cwd: taskCwd });

		assert.equal(result.exitCode, 0);
		assert.deepEqual(result.skills, ["runtime-fallback-skill"]);
		assert.equal(result.skillsWarning, undefined);
	});

	it("fails foreground runs on explicit unavailable pi-cohort skill requests without spawning", async () => {
		const agents = [makeAgent("worker")];

		const result = await runSync(tempDir, agents, "worker", "Task", { skills: ["pi-cohort"] });

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-cohort");
		assert.equal(mockPi.callCount(), 0);
	});

	it("fails foreground runs when an agent default requests pi-cohort skill", async () => {
		const agents = [makeAgent("worker", { skills: ["pi-cohort"] })];

		const result = await runSync(tempDir, agents, "worker", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "Skills not found: pi-cohort");
		assert.equal(mockPi.callCount(), 0);
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("preserves agent-written output files instead of overwriting them with the final receipt", async () => {
		const outputPath = path.join(tempDir, "report.md");
		const artifactsDir = path.join(tempDir, "artifacts");
		mockPi.onCall({ output: `Wrote to ${outputPath}`, delay: 100 });
		const agents = makeAgentConfigs(["echo"]);

		const runPromise = runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-preserved",
			outputPath,
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		setTimeout(() => {
			fs.writeFileSync(outputPath, "real file content", "utf-8");
		}, 20);

		const result = await runPromise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "real file content");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting assistant output when the target file was not changed", async () => {
		const outputPath = path.join(tempDir, "report.md");
		fs.writeFileSync(outputPath, "stale content", "utf-8");
		mockPi.onCall({ output: "fresh assistant output" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-fallback",
			outputPath,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "fresh assistant output");
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("rejects malformed acceptance at the executor boundary before any child runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo"), makeAgent("worker")]);
		const run = (params: Record<string, unknown>) =>
			executor.execute("acceptance-boundary", params, new AbortController().signal, undefined, makeMinimalCtx(tempDir));

		const typoLevel = await run({ agent: "echo", task: "t", acceptance: { level: "verifed" } });
		assert.equal(typoLevel.isError, true);
		assert.match(typoLevel.content[0]?.text ?? "", /acceptance\.level must be one of/);

		const unknownKey = await run({ tasks: [{ agent: "worker", task: "t", acceptance: { verifyCommands: [{ id: "v", command: "npm test" }] } }] });
		assert.equal(unknownKey.isError, true);
		assert.match(unknownKey.content[0]?.text ?? "", /tasks\[0\]\.acceptance\.verifyCommands is not a recognized acceptance field/);

		const stringVerify = await run({ chain: [{ agent: "worker", task: "t" }, { parallel: [{ agent: "worker", acceptance: { verify: "npm test" } }] }] });
		assert.equal(stringVerify.isError, true);
		assert.match(stringVerify.content[0]?.text ?? "", /chain\[1\]\.parallel\[0\]\.acceptance\.verify must be an array/);

		const dynamicTemplate = await run({
			chain: [
				{ agent: "worker", task: "t", as: "seed", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "seed", path: "/items" }, maxItems: 2 },
					parallel: { agent: "worker", task: "{item}", acceptance: "verifed" },
					collect: { as: "results" },
				},
			],
		});
		assert.equal(dynamicTemplate.isError, true);
		assert.match(dynamicTemplate.content[0]?.text ?? "", /chain\[1\]\.parallel\.acceptance has invalid level 'verifed'/);

		// No child was spawned for any rejected input.
		assert.equal(fs.readdirSync(mockPi.dir).filter((name) => name.startsWith("call-")).length, 0);
	});

	it("keeps configured single output opt-in at the top-level", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);
		mockPi.onCall({ output: "inline report" });

		const omitted = await executor.execute(
			"single-output-omitted",
			{ agent: "echo", task: "Write report" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(omitted.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(omitted.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);

		mockPi.onCall({ output: "saved report" });
		const explicit = await executor.execute(
			"single-output-explicit",
			{ agent: "echo", task: "Write report", output: true },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.match(explicit.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.readFileSync(path.join(tempDir, "default-report.md"), "utf-8"), "saved report");

		fs.unlinkSync(path.join(tempDir, "default-report.md"));
		mockPi.onCall({ output: "whitespace inline report" });
		const whitespace = await executor.execute(
			"single-output-whitespace",
			{ agent: "echo", task: "Write report", output: "   " },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);
		assert.match(whitespace.content[0]?.text ?? "", /whitespace inline report/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);
	});

	it("passes disabled single output to clarify when top-level output is omitted", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "clarified inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);
		let clarifyCalled = false;
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => {
					clarifyCalled = true;
					return { confirmed: true, templates: ["Write report"], behaviorOverrides: [{}], runInBackground: false };
				},
			},
		};

		const result = await executor.execute("single-clarify-output-omitted", { agent: "echo", task: "Write report", clarify: true }, new AbortController().signal, undefined, ctx as any);

		assert.equal(clarifyCalled, true);
		assert.match(result.content[0]?.text ?? "", /clarified inline report/);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);
	});

	it("executes clarify-selected single output overrides", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		const outputPath = path.join(tempDir, "clarified-report.md");
		mockPi.onCall({ output: "clarified saved report" });
		const executor = makeExecutor();
		const ctx = {
			...makeMinimalCtx(tempDir),
			hasUI: true,
			ui: {
				custom: async () => ({
					confirmed: true,
					templates: ["Write clarified report"],
					behaviorOverrides: [{ output: outputPath }],
					runInBackground: false,
				}),
			},
		};

		const result = await executor.execute("single-clarify-output-override", { agent: "echo", task: "Write report", clarify: true }, new AbortController().signal, undefined, ctx as any);

		assert.equal(result.isError, undefined);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "clarified saved report");
		assert.ok((readCallArgs().at(-1) ?? "").includes(`Write your findings to: ${outputPath}`));
	});

	it("treats string false as disabled output in foreground single runs", { skip: !createSubagentExecutor ? "executor not importable" : undefined }, async () => {
		mockPi.onCall({ output: "inline report" });
		const executor = makeExecutor([makeAgent("echo", { output: "default-report.md" })]);

		const result = await executor.execute(
			"single-string-false-output",
			{ agent: "echo", task: "Write report", output: "false" },
			new AbortController().signal,
			undefined,
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined);
		assert.match(result.content[0]?.text ?? "", /inline report/);
		assert.doesNotMatch(result.content[0]?.text ?? "", /Output saved to:/);
		assert.equal(fs.existsSync(path.join(tempDir, "false")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "default-report.md")), false);
		assert.doesNotMatch(readCallArgs().at(-1) ?? "", /Write your findings to:/);
	});

	for (const outputMode of [undefined, "inline"] as const) {
		for (const saveError of [false, true]) {
			it(`preserves exact single inline output (${outputMode ?? "unset"}, save ${saveError ? "error" : "success"})`, async () => {
				const reply = "Complete report\nwith details";
				const parent = path.join(tempDir, "reports");
				if (saveError) fs.writeFileSync(parent, "not a directory");
				const outputPath = path.join(parent, "report.md");
				mockPi.onCall({ output: reply });
				const result = await makeExecutor().execute(
					"inline-output", { agent: "echo", task: "Write report", output: outputPath, outputMode },
					new AbortController().signal, undefined, makeMinimalCtx(tempDir),
				);
				const child = result.details.results[0];
				assert.equal(result.isError, undefined);
				assert.equal(child.finalOutput, reply);
				if (saveError) {
					assert.ok(child.outputSaveError);
					assert.equal(result.content[0].text, `${reply}\n\nOutput file error: ${outputPath}\n${child.outputSaveError}`);
					assert.equal(result.content[0].text.split("Output file error:").length - 1, 1);
				} else {
					assert.equal(child.outputReference.path, outputPath);
					assert.equal(result.content[0].text, `${reply}\n\n${child.outputReference.message}`);
					assert.equal(result.content[0].text.split("Output saved to:").length - 1, 1);
					assert.equal(fs.readFileSync(outputPath, "utf-8"), reply);
				}
			});
		}
		for (const stderr of ["child failed", ""]) {
			it(`preserves single inline failure exception (${outputMode ?? "unset"}, ${stderr ? "stderr" : "empty stderr"})`, async () => {
				const reply = "Partial reply\nwith complete details";
				mockPi.onCall({ output: reply, exitCode: 1, stderr });
				const result = await makeExecutor().execute(
					"inline-failure", { agent: "echo", task: "Write report", output: path.join(tempDir, "report.md"), outputMode },
					new AbortController().signal, undefined, makeMinimalCtx(tempDir),
				);
				const child = result.details.results[0];
				assert.equal(result.isError, true);
				assert.equal(child.exitCode, 1);
				assert.equal(child.error, stderr || undefined);
				assert.equal(result.content[0].text, stderr || "Failed");
				assert.equal(child.finalOutput, reply);
				assert.equal(utils!.getSingleResultOutput(child), reply);
				assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf-8"), reply);
			});
		}
	}

	for (const row of [
		{ name: "stderr", reply: "PRIVATE partial reply", stderr: "plain failure", existing: false },
		{ name: "empty stderr", reply: "PRIVATE partial reply", stderr: "", existing: true },
		{ name: "empty reply", reply: "", stderr: "", existing: false },
	]) {
		it(`projects file-only exit 7 (${row.name}) after preserving the reply`, async () => {
			const outputPath = path.join(tempDir, "report.md");
			if (row.existing) fs.writeFileSync(outputPath, "existing target\n");
			mockPi.onCall({ output: row.reply, stderr: row.stderr, exitCode: 7 });
			const result = await makeExecutor().execute("file-only-failure", {
				agent: "echo", task: "Write report", output: outputPath, outputMode: "file-only",
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			const child = result.details.results[0];
			const pointer = `Full reply preserved at ${child.artifactPaths.outputPath}`;
			assert.equal(result.isError, true);
			assert.equal(child.exitCode, 7);
			assert.equal(child.finalOutput, pointer);
			assert.equal(result.content[0].text, `FAILED (exit code 7)${row.stderr ? `: ${row.stderr}` : ""}\n\n${pointer}`);
			assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf8"), row.reply);
			assert.doesNotMatch(result.content[0].text, /PRIVATE/);
			assert.equal(child.savedOutputPath, undefined);
			if (row.existing) assert.equal(fs.readFileSync(outputPath, "utf8"), "existing target\n");
			else assert.equal(fs.existsSync(outputPath), false);
		});
	}

	it("projects acceptance failures after parsing the original report", async () => {
		const report = {
			criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }],
			changedFiles: [], testsAddedOrUpdated: [], commandsRun: [], validationOutput: [],
			residualRisks: [], noStagedFiles: true, notes: "test missing",
		};
		const reply = `PRIVATE analysis\n\`\`\`acceptance-report\n${JSON.stringify(report)}\n\`\`\``;
		mockPi.onCall({ output: reply });
		const result = await makeExecutor().execute("acceptance-failure", {
			agent: "echo", task: "Task", output: "report.md", outputMode: "file-only",
			acceptance: { level: "checked", criteria: [{ id: "regression", must: "Regression is covered" }] },
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		const child = result.details.results[0];
		assert.equal(child.exitCode, 1);
		assert.equal(child.finalOutput, `Full reply preserved at ${child.artifactPaths.outputPath}`);
		assert.deepEqual(child.acceptance.childReport, report);
		assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf8"), "PRIVATE analysis");
		assert.doesNotMatch(result.content[0].text, /PRIVATE analysis|acceptance-report/);
	});

	it("rethrows native output-artifact write failures", async () => {
		const artifactsDir = path.join(tempDir, "artifacts");
		const { getArtifactPaths } = await import("../../src/shared/artifacts.ts");
		const artifact = getArtifactPaths(artifactsDir, "write-failure", "echo");
		fs.mkdirSync(artifact.outputPath, { recursive: true });
		mockPi.onCall({ output: "PRIVATE reply" });
		await assert.rejects(() => runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "write-failure", outputPath: path.join(tempDir, "report.md"), outputMode: "file-only",
			artifactsDir, artifactConfig: { enabled: true, includeJsonl: false, includeMetadata: false },
		}), /EISDIR/);
	});

	it("projects file-only save errors without changing exit 0", async () => {
		const parent = path.join(tempDir, "blocker");
		fs.writeFileSync(parent, "not a directory");
		const outputPath = path.join(parent, "report.md");
		mockPi.onCall({ output: "PRIVATE full reply" });
		const result = await makeExecutor().execute("file-only-save-error", {
			agent: "echo", task: "Write report", output: outputPath, outputMode: "file-only",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		const child = result.details.results[0];
		assert.equal(child.exitCode, 0);
		assert.ok(child.outputSaveError);
		const expected = `Output file error: ${outputPath}\n${child.outputSaveError}\n\nFull reply preserved at ${child.artifactPaths.outputPath}`;
		assert.equal(result.content[0].text, expected);
		assert.equal(child.finalOutput, expected);
		assert.equal(fs.readFileSync(child.artifactPaths.outputPath, "utf8"), "PRIVATE full reply");
		assert.doesNotMatch(expected, /PRIVATE|Output saved to:/);
		assert.equal(child.savedOutputPath, undefined);
	});

	for (const row of [
		{ name: "includeOutput false", artifactsDir: true, artifactConfig: { enabled: true, includeOutput: false } },
		{ name: "enabled false", artifactsDir: true, artifactConfig: { enabled: false } },
		{ name: "no directory", artifactsDir: false, artifactConfig: { enabled: true } },
	]) {
		it(`reports disabled artifact output (${row.name})`, async () => {
			mockPi.onCall({ output: "PRIVATE reply", exitCode: 7 });
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
				runId: "disabled-output", outputPath: path.join(tempDir, "report.md"), outputMode: "file-only",
				artifactsDir: row.artifactsDir ? path.join(tempDir, "artifacts") : undefined,
				artifactConfig: row.artifactConfig,
			});
			assert.equal(result.finalOutput, "Full reply not preserved (artifact output disabled)");
		});
	}

	it("supports public artifacts false for file-only failures", async () => {
		mockPi.onCall({ output: "PRIVATE reply", exitCode: 7 });
		const result = await makeExecutor().execute("no-artifacts", {
			agent: "echo", task: "Task", output: "report.md", outputMode: "file-only", artifacts: false,
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.content[0].text, "FAILED (exit code 7)\n\nFull reply not preserved (artifact output disabled)");
	});

	it("keeps leading-blank BLOCKED handoffs in single content", async () => {
		const blocked = "\n\nBLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		mockPi.onCall({ output: blocked });
		const result = await makeExecutor().execute("blocked", {
			agent: "echo", task: "Task", output: "report.md", outputMode: "file-only",
		}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
		assert.equal(result.content[0].text, blocked);
		assert.equal(result.details.results[0].error, blocked);
		assert.equal(result.details.results[0].finalOutput, blocked);
		assert.equal(result.details.results[0].exitCode, 1);
	});

	it("rejects file-only mode without an output path before spawning", async () => {
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only-missing-path",
			outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /outputMode: "file-only"/);
		assert.equal(mockPi.callCount(), 0);
	});

	it("returns only a saved-output reference in file-only mode", async () => {
		const outputPath = path.join(tempDir, "file-only-report.md");
		const artifactsDir = path.join(tempDir, "file-only-artifacts");
		mockPi.onCall({ output: "full saved output\nwith details" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "output-file-only",
			outputPath,
			outputMode: "file-only",
			artifactsDir,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.outputMode, "file-only");
		assert.equal(result.savedOutputPath, outputPath);
		assert.equal(result.outputReference?.path, outputPath);
		assert.match(result.finalOutput ?? "", /^Output saved to:/);
		assert.match(result.finalOutput ?? "", /2 lines/);
		assert.doesNotMatch(result.finalOutput ?? "", /full saved output/);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "full saved output\nwith details");
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.equal(fs.readFileSync(result.artifactPaths.outputPath, "utf-8"), "full saved output\nwith details");
	});

	it("preserves blocker output in file-only mode", async () => {
		const outputPath = path.join(tempDir, "blocked-file-only.md");
		const blocked = "BLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		mockPi.onCall({ output: blocked });
		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			runId: "blocked-file-only", outputPath, outputMode: "file-only",
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, blocked);
		assert.equal(result.finalOutput, blocked);
		assert.doesNotMatch(result.finalOutput ?? "", /Output saved to:/);
	});

	it("passes maxSubagentDepth through to child execution env", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH"] });
		const agents = makeAgentConfigs(["echo"]);
		const prevDepth = process.env.PI_SUBAGENT_DEPTH;
		const prevMaxDepth = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		try {
			const result = await runSync(tempDir, agents, "echo", "Task", {
				runId: "depth-env",
				maxSubagentDepth: 1,
			});

			assert.equal(result.exitCode, 0);
			assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_MAX_DEPTH: "1",
			});
		} finally {
			if (prevDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = prevDepth;
			if (prevMaxDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
			else process.env.PI_SUBAGENT_MAX_DEPTH = prevMaxDepth;
		}
	});

	it("passes prompt inheritance env flags through to child execution", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_INHERIT_PROJECT_CONTEXT", "PI_SUBAGENT_INHERIT_SKILLS"] });
		const agents = [makeAgent("echo", {
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "prompt-inheritance-env",
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: "0",
			PI_SUBAGENT_INHERIT_SKILLS: "0",
		});
	});

	it("passes fanout routing env only when builtin subagent is declared", async () => {
		const envKeys = [
			SUBAGENT_FANOUT_CHILD_ENV,
			SUBAGENT_PARENT_EVENT_SINK_ENV,
			SUBAGENT_PARENT_CONTROL_INBOX_ENV,
			SUBAGENT_PARENT_RUN_ID_ENV,
			SUBAGENT_PARENT_CHILD_INDEX_ENV,
		];
		const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		try {
			process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events.jsonl";
			process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
			process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
			process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "7";

			mockPi.onCall({ echoEnv: envKeys });
			const fanoutAgents = [makeAgent("delegator", { tools: ["read", "subagent"] })];
			const fanout = await runSync(tempDir, fanoutAgents, "delegator", "Task", { runId: "fanout-run", index: 2 });
			assert.equal(fanout.exitCode, 0);
			assert.deepEqual(JSON.parse(fanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "1",
				PI_SUBAGENT_PARENT_EVENT_SINK: "/tmp/inherited/events.jsonl",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "/tmp/inherited/control",
				PI_SUBAGENT_PARENT_RUN_ID: "fanout-run",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "2",
			});

			mockPi.onCall({ echoEnv: envKeys });
			const nonFanoutAgents = [makeAgent("worker", { tools: ["read"] })];
			const nonFanout = await runSync(tempDir, nonFanoutAgents, "worker", "Task", { runId: "non-fanout-run" });
			assert.equal(nonFanout.exitCode, 0);
			assert.deepEqual(JSON.parse(nonFanout.finalOutput ?? "{}"), {
				PI_SUBAGENT_FANOUT_CHILD: "0",
				PI_SUBAGENT_PARENT_EVENT_SINK: "",
				PI_SUBAGENT_PARENT_CONTROL_INBOX: "",
				PI_SUBAGENT_PARENT_RUN_ID: "",
				PI_SUBAGENT_PARENT_CHILD_INDEX: "",
			});
		} finally {
			for (const key of envKeys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});

	it("passes run metadata through to child execution", async () => {
		mockPi.onCall({ echoEnv: [
			"PI_SUBAGENT_RUN_ID",
			"PI_SUBAGENT_CHILD_AGENT",
			"PI_SUBAGENT_CHILD_INDEX",
		] });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "78f659a3",
			index: 2,
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.finalOutput ?? "{}"), {
			PI_SUBAGENT_RUN_ID: "78f659a3",
			PI_SUBAGENT_CHILD_AGENT: "echo",
			PI_SUBAGENT_CHILD_INDEX: "2",
		});
	});

	it("passes custom tool extensions through even when explicit extensions are allowlisted", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", {
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		})];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "tool-extension-allowlist",
		});

		assert.equal(result.exitCode, 0);
		const args = readCallArgs();
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("keeps unstructured turns alive while nonproductive events prevent idle attention", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "turn_start" }] },
				...Array.from({ length: 8 }, () => ({ delay: 200, jsonl: [{ type: "heartbeat" }] })),
				{ jsonl: [events.assistantMessage("done after heartbeats")] },
			],
		});

		const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
			controlConfig: { ...DEFAULT_CONTROL_CONFIG, needsAttentionAfterMs: 600, inFlightSilenceCeilingMs: 200, inFlightSilenceKillMs: 900 },
		});

		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done after heartbeats");
		assert.ok(!result.controlEvents?.some((event) => event.type === "needs_attention"));
	});

	for (const scenario of ["delayed", "tool-only", "corrected", "unrelated-error", "invalid", "aborted", "provider-error", "cancelled", "missing-settlement", "missing-settlement-control-disabled", "active-wait"]) {
		it(`settles structured foreground output: ${scenario}`, async () => {
			const schema = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] };
			const schemaPath = path.join(tempDir, "schema.json");
			const outputPath = path.join(tempDir, "structured.json");
			fs.writeFileSync(schemaPath, JSON.stringify(schema));
			const controller = new AbortController();
			const settled = { type: "agent_settled", aborted: scenario === "aborted" };
			const missingSettlement = scenario.startsWith("missing-settlement");
			const corrected = scenario === "corrected" || scenario === "unrelated-error";
			const first = scenario === "tool-only" || corrected ? [] : [events.assistantMessage("report")];
			if (corrected || scenario === "invalid") first.push(events.toolResult("structured_output", "Structured output validation failed: Expected boolean", true));
			if (scenario === "invalid") first.push(events.assistantMessage("report after rejected call"));
			if (scenario === "unrelated-error") first.push(events.toolResult("read", "unrelated failure", true));
			const success = events.toolResult("structured_output", "Structured output captured", false);
			const providerError = { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider exploded" } };
			mockPi.onCall({
				steps: [
					{ jsonl: first },
					...(scenario === "active-wait" ? Array.from({ length: 4 }, () => ({ delay: 500, jsonl: [{ type: "turn_end" }] })) : []),
					{
						delay: scenario === "delayed" || scenario === "cancelled" ? 1500 : 0,
						...(scenario === "invalid" ? { structuredOutputError: "Expected boolean" } : { structuredOutput: { done: true } }),
						jsonl: missingSettlement ? [] : [
							...(scenario === "tool-only" || corrected ? [success] : []),
							...(scenario === "provider-error" ? [providerError] : []),
							settled,
						],
					},
				],
				keepAliveAfterFinalMessageMs: 10000,
			});
			const timer = scenario === "cancelled" ? setTimeout(() => controller.abort(), 300) : undefined;
			const start = Date.now();
			const result = await runSync(tempDir, makeAgentConfigs(["echo"]), "echo", "Task", {
				structuredOutput: { schema, schemaPath, outputPath },
				signal: controller.signal,
				...(missingSettlement || scenario === "active-wait" ? { controlConfig: { ...DEFAULT_CONTROL_CONFIG, enabled: scenario !== "missing-settlement-control-disabled", needsAttentionAfterMs: 50, inFlightSilenceCeilingMs: 700, inFlightSilenceKillMs: missingSettlement ? 8000 : 900 } } : {}),
			});
			if (timer) clearTimeout(timer);
			assert.equal(mockPi.callCount(), 1);
			assert.ok(Date.now() - start < 6000, "settlement or silence backstop must bound cleanup");
			if (["delayed", "tool-only", "corrected", "active-wait"].includes(scenario)) {
				assert.equal(result.exitCode, 0, result.error);
				assert.deepEqual((result as RunSyncResult & { structuredOutput?: unknown }).structuredOutput, { done: true });
				assert.equal(result.error, undefined);
				assert.ok(!(result.progress?.recentOutput ?? []).some((line: string) => line.includes("Forcing termination")));
				if (scenario === "delayed") assert.ok(Date.now() - start >= 1500);
			} else {
				assert.notEqual(result.exitCode, 0);
				if (scenario === "invalid") assert.match(result.error ?? "", /Structured output validation failed:/);
				if (scenario === "provider-error") assert.match(result.error ?? "", /provider exploded/);
				if (scenario === "unrelated-error") assert.match(result.error ?? "", /unrelated failure/);
				if (missingSettlement) assert.match(result.error ?? "", /awaiting structured settlement exceeded its silence ceiling/);
				if (scenario === "missing-settlement-control-disabled") {
					assert.equal(result.progress.activityState, undefined);
					assert.equal(result.controlEvents, undefined);
				}
			}
		});
	}

	it("treats forced drain after final assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [events.assistantMessage("done-before-drain")],
			stderr: "Done after 1 turn(s). Ready for input.\n",
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "done-before-drain");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("treats forced drain after empty terminal assistant output as cleanup success", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					model: "mock/test-model",
					stopReason: "stop",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
				},
			}],
			keepAliveAfterFinalMessageMs: 10000,
		});
		const agents = makeAgentConfigs(["echo"]);

		const start = Date.now();
		const result = await runSync(tempDir, agents, "echo", "Task", {});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 4000, `should clean up shortly after empty terminal stop, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "");
		assert.equal(result.progress.status, "completed");
		assert.ok(!(result.progress?.recentOutput ?? []).some((line) => line.includes("Forcing termination")));
	});

	it("keeps explicit assistant errors as failures during final-drain cleanup", async () => {
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
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "provider exploded");
		assert.equal(result.progress.status, "failed");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("soft-interrupts the current turn and returns a paused result", async () => {
		mockPi.onCall({ delay: 10000 });
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();
		const controlEvents: Array<{ type?: string; to?: string }> = [];

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			runId: "interrupt-run",
			interruptSignal: controller.signal,
			onControlEvent: (event: { type?: string; to?: string }) => {
				controlEvents.push(event);
			},
		});
		const elapsed = Date.now() - start;

		assert.ok(elapsed < 5000, `should interrupt early, took ${elapsed}ms`);
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.progress.activityState, undefined);
		assert.deepEqual(controlEvents, []);
		assert.match(result.finalOutput ?? "", /Interrupted/);
	});


	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

});
