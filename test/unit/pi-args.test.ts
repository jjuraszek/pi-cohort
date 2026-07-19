import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	applyThinkingSuffix,
	buildPiArgs,
} from "../../src/runs/shared/pi-args.ts";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_SUBAGENT_FANOUT_CHILD: process.env.PI_SUBAGENT_FANOUT_CHILD,
	PI_SUBAGENT_PARENT_EVENT_SINK: process.env.PI_SUBAGENT_PARENT_EVENT_SINK,
	PI_SUBAGENT_PARENT_CONTROL_INBOX: process.env.PI_SUBAGENT_PARENT_CONTROL_INBOX,
	PI_SUBAGENT_PARENT_ROOT_RUN_ID: process.env.PI_SUBAGENT_PARENT_ROOT_RUN_ID,
	PI_SUBAGENT_PARENT_RUN_ID: process.env.PI_SUBAGENT_PARENT_RUN_ID,
	PI_SUBAGENT_PARENT_CHILD_INDEX: process.env.PI_SUBAGENT_PARENT_CHILD_INDEX,
	PI_SUBAGENT_PARENT_DEPTH: process.env.PI_SUBAGENT_PARENT_DEPTH,
	PI_SUBAGENT_PARENT_PATH: process.env.PI_SUBAGENT_PARENT_PATH,
	PI_SUBAGENT_PARENT_CAPABILITY_TOKEN: process.env.PI_SUBAGENT_PARENT_CAPABILITY_TOKEN,
	PI_SUBAGENT_RUN_ID: process.env.PI_SUBAGENT_RUN_ID,
};
const originalCwd = process.cwd();
const tempRoots: string[] = [];

afterEach(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	for (const root of tempRoots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe("buildPiArgs session wiring", () => {
	it("uses --session when sessionFile is provided", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-args-session-"));
		try {
			const sessionFile = path.join(tempDir, "nested", "session.jsonl");
			const { args } = buildPiArgs({
				baseArgs: ["-p"],
				task: "hello",
				sessionEnabled: true,
				sessionFile,
				sessionDir: "/tmp/should-not-be-used",
				inheritProjectContext: false,
				inheritSkills: false,
			});

			assert.ok(args.includes("--session"));
			assert.ok(args.includes(sessionFile));
			assert.ok(fs.existsSync(path.dirname(sessionFile)));
			assert.ok(!args.includes("--session-dir"), "--session-dir should not be emitted with --session");
			assert.ok(!args.includes("--no-session"), "--no-session should not be emitted with --session");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps fresh mode behavior (sessionDir + no session file)", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: true,
			sessionDir: "/tmp/subagent-sessions",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--session-dir"));
		assert.ok(args.includes("/tmp/subagent-sessions"));
		assert.ok(!args.includes("--session"));
	});
});

describe("buildPiArgs model wiring", () => {
	it("uses --model for provider-qualified model ids", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini"));
		assert.ok(!args.includes("--models"));
	});

	it("uses --model for bare model ids too", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "kimi-k2.5",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--model"));
		assert.ok(args.includes("kimi-k2.5"));
		assert.ok(!args.includes("--models"));
	});


	it("preserves thinking suffixes on model args", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			model: "openai-codex/gpt-5.4-mini",
			thinking: "high",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.equal(applyThinkingSuffix("openai-codex/gpt-5.4-mini", "high"), "openai-codex/gpt-5.4-mini:high");
		assert.ok(args.includes("--model"));
		assert.ok(args.includes("openai-codex/gpt-5.4-mini:high"));
	});
});

describe("buildPiArgs system prompt mode wiring", () => {
	it("uses --append-system-prompt by default", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--append-system-prompt"));
		assert.ok(!args.includes("--system-prompt"));
	});

	it("uses --system-prompt when systemPromptMode=replace", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "You are a worker",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
		assert.ok(!args.includes("--append-system-prompt"));
	});

	it("injects the subagent prompt runtime extension and env flags", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: true,
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.equal(env.PI_SUBAGENT_CHILD, "1");
		assert.equal(env.PI_SUBAGENT_INHERIT_PROJECT_CONTEXT, "0");
		assert.equal(env.PI_SUBAGENT_INHERIT_SKILLS, "1");
	});

	it("passes child intercom and orchestrator metadata through env", () => {
		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			intercomSessionName: "subagent-worker-78f659a3",
			orchestratorIntercomTarget: "subagent-chat-parent",
			runId: "78f659a3",
			childAgentName: "worker",
			childIndex: 2,
		});

		assert.equal(env.PI_SUBAGENT_INTERCOM_SESSION_NAME, "subagent-worker-78f659a3");
		assert.equal(env.PI_SUBAGENT_ORCHESTRATOR_TARGET, "subagent-chat-parent");
		assert.equal(env.PI_SUBAGENT_RUN_ID, "78f659a3");
		assert.equal(env.PI_SUBAGENT_CHILD_AGENT, "worker");
		assert.equal(env.PI_SUBAGENT_CHILD_INDEX, "2");
	});

	it("emits explicit builtin tool allowlists", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"],
		});

		const toolsArg = args[args.indexOf("--tools") + 1];
		assert.equal(toolsArg, "read,grep,find,ls,bash,edit,write,contact_supervisor");
	});

	it("keeps tool extension paths when explicit extensions are allowlisted", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "./custom-tool.ts"],
			extensions: ["./allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "runs", "shared", "subagent-prompt-runtime.ts"))));
		assert.ok(extensionArgs.includes("./custom-tool.ts"));
		assert.ok(extensionArgs.includes("./allowed-ext.ts"));
	});

	it("authorizes child fanout only from exact declared builtin subagent", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "subagent"],
			runId: "parent-run",
			childIndex: 1,
			parentEventSink: "/tmp/root/events",
			parentControlInbox: "/tmp/root/control",
			parentRootRunId: "root-run",
			parentCapabilityToken: "token-1",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(args[args.indexOf("--tools") + 1], "read,subagent");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/root/events");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/root/control");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "root-run");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "parent-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "1");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "1");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "parent-run", stepIndex: 1 }]);
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "token-1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("clears all fanout routing env values for non-fanout children", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read", "mcp:server/subagent"],
			parentEventSink: "/tmp/should-not-leak/events",
			parentControlInbox: "/tmp/should-not-leak/control",
			parentRootRunId: "root-should-not-leak",
			parentRunId: "should-not-leak",
			parentChildIndex: 9,
			parentCapabilityToken: "token-should-not-leak",
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
		assert.ok(!extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
	});

	it("inherits routing env only for authorized fanout children", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "inherited-root";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "inherited-run";
		process.env[SUBAGENT_RUN_ID_ENV] = "owner-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "2";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }, { runId: "../unsafe", stepIndex: 1 }, { runId: "owner-run", stepIndex: 1 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const fanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
		});
		assert.equal(fanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "/tmp/inherited/events");
		assert.equal(fanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "/tmp/inherited/control");
		assert.equal(fanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "inherited-root");
		assert.equal(fanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "owner-run");
		assert.equal(fanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "4");
		assert.equal(fanout.env[SUBAGENT_PARENT_DEPTH_ENV], "3");
		assert.deepEqual(JSON.parse(fanout.env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "owner-run", stepIndex: 1 }, { runId: "owner-run", stepIndex: 4 }]);
		assert.equal(fanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "inherited-token");

		const nonFanout = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
		});
		assert.equal(nonFanout.env[SUBAGENT_FANOUT_CHILD_ENV], "0");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_EVENT_SINK_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_RUN_ID_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_DEPTH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_PATH_ENV], "");
		assert.equal(nonFanout.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV], "");
	});

	it("prefers the current subagent run id over inherited ancestor ids for nested fanout routing", () => {
		process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = "/tmp/inherited/events";
		process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = "/tmp/inherited/control";
		process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = "root-run";
		process.env[SUBAGENT_PARENT_RUN_ID_ENV] = "older-parent";
		process.env[SUBAGENT_RUN_ID_ENV] = "ancestor-run";
		process.env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = "4";
		process.env[SUBAGENT_PARENT_DEPTH_ENV] = "1";
		process.env[SUBAGENT_PARENT_PATH_ENV] = JSON.stringify([{ runId: "root-run", stepIndex: 0 }]);
		process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = "inherited-token";

		const { env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			runId: "current-nested-run",
			childIndex: 2,
		});

		assert.equal(env[SUBAGENT_PARENT_RUN_ID_ENV], "current-nested-run");
		assert.equal(env[SUBAGENT_PARENT_CHILD_INDEX_ENV], "2");
		assert.equal(env[SUBAGENT_PARENT_DEPTH_ENV], "2");
		assert.deepEqual(JSON.parse(env[SUBAGENT_PARENT_PATH_ENV] ?? "[]"), [{ runId: "root-run", stepIndex: 0 }, { runId: "current-nested-run", stepIndex: 2 }]);
	});

	it("keeps child-safe fanout registration in explicit extensions mode", () => {
		const { args, env } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["subagent"],
			extensions: ["./agent-allowed-ext.ts"],
		});

		const extensionArgs = args.filter((arg, index) => args[index - 1] === "--extension");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(env[SUBAGENT_FANOUT_CHILD_ENV], "1");
		assert.ok(extensionArgs.some((arg) => arg.endsWith(path.join("src", "extension", "fanout-child.ts"))));
		assert.ok(extensionArgs.includes("./agent-allowed-ext.ts"));
	});

	it("emits an empty prompt file when replace mode is used with an empty prompt", () => {
		const { args } = buildPiArgs({
			baseArgs: ["-p"],
			task: "hello",
			sessionEnabled: false,
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
		});

		assert.ok(args.includes("--system-prompt"));
	});
});

describe("buildPiArgs forwarded flags", () => {
	const base = { baseArgs: ["--mode", "json", "-p"], task: "hi", sessionEnabled: false, inheritProjectContext: false, inheritSkills: false };

	it("appends forwarded flags after baseArgs when extensions inherit", () => {
		const { args } = buildPiArgs({ ...base, forwardedFlags: ["--no-autofix"] });
		assert.ok(args.includes("--no-autofix"));
		assert.ok(args.indexOf("--no-autofix") < args.indexOf("--extension"));
		assert.notEqual(args[args.length - 1], "--no-autofix");
	});

	it("drops forwarded flags when the agent restricts extensions", () => {
		const { args } = buildPiArgs({ ...base, forwardedFlags: ["--no-autofix"], extensions: [] });
		assert.ok(!args.includes("--no-autofix"));
		assert.ok(args.includes("--no-extensions"));
	});

	it("preserves repeated --extension args (no whole-array dedup)", () => {
		const { args } = buildPiArgs({ ...base, forwardedFlags: ["--no-autofix"], tools: ["subagent"] });
		const extCount = args.filter((a) => a === "--extension").length;
		assert.ok(extCount >= 2, "runtime + fanout extensions both present");
	});

	it("no-ops on empty/undefined forwardedFlags", () => {
		const { args } = buildPiArgs({ ...base });
		assert.ok(!args.includes("--no-autofix"));
	});
});
