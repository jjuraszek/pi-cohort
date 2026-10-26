import assert from "node:assert/strict";
import { describe, it, after, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveExtensionConfig } from "../../src/agents/agents.ts";
import { resolveCurrentMaxSubagentDepth, resolveTopLevelParallelMaxTasks } from "../../src/shared/types.ts";

describe("extension settings ladder", () => {
	let tempDirs: string[] = [];
	let previousProfile: string | undefined;
	let profile: string;
	beforeEach(() => {
		previousProfile = process.env.PI_CODING_AGENT_DIR;
		profile = createTempRepo();
		process.env.PI_CODING_AGENT_DIR = profile;
	});
	afterEach(() => {
		if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousProfile;
	});

	after(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function createTempRepo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-test-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		return dir;
	}

	function writeProjectSettings(repoDir: string, level: string, settings: unknown): void {
		const settingsDir = path.join(repoDir, level, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: settings }));
	}

	it("leaves depth and parallel defaults in consumers", () => {
		const config = resolveExtensionConfig(createTempRepo());
		assert.deepEqual(config, {});
		const previous = process.env.PI_SUBAGENT_MAX_DEPTH;
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		try {
			assert.equal(resolveCurrentMaxSubagentDepth(config.maxSubagentDepth), 2);
		} finally {
			if (previous !== undefined) process.env.PI_SUBAGENT_MAX_DEPTH = previous;
		}
		assert.equal(resolveTopLevelParallelMaxTasks(config.parallel?.maxTasks), 8);
	});

	it("returns undefined when no settings exist", () => {
		const repoDir = createTempRepo();
		const result = resolveExtensionConfig(repoDir).executionBackend;
		assert.equal(result, undefined);
	});

	it("reads executionBackend from root level", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { executionBackend: "test-backend" });
		const result = resolveExtensionConfig(repoDir).executionBackend;
		assert.equal(result, "test-backend");
	});

	it("nearest level wins over farther levels", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested", "sub");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });
		writeProjectSettings(repoDir, "nested", { executionBackend: "nested-backend" });

		const result = resolveExtensionConfig(subdir).executionBackend;
		assert.equal(result, "nested-backend");
	});

	it("skips levels with no settings", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested", "sub");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });
		// nested level has no .pi/settings.json

		const result = resolveExtensionConfig(subdir).executionBackend;
		assert.equal(result, "root-backend");
	});

	it("skips levels with malformed JSON", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });

		const nestedDir = path.join(repoDir, "nested", ".pi");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "settings.json"), "{ invalid json");

		const result = resolveExtensionConfig(subdir).executionBackend;
		assert.equal(result, "root-backend");
	});

	it("normalizes string value by trimming whitespace", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { executionBackend: "  spaced  " });
		const result = resolveExtensionConfig(repoDir).executionBackend;
		assert.equal(result, "spaced");
	});

	it("returns undefined when executionBackend is not in subagents settings", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { disableBuiltins: true });
		const result = resolveExtensionConfig(repoDir).executionBackend;
		assert.equal(result, undefined);
	});

	it("handles three-level nesting with middle level winning", () => {
		const repoDir = createTempRepo();
		const middle = path.join(repoDir, "middle");
		const deepest = path.join(middle, "deepest");
		fs.mkdirSync(deepest, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root" });
		writeProjectSettings(repoDir, "middle", { executionBackend: "middle" });
		// deepest has no setting

		const result = resolveExtensionConfig(deepest).executionBackend;
		assert.equal(result, "middle");
	});

	it("stops at git root and does not walk parent directories", () => {
		const repoDir = createTempRepo();
		const nested = path.join(repoDir, "nested");
		fs.mkdirSync(nested, { recursive: true });

		// Only nested has settings
		writeProjectSettings(repoDir, "nested", { executionBackend: "nested-backend" });

		// Create another temp dir that could theoretically be a parent
		// but is actually unrelated
		const unrelatedParent = createTempRepo();
		writeProjectSettings(unrelatedParent, ".", { executionBackend: "unrelated" });

		const result = resolveExtensionConfig(nested).executionBackend;
		assert.equal(result, "nested-backend");
	});

	it("throws for blank executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: "" } }));

		assert.throws(
			() => resolveExtensionConfig(repoDir).executionBackend,
			/must not be blank/i,
		);
	});

	it("throws for whitespace-only executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: "  \t  " } }));

		assert.throws(
			() => resolveExtensionConfig(repoDir).executionBackend,
			/must not be blank/i,
		);
	});

	it("throws for non-string executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: 123 } }));

		assert.throws(
			() => resolveExtensionConfig(repoDir).executionBackend,
			/invalid.*executionBackend/i,
		);
	});
	const rows = [
		["asyncByDefault", true, false, true],
		["forceTopLevelAsync", false, true, false],
		["showRosterOnStart", true, false, true],
		["forwardParentFlags", false, true, false],
		["defaultSessionDir", "profile", "root", "nearest"],
		["maxSubagentDepth", 1, 2, 3],
		["control", { a: 1 }, { b: 2 }, { c: 3 }],
		["parallel", { maxTasks: 1, concurrency: 1 }, { maxTasks: 2 }, { concurrency: 3 }],
		["chain", { dynamicFanout: { maxItems: 1 } }, { other: 2 }, {}],
		["worktreeSetupHook", "profile", "root", "nearest"],
		["worktreeTeardownHook", "profile", "root", "nearest"],
		["worktreeSetupHookTimeoutMs", 1, 2, 3],
		["worktreeTeardownHookTimeoutMs", 4, 5, 6],
		["executionBackend", "profile", "root", "nearest"],
	] as const;
	for (const [key, user, root, nearest] of rows) {
		it(`resolves sparse ${key} through nearest, root, profile, absence`, () => {
			const repo = createTempRepo();
			const nested = path.join(repo, "nested");
			fs.mkdirSync(nested);
			const profilePath = path.join(profile, "settings.json");
			fs.writeFileSync(profilePath, JSON.stringify({ subagents: { [key]: user, disableBuiltins: true, agentOverrides: {} } }));
			writeProjectSettings(repo, ".", { [key]: root });
			writeProjectSettings(repo, "nested", { [key]: nearest });
			assert.deepEqual(resolveExtensionConfig(nested), { [key]: nearest });
			fs.unlinkSync(path.join(nested, ".pi", "settings.json"));
			assert.deepEqual(resolveExtensionConfig(nested), { [key]: root });
			fs.unlinkSync(path.join(repo, ".pi", "settings.json"));
			assert.deepEqual(resolveExtensionConfig(nested), { [key]: user });
			fs.unlinkSync(profilePath);
			assert.deepEqual(resolveExtensionConfig(nested), {});
		});
	}

	for (const [key, invalid] of [
		["asyncByDefault", "true"], ["forceTopLevelAsync", 1],
		["showRosterOnStart", null], ["forwardParentFlags", {}],
		["defaultSessionDir", false], ["worktreeSetupHook", []], ["worktreeTeardownHook", 1],
		["maxSubagentDepth", -1], ["maxSubagentDepth", 1.5], ["maxSubagentDepth", "2"],
		["control", null], ["parallel", []], ["chain", "bad"],
	] as const) {
		it(`warns per read and drops only invalid ${key}=${JSON.stringify(invalid)}`, () => {
			const repo = createTempRepo();
			writeProjectSettings(repo, ".", { [key]: invalid, executionBackend: "native" });
			const warnings: string[] = [];
			const warn = console.warn;
			console.warn = (message) => warnings.push(String(message));
			try {
				for (let read = 0; read < 2; read++) assert.deepEqual(resolveExtensionConfig(repo), { executionBackend: "native" });
			} finally { console.warn = warn; }
			assert.equal(warnings.length, 2);
			for (const warning of warnings) {
				assert.ok(warning.includes(path.join(repo, ".pi", "settings.json")));
				assert.ok(warning.includes(key));
			}
		});
	}
	for (const value of [0, -1, 1.5, "invalid"]) {
		it(`preserves timeout ${value} for consumer validation`, () => {
			const repo = createTempRepo();
			writeProjectSettings(repo, ".", { worktreeSetupHookTimeoutMs: value, worktreeTeardownHookTimeoutMs: value });
			assert.deepEqual(resolveExtensionConfig(repo), { worktreeSetupHookTimeoutMs: value, worktreeTeardownHookTimeoutMs: value });
		});
	}
	it("preserves empty hook paths", () => {
		const repo = createTempRepo();
		writeProjectSettings(repo, ".", { worktreeSetupHook: "", worktreeTeardownHook: "" });
		assert.deepEqual(resolveExtensionConfig(repo), { worktreeSetupHook: "", worktreeTeardownHook: "" });
	});
	it("throws on malformed profile JSON", () => {
		fs.writeFileSync(path.join(profile, "settings.json"), "{");
		assert.throws(() => resolveExtensionConfig(createTempRepo()));
	});
	it("reads a marked non-git ancestor but not an unmarked cwd", () => {
		const repo = createTempRepo();
		fs.rmdirSync(path.join(repo, ".git"));
		const nested = path.join(repo, "nested");
		fs.mkdirSync(nested);
		assert.deepEqual(resolveExtensionConfig(nested), {});
		writeProjectSettings(repo, ".", { maxSubagentDepth: 0 });
		assert.deepEqual(resolveExtensionConfig(nested), { maxSubagentDepth: 0 });
	});

});
