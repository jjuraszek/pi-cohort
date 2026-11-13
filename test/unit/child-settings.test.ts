import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { childSettingsError, mergeChildSettings, writeChildAgentDir } from "../../src/runs/shared/child-settings.ts";

describe("childSettingsError", () => {
	it("accepts pi keys and extension blocks alike", () => {
		assert.equal(childSettingsError(undefined, "settings"), undefined);
		assert.equal(childSettingsError({ quietStartup: true, contextPrune: { pruneOn: "next-prompt" } }, "settings"), undefined);
	});

	it("rejects anything that is not an object", () => {
		for (const value of ["next-prompt", ["contextPrune"], null, 3]) {
			assert.equal(childSettingsError(value, "tasks[1].settings"), "tasks[1].settings must be an object of settings.json keys.");
		}
	});

	for (const key of ["defaultProjectTrust", "httpProxy", "selfUpdateCommand"]) {
		it(`names ${key} when a child tries to override it`, () => {
			assert.equal(
				childSettingsError({ quietStartup: true, [key]: "x" }, "settings"),
				`settings.${key} cannot be overridden for a child: pi takes it only from the user's own settings.json.`,
			);
		});
	}
});

describe("mergeChildSettings", () => {
	it("lets the call win key by key and keeps the agent's other keys", () => {
		assert.deepEqual(
			mergeChildSettings(
				{ theme: "light", contextPrune: { pruneOn: "next-prompt", keep: 2 }, packages: ["a"] },
				{ contextPrune: { pruneOn: "agent-message" }, packages: ["b"] },
			),
			{ theme: "light", contextPrune: { pruneOn: "agent-message", keep: 2 }, packages: ["b"] },
		);
	});

	it("returns whichever side is set", () => {
		const agent = { theme: "light" };
		assert.equal(mergeChildSettings(agent, undefined), agent);
		assert.equal(mergeChildSettings(undefined, agent), agent);
		assert.equal(mergeChildSettings(undefined, undefined), undefined);
	});
});

describe("writeChildAgentDir", () => {
	let root = "";
	let parentDir = "";
	let childDir = "";

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-child-settings-"));
		parentDir = path.join(root, "parent");
		childDir = path.join(root, "child");
		fs.mkdirSync(path.join(parentDir, "extensions"), { recursive: true });
		fs.writeFileSync(path.join(parentDir, "extensions", "probe.ts"), "export default () => {};\n");
		fs.writeFileSync(path.join(parentDir, "auth.json"), "{\"token\":\"old\"}\n");
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	function childSettings(): unknown {
		return JSON.parse(fs.readFileSync(path.join(childDir, "settings.json"), "utf-8"));
	}

	it("merges the override into a copy of the parent's settings and leaves the parent's file alone", () => {
		const parentSettings = `${JSON.stringify({ theme: "dark", contextPrune: { pruneOn: "agent-message", keep: 3 } })}\n`;
		fs.writeFileSync(path.join(parentDir, "settings.json"), parentSettings);

		writeChildAgentDir(childDir, { contextPrune: { pruneOn: "next-prompt" } }, parentDir);

		assert.deepEqual(childSettings(), { theme: "dark", contextPrune: { pruneOn: "next-prompt", keep: 3 } });
		assert.equal(fs.readFileSync(path.join(parentDir, "settings.json"), "utf-8"), parentSettings);
		assert.equal(fs.lstatSync(path.join(childDir, "settings.json")).isSymbolicLink(), false);
	});

	it("shares every other entry with the parent, so a rewritten credential reaches the parent", () => {
		writeChildAgentDir(childDir, { quietStartup: true }, parentDir);

		assert.deepEqual(fs.readdirSync(childDir).sort(), ["auth.json", "extensions", "settings.json"]);
		assert.deepEqual(fs.readdirSync(path.join(childDir, "extensions")), ["probe.ts"]);
		fs.writeFileSync(path.join(childDir, "auth.json"), "{\"token\":\"new\"}\n");
		assert.equal(fs.readFileSync(path.join(parentDir, "auth.json"), "utf-8"), "{\"token\":\"new\"}\n");
	});

	for (const [label, holder, contender] of [
		["two sessions on the parent directory", "parent", "parent"],
		["the parent and an overridden child", "parent", "child"],
		["two overridden children", "child", "sibling"],
	] as const) {
		it(`serializes MCP OAuth refreshes between ${label}`, async () => {
			const { McpOAuthCredentialStore } = await import(new URL(
				"extensions/mcp/oauth.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
			).href);
			fs.writeFileSync(path.join(parentDir, "mcp-auth.json"), "{}\n");
			const dirs = { parent: parentDir, child: childDir, sibling: path.join(root, "sibling") };
			for (const dir of [dirs.child, dirs.sibling]) {
				writeChildAgentDir(dir, { quietStartup: true }, parentDir);
				assert.equal(fs.realpathSync(path.join(dir, "mcp-auth.json")), fs.realpathSync(path.join(parentDir, "mcp-auth.json")));
			}
			function serverStore(dir: string) {
				const previous = process.env.PI_CODING_AGENT_DIR;
				try {
					process.env.PI_CODING_AGENT_DIR = dir;
					return new McpOAuthCredentialStore().forServer("fixture", "https://mcp.example/");
				} finally {
					if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
					else process.env.PI_CODING_AGENT_DIR = previous;
				}
			}
			const first = serverStore(dirs[holder]);
			const second = serverStore(dirs[contender]);
			let firstReleased = false;
			let overlapped = false;
			let secondRefresh: Promise<void> | undefined;
			await first.withRefreshLock(async () => {
				secondRefresh = second.withRefreshLock(async () => { overlapped = !firstReleased; });
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([secondRefresh, new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); })]);
				} finally {
					clearTimeout(timer);
				}
			});
			firstReleased = true;
			await secondRefresh;
			assert.equal(overlapped, false, "shared MCP credentials must not refresh under independent locks");
		});
	}

	it("starts from the override alone when the parent has no settings file", () => {
		writeChildAgentDir(childDir, { quietStartup: true }, parentDir);
		assert.deepEqual(childSettings(), { quietStartup: true });
	});

	it("starts from the override alone when the parent has no agent directory", () => {
		writeChildAgentDir(childDir, { quietStartup: true }, path.join(root, "missing"));
		assert.deepEqual(fs.readdirSync(childDir), ["settings.json"]);
	});

	it("refuses to launch over a parent settings file it cannot parse", () => {
		fs.writeFileSync(path.join(parentDir, "settings.json"), "{ not json");
		assert.throws(
			() => writeChildAgentDir(childDir, { quietStartup: true }, parentDir),
			/^Error: Cannot apply the child's settings override: /,
		);
		assert.equal(fs.existsSync(childDir), false);
	});
});
