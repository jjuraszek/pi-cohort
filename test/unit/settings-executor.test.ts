import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it, mock } from "node:test";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { createMockPi } from "../support/mock-pi.ts";
import { capturePiRuntime } from "../../src/runs/shared/pi-spawn.ts";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import registerFanoutChildSubagentExtension from "../../src/extension/fanout-child.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

it("resolves each call at its requested cwd without retaining a policy snapshot", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-executor-"));
	try {
		const roots = [path.join(root, "a"), path.join(root, "b")];
		const reads: string[] = [];
		const executor = createSubagentExecutor({
			pi: { events: createEventBus(), getSessionName: () => undefined } as any,
			state: { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null } as any,
			resolveConfig: (cwd) => {
				reads.push(cwd);
				return { defaultSessionDir: path.join(cwd, "sessions") };
			},
			tempArtifactsDir: root,
			getSubagentSessionRoot: () => root,
			expandTilde: (value) => value,
			discoverAgents: () => ({ agents: [] }),
		});
		await Promise.all(roots.map(async (cwd) => {
			const result = await executor.execute("doctor", { action: "doctor", cwd }, new AbortController().signal, undefined, makeMinimalCtx(root));
			assert.equal(result.isError, undefined);
			assert.ok(result.content[0]?.text?.includes(path.join(cwd, "sessions")));
			assert.doesNotMatch(result.content[0]?.text ?? "", /provenance/);
		}));
		assert.deepEqual(reads, roots);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function fixture(root: string, resolveConfig: (cwd: string) => any, runtime: any) {
	const state = { baseCwd: root, currentSessionId: null, asyncJobs: new Map(), foregroundRuns: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null } as any;
	return { state, executor: createSubagentExecutor({
		pi: { events: createEventBus(), getSessionName: () => undefined } as any,
		state, resolveConfig, captureRuntime: () => runtime ?? capturePiRuntime({ installRoot: getPackageDir() }),
		tempArtifactsDir: root, getSubagentSessionRoot: () => root,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [{ name: "worker", systemPrompt: "help" }] as any }),
	}) };
}

it("passes each call's hooks and timeouts through createWorktrees", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-hooks-"));
	try {
		const roots = ["a", "b"].map((name) => path.join(root, name));
		for (const cwd of roots) {
			fs.mkdirSync(cwd);
			for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]]) {
				assert.equal(spawnSync("git", args, { cwd }).status, 0);
			}
			fs.writeFileSync(path.join(cwd, ".git", "info", "exclude"), "hook.sh\ncalled\n");
			fs.writeFileSync(path.join(cwd, "hook.sh"), `#!/bin/sh\nprintf called > '${path.join(cwd, "called")}'\nexec sleep 5\n`, { mode: 0o755 });
		}
		const reads: string[] = [];
		const { executor } = fixture(root, (cwd) => {
			reads.push(cwd);
			return { worktreeSetupHook: path.join(cwd, "hook.sh"), worktreeSetupHookTimeoutMs: cwd === roots[0] ? 1000 : 1500 };
		}, undefined);
		for (const [index, cwd] of roots.entries()) {
			const result = await executor.execute(`hooks-${index}`, { cwd, tasks: [{ agent: "worker", task: "go" }], worktree: true, async: false }, new AbortController().signal, undefined, makeMinimalCtx(root));
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, new RegExp(`timed out after ${index === 0 ? 1000 : 1500}ms`));
			assert.equal(fs.readFileSync(path.join(cwd, "called"), "utf8"), "called");
		}
		assert.deepEqual(reads, roots);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("uses asyncByDefault from each call rather than the previous call", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-async-"));
	const runtime = createMockPi();
	runtime.install();
	const configs: any[] = [];
	const originalSpawn = childProcess.spawn;
	const stub = mock.method(childProcess, "spawn", (...args: any[]) => {
		if (args[1]?.some((arg: string) => arg.endsWith("subagent-runner.ts"))) {
			configs.push(JSON.parse(fs.readFileSync(args[1].at(-1), "utf8")));
			return new EventEmitter();
		}
		return originalSpawn(...args as Parameters<typeof originalSpawn>);
	});
	syncBuiltinESMExports();
	try {
		const roots = [path.join(root, "async"), path.join(root, "sync")];
		roots.forEach((cwd) => fs.mkdirSync(cwd));
		const reads: string[] = [];
		const { executor } = fixture(root, (cwd) => { reads.push(cwd); return { asyncByDefault: cwd === roots[0] }; }, runtime.runtime);
		const background = await executor.execute("background", { cwd: roots[0], agent: "worker", task: "go" }, new AbortController().signal, undefined, makeMinimalCtx(root));
		assert.match(background.content[0].text, /async runner did not produce a pid/);
		runtime.onCall({ output: "foreground reply" });
		const foreground = await executor.execute("foreground", { cwd: roots[1], agent: "worker", task: "go" }, new AbortController().signal, undefined, makeMinimalCtx(root));
		assert.equal(foreground.isError, undefined);
		assert.match(foreground.content[0].text, /foreground reply/);
		assert.deepEqual(configs.map((config) => config.cwd), [roots[0]]);
		assert.deepEqual(reads, roots);
	} finally { stub.mock.restore(); syncBuiltinESMExports(); runtime.uninstall(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("resolves nested params.cwd through the registered fanout tool", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-fanout-"));
	const saved = [process.env[SUBAGENT_CHILD_ENV], process.env[SUBAGENT_FANOUT_CHILD_ENV]];
	try {
		process.env[SUBAGENT_CHILD_ENV] = "1";
		process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
		let tool: any;
		const pi = { events: createEventBus(), registerTool(value: any) { tool = value; }, getSessionName() {} };
		registerFanoutChildSubagentExtension(pi as any);
		for (const name of ["a", "b"]) {
			const cwd = path.join(root, name);
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			const sessions = path.join(cwd, "sessions");
			fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ subagents: { defaultSessionDir: sessions } }));
			const result = await tool.execute(name, { action: "doctor", cwd }, new AbortController().signal, undefined, makeMinimalCtx(root));
			assert.equal(result.isError, undefined);
			assert.ok(result.content[0].text.includes(sessions), result.content[0].text);
		}
	} finally {
		for (const [index, key] of [SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV].entries()) {
			if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("resumes using target.cwd hooks and backend, not the request project's", async () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "settings-resume-")));
	const runtime = createMockPi();
	const configs: any[] = [];
	const stub = mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
		configs.push(JSON.parse(fs.readFileSync(args.at(-1)!, "utf8")));
		return new EventEmitter();
	});
	syncBuiltinESMExports();
	try {
		const targetCwd = path.join(root, "target");
		fs.mkdirSync(targetCwd);
		const sessionFile = path.join(root, "selected.jsonl");
		fs.writeFileSync(sessionFile, "history\n");
		const reads: string[] = [];
		const { state, executor } = fixture(root, (cwd) => {
			reads.push(cwd);
			return { worktreeSetupHook: path.join(cwd, "setup.sh"), worktreeSetupHookTimeoutMs: cwd === root ? 100 : 200, worktreeTeardownHook: path.join(cwd, "teardown.sh"), worktreeTeardownHookTimeoutMs: cwd === root ? 300 : 400, executionBackend: cwd === root ? "request-backend" : "target-backend" };
		}, runtime.runtime);
		state.foregroundRuns.set("selected", { runId: "selected", runtime: runtime.runtime, mode: "single", cwd: targetCwd, updatedAt: 1, children: [{ agent: "worker", index: 0, status: "complete", sessionFile }] });
		const result = await executor.execute("resume", { action: "resume", id: "selected", message: "continue" }, new AbortController().signal, undefined, makeMinimalCtx(root));
		assert.match(result.content[0].text, /async runner did not produce a pid/);
		assert.equal(configs.length, 1);
		assert.equal(configs[0].cwd, targetCwd);
		assert.equal(configs[0].worktreeSetupHook, path.join(targetCwd, "setup.sh"));
		assert.equal(configs[0].worktreeSetupHookTimeoutMs, 200);
		assert.equal(configs[0].worktreeTeardownHook, path.join(targetCwd, "teardown.sh"));
		assert.equal(configs[0].worktreeTeardownHookTimeoutMs, 400);
		assert.equal(configs[0].executionBackends.userPreference, "target-backend");
		assert.deepEqual(reads, [root, targetCwd]);
	} finally { stub.mock.restore(); syncBuiltinESMExports(); runtime.uninstall(); fs.rmSync(root, { recursive: true, force: true }); }
});
