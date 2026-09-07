/**
 * Real, model-free regression for the nested-fanout context loss described in
 * the fanout-child-own-subagent-history hotfix record: a fanout lead spawned
 * via the real pi engine must retain its own `subagent` call/result across its
 * own next turn, so it finishes instead of repeating the completed delegation.
 *
 * Uses the real `pi` CLI (a devDependency, resolved from this worktree's
 * node_modules/.bin) for the lead and grandchild hops - the bug lives inside
 * pi's own "context" event handling for the lead's own running session, which
 * a fake CLI (see test/support/mock-pi.ts) cannot exercise. The outer
 * "dispatcher" role is played in-process, exactly like
 * nested-child-grand-total.test.ts, via the same fanout-child tool.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir, tryImport } from "../support/helpers.ts";

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fanoutChild = await tryImport<FanoutChildModule>("./src/extension/fanout-child.ts");
const realPiBinDir = path.resolve(__dirname, "..", "..", "node_modules", ".bin");
const available = !!fanoutChild;

interface FixtureLogRow {
	depth: string;
	decision: "dispatch" | "finish-after-dispatch" | "finish-no-tool";
	msgs: number;
}

function readFixtureLog(logPath: string): FixtureLogRow[] {
	if (!fs.existsSync(logPath)) return [];
	return fs.readFileSync(logPath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as FixtureLogRow);
}

describe("fanout child retains its own delegation history across a real pi run", { skip: !available ? "fanout child extension or real pi binary unavailable" : undefined }, () => {
	let tempDir: string;
	let originalCwd: string;
	let originalEnv: Map<string, string | undefined>;
	let fixtureLog: string;

	const environmentKeys = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PATH", SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV, "PI_SUBAGENT_DEPTH", "PI_SUBAGENT_MAX_DEPTH", "FANOUT_FIXTURE_LOG"] as const;

	beforeEach(() => {
		tempDir = createTempDir("pi-fanout-own-history-");
		originalCwd = process.cwd();
		originalEnv = new Map(environmentKeys.map((key) => [key, process.env[key]]));

		const profileDir = path.join(tempDir, "profile");
		fs.mkdirSync(profileDir, { recursive: true });
		process.chdir(tempDir);
		process.env.HOME = profileDir;
		process.env.USERPROFILE = profileDir;
		process.env.PI_CODING_AGENT_DIR = profileDir;
		process.env.PATH = `${realPiBinDir}${path.delimiter}${process.env.PATH ?? ""}`;
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		delete process.env.PI_SUBAGENT_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;

		fixtureLog = path.join(tempDir, "fixture-log.jsonl");
		process.env.FANOUT_FIXTURE_LOG = fixtureLog;

		fs.mkdirSync(path.join(tempDir, ".pi", "extensions"), { recursive: true });
		fs.copyFileSync(
			path.join(__dirname, "fixtures", "fanout-lead-grandchild", "provider.ts"),
			path.join(tempDir, ".pi", "extensions", "fanout-fixture-provider.ts"),
		);

		fs.mkdirSync(path.join(tempDir, ".pi", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, ".pi", "agents", "lead.md"),
			"---\nname: lead\ndescription: Fanout lead fixture\ntools: subagent\nmodel: fanout-fixture/scripted\n---\nDelegate to the grandchild, then report done.\n",
		);
		fs.writeFileSync(
			path.join(tempDir, ".pi", "agents", "grandchild.md"),
			"---\nname: grandchild\ndescription: Fanout grandchild fixture\ntools: []\nmodel: fanout-fixture/scripted\n---\nReturn the fixture response.\n",
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		for (const [key, value] of originalEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		removeTempDir(tempDir);
	});

	it("finishes the grandchild and the lead without the lead repeating the completed delegation", async () => {
		let tool: RegisteredTool | undefined;
		fanoutChild!.default({
			events: createEventBus(),
			registerTool: (registered) => { tool = registered; },
			getSessionName: () => undefined,
		});
		assert.ok(tool, "expected the fanout-child subagent tool to register");

		const result = await tool.execute(
			"root-dispatch",
			{ agent: "lead", task: "NEXT_AGENT=grandchild" },
			new AbortController().signal,
			() => {},
			makeMinimalCtx(tempDir),
		);

		assert.equal(result.isError, undefined, `lead run reported an error: ${JSON.stringify(result)}`);
		assert.match(result.content.map((part) => part.text ?? "").join("\n"), /FIXTURE_DONE depth=1/);

		const rows = readFixtureLog(fixtureLog);
		assert.ok(rows.length > 0, "expected the fixture provider to have logged at least one decision");

		const leadDispatches = rows.filter((row) => row.depth === "1" && row.decision === "dispatch");
		const leadFinishes = rows.filter((row) => row.depth === "1" && row.decision === "finish-after-dispatch");
		const grandchildFinishes = rows.filter((row) => row.depth === "2" && row.decision === "finish-no-tool");

		assert.equal(leadDispatches.length, 1, `expected the lead to dispatch exactly once, saw: ${JSON.stringify(rows)}`);
		assert.equal(leadFinishes.length, 1, `expected the lead to finish exactly once after its own dispatch, saw: ${JSON.stringify(rows)}`);
		assert.equal(grandchildFinishes.length, 1, `expected the grandchild to finish exactly once, saw: ${JSON.stringify(rows)}`);
	});
});
