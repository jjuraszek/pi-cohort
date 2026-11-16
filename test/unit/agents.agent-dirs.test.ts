import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll } from "../../src/agents/agents.ts";

let tempDir = "";
let repoRoot = "";
let oldEnv: Record<string, string | undefined> = {};

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function agentFile(name: string): string {
	return `---\nname: ${name}\ndescription: ${name} persona\n---\n\nYou are ${name}.\n`;
}

describe("project agentDirs setting", () => {
	beforeEach(() => {
		oldEnv = {
			HOME: process.env.HOME,
			USERPROFILE: process.env.USERPROFILE,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		};
		tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-dirs-")));
		const emptyHome = path.join(tempDir, "home");
		const emptyAgentDir = path.join(tempDir, "agent");
		fs.mkdirSync(emptyHome);
		fs.mkdirSync(emptyAgentDir);
		process.env.HOME = emptyHome;
		process.env.USERPROFILE = emptyHome;
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
		repoRoot = path.join(tempDir, "repo");
		fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	for (const agentDirs of ["../.claude/agents", ["../.claude/agents"]]) {
		it(`a string and a one-element array discover the same personas: ${JSON.stringify(agentDirs)}`, () => {
			const names = ["configured-alpha", "configured-beta"];
			for (const name of names) {
				writeFile(path.join(repoRoot, ".claude", "agents", `${name}.md`), agentFile(name));
			}
			writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({ subagents: { agentDirs } }));

			const listed = discoverAgentsAll(repoRoot).project;
			const dispatched = discoverAgents(repoRoot, "both").agents.filter((agent) => agent.source === "project");
			assert.deepEqual(listed.map((agent) => agent.name).sort(), names, "listing discovers both configured personas");
			assert.deepEqual(dispatched, listed, "dispatch discovers the same personas as listing");
		});
	}
});
