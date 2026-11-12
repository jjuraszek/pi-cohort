import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, it } from "node:test";

import { ASYNC_DIR } from "../../src/shared/types.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { registerSlashSubagentBridge } from "../../src/slash/slash-bridge.ts";
import { createMockPi, events as childEvents, makeAgent, makeMinimalCtx } from "../support/helpers.ts";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

type RegisteredSlashCommand = { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown };

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: RegisteredSlashCommand,
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			safetyRescanTimer: ReturnType<typeof setInterval> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
	) => void;
}

interface SlashLiveStateModule {
	clearSlashSnapshots?: typeof import("../../src/slash/slash-live-state.ts").clearSlashSnapshots;
	getSlashRenderableSnapshot?: typeof import("../../src/slash/slash-live-state.ts").getSlashRenderableSnapshot;
	resolveSlashMessageDetails?: typeof import("../../src/slash/slash-live-state.ts").resolveSlashMessageDetails;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let clearSlashSnapshots: SlashLiveStateModule["clearSlashSnapshots"];
let getSlashRenderableSnapshot: SlashLiveStateModule["getSlashRenderableSnapshot"];
let resolveSlashMessageDetails: SlashLiveStateModule["resolveSlashMessageDetails"];
let available = true;
try {
	({ registerSlashCommands } = await import("../../src/slash/slash-commands.ts") as RegisterSlashCommandsModule);
	({ clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails } = await import("../../src/slash/slash-live-state.ts") as SlashLiveStateModule);
} catch {
	available = false;
}

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(event, current.filter((entry) => entry !== handler));
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		safetyRescanTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-slash-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		fs.rmSync(home, { recursive: true, force: true });
	}
}


function createCommandContext(
	overrides: Partial<{
		cwd: string;
		hasUI: boolean;
		custom: (...args: unknown[]) => Promise<unknown>;
		notify: (message: string, type?: string) => void;
		setStatus: (key: string, text: string | undefined) => void;
		setToolsExpanded: (expanded: boolean) => void;
		sessionManager: unknown;
	}> = {},
) {
	return {
		cwd: overrides.cwd ?? process.cwd(),
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: overrides.notify ?? ((_message: string) => {}),
			setStatus: overrides.setStatus ?? ((_key: string, _text: string | undefined) => {}),
			setToolsExpanded: overrides.setToolsExpanded ?? ((_expanded: boolean) => {}),
			onTerminalInput: () => () => {},
			custom: overrides.custom ?? (async () => undefined),
		},
		modelRegistry: { getAvailable: () => [] },
		sessionManager: overrides.sessionManager ?? {
			getSessionFile: () => null,
			getSessionId: () => "session-test",
		},
	};
}

async function withTempProject<T>(prefix: string, fn: (root: string) => Promise<T>): Promise<T> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(root, ".pi", "agents"), { recursive: true });
	fs.mkdirSync(path.join(root, ".pi", "chains"), { recursive: true });
	try {
		return await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeProjectChain(root: string, fileName: string, content: string): void {
	fs.writeFileSync(path.join(root, ".pi", "chains", fileName), content, "utf-8");
}

async function captureSlashCommandParams(
	commandName: string,
	args: string,
	cwd: string,
	setup?: () => void,
): Promise<{ params: unknown; notifications: string[] }> {
	return withIsolatedHome(async () => {
		setup?.();
		const commands = new Map<string, RegisteredSlashCommand>();
		const events = createEventBus();
		let requestedParams: unknown;
		const notifications: string[] = [];
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: `${commandName} finished` }],
					details: { mode: "chain", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: RegisteredSlashCommand) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(cwd));
		await commands.get(commandName)!.handler(args, createCommandContext({
			cwd,
			notify: (message) => {
				notifications.push(message);
			},
		}));
		return { params: requestedParams, notifications };
	});
}

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run accepts an agent without a task", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		const sessionManager = {
			flushed: false,
			rewrites: 0,
			getSessionFile: () => "session.jsonl",
			_rewriteFile() {
				this.rewrites++;
			},
		};
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "Commit finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout", createCommandContext({ sessionManager }));

		assert.deepEqual(requestedParams, { agent: "scout", task: "", clarify: false, agentScope: "both" });
		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "Running subagent...");
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Commit finished/);
		assert.equal(sessionManager.rewrites, 2);
		assert.equal(sessionManager.flushed, true);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on success", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [{ sessionFile: "/tmp/child-session.jsonl" }] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Scout finished/);
		assert.match((sent[1] as { content?: string }).content ?? "", /Child session exports\n\n- `\/tmp\/child-session\.jsonl`/);
		assert.deepEqual(log, ["send:visible", "status:│ running...", "send:visible", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Scout finished");
	});

	it("/run collapses tool detail before showing the initial live card", async () => {
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: { content: [{ type: "text", text: "done" }], details: { mode: "single", results: [] } },
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage() {
				log.push("send");
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setToolsExpanded: (expanded) => log.push(`expanded:${String(expanded)}`),
		}));

		assert.deepEqual(log.slice(0, 2), ["expanded:false", "send"]);
	});

	it("/run finalizes the slash snapshot before the last UI redraw on error", async () => {
		const sent: unknown[] = [];
		const log: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
				log.push(`send:${(message as { display?: boolean }).display === false ? "hidden" : "visible"}`);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext({
			hasUI: true,
			setStatus: (_key, text) => {
				log.push(`status:${text ?? "clear"}`);
			},
		}));

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[0] as { display?: boolean }).display, true);
		assert.equal((sent[0] as { content?: string }).content, "inspect this");
		assert.equal((sent[1] as { customType?: string; display?: boolean }).customType, SLASH_RESULT_TYPE);
		assert.equal((sent[1] as { display?: boolean }).display, true);
		assert.match((sent[1] as { content?: string }).content ?? "", /Subagent failed/);
		assert.deepEqual(log, ["send:visible", "status:│ running...", "send:visible", "status:clear"]);

		const visibleDetails = resolveSlashMessageDetails!((sent[0] as { details?: unknown }).details);
		assert.ok(visibleDetails);
		const visibleSnapshot = getSlashRenderableSnapshot!(visibleDetails!);
		assert.equal((visibleSnapshot.result.content[0] as { text?: string }).text, "Subagent failed");
	});

	it("/parallel forwards inline output behavior config", async () => {
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedParams: unknown;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: unknown };
			requestedParams = payload.params;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(_message: unknown) {},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("parallel")!.handler("scout[output=x.md,outputMode=file-only,reads=a.md+b.md,progress] -- Review", createCommandContext());

		assert.deepEqual(requestedParams, {
			tasks: [{ agent: "scout", task: "Review", output: "x.md", outputMode: "file-only", reads: ["a.md", "b.md"], progress: true }],
			clarify: false,
			agentScope: "both",
		});
	});

	it("/parallel no longer hard-blocks runs above the old 8-task limit before the executor responds", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		let requestedTasks = 0;
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const payload = data as { requestId: string; params?: { tasks?: unknown[] } };
			requestedTasks = payload.params?.tasks?.length ?? 0;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId: payload.requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId: payload.requestId,
				result: {
					content: [{ type: "text", text: "parallel finished" }],
					details: { mode: "parallel", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		const args = Array.from({ length: 9 }, (_, index) => `scout \"task ${index + 1}\"`).join(" -> ");
		await commands.get("parallel")!.handler(args, createCommandContext());

		assert.equal(requestedTasks, 9);
		assert.equal(sent.length, 2);
		assert.match((sent[1] as { content?: string }).content ?? "", /parallel finished/);
	});
});

describe("saved chain slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("/run-chain keeps stopOn on sequential saved-chain steps", async () => {
		await withTempProject("pi-chain-stop-on-", async (root) => {
			const schemas = path.join(root, ".pi", "chains", "schemas");
			fs.mkdirSync(schemas);
			fs.writeFileSync(path.join(schemas, "verdict.json"), '{"type":"object"}');
			writeProjectChain(root, "verdict-flow.chain.md", `---
name: verdict-flow
description: Review
---

## reviewer
outputSchema: schemas/verdict.json
stopOn: {"path":"/verdict","in":["FAIL"]}

Review
`);
			const chain = await captureSlashCommandParams("run-chain", "verdict-flow -- Review", root);
			assert.deepEqual((chain.params as { chain: Array<{ stopOn?: unknown }> }).chain[0].stopOn, { path: "/verdict", in: ["FAIL"] });
		});
	});

	it("/run and /chain accept dotted packaged runtime agent names", async () => {
		await withTempProject("pi-packaged-agent-slash-", async (root) => {
			fs.writeFileSync(path.join(root, ".pi", "agents", "code-analysis.scout.md"), `---
name: scout
package: code-analysis
description: Fast recon
---

Inspect
`, "utf-8");
			fs.writeFileSync(path.join(root, ".pi", "agents", "documentation.writer.md"), `---
name: writer
package: documentation
description: Writer
---

Write
`, "utf-8");

			const run = await captureSlashCommandParams("run", "code-analysis.scout Investigate", root);
			assert.deepEqual(run.params, { agent: "code-analysis.scout", task: "Investigate", clarify: false, agentScope: "both" });

			const chain = await captureSlashCommandParams("chain", "code-analysis.scout \"Scan\" -> documentation.writer", root);
			assert.deepEqual((chain.params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan" },
				{ agent: "documentation.writer", task: undefined },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const runCompletions = commands.get("run")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(runCompletions.map((completion) => completion.value), ["code-analysis.scout"]);
				const chainCompletions = commands.get("chain")!.getArgumentCompletions!("code-analysis.scout \"Scan\" -> doc") as Array<{ value: string; label: string }>;
				assert.deepEqual(chainCompletions.map((completion) => completion.value), ["code-analysis.scout \"Scan\" -> documentation.writer"]);
			});
		});
	});

	it("/chain dispatches with clarify: false", async () => {
		await withTempProject("pi-chain-clarify-", async (root) => {
			const { params } = await captureSlashCommandParams("chain", 'scout "Scan the diff" -> reviewer', root);
			const chainParams = params as { chain?: Array<{ agent?: string }>; clarify?: boolean; agentScope?: string };

			assert.deepEqual(chainParams.chain?.map(({ agent }) => agent), ["scout", "reviewer"]);
			assert.equal(chainParams.clarify, false);
			assert.equal(chainParams.agentScope, "both");
		});
	});

	it("/run-chain launches a saved chain with a shared task", async () => {
		await withTempProject("pi-run-chain-success-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan {task}

## reviewer

Review {previous}
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit the auth flow", root);
			const runParams = params as {
				chain?: Array<{ agent?: string; task?: string }>;
				task?: string;
				clarify?: boolean;
				agentScope?: string;
				async?: unknown;
				context?: unknown;
			};

			assert.deepEqual(runParams.chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "scout", task: "Scan {task}" },
				{ agent: "reviewer", task: "Review {previous}" },
			]);
			assert.equal(runParams.task, "Audit the auth flow");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.async, undefined);
			assert.equal(runParams.context, undefined);
		});
	});

	it("/run-chain launches a saved JSON chain with dynamic fanout", async () => {
		await withTempProject("pi-run-chain-json-dynamic-", async (root) => {
			writeProjectChain(root, "dynamic-review.chain.json", JSON.stringify({
				name: "dynamic-review",
				description: "Dynamic review flow",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
						parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
						collect: { as: "reviews" },
					},
				],
			}));

			const { params } = await captureSlashCommandParams("run-chain", "dynamic-review -- Audit", root);
			const runParams = params as { chain?: Array<Record<string, unknown>>; task?: string; clarify?: boolean; agentScope?: string };

			assert.equal(runParams.task, "Audit");
			assert.equal(runParams.clarify, false);
			assert.equal(runParams.agentScope, "both");
			assert.equal(runParams.chain?.[0]?.agent, "scout");
			assert.deepEqual(runParams.chain?.[1]?.expand, { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 });
			assert.deepEqual(runParams.chain?.[1]?.collect, { as: "reviews" });
		});
	});

	it("/run-chain launches and completes packaged saved chains by dotted runtime name", async () => {
		await withTempProject("pi-run-chain-packaged-", async (root) => {
			writeProjectChain(root, "code-analysis.review-flow.chain.md", `---
name: review-flow
package: code-analysis
description: Review flow
---

## code-analysis.scout

Scan {task}
`);

			const { params } = await captureSlashCommandParams("run-chain", "code-analysis.review-flow -- Audit", root);
			assert.equal((params as { task?: string }).task, "Audit");
			assert.deepEqual((params as { chain?: Array<{ agent?: string; task?: string }> }).chain?.map(({ agent, task }) => ({ agent, task })), [
				{ agent: "code-analysis.scout", task: "Scan {task}" },
			]);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};
				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("code-") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value), ["code-analysis.review-flow"]);
			});
		});
	});

	it("/run-chain reports an unknown saved chain without launching", async () => {
		await withTempProject("pi-run-chain-unknown-", async (root) => {
			const { params, notifications } = await captureSlashCommandParams("run-chain", "missing -- Do work", root);

			assert.equal(params, undefined);
			assert.deepEqual(notifications, ["Unknown chain: missing"]);
		});
	});

	it("/run-chain suggests saved chain names", async () => {
		await withTempProject("pi-run-chain-completions-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);
			writeProjectChain(root, "release-flow.chain.md", `---
name: release-flow
description: Release flow
---

## planner

Plan
`);
			writeProjectChain(root, "triage.chain.md", `---
name: triage
description: Triage flow
---

## scout

Triage
`);

			await withIsolatedHome(async () => {
				const commands = new Map<string, RegisteredSlashCommand>();
				const pi = {
					events: createEventBus(),
					registerCommand(name: string, spec: RegisteredSlashCommand) {
						commands.set(name, spec);
					},
					registerShortcut() {},
					sendMessage(_message: unknown) {},
				};

				registerSlashCommands!(pi, createState(root));
				const completions = commands.get("run-chain")!.getArgumentCompletions!("re") as Array<{ value: string; label: string }>;
				assert.deepEqual(completions.map((completion) => completion.value).sort(), ["release-flow", "review-flow"]);
				assert.deepEqual(completions.map((completion) => completion.label).sort(), ["release-flow", "review-flow"]);
				assert.equal(commands.get("run-chain")!.getArgumentCompletions!("review-flow -- "), null);
			});
		});
	});

	it("/run-chain maps --bg to async execution", async () => {
		await withTempProject("pi-run-chain-bg-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --bg", root);

			assert.equal((params as { async?: unknown }).async, true);
			assert.equal((params as { context?: unknown }).context, undefined);
		});
	});

	it("/run-chain maps --fork to forked context", async () => {
		await withTempProject("pi-run-chain-fork-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Review flow
---

## scout

Scan
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Audit --fork", root);

			assert.equal((params as { context?: unknown }).context, "fork");
			assert.equal((params as { async?: unknown }).async, undefined);
		});
	});

	it("/run-chain prefers a project saved chain over a same-named user chain", async () => {
		await withTempProject("pi-run-chain-priority-", async (root) => {
			writeProjectChain(root, "review-flow.chain.md", `---
name: review-flow
description: Project review flow
---

## scout

Project chain task
`);

			const { params } = await captureSlashCommandParams("run-chain", "review-flow -- Shared task", root, () => {
				const userChainsDir = path.join(os.homedir(), ".pi", "agent", "chains");
				fs.mkdirSync(userChainsDir, { recursive: true });
				fs.writeFileSync(path.join(userChainsDir, "review-flow.chain.md"), `---
name: review-flow
description: User review flow
---

## scout

User chain task
`, "utf-8");
			});

			assert.equal((params as { chain?: Array<{ task?: string }> }).chain?.[0]?.task, "Project chain task");
		});
	});

	it("/run-chain resolves saved outputSchema files at the command boundary", async () => {
		await withTempProject("pi-run-chain-schema-", async (root) => {
			const schemasDir = path.join(root, ".pi", "chains", "schemas");
			fs.mkdirSync(schemasDir, { recursive: true });
			fs.writeFileSync(path.join(schemasDir, "finding.schema.json"), JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }), "utf-8");
			writeProjectChain(root, "schema-flow.chain.md", `---
name: schema-flow
description: Schema flow
---

## scout
outputSchema: ./schemas/finding.schema.json

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "schema-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: Array<{ outputSchema?: unknown }> }).chain?.[0]?.outputSchema, {
				type: "object",
				properties: { ok: { type: "boolean" } },
			});
		});
	});

	it("/run-chain preserves saved step behavior fields", async () => {
		await withTempProject("pi-run-chain-fields-", async (root) => {
			writeProjectChain(root, "field-flow.chain.md", `---
name: field-flow
description: Field flow
---

## scout
output: context.md
outputMode: file-only
reads: input.md, notes.md
model: openai/gpt-5.5
skills: research, audit
progress: true

Gather context
`);

			const { params } = await captureSlashCommandParams("run-chain", "field-flow -- Shared task", root);

			assert.deepEqual((params as { chain?: unknown[] }).chain?.[0], {
				agent: "scout",
				task: "Gather context",
				output: "context.md",
				outputMode: "file-only",
				reads: ["input.md", "notes.md"],
				progress: true,
				skill: ["research", "audit"],
				model: "openai/gpt-5.5",
			});
		});
	});
});


describe("interrupt-child slash command", () => {
	function setup(state = createState(process.cwd())) {
		const commands = new Map<string, RegisteredSlashCommand>();
		const events = createEventBus();
		const sent: unknown[] = [];
		const notifications: Array<{ message: string; type?: string }> = [];
		const statuses: Array<string | undefined> = [];
		let rewrites = 0;
		const pi = {
			events,
			registerCommand(name: string, spec: RegisteredSlashCommand) { commands.set(name, spec); },
			registerShortcut() {},
			sendMessage(message: unknown) { sent.push(message); },
		};
		const ctx = createCommandContext({
			hasUI: true,
			notify: (message, type) => notifications.push({ message, type }),
			setStatus: (key, text) => { assert.equal(key, "subagent-slash"); statuses.push(text); },
			sessionManager: { getSessionFile: () => "session.jsonl", _rewriteFile: () => { rewrites++; } },
		});
		registerSlashCommands!(pi, state);
		const command = commands.get("interrupt-child");
		assert.ok(command, "register /interrupt-child");
		return { command, events, ctx, notifications, statuses, assertNoSteer() {
			assert.deepEqual(sent, []);
			assert.equal(rewrites, 0);
		} };
	}

	it("/interrupt-child argument handling and running-child completions", async () => {
		const state = createState(process.cwd());
		const h = setup(state);
		const requests: unknown[] = [];
		h.events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const { requestId, params } = data as { requestId: string; params: unknown };
			requests.push(params);
			h.events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			h.events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId, result: { content: [{ type: "text", text: "action result" }] }, isError: false,
			});
		});
		for (const args of ["", "-1", "+1", "1.5", "1e2", "abc", "1 run extra"]) {
			await h.command.handler(args, h.ctx);
			assert.deepEqual(h.notifications.pop(), { message: "Usage: /interrupt-child <index> [run-id]", type: "error" });
		}
		assert.deepEqual(requests, []);
		assert.deepEqual(h.command.getArgumentCompletions!(""), []);
		await h.command.handler("1", h.ctx);
		assert.deepEqual(requests.pop(), { action: "interrupt", index: 1 });
		state.foregroundControls.set("run-a", { childInterrupts: new Map([[0, () => true], [2, () => true]]) });
		await h.command.handler("  02  ", h.ctx);
		assert.deepEqual(requests.pop(), { action: "interrupt", index: 2, id: "run-a" });
		const values = (prefix: string) => (h.command.getArgumentCompletions!(prefix) as Array<{ value: string }>).map(({ value }) => value);
		assert.deepEqual(values(""), ["0", "2"]);
		assert.deepEqual(values("2"), ["2"]);
		state.foregroundControls.set("run-b", { childInterrupts: new Map([[1, () => true]]) });
		await h.command.handler("1", h.ctx);
		assert.deepEqual(requests, []);
		assert.match(h.notifications.at(-1)!.message, /run-a/);
		assert.match(h.notifications.at(-1)!.message, /run-b/);
		assert.deepEqual(values(""), ["0 run-a", "2 run-a", "1 run-b"]);
		assert.deepEqual(values("1 r"), ["1 run-b"]);
		state.foregroundControls.get("run-a").childInterrupts.delete(0);
		assert.deepEqual(values("0"), []);
		await h.command.handler("1 run-b", h.ctx);
		assert.deepEqual(requests.pop(), { action: "interrupt", index: 1, id: "run-b" });
		assert.deepEqual(h.notifications.at(-1), { message: "action result", type: "info" });
		assert.equal(h.statuses.at(-1), undefined);
		h.assertNoSteer();
	});

	it("/interrupt-child reports bridge errors without steering or rewriting the session", async () => {
		const h = setup();
		await h.command.handler("1", h.ctx);
		assert.match(h.notifications.at(-1)!.message, /No slash subagent bridge responded/);
		assert.equal(h.notifications.at(-1)!.type, "error");
		const bridge = registerSlashSubagentBridge({
			events: h.events, getContext: () => h.ctx,
			execute: async () => { throw new Error("executor unavailable"); },
		});
		try {
			await h.command.handler("1", h.ctx);
			assert.deepEqual(h.notifications.at(-1), { message: "executor unavailable", type: "error" });
			assert.equal(h.statuses.at(-1), undefined);
			h.assertNoSteer();
		} finally { bridge.dispose(); }
	});

	for (const explicit of [false, true]) {
		it(`/interrupt-child stops one child of a blocked foreground run (${explicit ? "prefix" : "implicit"})`, async () => {
			await withTempProject("pi-slash-interrupt-", async (root) => {
				const state = createState(root);
				const h = setup(state);
				const mock = createMockPi();
				mock.install();
				const ctx = makeMinimalCtx(root);
				const executor = createSubagentExecutor({
					captureRuntime: mock.captureRuntime,
					pi: { events: h.events, getSessionName: () => undefined }, state,
					resolveConfig: () => ({ control: { enabled: false } }),
					tempArtifactsDir: root, getSubagentSessionRoot: () => root,
					expandTilde: (value: string) => value,
					discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }),
				});
				const bridge = registerSlashSubagentBridge({ events: h.events, getContext: () => ctx, execute: executor.execute });
				for (const index of [0, 1, 2]) mock.onCall({ taskIncludes: `Child task ${index}`, steps: [
					{ jsonl: [childEvents.messageStart()] },
					{ delay: index === 1 ? 60_000 : 1_500, jsonl: [childEvents.assistantMessage(`Completed child ${index}`)] },
				] });
				const controller = new AbortController();
				let settled = false;
				const pending = executor.execute("blocked-call", {
					tasks: [0, 1, 2].map((index) => ({ agent: "echo", task: `Child task ${index}` })), async: false,
				}, controller.signal, () => {}, ctx).finally(() => { settled = true; });
				try {
					const deadline = Date.now() + 5_000;
					while (mock.callCount() < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
					assert.equal(mock.callCount(), 3);
					const [runId, control] = [...state.foregroundControls.entries()][0];
					assert.equal(control.childInterrupts.size, 3);
					assert.equal(settled, false);
					const suffix = explicit ? ` ${runId.slice(0, 6)}` : "";
					await h.command.handler(`99${suffix}`, h.ctx);
					assert.deepEqual(h.notifications.at(-1), { message: `Foreground run ${runId} has no running child at index 99.`, type: "error" });
					assert.equal(control.childInterrupts.size, 3);
					await h.command.handler(`1${suffix}`, h.ctx);
					assert.deepEqual(h.notifications.at(-1), { message: `Interrupt requested for child 1 of foreground run ${runId}.`, type: "info" });
					assert.deepEqual([...control.childInterrupts.keys()].sort(), [0, 2]);
					assert.equal(settled, false, "siblings must still be in flight after the stop request");
					assert.equal(h.statuses.at(-1), undefined);
					const result = await pending;
					assert.equal(controller.signal.aborted, false);
					assert.notEqual(result.isError, true);
					assert.equal(result.details.results.length, 3);
					assert.equal(result.details.results[1].interrupted, true);
					assert.match(result.content[0].text, /=== Task 2: echo ===\nINTERRUPTED/);
					for (const index of [0, 2]) {
						assert.notEqual(result.details.results[index].interrupted, true);
						assert.equal(result.details.results[index].exitCode, 0);
						assert.equal(result.details.results[index].finalOutput, `Completed child ${index}`);
						assert.match(result.content[0].text, new RegExp(`Completed child ${index}`));
					}
					h.assertNoSteer();
				} finally {
					controller.abort();
					await pending;
					bridge.dispose();
					mock.uninstall();
				}
			});
		});
	}
});


describe("cohort-doctor slash command", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	beforeEach(() => {
		clearSlashSnapshots?.();
	});

	it("routes to the doctor tool action", async () => {
		const { params } = await captureSlashCommandParams("cohort-doctor", "", process.cwd());
		assert.deepEqual(params, { action: "doctor" });
	});

	it("does not register the removed subagents-status overlay command", async () => {
		await withIsolatedHome(async () => {
			const commands = new Map<string, RegisteredSlashCommand>();
			const pi = {
				events: createEventBus(),
				registerCommand(name: string, spec: RegisteredSlashCommand) {
					commands.set(name, spec);
				},
				registerShortcut() {},
				sendMessage(_message: unknown) {},
			};

			registerSlashCommands!(pi, createState(process.cwd()));
			assert.equal(commands.has("subagents-status"), false);
		});
	});

});
