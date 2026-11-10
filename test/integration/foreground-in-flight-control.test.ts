/**
 * Integration tests: in-flight turn awareness in the foreground control watchdog.
 *
 * Verifies that a silent gap INSIDE an open turn (after message_start, before
 * message_end) is capped by inFlightSilenceCeilingMs rather than by
 * needsAttentionAfterMs.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeAgent,
	makeMinimalCtx,
	removeTempDir,
	makeAgentConfigs,
	events,
	tryImport,
} from "../support/helpers.ts";

interface RunSyncResult {
	exitCode: number;
	error?: string;
	controlEvents?: Array<{ type?: string; message: string; reason?: string }>;
	progress: { activityState?: string; status: string };
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

const executorModule = await import("../../src/runs/foreground/subagent-executor.ts");
const execution = await tryImport<ExecutionModule>("./src/runs/foreground/execution.ts");
const available = !!execution;
const runSync = execution?.runSync;

describe("foreground in-flight turn control", { skip: !available ? "pi packages not available" : undefined }, () => {
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

	it("interrupt with an index naming no running child errors", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 2_000, jsonl: [events.assistantMessage("Sibling completed")] },
			],
		});
		const state = {
			baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(),
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
			foregroundControls: new Map(), lastForegroundControlId: null,
		};
		const executor = executorModule.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state,
			resolveConfig: () => ({ control: { enabled: false } }),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({ agents: [makeAgent("echo")] }),
		});
		const controller = new AbortController();
		const ctx = makeMinimalCtx(tempDir);
		const pending = executor.execute("invalid-child-index", {
			tasks: [0, 1, 2].map((index) => ({ agent: "echo", task: `Task ${index}` })),
			async: false,
		}, controller.signal, undefined, ctx);
		try {
			const deadline = Date.now() + 5_000;
			while (mockPi.callCount() < 3 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(mockPi.callCount(), 3, "all three children must start before the request");
			const [runId] = state.foregroundControls.keys();
			assert.ok(runId, "the foreground run must still be in flight");
			const response = await executor.execute("invalid-stop", {
				action: "interrupt", id: runId, index: 3,
			}, undefined, undefined, ctx);
			const result = await pending;
			assert.equal(response.isError, true, "index 3 names no running child and must return an error");
			assert.match(response.content[0].text, /no running child at index 3/);
			assert.equal(result.details.results.length, 3);
			for (const child of result.details.results) {
				assert.equal(child.exitCode, 0);
				assert.notEqual(child.interrupted, true, "an invalid index must stop no child");
				assert.equal(child.finalOutput, "Sibling completed");
			}
		} finally {
			controller.abort();
			await pending;
		}
	});

	it("treats a silent in-flight turn under the ceiling as active_long_running, not needs_attention", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 1_300, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-inflight",
			// 1s: message_start from a real child must land before the attention timer under full-suite load
			controlConfig: { enabled: true, needsAttentionAfterMs: 1_000, inFlightSilenceCeilingMs: 100_000, activeNoticeAfterMs: 100_000, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.equal(result.exitCode, 0);
		assert.ok(!controlEvents.some((e) => e.type === "needs_attention"), "must not flag needs_attention mid-turn");
	});

	it("escalates a silent in-flight turn past the ceiling to needs_attention", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 1_300, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-ceiling",
			controlConfig: { enabled: true, needsAttentionAfterMs: 200, inFlightSilenceCeilingMs: 500, activeNoticeAfterMs: 100_000, notifyOn: ["active_long_running", "needs_attention"] },
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.equal(result.exitCode, 0);
		assert.ok(controlEvents.some((e) => e.type === "needs_attention"), "must escalate once silence exceeds the ceiling");
	});

	it("SIGTERMs an in-flight turn that stays silent past inFlightSilenceKillMs", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 5_000, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const controlEvents: NonNullable<RunSyncResult["controlEvents"]> = [];
		const result = await runSync!(tempDir, agents, "echo", "Think hard", {
			runId: "run-killcap",
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				inFlightSilenceCeilingMs: 300,
				inFlightSilenceKillMs: 600,
				activeNoticeAfterMs: 100_000,
				notifyOn: ["active_long_running", "needs_attention"],
			},
			onControlEvent: (event: NonNullable<RunSyncResult["controlEvents"]>[number]) => controlEvents.push(event),
		});
		assert.notEqual(result.exitCode, 0, "killed run must settle non-zero");
		assert.ok(controlEvents.some((e) => e.type === "needs_attention"), "needs_attention must be emitted before the kill");
		assert.notEqual(result.progress.status, "interrupted");
		assert.ok(result.error?.includes("inFlightSilenceKillMs"), "error must name the cap");
	});

	it("does not kill a turn that keeps emitting events past the kill cap", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: [events.messageStart()] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.toolStart("read"), events.toolEnd("read")] },
				{ delay: 600, jsonl: [events.assistantMessage("done")] },
			],
		});
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync!(tempDir, agents, "echo", "Stream", {
			runId: "run-streaming",
			controlConfig: {
				enabled: true,
				needsAttentionAfterMs: 200,
				inFlightSilenceCeilingMs: 400,
				inFlightSilenceKillMs: 1_200,
				activeNoticeAfterMs: 100_000,
				notifyOn: ["active_long_running", "needs_attention"],
			},
		});
		assert.equal(result.exitCode, 0, "a streaming child must run to completion");
	});
});
