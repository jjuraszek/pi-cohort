import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { readStructuredOutput, STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "../../src/runs/shared/structured-output.ts";
import registerSubagentPromptRuntime, {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	rewriteSubagentPrompt,
	stripInheritedSkills,
	stripParentOnlySubagentMessages,
	stripProjectContext,
	stripSubagentOrchestrationSkill,
} from "../../src/runs/shared/subagent-prompt-runtime.ts";

const envSnapshot = {
	PI_SUBAGENT_INHERIT_PROJECT_CONTEXT: process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT,
	PI_SUBAGENT_INHERIT_SKILLS: process.env.PI_SUBAGENT_INHERIT_SKILLS,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE,
	PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA: process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA,
};

const SKILLS_SECTION = "\n\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\nWhen a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n<available_skills>\n  <skill>\n    <name>safe-bash</name>\n    <description>desc</description>\n    <location>/tmp/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>pi-cohort</name>\n    <description>delegate to subagents</description>\n    <location>/tmp/pi-cohort/SKILL.md</location>\n  </skill>\n</available_skills>";

const BASE_PROMPT = [
	"You are a subagent.",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
	"\nCurrent working directory: /repo",
].join("");

const PROMPT_WITH_EXPLICIT_SKILL = [
	"You are a subagent.\n\n<skill name=\"explicit\">\nKeep this section\n</skill>",
	"\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n## /repo/AGENTS.md\n\nProject rules\n\n",
	SKILLS_SECTION,
	"\nCurrent date: 2026-04-16",
].join("");

afterEach(() => {
	if (envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT === undefined) delete process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	else process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = envSnapshot.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT;
	if (envSnapshot.PI_SUBAGENT_INHERIT_SKILLS === undefined) delete process.env.PI_SUBAGENT_INHERIT_SKILLS;
	else process.env.PI_SUBAGENT_INHERIT_SKILLS = envSnapshot.PI_SUBAGENT_INHERIT_SKILLS;
	if (envSnapshot.PI_SUBAGENT_FANOUT_CHILD === undefined) delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	else process.env.PI_SUBAGENT_FANOUT_CHILD = envSnapshot.PI_SUBAGENT_FANOUT_CHILD;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE === undefined) delete process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	else process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA === undefined) delete process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	else process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = envSnapshot.PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA;
});

describe("subagent prompt runtime", () => {
	it("registered structured_output tool accepts valid schema output and writes the capture file", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-structured-runtime-"));
		try {
			const schemaPath = path.join(dir, "schema.json");
			const outputPath = path.join(dir, "output.json");
			fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }), "utf-8");
			process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
			process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
			let execute: ((_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }>) | undefined;

			registerSubagentPromptRuntime({
				registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }) {
					if (tool.name === "structured_output") execute = tool.execute;
				},
				on() {},
			} as { registerTool(tool: { name: string; execute: (_id: string, params: { value: unknown }) => Promise<{ terminate?: boolean }> }): void; on(): void });

			assert.ok(execute, "structured_output tool should be registered");
			const result = await execute("tool-1", { value: { ok: true } });
			assert.equal(result.terminate, true);
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { status: "success", value: { ok: true } });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("strips only the project context block", () => {
		const rewritten = stripProjectContext(BASE_PROMPT);
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(rewritten.includes("The following skills provide specialized instructions for specific tasks."));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("strips only the inherited skills block", () => {
		const rewritten = stripInheritedSkills(BASE_PROMPT);
		assert.ok(rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current date: 2026-04-16"));
	});

	it("can strip both inherited sections together", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(!rewritten.includes("# Project Context"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(rewritten.includes("Current working directory: /repo"));
	});

	it("injects a child-only boundary that forbids proposing or running subagents", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("Do not propose or run subagents."));
		assert.ok(rewritten.includes("If you need to edit files, call the actual edit/write tools."));
		assert.ok(rewritten.includes("Do not print tool-call syntax, patches, or pseudo-tool calls as text."));
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
		assert.equal(rewriteSubagentPrompt(rewritten, { inheritProjectContext: true, inheritSkills: true }).lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited child boundaries with the fanout boundary when authorized", () => {
		const strictPrompt = `${CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(strictPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
			fanoutChild: true,
		});

		assert.ok(rewritten.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
		assert.ok(rewritten.includes("You may use the `subagent` tool only for the fanout work explicitly requested in this task."));
		assert.ok(!rewritten.includes("Do not propose or run subagents."));
		assert.equal(rewritten.lastIndexOf(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("replaces inherited fanout boundaries with the strict boundary when fanout is not authorized", () => {
		const fanoutPrompt = `${CHILD_FANOUT_BOUNDARY_INSTRUCTIONS}\n\n${BASE_PROMPT}`;
		const rewritten = rewriteSubagentPrompt(fanoutPrompt, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.startsWith(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
		assert.ok(!rewritten.includes("explicit fanout responsibility"));
		assert.equal(rewritten.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS), 0);
	});

	it("keeps explicitly injected skill content when inherited skills are stripped", () => {
		const rewritten = rewriteSubagentPrompt(PROMPT_WITH_EXPLICIT_SKILL, {
			inheritProjectContext: false,
			inheritSkills: false,
		});
		assert.ok(rewritten.includes("<skill name=\"explicit\">"));
		assert.ok(!rewritten.includes("<available_skills>"));
		assert.ok(!rewritten.includes("# Project Context"));
	});

	it("strips the subagent orchestration skill even when inherited skills remain", () => {
		const rewritten = rewriteSubagentPrompt(BASE_PROMPT, {
			inheritProjectContext: true,
			inheritSkills: true,
		});

		assert.ok(rewritten.includes("<name>safe-bash</name>"));
		assert.ok(!rewritten.includes("<name>pi-cohort</name>"));
		assert.ok(!rewritten.includes("delegate to subagents"));
	});

	it("strips explicit pi-cohort skill injection from child prompts", () => {
		const prompt = "Before\n\n<skill name=\"pi-cohort\">\nDo not keep this.\n</skill>\n\n<skill name=\"safe-bash\">\nKeep this.\n</skill>\nAfter";
		const rewritten = stripSubagentOrchestrationSkill(prompt);

		assert.ok(!rewritten.includes("Do not keep this"));
		assert.ok(rewritten.includes("<skill name=\"safe-bash\">"));
	});

	it("strips parent-only subagent custom messages from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const notify = { role: "custom", customType: "subagent-notify", content: "Background task completed" };
		const control = { role: "custom", customType: "subagent_control_notice", content: "needs attention" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		assert.deepEqual(stripParentOnlySubagentMessages([user, instruction, slashResult, notify, control, otherCustom], new Set()), [user, otherCustom]);
	});

	it("strips prior parent subagent tool calls and results from forked child context", () => {
		const user = { role: "user", content: "Task" };
		const subagentResult = { role: "toolResult", toolCallId: "call-1", toolName: "subagent", content: "subagent results" };
		const readResult = { role: "toolResult", toolName: "read", content: "file contents" };
		const mixedAssistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "I will inspect the repo." },
				{ type: "toolCall", id: "call-2", name: "subagent", input: { agent: "worker" } },
				{ type: "toolCall", name: "read", input: { path: "README.md" } },
			],
		};
		const pureSubagentCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-3", name: "subagent", input: { agent: "reviewer" } }],
		};

		assert.deepEqual(
			stripParentOnlySubagentMessages(
				[user, subagentResult, readResult, mixedAssistant, pureSubagentCall],
				new Set(["call-1", "call-2", "call-3"]),
			),
			[
				user,
				readResult,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will inspect the repo." },
						{ type: "toolCall", name: "read", input: { path: "README.md" } },
					],
				},
			],
		);
	});

	it("strips only inherited parent subagent calls/results when the boundary is known, keeping the child's own", () => {
		const user = { role: "user", content: "Task" };
		const inheritedCall = { role: "assistant", content: [{ type: "toolCall", id: "inherited-1", name: "subagent", arguments: { agent: "worker" } }] };
		const inheritedResult = { role: "toolResult", toolCallId: "inherited-1", toolName: "subagent", content: "inherited results" };
		const ownCall = { role: "assistant", content: [{ type: "toolCall", id: "own-1", name: "subagent", arguments: { agent: "grandchild" } }] };
		const ownResult = { role: "toolResult", toolCallId: "own-1", toolName: "subagent", content: "grandchild done" };

		const result = stripParentOnlySubagentMessages(
			[user, inheritedCall, inheritedResult, ownCall, ownResult],
			new Set(["inherited-1"]),
		);

		assert.deepEqual(result, [user, ownCall, ownResult]);
	});

	it("keeps a fanout child's own delegation call/result across a second turn without re-stripping it", () => {
		const user = { role: "user", content: "Task" };
		const firstOwnCall = { role: "assistant", content: [{ type: "toolCall", id: "own-1", name: "subagent", arguments: { agent: "grandchild" } }] };
		const firstOwnResult = { role: "toolResult", toolCallId: "own-1", toolName: "subagent", content: "grandchild done" };
		const secondOwnCall = { role: "assistant", content: [{ type: "toolCall", id: "own-2", name: "subagent", arguments: { agent: "grandchild" } }] };
		const secondOwnResult = { role: "toolResult", toolCallId: "own-2", toolName: "subagent", content: "grandchild done again" };

		// No inherited ids at all (fresh child): everything the child produced itself survives.
		const result = stripParentOnlySubagentMessages(
			[user, firstOwnCall, firstOwnResult, secondOwnCall, secondOwnResult],
			new Set(),
		);

		assert.deepEqual(result, [user, firstOwnCall, firstOwnResult, secondOwnCall, secondOwnResult]);
	});

	it("captures the inherited/own boundary from session_start for both fresh and forked child contexts", () => {
		let sessionStart: ((event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => void) | undefined;
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: unknown, ctx?: unknown) => unknown) {
				if (event === "session_start") sessionStart = handler as typeof sessionStart;
				if (event === "context") contextHandler = handler as typeof contextHandler;
			},
		} as { on(event: string, handler: (payload: unknown, ctx?: unknown) => unknown): void });

		assert.ok(sessionStart, "expected a session_start handler");
		assert.ok(contextHandler, "expected a context handler");

		// Forked child: the branch at session_start already contains an inherited parent subagent call.
		const inheritedCall = { role: "assistant", content: [{ type: "toolCall", id: "parent-1", name: "subagent", arguments: { agent: "lead" } }] };
		sessionStart?.({ type: "session_start", reason: "fork" }, { sessionManager: { getBranch: () => [{ type: "message", message: inheritedCall }] } });

		const inheritedResult = { role: "toolResult", toolCallId: "parent-1", toolName: "subagent", content: "inherited" };
		const ownCall = { role: "assistant", content: [{ type: "toolCall", id: "own-1", name: "subagent", arguments: { agent: "grandchild" } }] };
		const ownResult = { role: "toolResult", toolCallId: "own-1", toolName: "subagent", content: "own" };
		assert.deepEqual(
			contextHandler?.({ messages: [inheritedCall, inheritedResult, ownCall, ownResult] }),
			{ messages: [ownCall, ownResult] },
		);

		// Fresh child: nothing inherited at session_start, so the child's own calls all survive.
		sessionStart?.({ type: "session_start", reason: "new" }, { sessionManager: { getBranch: () => [] } });
		assert.equal(contextHandler?.({ messages: [ownCall, ownResult] }), undefined);
	});

	it("rewrites the final child-visible prompt through before_agent_start", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		assert.ok(beforeAgentStart, "expected before_agent_start handler");
		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "0";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "0";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(!rewritten.systemPrompt.includes("# Project Context"));
		assert.ok(!rewritten.systemPrompt.includes("<available_skills>"));
		assert.ok(rewritten.systemPrompt.includes("Current date: 2026-04-16"));
	});

	it("uses the fanout boundary through before_agent_start when fanout env is set", async () => {
		let beforeAgentStart: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) {
				if (event === "before_agent_start") beforeAgentStart = handler;
			},
		} as { on(event: string, handler: (payload: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>): void });

		process.env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT = "1";
		process.env.PI_SUBAGENT_INHERIT_SKILLS = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";

		const rewritten = await beforeAgentStart?.({ systemPrompt: BASE_PROMPT });
		assert.ok(rewritten);
		assert.ok(rewritten.systemPrompt.startsWith(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
	});

	it("filters parent-only artifacts from polluted fork context while preserving ordinary history", () => {
		let sessionStart: ((event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => void) | undefined;
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: unknown, ctx?: unknown) => unknown) {
				if (event === "session_start") sessionStart = handler as typeof sessionStart;
				if (event === "context") contextHandler = handler as typeof contextHandler;
			},
		} as { on(event: string, handler: (payload: unknown, ctx?: unknown) => unknown): void });

		const priorParentTurn = { role: "user", content: "Earlier we said planner → worker → reviewers → worker." };
		const currentTask = { role: "user", content: "Now implement only the assigned fix." };
		const instruction = { role: "custom", customType: "subagent-orchestration-instructions", content: "Subagent orchestration is enabled." };
		const slashResult = { role: "custom", customType: "subagent-slash-result", content: "## Orchestration" };
		const subagentCall = { role: "assistant", content: [{ type: "toolCall", id: "subagent-1", name: "subagent", input: { agent: "worker" } }] };
		const subagentResult = { role: "toolResult", toolCallId: "subagent-1", toolName: "subagent", content: "subagent results" };
		const otherCustom = { role: "custom", customType: "other", content: "keep" };

		// Mirrors production: session_start fires at fork time with the inherited call already in the branch.
		sessionStart?.({ type: "session_start", reason: "fork" }, { sessionManager: { getBranch: () => [{ type: "message", message: subagentCall }] } });

		assert.deepEqual(contextHandler?.({ messages: [priorParentTurn, instruction, slashResult, subagentCall, subagentResult, otherCustom, currentTask] }), {
			messages: [priorParentTurn, otherCustom, currentTask],
		});
	});

	it("does not rewrite child context when no parent-only artifacts are present", () => {
		let contextHandler: ((event: { messages: unknown[] }) => { messages: unknown[] } | undefined) | undefined;
		registerSubagentPromptRuntime({
			on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined) {
				if (event === "context") contextHandler = handler;
			},
		} as { on(event: string, handler: (payload: { messages: unknown[] }) => { messages: unknown[] } | undefined): void });

		const messages = [
			{ role: "user", content: "Task" },
			{ role: "toolResult", toolName: "read", content: "file" },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", input: { path: "README.md" } }] },
		];

		assert.equal(contextHandler?.({ messages }), undefined);
	});
});

const reaskSchema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
let runtimeImportId = 0;

async function withStructuredRuntime(run: (runtime: any) => Promise<void> | void, missing: string[] = [], schema: object = reaskSchema) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-reask-"));
	const saved = [STRUCTURED_OUTPUT_SCHEMA_ENV, STRUCTURED_OUTPUT_CAPTURE_ENV].map((key) => [key, process.env[key]] as const);
	try {
		const outputPath = path.join(dir, "output.json");
		const schemaPath = path.join(dir, "schema.json");
		fs.writeFileSync(schemaPath, JSON.stringify(schema));
		process.env[STRUCTURED_OUTPUT_SCHEMA_ENV] = schemaPath;
		process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] = outputPath;
		for (const key of missing) delete process.env[key];
		const handlers = new Map<string, (event: any) => any>();
		let tool: any;
		const { default: register } = await import(`../../src/runs/shared/subagent-prompt-runtime.ts?reask=${++runtimeImportId}`);
		register({ registerTool(value: any) { tool = value; }, on(name: string, handler: any) { handlers.set(name, handler); } });
		const event = {
			outcome: "completed",
			entries: [{ type: "custom_message", customType: "report", content: "Report first", display: true }],
			context: { canContinue: false, contextMessages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		};
		const settle = (value = event) => {
			assert.ok(handlers.has("agent_before_settle"), "expected settlement handler");
			return handlers.get("agent_before_settle")!(value);
		};
		const attempt = (args: unknown, toolName = "structured_output", isError = true, text = 'Validation failed for tool "structured_output": invalid value') => {
			assert.ok(handlers.has("tool_execution_start"), "expected attempt handlers");
			handlers.get("tool_execution_start")!({ toolName, args, toolCallId: "call-1" });
			handlers.get("tool_execution_end")!({ toolName, isError, toolCallId: "call-1", result: { content: [{ type: "text", text }] } });
		};
		const read = () => readStructuredOutput({ schema, schemaPath, outputPath });
		await run({ dir, outputPath, handlers, tool, event, settle, attempt, read });
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("structured output settlement", () => {
	it("appends the exact re-ask after existing drafts without mutation, once per module", async () => {
		for (let processAttempt = 0; processAttempt < 2; processAttempt++) {
			await withStructuredRuntime(({ event, settle }) => {
				const original = structuredClone(event);
				const result = settle();
				assert.equal(result.continue, true);
				assert.deepEqual(result.entries.slice(0, event.entries.length), event.entries);
				assert.deepEqual(result.entries.at(-1), {
					type: "custom_message", customType: "pi-cohort:structured-output-reask", display: true,
					content: "You finished without calling `structured_output`. Call `structured_output` now with a `value` matching this schema, and send no other text:\n\n" + JSON.stringify(reaskSchema, null, 2),
				});
				assert.equal(result.entries.length, event.entries.length + 1);
				assert.deepEqual(event, original);
				assert.equal(settle(), undefined);
			});
		}
	});

	for (const row of [
		{ name: "valid capture", capture: { status: "success", value: { ok: true } } },
		{ name: "error capture", capture: { status: "error", message: "invalid value" } },
		{ name: "aborted", outcome: "aborted" },
		{ name: "provider error", outcome: "error" },
		{ name: "token exhaustion with trailing non-assistant messages", stopReason: "length" },
	]) {
		it(`suppresses re-ask for ${row.name} without consuming the flag`, async () => {
			await withStructuredRuntime(({ outputPath, event, settle }) => {
				if (row.capture) fs.writeFileSync(outputPath, JSON.stringify(row.capture));
				if (row.outcome) event.outcome = row.outcome;
				if (row.stopReason) event.context.contextMessages = [
					{ role: "assistant", stopReason: "stop" }, { role: "assistant", stopReason: row.stopReason },
					{ role: "toolResult" }, { role: "custom" },
				];
				if (row.outcome) Object.defineProperty(event.context, "contextMessages", { get() { throw new Error("outcome must be checked first"); }, configurable: true });
				assert.equal(settle(), undefined);
				fs.rmSync(outputPath, { force: true });
				event.outcome = "completed";
				Object.defineProperty(event.context, "contextMessages", { value: [{ role: "assistant", stopReason: "stop" }], configurable: true });
				assert.equal(settle().continue, true);
			});
		});
	}

	for (const missing of [[STRUCTURED_OUTPUT_CAPTURE_ENV], [STRUCTURED_OUTPUT_SCHEMA_ENV], [STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV]]) {
		it(`registers no structured listeners without ${missing.join(" and ")}`, async () => {
			await withStructuredRuntime(({ handlers, tool }) => {
				assert.equal(tool, undefined);
				for (const name of ["agent_before_settle", "tool_execution_start", "tool_execution_end"]) assert.equal(handlers.has(name), false);
			}, missing);
		});
	}

	for (const validation of ["parameters", "execute"]) {
		it(`records invalid ${validation} calls and allows a same-turn valid correction`, async () => {
			await withStructuredRuntime(async ({ outputPath, tool, attempt, settle, read }) => {
				const args = { value: { ok: "yes" } };
				let diagnostic = "";
				const rejected = (error: Error) => {
					diagnostic = error.message;
					return true;
				};
				if (validation === "parameters") assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "call-1", name: tool.name, arguments: args }), rejected);
				else await assert.rejects(tool.execute("call-1", args), rejected);
				attempt(args, "structured_output", true, diagnostic);
				const envelope = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
				assert.equal(envelope.status, "error");
				assert.ok(envelope.message.length > 0);
				assert.ok(!envelope.message.includes("Received arguments:"));
				assert.deepEqual(read(), { error: validation === "parameters"
					? "Structured output validation failed: - value.ok: must be boolean"
					: "Structured output validation failed: ok: must be boolean" });
				if (process.platform !== "win32") assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
				assert.equal(settle(), undefined);
				const result = await tool.execute("call-2", { value: { ok: true } });
				assert.equal(result.terminate, true);
				attempt(args);
				attempt(args, "structured_output", false);
				assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { status: "success", value: { ok: true } });
				assert.equal(settle(), undefined);
			});
		});
	}

	it("rejects missing arguments under a null schema through Pi validation, writer, and reader", async () => {
		await withStructuredRuntime(async ({ outputPath, handlers, tool, settle, read }) => {
			let diagnostic = "";
			assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "null-call", name: tool.name, arguments: {} }), (error: Error) => {
				diagnostic = error.message;
				return diagnostic.startsWith('Validation failed for tool "structured_output":');
			});
			handlers.get("tool_execution_end")({ toolName: tool.name, isError: true, result: { content: [{ type: "text", text: diagnostic }] } });
			assert.deepEqual(read(), { error: "Structured output validation failed: - value: must have required properties value" });
			assert.equal(settle(), undefined);
			await tool.execute("valid-null", { value: null });
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { status: "success", value: null });
			assert.deepEqual(read(), { value: null });
			handlers.get("tool_execution_end")({ toolName: tool.name, isError: true, result: { content: [{ type: "text", text: diagnostic }] } });
			assert.deepEqual(read(), { value: null });
		}, [], { type: "null" });
	});

	it("accepts a valid follow-up as a terminating structured capture", async () => {
		await withStructuredRuntime(async ({ outputPath, tool, attempt, settle }) => {
			assert.equal(settle().continue, true);
			const result = await tool.execute("call-1", { value: { ok: true } });
			attempt({ value: { ok: true } }, "structured_output", false);
			assert.equal(result.terminate, true);
			assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf-8")), { status: "success", value: { ok: true } });
			assert.equal(settle(), undefined);
		});
	});

	it("does not send a third request after an invalid follow-up followed by prose", async () => {
		await withStructuredRuntime(async ({ outputPath, tool, attempt, settle }) => {
			assert.equal(settle().continue, true);
			await assert.rejects(tool.execute("call-1", { value: { ok: "yes" } }), /Structured output validation failed:/);
			attempt({ value: { ok: "yes" } });
			assert.equal(settle(), undefined);
			fs.unlinkSync(outputPath);
			assert.equal(settle(), undefined);
		});
	});

	for (const row of [
		{ text: "Structured output validation failed: Structured output validation failed: bad value\nReceived arguments: SENTINEL", message: "bad value" },
		{ text: 'Validation failed for tool "structured_output": bad parameter\nReceived arguments: SENTINEL', message: "bad parameter" },
		{ text: "Structured output validation failed: \nReceived arguments: SENTINEL", message: "Invalid structured_output arguments" },
		{ text: 'Invalid arguments for tool "structured_output": SENTINEL', message: "Invalid structured_output arguments" },
	]) {
		it(`normalizes diagnostic ${row.text.split("\n")[0]}`, async () => {
			await withStructuredRuntime(({ attempt, read }) => {
				attempt({}, "structured_output", true, row.text);
				assert.deepEqual(read(), { error: `Structured output validation failed: ${row.message}` });
			});
		});
	}

	it("does not record non-validation failures or recover a truncated attempted call", async () => {
		await withStructuredRuntime(({ attempt, outputPath, event, settle }) => {
			const text = 'Tool call "structured_output" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.';
			attempt({}, "read");
			attempt({}, "structured_output", false);
			assert.equal(fs.existsSync(outputPath), false);
			attempt({}, "structured_output", true, text);
			event.context.contextMessages = [{ role: "assistant", stopReason: "length" }, { role: "toolResult", content: [{ type: "text", text }] }];
			assert.equal(settle(), undefined);
			assert.equal(fs.existsSync(outputPath), false);
			assert.equal(event.context.contextMessages[1].content[0].text, text);
		});
	});

	it("suppresses recovery on inspection failures and preserves unknown captures on recording", async () => {
		await withStructuredRuntime(({ outputPath, attempt, settle }) => {
			fs.mkdirSync(outputPath);
			assert.doesNotThrow(() => attempt({}));
			assert.ok(fs.statSync(outputPath).isDirectory());
			assert.equal(settle(), undefined);
		});
		// Windows reports ENOENT for a file parent, so recovery legitimately re-asks.
		if (process.platform !== "win32") {
			await withStructuredRuntime(({ dir, outputPath, settle }) => {
				fs.rmSync(dir, { recursive: true });
				fs.writeFileSync(dir, "not a directory");
				assert.doesNotThrow(() => assert.equal(settle(), undefined));
			});
		}
	});

	it("retains successful execute write failures as thrown failures without recovery", async () => {
		await withStructuredRuntime(async ({ outputPath, tool, settle }) => {
			fs.mkdirSync(outputPath);
			await assert.rejects(tool.execute("call-1", { value: { ok: true } }), /EISDIR/);
			fs.rmSync(outputPath, { recursive: true });
			assert.equal(settle(), undefined);
		});
	});

	it("swallows attempt-record write failures without creating directories", async () => {
		await withStructuredRuntime(({ dir, outputPath, attempt, settle }) => {
			fs.rmSync(dir, { recursive: true });
			assert.doesNotThrow(() => attempt({ value: { ok: "yes" } }));
			assert.equal(fs.existsSync(outputPath), false);
			assert.equal(fs.existsSync(dir), false);
			assert.equal(settle(), undefined);
		});
	});
});
