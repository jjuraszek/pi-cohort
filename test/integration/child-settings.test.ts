/**
 * Hermetic integration test for per-child settings overrides.
 *
 * Proves a `settings` override from the call or the agent config reaches the
 * child it was written for, and only that child, through foreground
 * (runSync -> buildPiArgs) and async (executeAsyncSingle/executeAsyncChain ->
 * subagent-runner -> buildPiArgs) dispatch. The mock pi binary replies with the
 * settings.json of the agent directory it was launched with; no real model calls.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MockPi } from "../support/helpers.ts";
import { createEventBus, createMockPi, createTempDir, makeAgent, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

interface ExecuteResult {
	isError?: boolean;
	content: Array<{ text?: string }>;
	details: { asyncId?: string; results: Array<{ finalOutput?: string }> };
}

interface ExecutorModule {
	createSubagentExecutor(deps: Record<string, unknown>): {
		execute(id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: undefined, ctx: unknown): Promise<ExecuteResult>;
	};
}

const executorMod = await tryImport<ExecutorModule>("./src/runs/foreground/subagent-executor.ts");
const asyncMod = await tryImport<{ isAsyncAvailable(runtime: unknown): boolean }>("./src/runs/background/async-execution.ts");
const typesMod = await tryImport<{ RESULTS_DIR: string }>("./src/shared/types.ts");
const agentDirMod = await tryImport<{ PINNED_AGENT_DIR: string }>("./src/shared/agent-dir.ts");
const available = !!(executorMod && asyncMod && typesMod && agentDirMod);
const asyncAvailable = available && asyncMod!.isAsyncAvailable(createMockPi().runtime);
// The suite writes the parent's settings.json, so it runs only against the isolated test home.
const parentAgentDir = agentDirMod?.PINNED_AGENT_DIR ?? "";
const isolated = parentAgentDir === path.join(os.homedir(), ".pi", "agent") && path.basename(path.dirname(os.homedir())).startsWith("pct-");
const skip = !available ? "pi packages not available" : !isolated ? "needs the isolated test home" : undefined;

const PARENT_SETTINGS = { theme: "dark", contextPrune: { pruneOn: "agent-message", keep: 3 } };
const NEXT_PROMPT = { contextPrune: { pruneOn: "next-prompt" } };

async function waitForAsyncResultFile(id: string, timeoutMs = 30_000): Promise<{ results: Array<{ output?: string }> }> {
	const resultPath = path.join(typesMod!.RESULTS_DIR, `${id}.json`);
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(resultPath)) {
		if (Date.now() > deadline) assert.fail(`Timed out waiting for async result file: ${resultPath}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return JSON.parse(fs.readFileSync(resultPath, "utf-8"));
}

function seenSettings(output: string | undefined): unknown {
	return JSON.parse(output ?? "null");
}

describe("child settings override", { skip }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const parentSettingsPath = path.join(parentAgentDir, "settings.json");

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
		fs.mkdirSync(parentAgentDir, { recursive: true });
		fs.writeFileSync(parentSettingsPath, JSON.stringify(PARENT_SETTINGS));
	});

	after(() => {
		mockPi.uninstall();
		fs.rmSync(parentSettingsPath, { force: true });
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
		mockPi.onCall({ echoAgentSettings: true });
	});

	afterEach(() => {
		removeTempDir(tempDir);
		assert.deepEqual(JSON.parse(fs.readFileSync(parentSettingsPath, "utf-8")), PARENT_SETTINGS, "the parent's settings.json must stay untouched");
	});

	function execute(id: string, params: Record<string, unknown>): Promise<ExecuteResult> {
		const executor = executorMod!.createSubagentExecutor({
			captureRuntime: mockPi.captureRuntime,
			pi: { events: createEventBus(), getSessionName: () => undefined },
			state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null },
			resolveConfig: () => ({}),
			tempArtifactsDir: tempDir,
			getSubagentSessionRoot: () => tempDir,
			expandTilde: (value: string) => value,
			discoverAgents: () => ({
				agents: [
					makeAgent("scout"),
					makeAgent("one-shot", { settings: { ...NEXT_PROMPT, theme: "light" } }),
				],
			}),
		});
		return executor.execute(id, { clarify: false, ...params }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
	}

	it("applies a task's override to that child and not to its sibling", async () => {
		const result = await execute("parallel", { tasks: [{ agent: "scout", task: "a", settings: NEXT_PROMPT }, { agent: "scout", task: "b" }] });
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(result.details.results.map((child) => seenSettings(child.finalOutput)), [
			{ theme: "dark", contextPrune: { pruneOn: "next-prompt", keep: 3 } },
			PARENT_SETTINGS,
		]);
	});

	it("applies an agent's override to every launch of it, and lets the call win key by key", async () => {
		const fromAgent = await execute("agent", { agent: "one-shot", task: "a" });
		assert.equal(fromAgent.isError, undefined, fromAgent.content[0]?.text);
		assert.deepEqual(seenSettings(fromAgent.details.results[0]?.finalOutput), { theme: "light", contextPrune: { pruneOn: "next-prompt", keep: 3 } });

		const fromCall = await execute("call", { agent: "one-shot", task: "a", settings: { contextPrune: { pruneOn: "agent-message" } } });
		assert.equal(fromCall.isError, undefined, fromCall.content[0]?.text);
		assert.deepEqual(seenSettings(fromCall.details.results[0]?.finalOutput), { theme: "light", contextPrune: { pruneOn: "agent-message", keep: 3 } });
	});

	it("applies overrides on chain steps and their parallel members", async () => {
		const result = await execute("chain", {
			chain: [
				{ agent: "scout", task: "one", settings: NEXT_PROMPT },
				{ parallel: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b", settings: { theme: "light" } }] },
			],
		});
		assert.equal(result.isError, undefined, result.content[0]?.text);
		assert.deepEqual(result.details.results.map((child) => seenSettings(child.finalOutput)), [
			{ theme: "dark", contextPrune: { pruneOn: "next-prompt", keep: 3 } },
			PARENT_SETTINGS,
			{ theme: "light", contextPrune: { pruneOn: "agent-message", keep: 3 } },
		]);
	});

	it("rejects a user-only key by name before launching any child", async () => {
		const result = await execute("rejected", {
			tasks: [{ agent: "scout", task: "a" }, { agent: "scout", task: "b", settings: { defaultProjectTrust: "always" } }],
		});
		assert.equal(result.isError, true);
		assert.equal(
			result.content[0]?.text,
			"Invalid settings override:\n- tasks[1].settings.defaultProjectTrust cannot be overridden for a child: pi takes it only from the user's own settings.json.",
		);
		assert.equal(mockPi.callCount(), 0);
	});

	it("applies an async child's override", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const launch = await execute("async-single", { agent: "one-shot", task: "a", async: true, settings: { theme: "call" } });
		assert.ok(launch.details.asyncId, launch.content[0]?.text);
		const persisted = await waitForAsyncResultFile(launch.details.asyncId);
		assert.deepEqual(seenSettings(persisted.results[0]?.output), { theme: "call", contextPrune: { pruneOn: "next-prompt", keep: 3 } });
	});

	it("applies overrides on async chain steps and their parallel members", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const launch = await execute("async-chain", {
			chain: [
				{ agent: "scout", task: "one", settings: NEXT_PROMPT },
				{ parallel: [{ agent: "scout", task: "a" }, { agent: "one-shot", task: "b", settings: { theme: "call" } }] },
			],
			async: true,
		});
		assert.ok(launch.details.asyncId, launch.content[0]?.text);
		const persisted = await waitForAsyncResultFile(launch.details.asyncId);
		assert.deepEqual(persisted.results.map((child) => seenSettings(child.output)), [
			{ theme: "dark", contextPrune: { pruneOn: "next-prompt", keep: 3 } },
			PARENT_SETTINGS,
			{ theme: "call", contextPrune: { pruneOn: "next-prompt", keep: 3 } },
		]);
	});

	it("applies a task's override in an async parallel run and not to its sibling", { skip: !asyncAvailable ? "jiti not available" : undefined }, async () => {
		const launch = await execute("async-parallel", { tasks: [{ agent: "scout", task: "a", settings: NEXT_PROMPT }, { agent: "scout", task: "b" }], async: true });
		assert.ok(launch.details.asyncId, launch.content[0]?.text);
		const persisted = await waitForAsyncResultFile(launch.details.asyncId);
		assert.deepEqual(persisted.results.map((child) => seenSettings(child.output)), [
			{ theme: "dark", contextPrune: { pruneOn: "next-prompt", keep: 3 } },
			PARENT_SETTINGS,
		]);
	});
});
