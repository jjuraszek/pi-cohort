import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "../../src/runs/shared/pi-args.ts";
import type { MockPi } from "../support/helpers.ts";
import {
	createEventBus,
	createMockPi,
	createTempDir,
	makeMinimalCtx,
	removeTempDir,
	tryImport,
} from "../support/helpers.ts";

interface RegisteredTool {
	execute: (
		id: string,
		params: { agent: string; task: string },
		signal: AbortSignal,
		onUpdate: (update: unknown) => void,
		ctx: ReturnType<typeof makeMinimalCtx>,
	) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
}

interface FanoutChildModule {
	default: (pi: { events: ReturnType<typeof createEventBus>; registerTool: (tool: RegisteredTool) => void; getSessionName: () => undefined }) => void;
}

const fanoutChild = await tryImport<FanoutChildModule>("./src/extension/fanout-child.ts");
const available = !!fanoutChild;
const environmentKeys = [
	"HOME",
	"USERPROFILE",
	"PI_CODING_AGENT_DIR",
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
] as const;

function assistantEvent(text: string, total: number) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason: "stop",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total } },
		},
	};
}

describe("nested child grand-total accounting", { skip: !available ? "fanout child extension unavailable" : undefined }, () => {
	let mockPi: MockPi;
	let tempDir: string;
	let originalCwd: string;
	let environment: Map<string, string | undefined>;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-nested-grand-total-");
		originalCwd = process.cwd();
		environment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		const profileDir = path.join(tempDir, "profile");
		fs.mkdirSync(profileDir, { recursive: true });
		process.chdir(tempDir);
		process.env.HOME = profileDir;
		process.env.USERPROFILE = profileDir;
		process.env.PI_CODING_AGENT_DIR = profileDir;
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		process.env.PI_SUBAGENT_DEPTH = "1";
		process.env.PI_SUBAGENT_MAX_DEPTH = "2";
		for (const key of environmentKeys.slice(7)) delete process.env[key];
		mockPi.reset();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const [key, value] of environment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		removeTempDir(tempDir);
	});

	it("forwards cumulative child costs without a missing grand-total accumulator", async () => {
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "agents", "grandchild.md"),
			"---\nname: grandchild\ndescription: Nested grand-total integration fixture\ntools: []\n---\nReturn the fixture response.\n",
		);
		mockPi.onCall({
			jsonl: [
				assistantEvent("starting fixture", 0),
				assistantEvent("continuing fixture", 0.25),
				assistantEvent("grandchild complete", 0),
			],
		});

		let tool: RegisteredTool | undefined;
		fanoutChild!.default({
			events: createEventBus(),
			registerTool: (registered) => { tool = registered; },
			getSessionName: () => undefined,
		});
		assert.ok(tool, "expected the child-safe subagent tool to register");

		const observedCosts: number[] = [];
		const result = await tool.execute(
			"nested-cost",
			{ agent: "grandchild", task: "Return the fixture response." },
			new AbortController().signal,
			(update) => {
				const cost = (update as { details?: { results?: Array<{ usage?: { cost?: unknown } }> } }).details?.results?.[0]?.usage?.cost;
				if (typeof cost === "number") observedCosts.push(cost);
			},
			makeMinimalCtx(tempDir),
		);

		assert.deepEqual(observedCosts.slice(0, 3), [0, 0.25, 0.25]);
		assert.ok(observedCosts.slice(3).every((cost) => cost === 0.25), `unexpected duplicate update costs: ${observedCosts.join(", ")}`);
		assert.equal(result.isError, undefined);
		assert.match(result.content.map((part) => part.text ?? "").join("\n"), /grandchild complete/);
	});
});
