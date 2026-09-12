import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ExternalAttemptRequest, ExternalAttemptResult, ExternalExecution } from "../../src/runs/shared/external-execution.ts";
import { runExternalBackgroundAttempt, type RunExternalBackgroundAttemptInput, type OnSynthesizedChildEvent } from "../../src/runs/background/external-attempt.ts";

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
	it("interactive argv: does not include -p or --mode json in owner request", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		await runExternalBackgroundAttempt({
			owner,
			attemptId: "attempt-1",
			args: ["Task: test"],
			environment: {},
			cwd: "/work",
			sessionFile: SESSION_FILE,
		});
		assert.equal(calls.length, 1);
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
			{ type: "tool_execution_start", toolName: "bash" },
			{ type: "message_end", toolName: undefined },
		]);
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
