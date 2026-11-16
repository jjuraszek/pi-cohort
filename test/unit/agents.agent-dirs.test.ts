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

function agentFile(name: string, fields: Record<string, string> = {}): string {
	const frontmatter = Object.entries(fields).map(([key, value]) => `${key}: ${value}\n`).join("");
	return `---\nname: ${name}\ndescription: ${name} persona\n${frontmatter}---\n\nYou are ${name}.\n`;
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

	it("a persona only in a configured directory is listed and dispatched from its original file", () => {
		const configuredDir = path.join(repoRoot, ".claude", "agents");
		const originalFile = path.join(configuredDir, "configured.md");
		const content = agentFile("configured");
		writeFile(originalFile, content);
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentDirs: "../.claude/agents" },
		}));
		const defaultDirs = [path.join(repoRoot, ".agents"), path.join(repoRoot, ".pi", "agents")];
		for (const dir of defaultDirs) fs.mkdirSync(dir, { recursive: true });

		const listed = discoverAgentsAll(repoRoot).project;
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "configured");
		assert.equal(listed[0].source, "project");
		assert.equal(listed[0].filePath, originalFile);
		assert.equal(listed[0].systemPrompt, "You are configured.");
		const dispatched = discoverAgents(repoRoot, "both").agents.filter((agent) => agent.name === "configured");
		assert.deepEqual(dispatched, listed, "dispatch uses the same original definition as listing");

		for (const dir of defaultDirs) {
			assert.deepEqual(fs.readdirSync(dir), [], "discovery creates no copy or symlink in default directories");
		}
		assert.deepEqual(fs.readdirSync(configuredDir), ["configured.md"]);
		assert.ok(fs.lstatSync(originalFile).isFile());
		assert.equal(fs.realpathSync(originalFile), originalFile, "the original definition needs no symlink");
		assert.equal(fs.readFileSync(originalFile, "utf-8"), content);
	});

	for (const nestedAgentDirs of [undefined, [], "../.claude/agents"]) {
		it(`relative entries resolve against each settings file from any cwd: ${JSON.stringify(nestedAgentDirs) ?? "absent"}`, () => {
			const nestedRoot = path.join(repoRoot, "services", "api");
			const deepCwd = path.join(nestedRoot, "src");
			fs.mkdirSync(deepCwd, { recursive: true });
			const rootFile = path.join(repoRoot, ".claude", "agents", "root-persona.md");
			const nestedFile = path.join(nestedRoot, ".claude", "agents", "nested-persona.md");
			writeFile(rootFile, agentFile("root-persona"));
			writeFile(nestedFile, agentFile("nested-persona"));
			writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
				subagents: { agentDirs: "../.claude/agents" },
			}));
			writeFile(path.join(nestedRoot, ".pi", "settings.json"), JSON.stringify({
				subagents: { agentDirs: nestedAgentDirs },
			}));

			for (const cwd of [repoRoot, nestedRoot, deepCwd]) {
				const expectedFiles = cwd !== repoRoot && typeof nestedAgentDirs === "string"
					? [rootFile, nestedFile].sort()
					: [rootFile];
				const listed = discoverAgentsAll(cwd);
				const dispatched = discoverAgents(cwd, "both");
				assert.deepEqual(listed.project.map((agent) => agent.filePath).sort(), expectedFiles,
					"each settings file resolves its own entries without clearing ancestor entries");
				assert.deepEqual(dispatched.agents.filter((agent) => agent.source === "project"), listed.project);
				const createDir = path.join(cwd === repoRoot ? repoRoot : nestedRoot, ".pi", "agents");
				assert.equal(listed.projectDir, createDir, "configured directories do not change the create target");
				assert.equal(dispatched.projectAgentsDir, createDir);
			}
		});
	}

	it("a definition added later is discovered without a per-agent entry", () => {
		const configuredDir = path.join(repoRoot, ".claude", "agents");
		const settingsPath = path.join(repoRoot, ".pi", "settings.json");
		const settings = JSON.stringify({ subagents: { agentDirs: "../.claude/agents" } });
		fs.mkdirSync(configuredDir, { recursive: true });
		writeFile(settingsPath, settings);
		assert.deepEqual(discoverAgentsAll(repoRoot).project, []);
		assert.deepEqual(discoverAgents(repoRoot, "both").agents.filter((agent) => agent.source === "project"), []);

		const addedFile = path.join(configuredDir, "added-later.md");
		writeFile(addedFile, agentFile("added-later"));
		const listed = discoverAgentsAll(repoRoot).project;
		assert.equal(listed.length, 1);
		assert.equal(listed[0].name, "added-later");
		assert.equal(listed[0].filePath, addedFile);
		assert.deepEqual(discoverAgents(repoRoot, "both").agents.filter((agent) => agent.source === "project"), listed);
		assert.equal(fs.readFileSync(settingsPath, "utf-8"), settings, "directory discovery needs no per-agent settings change");
	});

	for (const fields of [
		{},
		{ model: "frontmatter-model" },
		{ thinking: "low" },
		{ model: "frontmatter-model", thinking: "low" },
	] as Record<string, string>[]) {
		it(`frontmatter wins and overrides fill unset model and thinking for a configured persona: ${JSON.stringify(fields)}`, () => {
			const name = "configured";
			const content = agentFile(name, fields);
			const defaultFile = path.join(repoRoot, ".pi", "agents", "definition.md");
			const configuredFile = path.join(repoRoot, ".claude", "agents", "definition.md");
			writeFile(defaultFile, content);
			writeFile(configuredFile, content);
			const settingsPath = path.join(repoRoot, ".pi", "settings.json");
			const agentOverrides = { [name]: { model: "override-model", thinking: "high" } };
			writeFile(settingsPath, JSON.stringify({ subagents: { agentOverrides } }));
			const baseline = discoverAgents(repoRoot, "both").agents.find((agent) => agent.name === name);
			assert.ok(baseline);
			assert.equal(baseline.filePath, defaultFile);

			writeFile(settingsPath, JSON.stringify({ subagents: { agentDirs: "../.claude/agents", agentOverrides } }));
			const listed = discoverAgentsAll(repoRoot).project;
			assert.equal(listed.length, 1);
			assert.equal(listed[0].filePath, configuredFile);
			assert.equal(listed[0].source, "project");
			assert.equal(listed[0].model, fields.model ?? "override-model");
			assert.equal(listed[0].thinking, fields.thinking ?? "high");
			assert.deepEqual(listed[0], { ...baseline, filePath: configuredFile },
				"configured and default locations use the same per-field resolution and override metadata");
			const dispatched = discoverAgents(repoRoot, "both").agents.filter((agent) => agent.name === name);
			assert.deepEqual(dispatched, listed, "dispatch preserves frontmatter and fills only unset fields by persona name");
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

	for (const agentDirs of [
		["../.claude/agents", "../team-personas"],
		["../team-personas", "../.claude/agents"],
	]) {
		it(`the later array entry wins in listing and dispatch above defaults, user and bundled personas: ${JSON.stringify(agentDirs)}`, () => {
			const name = "worker";
			const userFile = path.join(process.env.PI_CODING_AGENT_DIR!, "agents", "worker.md");
			writeFile(userFile, agentFile(name, { model: "user-model" }));
			writeFile(path.join(repoRoot, ".agents", "worker.md"), agentFile(name, { model: "legacy-model" }));
			writeFile(path.join(repoRoot, ".pi", "agents", "worker.md"), agentFile(name, { model: "default-model" }));
			for (const dir of agentDirs) {
				writeFile(path.resolve(repoRoot, ".pi", dir, "worker.md"), agentFile(name, { model: dir }));
			}
			writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({ subagents: { agentDirs } }));

			const listed = discoverAgentsAll(repoRoot);
			assert.ok(listed.builtin.some((agent) => agent.name === name), "the clash includes a real bundled persona");
			assert.equal(listed.user.find((agent) => agent.name === name)?.filePath, userFile);
			assert.equal(listed.project.length, 1, "listing deduplicates all project copies by name");
			assert.equal(listed.project[0].filePath, path.resolve(repoRoot, ".pi", agentDirs[1], "worker.md"));
			assert.equal(listed.project[0].model, agentDirs[1]);
			assert.equal(listed.project[0].source, "project");
			assert.deepEqual(discoverAgents(repoRoot, "both").agents.filter((agent) => agent.name === name), listed.project,
				"dispatch uses the later configured file over defaults, user and bundled copies");

			const nestedRoot = path.join(repoRoot, "service");
			const nestedFile = path.join(nestedRoot, ".pi", "agents", "worker.md");
			writeFile(nestedFile, agentFile(name, { model: "nearer-default-model" }));
			const nestedListed = discoverAgentsAll(nestedRoot).project;
			assert.equal(nestedListed.length, 1);
			assert.equal(nestedListed[0].filePath, nestedFile, "a nearer default still outranks farther configured entries");
			assert.deepEqual(discoverAgents(nestedRoot, "both").agents.filter((agent) => agent.name === name), nestedListed);
		});
	}

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
