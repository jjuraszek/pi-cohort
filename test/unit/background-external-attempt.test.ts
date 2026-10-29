import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import childProcess, * as childProcessNamespace from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { runSingleStep } from "../../src/runs/background/subagent-runner.ts";
import { PiRuntimeLaunchError } from "../../src/runs/shared/pi-spawn.ts";
import { applyChildEventToLifecycle, deriveActivityState, resolveControlConfig, type TurnLifecycleState } from "../../src/runs/shared/subagent-control.ts";
import { after, describe, it } from "node:test";
import type { ExternalAttemptRequest, ExternalAttemptResult, ExternalExecution } from "../../src/runs/shared/external-execution.ts";
import { runExternalBackgroundAttempt, type RunExternalBackgroundAttemptInput, type OnSynthesizedChildEvent } from "../../src/runs/background/external-attempt.ts";

import { createMockPi } from "../support/mock-pi.ts";
const mockPi = createMockPi();
const runtime = mockPi.runtime;
after(() => { mockPi.install(); mockPi.uninstall(); });

const SESSION_FILE = "/tmp/background-session.jsonl";
const REPORTING_EXTENSION_SUFFIX = path.join("execution-backend", "reporting-extension.ts");

function makeSurface() {
	return {
		protocolVersion: 1 as const,
		backend: "fake",
		surface: { kind: "pane" as const, id: "p1" },
		display: { label: "fake", hint: "safe" },
		data: "",
	};
}

function makeOwner(
	resultFactory: (request: ExternalAttemptRequest) => ExternalAttemptResult | Promise<ExternalAttemptResult>,
): { owner: ExternalExecution; calls: ExternalAttemptRequest[] } {
	const calls: ExternalAttemptRequest[] = [];
	const owner: ExternalExecution = {
		surface: makeSurface(),
		ready: Promise.resolve(),
		async runAttempt(request) {
			calls.push(request);
			return resultFactory(request);
		},
		async finish(disposition) {
			return { handle: this.surface, retained: disposition === "retained" };
		},
	};
	return { owner, calls };
}

function baseAttemptResult(overrides: Partial<ExternalAttemptResult> = {}): ExternalAttemptResult {
	return {
		attemptId: "attempt-1",
		sessionFile: SESSION_FILE,
		messages: [],
		outcome: "success",
		finalOutput: "done",
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		model: "mock/model",
		turns: 1,
		exit: { code: 0, signal: null },
		interrupted: false,
		...overrides,
	};
}

function makeInput(overrides: Partial<RunExternalBackgroundAttemptInput> = {}): RunExternalBackgroundAttemptInput {
	const { owner } = makeOwner(() => baseAttemptResult());
	// Simulate args built by buildPiArgs with baseArgs: [] -- no --mode json or -p.
	// Do NOT pass getPiSpawnCommand output as input: runExternalBackgroundAttempt calls
	// getPiSpawnCommand internally, causing a double prefix on Windows.
	return {
		runtime,
		owner,
		attemptId: "attempt-1",
		args: ["--model", "test/model", "Task: do something"],
		environment: { PATH: "/usr/bin" },
		cwd: "/exact/worktree",
		sessionFile: SESSION_FILE,
		...overrides,
	};
}

describe("runExternalBackgroundAttempt", () => {
	it("native success observes the selected Node A and Pi root rather than process B", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-selected-"));
		const nodeA = path.join(dir, path.basename(process.execPath));
		fs.copyFileSync(process.execPath, nodeA);
		fs.chmodSync(nodeA, 0o755);
		const selectedRuntime = { ...runtime, nodeExecPath: fs.realpathSync.native(nodeA) };
		assert.notEqual(selectedRuntime.nodeExecPath, fs.realpathSync.native(process.execPath));
		mockPi.install();
		mockPi.onCall({ echoRuntime: true, output: "done" });
		const outputFile = path.join(dir, "output.log");
		const result = await runSingleStep({ agent: "test", task: "test", maxSubagentDepth: 0 } as any, { runtime: selectedRuntime, cwd: dir, outputFile, id: "native", flatIndex: 0, flatStepCount: 1, placeholder: "{previous}", previousOutput: "", sessionEnabled: false } as any);
		assert.equal(result.exitCode, 0);
		const observation = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n").map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).find((event) => event?.type === "mock_runtime");
		assert.equal(observation.nodeExecPath, selectedRuntime.nodeExecPath);
		assert.equal(observation.piPackageRoot, selectedRuntime.piPackageRoot);
		mockPi.reset();
	});
	it("rejects a typed launch failure without calling the owner", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await assert.rejects(runExternalBackgroundAttempt(makeInput({ owner, runtime: { ...runtime, piEntryPath: path.join(runtime.piPackageRoot, "missing.mjs") } })), PiRuntimeLaunchError);
		assert.equal(calls.length, 0);
	});
	it("native typed launch failure cleans prompt files without retry or child launch", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-cleanup-"));
		const before = fs.readdirSync(os.tmpdir()).sort();
		const result = await runSingleStep({ agent: "test", task: "test", systemPrompt: "prompt", modelCandidates: ["first", "second"] } as any, { runtime: { ...runtime, piEntryPath: path.join(runtime.piPackageRoot, "missing.mjs") }, cwd: dir, outputFile: path.join(dir, "output.log"), id: "typed", flatIndex: 0, flatStepCount: 1, placeholder: "{previous}", previousOutput: "", sessionEnabled: false } as any);
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /missing.mjs/);
		assert.equal(result.modelAttempts?.length ?? 0, 0);
		assert.equal(mockPi.callCount(), 0);
		assert.deepEqual(fs.readdirSync(os.tmpdir()).sort(), before);
	});
	it("native spawn error with retry-looking text stops after one launch and cleans prompts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-spawn-error-"));
		const node = path.join(dir, "quota-node");
		fs.writeFileSync(node, "synthetic executable removed before spawn\n");
		fs.chmodSync(node, 0o755);
		const selectedRuntime = { ...runtime, nodeExecPath: node };
		const before = fs.readdirSync(os.tmpdir()).sort();
		let launches = 0;
		const interrupts: Array<(() => void) | undefined> = [];
		const realSpawn = childProcess.spawn;
		let spawnCalls = 0;
		const disappearingSpawn: typeof realSpawn = ((command, ...args) => {
			if (command === node) {
				spawnCalls++;
				assert.ok(fs.statSync(node).isFile());
				fs.unlinkSync(node);
			}
			return realSpawn(command, ...args);
		}) as typeof realSpawn;
		let result: Awaited<ReturnType<typeof runSingleStep>>;
		try {
			childProcess.spawn = disappearingSpawn;
			syncBuiltinESMExports();
			assert.equal(childProcessNamespace.spawn, disappearingSpawn);
			result = await runSingleStep({ agent: "test", task: "test", systemPrompt: "prompt", modelCandidates: ["first", "second"] } as any, {
				runtime: selectedRuntime, cwd: dir, outputFile: path.join(dir, "output.log"), id: "spawn", flatIndex: 0, flatStepCount: 1, placeholder: "{previous}", previousOutput: "", sessionEnabled: false,
				onAttemptStart: () => { launches++; }, registerInterrupt: (interrupt: (() => void) | undefined) => interrupts.push(interrupt),
			} as any);
		} finally {
			childProcess.spawn = realSpawn;
			syncBuiltinESMExports();
			assert.equal(childProcessNamespace.spawn, realSpawn);
		}
		assert.equal(spawnCalls, 1);
		assert.equal(fs.existsSync(node), false);
		assert.equal(launches, 1);
		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes(node));
		assert.ok(result.error?.includes(runtime.piEntryPath));
		assert.match(result.error ?? "", /^Failed to spawn selected Pi runtime .*Error: spawn .*ENOENT/);
		assert.equal(result.modelAttempts?.length ?? 0, 0);
		assert.equal(typeof interrupts[0], "function");
		assert.equal(interrupts.at(-1), undefined);
		assert.deepEqual(fs.readdirSync(os.tmpdir()).sort(), before);
	});
	it("interactive argv: does not include -p or --mode json in owner request", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt({
			runtime,
			owner,
			attemptId: "attempt-1",
			args: ["Task: test"],
			environment: {},
			cwd: "/work",
			sessionFile: SESSION_FILE,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, runtime.nodeExecPath);
		assert.equal(calls[0].args[0], runtime.piEntryPath);
		assert.ok(!calls[0].args.includes("-p"), "must not include -p (print mode)");
		assert.ok(!calls[0].args.includes("--mode"), "must not include --mode flag");
		assert.ok(!calls[0].args.includes("json"), "must not include json mode arg");
	});

	it("injects the reporting extension before the task arg", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(calls.length, 1);
		const args = calls[0].args;
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(
			extensionArgs.some((arg) => arg.endsWith(REPORTING_EXTENSION_SUFFIX)),
			`expected reporting extension in ${JSON.stringify(extensionArgs)}`,
		);
		// Task arg must be last
		assert.equal(args.at(-1), "Task: do something");
	});

	it("passes the session file and attemptId to the owner", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult({ sessionFile: SESSION_FILE }));
		await runExternalBackgroundAttempt(makeInput({ owner, sessionFile: SESSION_FILE, attemptId: "bg-attempt-5" }));
		assert.equal(calls.length, 1);
		assert.equal(calls[0].sessionFile, SESSION_FILE);
		assert.equal(calls[0].attemptId, "bg-attempt-5");
	});

	it("passes exact cwd to the owner", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner, cwd: "/exact/cwd" }));
		assert.equal(calls[0].cwd, "/exact/cwd");
	});

	it("maps a success durable outcome to exitCode 0", async () => {
		const { owner } = makeOwner(() => baseAttemptResult({ outcome: "success", exit: { code: 0, signal: null } }));
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, false);
	});

	it("maps a failed durable outcome to exitCode 1 even when exit code is zero", async () => {
		const { owner } = makeOwner(() =>
			baseAttemptResult({ outcome: "failed", error: "boom", exit: { code: 0, signal: null } }),
		);
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.exitCode, 1, "failed durable must not become success from zero exit");
		assert.equal(result.error, "boom");
		assert.equal(result.interrupted, false);
	});

	it("maps a failed durable outcome to the actual nonzero exit code when available", async () => {
		const { owner } = makeOwner(() =>
			baseAttemptResult({ outcome: "failed", error: "boom", exit: { code: 42, signal: null } }),
		);
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.exitCode, 42);
	});

	it("maps an interrupted durable outcome to exitCode 1 even when exit code is zero", async () => {
		const { owner } = makeOwner(() =>
			baseAttemptResult({ outcome: "interrupted", finalOutput: "partial", exit: { code: 0, signal: null } }),
		);
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.exitCode, 1, "interrupted durable must not become success from zero exit");
		assert.equal(result.interrupted, true);
	});

	it("maps messages, usage, model, and finalOutput from the owner result", async () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "answer" }],
				api: "test",
				provider: "test",
				model: "model-a",
				usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
				stopReason: "stop" as const,
				timestamp: 1,
			},
		];
		const { owner } = makeOwner(() =>
			baseAttemptResult({
				messages,
				usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 1, turns: 1 },
				model: "model-a",
				finalOutput: "answer",
			}),
		);
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.finalOutput, "answer");
		assert.equal(result.model, "model-a");
		assert.deepEqual(result.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 1, turns: 1 });
		assert.equal(result.messages.length, 1);
	});

	it("detects an observed mutation from an assistant tool call in messages", async () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "toolCall" as const,
						id: "t1",
						name: "edit",
						arguments: { path: "src/file.ts", oldText: "a", newText: "b" },
					},
				],
				api: "test",
				provider: "test",
				model: "model-a",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "toolUse" as const,
				timestamp: 1,
			},
		];
		const { owner } = makeOwner(() => baseAttemptResult({ messages }));
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.observedMutationAttempt, true);
	});

	it("reports no observed mutation when no mutating tool calls are present", async () => {
		const { owner } = makeOwner(() => baseAttemptResult({ messages: [] }));
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.observedMutationAttempt, false);
	});

	it("stderr is always empty (durable result replaces stderr)", async () => {
		const { owner } = makeOwner(() => baseAttemptResult({ outcome: "failed", error: "detail" }));
		const result = await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(result.stderr, "");
	});

	it("forwards signal and interruptSignal to the owner runAttempt", async () => {
		const signal = new AbortController().signal;
		const interruptSignal = new AbortController().signal;
		const capturedRequest: { signal?: AbortSignal; interruptSignal?: AbortSignal } = {};
		const owner: ExternalExecution = {
			surface: makeSurface(),
			ready: Promise.resolve(),
			async runAttempt(request) {
				capturedRequest.signal = request.signal;
				capturedRequest.interruptSignal = request.interruptSignal;
				return baseAttemptResult();
			},
			async finish(disposition) { return { handle: this.surface, retained: disposition === "retained" }; },
		};
		await runExternalBackgroundAttempt(makeInput({ owner, signal, interruptSignal }));
		assert.strictEqual(capturedRequest.signal, signal);
		assert.strictEqual(capturedRequest.interruptSignal, interruptSignal);
	});

	it("merges input environment into the owner request environment", async () => {
		const capturedEnv: Record<string, string> = {};
		const owner: ExternalExecution = {
			surface: makeSurface(),
			ready: Promise.resolve(),
			async runAttempt(request) {
				Object.assign(capturedEnv, request.environment);
				return baseAttemptResult();
			},
			async finish(disposition) { return { handle: this.surface, retained: disposition === "retained" }; },
		};
		await runExternalBackgroundAttempt(makeInput({
			owner,
			environment: { MY_VAR: "hello", PATH: "/usr/bin" },
		}));
		assert.equal(capturedEnv.MY_VAR, "hello");
		assert.equal(capturedEnv.PATH, "/usr/bin");
	});

	it("synthesizes tool_execution_start + message_end from assistant messages via onChildEvent", async () => {
		const events: Array<{ type?: string; toolName?: string }> = [];
		const onChildEvent: OnSynthesizedChildEvent = (event) => events.push({ type: event.type, toolName: event.toolName });
		let capturedOnNewSessionMessage: ((msg: unknown) => void) | undefined;
		const owner: ExternalExecution = {
			surface: { protocolVersion: 1, backend: "fake", surface: { kind: "test", id: "s" }, display: { label: "l", hint: "h" }, data: null },
			ready: Promise.resolve(),
			async runAttempt(request) {
				capturedOnNewSessionMessage = request.onNewSessionMessage;
				return baseAttemptResult();
			},
			async finish() { return { handle: this.surface, retained: false }; },
		};
		await runExternalBackgroundAttempt({ ...makeInput({ owner }), onChildEvent });
		// Simulate session watcher forwarding an assistant message with a tool call.
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }],
		};
		capturedOnNewSessionMessage?.(assistantMsg);
		assert.deepEqual(events, [
			{ type: "message_start", toolName: undefined },
			{ type: "tool_execution_start", toolName: "bash" },
			{ type: "message_end", toolName: undefined },
		]);
	});

	for (const { name, content, toolEvents } of [
		{ name: "final answer", content: [{ type: "text", text: "done" }], toolEvents: [] },
		{
			name: "several tools",
			content: [
				{ type: "toolCall", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", name: "read", arguments: { path: "file.ts" } },
			],
			toolEvents: [
				{ type: "tool_execution_start", toolName: "bash", args: { command: "ls" } },
				{ type: "tool_execution_start", toolName: "read", args: { path: "file.ts" } },
			],
		},
	]) {
		it(`synthesizes one message start and end for ${name}`, async () => {
			const events: Parameters<OnSynthesizedChildEvent>[0][] = [];
			const { owner, calls } = makeOwner(() => baseAttemptResult());
			await runExternalBackgroundAttempt(makeInput({ owner, onChildEvent: (event) => events.push(event) }));
			const forward = calls[0].onNewSessionMessage;
			assert.ok(forward);
			const finalMessage = { role: "assistant", content };
			forward(finalMessage);
			assert.deepEqual(events, [
				{ type: "message_start" },
				...toolEvents,
				{ type: "message_end", message: finalMessage },
			]);
		});
	}

	it("omits the session callback without onChildEvent", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner }));
		assert.equal(calls[0].onNewSessionMessage, undefined);
	});

	it("ignores user, system, and custom session messages", async () => {
		const events: Parameters<OnSynthesizedChildEvent>[0][] = [];
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner, onChildEvent: (event) => events.push(event) }));
		const forward = calls[0].onNewSessionMessage;
		assert.ok(forward);
		for (const role of ["user", "system", "custom"]) forward({ role, content: [] });
		assert.deepEqual(events, []);
	});

	it("propagates the same callback error synchronously", async () => {
		const sentinel = new Error("callback failed");
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner, onChildEvent: () => { throw sentinel; } }));
		const forward = calls[0].onNewSessionMessage;
		assert.ok(forward);
		assert.throws(() => forward({ role: "assistant", content: [] }), (error) => error === sentinel);
	});

	it("synthesizes tool_execution_end + tool_result_end from toolResult messages via onChildEvent", async () => {
		const events: Array<{ type?: string }> = [];
		const onChildEvent: OnSynthesizedChildEvent = (event) => events.push({ type: event.type });
		let capturedOnNewSessionMessage: ((msg: unknown) => void) | undefined;
		const owner: ExternalExecution = {
			surface: { protocolVersion: 1, backend: "fake", surface: { kind: "test", id: "s" }, display: { label: "l", hint: "h" }, data: null },
			ready: Promise.resolve(),
			async runAttempt(request) {
				capturedOnNewSessionMessage = request.onNewSessionMessage;
				return baseAttemptResult();
			},
			async finish() { return { handle: this.surface, retained: false }; },
		};
		await runExternalBackgroundAttempt({ ...makeInput({ owner }), onChildEvent });
		const toolResultMsg = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "output" }], isError: false };
		capturedOnNewSessionMessage?.(toolResultMsg);
		assert.deepEqual(events, [
			{ type: "tool_execution_end" },
			{ type: "tool_result_end" },
		]);
	});
});

describe("external replay composition", () => {
	it("keeps tool turns calm through the ceiling and closes on the final answer", async () => {
		const events: Parameters<OnSynthesizedChildEvent>[0][] = [];
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt(makeInput({ owner, onChildEvent: (event) => events.push(event) }));
		const forward = calls[0].onNewSessionMessage;
		assert.ok(forward);
		const config = resolveControlConfig();
		const startedAt = 1000;
		let lastActivityAt = startedAt;
		let lifecycle: TurnLifecycleState = {};
		let reducedCount = 0;
		const reduceNewEvents = () => {
			for (; reducedCount < events.length; reducedCount++) {
				const event = events[reducedCount];
				const now = lastActivityAt + 100;
				const message = event.message as { content?: { type?: string }[] } | undefined;
				const hasToolCall = event.type === "message_end" && Array.isArray(message?.content)
					&& message.content.some((part) => part.type === "toolCall");
				lifecycle = applyChildEventToLifecycle(lifecycle, { type: event.type, hasToolCall }, now);
				lastActivityAt = now;
			}
		};
		const activityAfter = (elapsed: number) => deriveActivityState({
			config,
			startedAt,
			lastActivityAt,
			now: lastActivityAt + elapsed,
			inFlightTurn: lifecycle.turnOpen,
			lastProductiveSignalAt: lifecycle.lastProductiveSignalAt,
		});

		forward({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 90" } }] });
		reduceNewEvents();
		assert.equal(lifecycle.turnOpen, true);
		assert.equal(lifecycle.lastProductiveSignalAt, lastActivityAt);
		assert.equal(activityAfter(config.needsAttentionAfterMs), undefined);
		assert.equal(activityAfter(config.needsAttentionAfterMs + 1), "active_long_running");
		assert.equal(config.inFlightSilenceCeilingMs, 600000);
		assert.equal(activityAfter(config.inFlightSilenceCeilingMs), "active_long_running");
		assert.equal(activityAfter(config.inFlightSilenceCeilingMs + 1), "needs_attention");
		const toolTurnActivityAt = lastActivityAt;

		forward({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "done" }], isError: false });
		reduceNewEvents();
		assert.equal(lifecycle.turnOpen, true);
		forward({ role: "assistant", content: [{ type: "text", text: "finished" }] });
		reduceNewEvents();
		assert.equal(lifecycle.turnOpen, false);
		assert.ok(lastActivityAt > toolTurnActivityAt);
		assert.equal(lifecycle.lastProductiveSignalAt, lastActivityAt);
		assert.equal(activityAfter(config.needsAttentionAfterMs + 1), "needs_attention");
	});
});
