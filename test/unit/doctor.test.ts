import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { buildDoctorReport } from "../../src/extension/doctor.ts";
import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import type { ExtensionConfig, SubagentState } from "../../src/shared/types.ts";

function makeState(cwd: string): SubagentState {
	return {
		baseCwd: cwd,
		currentSessionId: "session-current",
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

function makeAgent(name: string, source: AgentConfig["source"]): AgentConfig {
	return {
		name,
		description: `${name} agent`,
		systemPrompt: "Prompt",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source,
		filePath: `/tmp/${name}.md`,
	};
}

function makeChain(name: string, source: ChainConfig["source"]): ChainConfig {
	return {
		name,
		description: `${name} chain`,
		source,
		filePath: `/tmp/${name}.chain.md`,
		steps: [{ agent: "worker", task: "Work" }],
	};
}

describe("buildDoctorReport", () => {
	it("formats a bounded successful environment summary", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-success-"));
		try {
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });

			const report = buildDoctorReport({
				cwd: root,
				config: { defaultSessionDir: "~/subagent-sessions" } as ExtensionConfig,
				state: makeState(root),
				currentSessionFile: path.join(root, "sessions", "parent.jsonl"),
				currentSessionId: "session-abc123",
				expandTilde: (value) => value.replace(/^~\//, `${root}/home/`),
				paths,
				deps: {
					isAsyncAvailable: () => true,
					discoverAgentsAll: () => ({
						builtin: [makeAgent("builtin-a", "builtin")],
						user: [makeAgent("user-a", "user")],
						project: [makeAgent("project-a", "project"), makeAgent("project-b", "project")],
						chains: [makeChain("user-flow", "user"), makeChain("project-flow", "project")],
						userDir: path.join(root, "home", ".agents"),
						projectDir: path.join(root, ".pi", "agents"),
						userChainDir: path.join(root, "home", ".pi", "agent", "chains"),
						projectChainDir: path.join(root, ".pi", "chains"),
						userSettingsPath: path.join(root, "home", ".pi", "agent", "settings.json"),
						projectSettingsPath: path.join(root, ".pi", "settings.json"),
					}),
					discoverAvailableSkills: () => [
						{ name: "project-skill", source: "project" },
						{ name: "package-skill", source: "user-package" },
					],
				},
			});

			assert.match(report, /^Subagents doctor report/);
			assert.ok(report.includes(`- cwd: ${root}`));
			assert.match(report, /- async support: available/);
			assert.match(report, /- configured session dir: .*subagent-sessions/);
			assert.match(report, /- current session file: .*parent\.jsonl/);
			assert.match(report, /- temp root: ok /);
			assert.match(report, /- agents: total 4 \(builtin 1, user 1, project 2\)/);
			assert.match(report, /- chains: total 2 \(builtin 0, user 1, project 1\)/);
			assert.match(report, /- skills: total 2 \(project 1, user-package 1\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps reporting when a directory or discovery check fails", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-failure-"));
		try {
			const asyncPath = path.join(root, "async-file");
			fs.writeFileSync(asyncPath, "not a directory");
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				paths: {
					tempRootDir: root,
					asyncDir: asyncPath,
					resultsDir: path.join(root, "missing-results"),
					chainRunsDir: path.join(root, "missing-chains"),
				},
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => {
						throw new Error("discovery exploded");
					},
					discoverAvailableSkills: () => [],
				},
			});

			assert.match(report, /- async support: unavailable/);
			assert.match(report, /- async runs: failed .*Error: not a directory:/);
			assert.match(report, /- results: missing /);
			assert.match(report, /- agents\/chains: failed — Error: discovery exploded/);
			assert.match(report, /- skills: total 0 \(none\)/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes an empty Cost section when externalCostBySource is empty", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-cost-empty-"));
		try {
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state: makeState(root),
				paths,
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => ({ builtin: [], user: [], project: [], chains: [], userDir: "", projectDir: "", userChainDir: "", projectChainDir: "", userSettingsPath: "", projectSettingsPath: "" }),
					discoverAvailableSkills: () => [],
				},
			});
			assert.match(report, /^Cost$/m);
			assert.ok(report.includes("- external: $0.0000 (0 sources)"));
			assert.doesNotMatch(report, /^  - /m);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("includes per-source rows in Cost section when externalCostBySource is non-empty", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-doctor-cost-filled-"));
		try {
			const paths = {
				tempRootDir: path.join(root, "temp-root"),
				asyncDir: path.join(root, "async"),
				resultsDir: path.join(root, "results"),
				chainRunsDir: path.join(root, "chains"),
			};
			for (const dir of Object.values(paths)) fs.mkdirSync(dir, { recursive: true });
			const state = makeState(root);
			state.grandTotal.externalCostBySource.set("pi-context-prune", { totalCost: 0.12, inputTokens: 1234, outputTokens: 400 });
			state.grandTotal.externalCostBySource.set("other", { totalCost: 0.03 });
			const report = buildDoctorReport({
				cwd: root,
				config: {},
				state,
				paths,
				deps: {
					isAsyncAvailable: () => false,
					discoverAgentsAll: () => ({ builtin: [], user: [], project: [], chains: [], userDir: "", projectDir: "", userChainDir: "", projectChainDir: "", userSettingsPath: "", projectSettingsPath: "" }),
					discoverAvailableSkills: () => [],
				},
			});
			assert.ok(report.includes("- external: $0.1500 (2 sources)"));
			assert.match(report, /  - pi-context-prune \$0\.1200 \(in 1\.2k \/ out 400\)/);
			assert.match(report, /  - other \$0\.0300/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
