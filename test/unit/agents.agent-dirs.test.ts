import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, resolveExtensionConfig } from "../../src/agents/agents.ts";

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

	for (const agentDirs of ["../.claude/agents", ["../.claude/agents"], " ../.claude/agents ", [" ../.claude/agents "]]) {
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
			assert.deepEqual(resolveExtensionConfig(repoRoot), {}, "agentDirs is not an extension setting");
		});
	}

	it("accepts multiple paths including home and absolute entries as project personas", () => {
		const homeDir = path.join(os.homedir(), "extra-personas");
		const absoluteDir = path.join(tempDir, "absolute-personas");
		writeFile(path.join(homeDir, "home-persona.md"), agentFile("home-persona"));
		writeFile(path.join(absoluteDir, "absolute-persona.md"), agentFile("absolute-persona"));
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentDirs: ["~/extra-personas", absoluteDir] },
		}));

		const listed = discoverAgentsAll(repoRoot).project;
		assert.deepEqual(listed.map((agent) => agent.name).sort(), ["absolute-persona", "home-persona"]);
		assert.ok(listed.every((agent) => agent.source === "project"));
		assert.deepEqual(discoverAgents(repoRoot, "both").agents.filter((agent) => agent.source === "project"), listed);
	});

	for (const agentDirs of ["../.claude/agents", []]) {
		it(`bundled and user personas stay discovered with agentDirs set: ${JSON.stringify(agentDirs)}`, () => {
			writeFile(path.join(os.homedir(), ".agents", "home-persona.md"), agentFile("home-persona"));
			writeFile(path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "profile-persona.md"), agentFile("profile-persona"));
			writeFile(path.join(repoRoot, ".claude", "agents", "configured.md"), agentFile("configured"));
			const settingsPath = path.join(repoRoot, ".pi", "settings.json");
			writeFile(settingsPath, JSON.stringify({ subagents: {} }));
			const baseline = discoverAgentsAll(repoRoot);
			const baselineDispatch = discoverAgents(repoRoot, "both");
			assert.ok(baseline.builtin.length > 0, "bundled personas need no directory entry");
			assert.deepEqual(baseline.user.map((agent) => agent.name), ["home-persona", "profile-persona"]);

			writeFile(settingsPath, JSON.stringify({ subagents: { agentDirs } }));
			const listed = discoverAgentsAll(repoRoot);
			assert.deepEqual(listed.builtin, baseline.builtin);
			assert.deepEqual(listed.user, baseline.user);
			assert.deepEqual(listed.project.map((agent) => agent.name), typeof agentDirs === "string" ? ["configured"] : []);
			assert.deepEqual(
				discoverAgents(repoRoot, "both").agents.filter((agent) => agent.source !== "project"),
				baselineDispatch.agents,
			);
			assert.deepEqual(discoverAgents(repoRoot, "user").agents, baselineDispatch.agents, "user scope excludes configured personas");
		});

		for (const disableBuiltins of [false, true]) {
			it(`disableBuiltins and agentOverrides keep their behavior with agentDirs set: ${JSON.stringify({ agentDirs, disableBuiltins })}`, () => {
				const profile = process.env.PI_CODING_AGENT_DIR!;
				writeFile(path.join(profile, "agents", "user-persona.md"), agentFile("user-persona"));
				writeFile(path.join(profile, "settings.json"), JSON.stringify({ subagents: {
					disableBuiltins: true,
					agentOverrides: {
						worker: { disabled: false, model: "user-model", thinking: "low" },
						reviewer: { disabled: false, model: "user-reviewer-model" },
						"user-persona": { model: "user-model" },
					},
				} }));
				writeFile(path.join(repoRoot, ".claude", "agents", "configured.md"), agentFile("configured"));
				const settingsPath = path.join(repoRoot, ".pi", "settings.json");
				const subagents = {
					disableBuiltins,
					agentOverrides: {
						worker: { disabled: false, model: "project-model", thinking: "high" },
						"user-persona": { model: "project-user-model" },
					},
				};
				writeFile(settingsPath, JSON.stringify({ subagents }));
				const baseline = discoverAgentsAll(repoRoot);
				const baselineDispatch = discoverAgents(repoRoot, "both");
				const worker = baselineDispatch.agents.find((agent) => agent.name === "worker");
				assert.equal(worker?.source, "builtin");
				assert.equal(worker.model, "project-model");
				assert.equal(worker.thinking, "high");
				assert.equal(baseline.builtin.find((agent) => agent.name === "reviewer")?.disabled, disableBuiltins);
				assert.equal(baselineDispatch.agents.some((agent) => agent.name === "reviewer"), !disableBuiltins);
				assert.equal(baselineDispatch.agents.some((agent) => agent.name === "planner"), !disableBuiltins);
				assert.equal(baseline.user[0].model, "project-user-model");

				writeFile(settingsPath, JSON.stringify({ subagents: { ...subagents, agentDirs } }));
				const listed = discoverAgentsAll(repoRoot);
				const dispatched = discoverAgents(repoRoot, "both").agents;
				assert.deepEqual(listed.builtin, baseline.builtin, "builtin disable and override metadata stay unchanged");
				assert.deepEqual(listed.user, baseline.user, "custom user overrides stay unchanged");
				assert.deepEqual(dispatched.filter((agent) => agent.source !== "project"), baselineDispatch.agents);
				assert.deepEqual(dispatched.filter((agent) => agent.source === "project").map((agent) => agent.name),
					typeof agentDirs === "string" ? ["configured"] : [], "bulk disable does not disable configured personas");
			});
		}
	}

	for (const agentDirs of ["../extra-personas", [], 42]) {
		it(`agentDirs in the profile settings adds nothing: ${JSON.stringify(agentDirs)}`, (t) => {
			writeFile(path.join(tempDir, "extra-personas", "profile-extra.md"), agentFile("profile-extra"));
			const settingsPath = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
			const baseline = discoverAgentsAll(repoRoot);
			const baselineDispatch = discoverAgents(repoRoot, "both");
			const warnings: string[] = [];
			t.mock.method(console, "warn", (message: string) => warnings.push(message));
			writeFile(settingsPath, JSON.stringify({ subagents: { agentDirs } }));

			assert.deepEqual(discoverAgentsAll(repoRoot), baseline);
			assert.deepEqual(discoverAgents(repoRoot, "both"), baselineDispatch);
			const warning = `Subagent settings in '${settingsPath}' have invalid 'agentDirs'; expected a string or an array of non-empty strings.`;
			assert.deepEqual(warnings, agentDirs === 42 ? [warning, warning] : []);
		});
	}

	for (const agentDirs of [null, 42, true, {}, "", " \t ", ["../.claude/agents", 42], ["../.claude/agents", " "]]) {
		it(`drops invalid agentDirs with a warning and keeps other settings: ${JSON.stringify(agentDirs)}`, (t) => {
			const warnings: string[] = [];
			t.mock.method(console, "warn", (message: string) => warnings.push(message));
			const settingsPath = path.join(repoRoot, ".pi", "settings.json");
			writeFile(path.join(repoRoot, ".claude", "agents", "configured.md"), agentFile("configured"));
			writeFile(path.join(repoRoot, ".pi", "agents", "default.md"), agentFile("default"));
			writeFile(settingsPath, JSON.stringify({ subagents: {
				agentDirs,
				agentOverrides: { default: { model: "test-model" } },
			} }));

			const listed = discoverAgentsAll(repoRoot).project;
			assert.deepEqual(listed.map((agent) => agent.name), ["default"]);
			assert.equal(listed[0].model, "test-model");
			assert.deepEqual(warnings, [
				`Subagent settings in '${settingsPath}' have invalid 'agentDirs'; expected a string or an array of non-empty strings.`,
			]);
		});
	}
});
