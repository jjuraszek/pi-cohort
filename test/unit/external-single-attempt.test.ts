import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runExternalSingleAttempt } from "../../src/runs/foreground/external-single-attempt.ts";
import type { ExternalAttemptRequest, ExternalAttemptResult, ExternalExecution } from "../../src/runs/shared/external-execution.ts";
import { getPiSpawnCommand } from "../../src/runs/shared/pi-spawn.ts";
import { makeAgent, createTempDir, removeTempDir } from "../support/helpers.ts";

const SECRET_SENTINEL = "sk-test-sentinel-do-not-leak";
const SESSION_FILE = path.join(os.tmpdir(), "session.jsonl");
const REPORTING_EXTENSION_SUFFIX = path.join("execution-backend", "reporting-extension.ts");

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

function makeOwner(resultFactory: (request: ExternalAttemptRequest) => Promise<ExternalAttemptResult> | ExternalAttemptResult) {
	const calls: ExternalAttemptRequest[] = [];
	const owner: ExternalExecution = {
		surface: { protocolVersion: 1, backend: "fake", surface: { kind: "pane", id: "p1" }, display: { label: "fake", hint: "safe" }, data: "" },
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

describe("runExternalSingleAttempt", () => {
	it("requires an explicit session file before building any args", async () => {
		const { owner } = makeOwner(() => baseAttemptResult());
		const agent = makeAgent("worker");
		await assert.rejects(
			runExternalSingleAttempt({
				owner,
				attemptId: "a1",
				runtimeCwd: "/work",
				agent,
				model: undefined,
				task: "Task",
				options: { runId: "run-1" },
				shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
			}),
			/sessionFile/,
		);
	});

	it("builds interactive args: no --mode/-p, reporting extension present, exact session and trailing task", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		const agent = makeAgent("worker", { model: "anthropic/claude-sonnet-4", completionGuard: false });
		const sessionFile = path.join(os.tmpdir(), "exact-session.jsonl");
		const tempDir = createTempDir();
		try {
			const result = await runExternalSingleAttempt({
				owner,
				attemptId: "a1",
				runtimeCwd: tempDir,
				agent,
				model: agent.model,
				task: "Task",
				options: { runId: "run-1", sessionFile, cwd: tempDir },
				shared: { sessionEnabled: true, systemPrompt: "system prompt body", attemptNotes: [] },
			});

			assert.equal(result.exitCode, 0);
			assert.equal(calls.length, 1);
			const request = calls[0];
			assert.equal(request.cwd, tempDir);
			assert.equal(request.sessionFile, sessionFile);

			const commandPrefix = getPiSpawnCommand([]).args;
			assert.deepEqual(request.args.slice(0, commandPrefix.length), commandPrefix);
			assert.deepEqual(request.args.slice(commandPrefix.length, commandPrefix.length + 2), ["--session", sessionFile]);
			assert.ok(!request.args.includes("--mode"), "must not run in json mode");
			assert.ok(!request.args.includes("-p"), "must not run in print mode");
			assert.ok(!request.args.includes("json"));

			const extensionArgs = request.args.filter((arg, index) => request.args[index - 1] === "--extension");
			assert.ok(
				extensionArgs.some((arg) => arg.endsWith(REPORTING_EXTENSION_SUFFIX)),
				`expected reporting extension in ${JSON.stringify(extensionArgs)}`,
			);

			assert.equal(request.args.at(-1), "Task: Task");
			assert.ok(request.args.includes("--model"));
			assert.equal(request.args[request.args.indexOf("--model") + 1], "anthropic/claude-sonnet-4");
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("preserves normal extension discovery when agent extensions are absent", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		const agent = makeAgent("worker");
		await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent,
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.ok(!calls[0].args.includes("--no-extensions"));
	});

	it("keeps --no-extensions and includes both reporting and user/runtime extensions when extensions are explicit", async () => {
		const { owner, calls } = makeOwner(() => baseAttemptResult());
		const agent = makeAgent("worker", { extensions: ["./user-ext.ts"] });
		await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent,
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		const args = calls[0].args;
		assert.ok(args.includes("--no-extensions"));
		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.includes("./user-ext.ts"));
		assert.ok(extensionArgs.some((arg) => arg.endsWith(REPORTING_EXTENSION_SUFFIX)));
	});

	it("keeps the API key/token sentinel out of argv, error, and result metadata while still passing it through env", async () => {
		const { owner, calls } = makeOwner((request) => {
			assert.equal(request.environment.SUPER_SECRET_TOKEN, SECRET_SENTINEL);
			return baseAttemptResult();
		});
		const agent = makeAgent("worker");
		const savedToken = process.env.SUPER_SECRET_TOKEN;
		process.env.SUPER_SECRET_TOKEN = SECRET_SENTINEL;
		try {
			const result = await runExternalSingleAttempt({
				owner,
				attemptId: "a1",
				runtimeCwd: "/work",
				agent,
				model: undefined,
				task: "Task",
				options: { runId: "run-1", sessionFile: SESSION_FILE },
				shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
			});
			assert.ok(!calls[0].args.join(" ").includes(SECRET_SENTINEL));
			assert.ok(!JSON.stringify(result).includes(SECRET_SENTINEL));
		} finally {
			if (savedToken === undefined) delete process.env.SUPER_SECRET_TOKEN;
			else process.env.SUPER_SECRET_TOKEN = savedToken;
		}
	});

	it("maps owner messages/usage/model/finalOutput/exit into SingleResult", async () => {
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "answer" }],
			api: "test", provider: "test", model: "model-a",
			usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
			stopReason: "stop" as const,
			timestamp: 1,
		}];
		const { owner } = makeOwner(() => baseAttemptResult({
			messages,
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 1, turns: 1 },
			model: "model-a",
			finalOutput: "answer",
			exit: { code: 0, signal: null },
		}));
		const agent = makeAgent("worker");
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent,
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "model-a");
		assert.equal(result.finalOutput, "answer");
		assert.deepEqual(result.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 1, turns: 1 });
		assert.equal(result.messages?.length, 1);
	});

	it("maps a failed owner outcome into an error result", async () => {
		const { owner } = makeOwner(() => baseAttemptResult({ outcome: "failed", error: "boom", exit: { code: 1, signal: null } }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker"),
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "boom");
	});

	it("maps an interrupted owner outcome the same way native interruption is mapped", async () => {
		const { owner } = makeOwner(() => baseAttemptResult({ outcome: "interrupted", finalOutput: "partial", exit: { code: null, signal: "SIGTERM" } }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker"),
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "partial");
	});

	it("reclassifies a hidden tool error (exitCode 0, isError toolResult) as a failed result via the shared finalizer", async () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "t1", name: "bash", arguments: { command: "rm -rf /nonexistent" } }],
				api: "test", provider: "test", model: "model-a",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "toolUse" as const,
				timestamp: 1,
			},
			{
				role: "toolResult" as const,
				toolCallId: "t1",
				toolName: "bash",
				isError: true,
				content: [{ type: "text" as const, text: "permission denied" }],
				timestamp: 2,
			},
		];
		const { owner } = makeOwner(() => baseAttemptResult({ messages, finalOutput: "", exit: { code: 0, signal: null } }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker", { completionGuard: false }),
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /bash failed \(exit 1\): permission denied/);
	});

	it("classifies BLOCKED: output as a failed result via the shared finalizer", async () => {
		const blocked = "BLOCKED: need approval\nDone: inspected\nRemaining: rotate key";
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: blocked }],
			api: "test", provider: "test", model: "model-a",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			stopReason: "stop" as const,
			timestamp: 1,
		}];
		const { owner } = makeOwner(() => baseAttemptResult({ messages, finalOutput: blocked }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker"),
			model: undefined,
			task: "Implement the approved deployment",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, blocked);
		assert.equal(result.finalOutput, blocked);
	});

	it("fails implementation runs that complete without an observed mutation attempt", async () => {
		const messages = [{
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Validation:\nlet rawFilename = params.filename.trim();" }],
			api: "test", provider: "test", model: "model-a",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
			stopReason: "stop" as const,
			timestamp: 1,
		}];
		const { owner } = makeOwner(() => baseAttemptResult({ messages, finalOutput: "Validation:\nlet rawFilename = params.filename.trim();" }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker"),
			model: undefined,
			task: "Implement the approved file changes",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /completed without making edits/);
	});

	it("allows implementation runs when a replayed assistant tool call is a mutating edit", async () => {
		const messages = [
			{
				role: "assistant" as const,
				content: [{ type: "toolCall" as const, id: "t1", name: "edit", arguments: { path: "src/file.ts", oldText: "a", newText: "b" } }],
				api: "test", provider: "test", model: "model-a",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "toolUse" as const,
				timestamp: 1,
			},
			{
				role: "assistant" as const,
				content: [{ type: "text" as const, text: "Applied edit" }],
				api: "test", provider: "test", model: "model-a",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
				stopReason: "stop" as const,
				timestamp: 2,
			},
		];
		const { owner } = makeOwner(() => baseAttemptResult({ messages, finalOutput: "Applied edit" }));
		const result = await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker"),
			model: undefined,
			task: "Implement the approved file changes",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.finalOutput, "Applied edit");
	});

	it("reads structured output the same way native single attempts do", async () => {
		const tempDir = createTempDir();
		try {
			const outputPath = `${tempDir}/structured.json`;
			const schemaPath = `${tempDir}/schema.json`;
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }), "utf-8");
			// Written from the resultFactory (mimicking the child writing it during the
			// owner attempt) so it lands after initializeAttempt's pre-run cleanup.
			const { owner } = makeOwner(() => {
				fs.writeFileSync(outputPath, JSON.stringify({ ok: true }), "utf-8");
				return baseAttemptResult();
			});
			const result = await runExternalSingleAttempt({
				owner,
				attemptId: "a1",
				runtimeCwd: tempDir,
				agent: makeAgent("worker", { completionGuard: false }),
				model: undefined,
				task: "Task",
				options: {
					runId: "run-1",
					sessionFile: SESSION_FILE,
					structuredOutput: { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, schemaPath, outputPath },
				},
				shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] },
			});
			assert.equal(result.exitCode, 0);
			assert.deepEqual(result.structuredOutput, { ok: true });
		} finally {
			removeTempDir(tempDir);
		}
	});

	it("cleans up the temp prompt directory on success", async () => {
		let promptDir = "";
		const { owner } = makeOwner((request) => {
			const promptFlagIndex = request.args.indexOf("--system-prompt");
			const promptPath = request.args[promptFlagIndex + 1];
			assert.ok(promptPath);
			promptDir = path.dirname(promptPath);
			assert.equal(fs.existsSync(promptDir), true);
			return baseAttemptResult();
		});
		await runExternalSingleAttempt({
			owner,
			attemptId: "a1",
			runtimeCwd: "/work",
			agent: makeAgent("worker", { systemPromptMode: "replace" }),
			model: undefined,
			task: "Task",
			options: { runId: "run-1", sessionFile: SESSION_FILE },
			shared: { sessionEnabled: true, systemPrompt: "a non-empty system prompt", attemptNotes: [] },
		});
		assert.equal(fs.existsSync(promptDir), false);
	});

	it("cleans up the temp prompt directory even when the owner attempt throws", async () => {
		let promptDir = "";
		const owner: ExternalExecution = {
			surface: { protocolVersion: 1, backend: "fake", surface: { kind: "pane", id: "p1" }, display: { label: "fake", hint: "safe" }, data: "" },
			ready: Promise.resolve(),
			async runAttempt(request) {
				const promptFlagIndex = request.args.indexOf("--system-prompt");
				const promptPath = request.args[promptFlagIndex + 1];
				assert.ok(promptPath);
				promptDir = path.dirname(promptPath);
				assert.equal(fs.existsSync(promptDir), true);
				throw new Error("owner attempt failed safely");
			},
			async finish(disposition) {
				return { handle: this.surface, retained: disposition === "retained" };
			},
		};
		await assert.rejects(
			runExternalSingleAttempt({
				owner,
				attemptId: "a1",
				runtimeCwd: "/work",
				agent: makeAgent("worker", { systemPromptMode: "replace" }),
				model: undefined,
				task: "Task",
				options: { runId: "run-1", sessionFile: SESSION_FILE },
				shared: { sessionEnabled: true, systemPrompt: "a non-empty system prompt", attemptNotes: [] },
			}),
			/owner attempt failed safely/,
		);
		assert.equal(fs.existsSync(promptDir), false);
	});
});
