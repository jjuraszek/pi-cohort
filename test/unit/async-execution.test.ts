import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import childProcess, { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it, mock } from "node:test";
import { asyncStartHeadline, executeAsyncSingle, executeAsyncChain, spawnDetachedWithLog, spawnRunner } from "../../src/runs/background/async-execution.ts";
import { createJitiCliResolver, resolveHostModuleAliases } from "../../src/runs/shared/jiti-cli.ts";

import { createMockPi } from "../support/mock-pi.ts";
import { ASYNC_DIR } from "../../src/shared/types.ts";
import { PiRuntimeLaunchError } from "../../src/runs/shared/pi-spawn.ts";
import * as piArgs from "../../src/runs/shared/pi-args.ts";
import { buildPiArgs, cleanupTempDir } from "../../src/runs/shared/pi-args.ts";
import { createNestedRoute, writeNestedEvent, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv } from "../../src/runs/shared/nested-events.ts";
const mockPi = createMockPi();
const runtime = mockPi.runtime;
mockPi.install();
after(() => mockPi.uninstall());

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("spawnDetachedWithLog", () => {
	it("captures child stderr in <asyncDir>/runner.log", async () => {
		const asyncDir = tempDir("pi-cohort-spawnlog-");
		const result = spawnDetachedWithLog(process.execPath, ["-e", "console.error('boom-stderr'); process.exit(1)"], asyncDir, asyncDir);
		assert.equal(result.error, undefined);
		assert.equal(typeof result.pid, "number");
		const logPath = path.join(asyncDir, "runner.log");
		await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf-8").includes("boom-stderr"));
	});

	it("falls back to ignored stdio when the log fd cannot be opened", () => {
		const asyncDir = path.join(tempDir("pi-cohort-spawnlog-missing-"), "does-not-exist");
		const result = spawnDetachedWithLog(process.execPath, ["-e", "process.exit(0)"], os.tmpdir(), asyncDir);
		assert.equal(result.error, undefined);
		assert.equal(typeof result.pid, "number");
	});

	it("closes the parent fd even when spawn throws", () => {
		const asyncDir = tempDir("pi-cohort-spawnthrow-");
		const logPath = path.join(asyncDir, "runner.log");
		// On POSIX, openSync returns the lowest available fd. Take a baseline probe
		// before the call under test; if spawnDetachedWithLog leaks its fd, the
		// lowest-available fd advances and the post-call probe returns a higher number.
		const baseline = fs.openSync(logPath, "a");
		fs.closeSync(baseline);
		const throwingSpawn = (() => { throw new Error("spawn exploded"); }) as unknown as typeof import("node:child_process").spawn;
		assert.throws(() => spawnDetachedWithLog(process.execPath, [], asyncDir, asyncDir, throwingSpawn), /spawn exploded/);
		const probe = fs.openSync(logPath, "a");
		fs.closeSync(probe);
		assert.equal(probe, baseline);
	});

	it("closes the parent fd when the child process does not produce a pid", () => {
		const asyncDir = tempDir("pi-cohort-spawnnopid-");
		const logPath = path.join(asyncDir, "runner.log");
		const baseline = fs.openSync(logPath, "a");
		fs.closeSync(baseline);
		const noPidSpawn = (() => ({ pid: undefined, on: () => {}, unref: () => {} })) as unknown as typeof import("node:child_process").spawn;
		const result = spawnDetachedWithLog(process.execPath, [], asyncDir, asyncDir, noPidSpawn);
		assert.match(result.error ?? "", /did not produce a pid/);
		const probe = fs.openSync(logPath, "a");
		fs.closeSync(probe);
		assert.equal(probe, baseline);
	});
});

describe("durable async startup", () => {
	for (const scenario of ["single", "chain", "reused-chain", "mixed-chain", "outside-chain", "missing-file-chain", "revived", "default", "success", "prepare-error", "false-stamp", "throw-stamp", "relative", "missing", "file", "retargeted", "noncanonical", "missing-origin", "unused-origin"] as const) {
		it(`${scenario} validates and stamps origin before the spawn dependency`, () => {
			const savedEnv = { ...process.env };
			let promptDir: string | undefined;
			let write: any;
			let spawnMock: any;
			try {
				for (const value of Object.values(piArgs)) if (typeof value === "string" && value.startsWith("PI_SUBAGENT_")) delete process.env[value];
				const cwd = tempDir("async-origin-");
				const id = `origin-${scenario}-${Date.now()}`;
				const route = createNestedRoute("12345678-1234-4234-8234-123456789abc");
				const built = buildPiArgs({ baseArgs: [], task: "test", cwd, sessionEnabled: false, tools: ["subagent"], parentEventSink: route.eventSink, parentControlInbox: route.controlInbox, parentRootRunId: route.rootRunId, parentCapabilityToken: route.capabilityToken, inheritProjectContext: false, inheritSkills: false, runId: "parent", childAgentName: "parent-agent", childIndex: 0 });
				promptDir = built.tempDir;
				Object.assign(process.env, built.env);
				assert.deepEqual(resolveInheritedNestedRouteFromEnv(), route);
				assert.ok(resolveNestedParentAddressFromEnv());
				const base = path.join(cwd, "new", "sessions");
				if (scenario === "prepare-error") { fs.mkdirSync(path.dirname(base)); fs.writeFileSync(base, "not a directory"); }
				const prior = fs.realpathSync.native(tempDir("prior-origin-"));
				const sessionFile = path.join(prior, "original.jsonl");
				fs.writeFileSync(sessionFile, "original conversation\n");
				const invalid = ["relative", "missing", "file", "retargeted", "noncanonical", "missing-origin", "unused-origin", "outside-chain", "missing-file-chain"].includes(scenario);
				if (scenario === "unused-origin") assert.notEqual(prior, path.join(base, `async-${id}`));
				let origin = prior;
				if (scenario === "relative") origin = "relative";
				if (scenario === "missing") origin = path.join(cwd, "absent");
				if (scenario === "file") origin = sessionFile;
				if (scenario === "noncanonical") origin = `${prior}/.`;
				if (scenario === "retargeted") { origin = path.join(cwd, "alias"); fs.symlinkSync(prior, origin); }
				let launches = 0;
				let childLaunches = 0;
				spawnMock = mock.method(childProcess, "spawn", () => { childLaunches++; return { pid: 12345, on() {}, unref() {} }; });
				let stamps = 0;
				let observed: any;
				const originalWrite = fs.writeFileSync;
				write = mock.method(fs, "writeFileSync", (file: any, data: any, ...rest: any[]) => {
					if (String(file).startsWith(route.eventSink + path.sep) && scenario === "throw-stamp") { stamps++; throw new Error("stamp write exploded"); }
					if (String(file).includes("async-cfg-")) {
						launches++;
						observed = { config: JSON.parse(String(data)), events: fs.readdirSync(route.eventSink).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(route.eventSink, name), "utf8"))) };
						if (scenario !== "success") throw new Error("stop before child");
					}
					return originalWrite(file, data, ...rest);
				});
				syncBuiltinESMExports();
				const common = { ctx: { runtime, cwd, currentSessionId: "parent-B", pi: { events: { emit() {} } } }, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1, ...(scenario === "default" ? {} : { sessionRoot: ["reused-chain", "mixed-chain", "outside-chain", "missing-file-chain"].includes(scenario) ? prior : base }) };
				const writer = scenario === "false-stamp" ? () => { stamps++; return false; } : writeNestedEvent;
				const freshFile = path.join(prior, "fresh", "session.jsonl");
				const result = scenario.endsWith("chain")
					? executeAsyncChain(id, { ...common,
						chain: [{ agent: "test", task: "test", progress: false }, { parallel: [{ agent: "test", task: "other", progress: false }] }], agents: [{ name: "test" }],
						...(scenario === "chain" ? {} : { originSessionRoot: prior, sessionFilesByFlatIndex: [sessionFile, scenario === "mixed-chain" ? undefined : scenario === "missing-file-chain" ? freshFile : scenario === "outside-chain" ? path.join(cwd, "outside.jsonl") : sessionFile] }),
					} as any, writer)
					: executeAsyncSingle(id, { ...common, agent: "test", agentConfig: { name: "test", tools: ["read"] }, ...((scenario === "revived" || invalid) ? { ...(scenario === "unused-origin" ? {} : { sessionFile }), ...(scenario === "missing-origin" ? {} : { originSessionRoot: origin }) } : {}) } as any, writer);
				assert.equal(result.isError, scenario === "success" ? undefined : true);
				assert.equal(childLaunches, scenario === "success" ? 1 : 0);
				const status = JSON.parse(fs.readFileSync(path.join(path.dirname(ASYNC_DIR), "nested-subagent-runs", route.rootRunId, id, "status.json"), "utf8"));
				assert.equal(status.state, scenario === "success" ? "queued" : "failed");
				assert.deepEqual(status.runtime, runtime);
				assert.equal(status.originSessionRoot, undefined);
				if (invalid || scenario === "false-stamp" || scenario === "throw-stamp" || scenario === "prepare-error") {
					assert.equal(launches, 0);
					assert.equal(fs.readdirSync(route.eventSink).filter(name => name.endsWith(".json")).length, 0);
					assert.match(result.content[0].text, invalid ? /origin.*(absolute|exist|directory|canonical|required|reused)|outside origin|regular .jsonl/i : scenario === "prepare-error" ? /ENOTDIR/ : /stamp/);
					if (scenario === "false-stamp" || scenario === "throw-stamp") assert.equal(stamps, 1);
					if (scenario === "missing") assert.equal(fs.existsSync(origin), false);
				} else {
					assert.equal(launches, 1);
					assert.equal(observed.events.length, 1);
					assert.equal(fs.readdirSync(route.eventSink).filter(name => name.endsWith(".json")).length, 1);
					const child = observed.events[0].child;
					assert.deepEqual(child.runtime, runtime);
					assert.equal(child.sessionRoot, ["revived", "reused-chain", "mixed-chain"].includes(scenario) ? prior : observed.config.sessionDir);
					assert.equal(child.state, "queued");
					assert.equal(child.pid, undefined);
					assert.equal(fs.realpathSync.native(observed.config.sessionDir), observed.config.sessionDir);
					if (scenario !== "default") assert.equal(observed.config.sessionDir, fs.realpathSync.native(path.join(["reused-chain", "mixed-chain"].includes(scenario) ? prior : base, `async-${id}`)));
					if (scenario === "revived") assert.equal(observed.config.steps[0].sessionFile, sessionFile);
				}
				assert.equal(fs.readFileSync(sessionFile, "utf8"), "original conversation\n");
			} finally {
				write?.mock.restore(); spawnMock?.mock.restore();
				syncBuiltinESMExports();
				for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
				Object.assign(process.env, savedEnv);
				cleanupTempDir(promptDir);
			}
		});
	}
	for (const mode of ["single", "chain"] as const) {
		it(`${mode} rejects an existing run directory without overwriting or spawning`, () => {
			const id = `repeated-${mode}-${Date.now()}`;
			const dir = path.join(ASYNC_DIR, id);
			fs.mkdirSync(dir, { recursive: true });
			const statusPath = path.join(dir, "status.json");
			const previous = '{"state":"complete","runtime":{"original":true}}\n';
			fs.writeFileSync(statusPath, previous);
			let launches = 0;
			const original = fs.writeFileSync;
			const write = mock.method(fs, "writeFileSync", (file: any, ...args: any[]) => {
				if (String(file).includes("async-cfg-")) { launches++; throw new Error("unexpected spawn"); }
				return original(file, ...args);
			});
			try {
				const common = { ctx: { runtime, cwd: os.tmpdir(), currentSessionId: "parent", pi: { events: { emit() {} } } }, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 };
				const result = mode === "single"
					? executeAsyncSingle(id, { ...common, agent: "test", agentConfig: { name: "test" } } as any)
					: executeAsyncChain(id, { ...common, chain: [{ agent: "test", task: "test", progress: false }], agents: [{ name: "test" }] } as any);
				assert.equal(result.isError, true);
				assert.match(result.content[0].text, /Failed to create async run directory/);
				assert.equal(fs.readFileSync(statusPath, "utf8"), previous);
				assert.equal(launches, 0);
			} finally { write.mock.restore(); }
		});
	}
	for (const mode of ["single", "chain", "parallel", "dynamic"] as const) {
		it(`${mode} publishes complete configured metadata before spawning`, () => {
			const id = `metadata-${mode}-${Date.now()}`;
			const cwd = tempDir("metadata-");
			const sessionFile = path.join(cwd, "resume.jsonl");
			let observed = false;
			let assertionError: unknown;
			const original = fs.writeFileSync;
			const spawnMock = mock.method(fs, "writeFileSync", (file: any, data: any, ...rest: any[]) => {
				if (String(file).includes("async-cfg-")) {
					const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
					try {
					assert.equal(status.state, "queued");
					assert.equal(status.sessionDir, fs.realpathSync.native(path.join(path.dirname(ASYNC_DIR), "sessions", `async-${id}`)));
					assert.equal(JSON.parse(String(data)).sessionDir, status.sessionDir);
					assert.equal(status.pid, undefined);
					assert.equal("nestedRoute" in status, false);
					assert.equal("nestedSelf" in status, false);
					assert.equal(JSON.stringify(status).includes("secret-capability"), false);
					assert.equal(JSON.parse(String(data)).nestedRoute.capabilityToken, "secret-capability");
					assert.equal(status.runId, id);
					assert.deepEqual(status.runtime, runtime);
					assert.equal(status.sessionId, "parent");
					assert.equal("starterPid" in status, false);
					assert.equal(status.lastActivityAt, status.startedAt);
					assert.equal(status.outputFile, path.join(ASYNC_DIR, id, "output-0.log"));
					const expectedStep = mode === "dynamic"
						? { agent: "expand:test", label: "Dynamic fanout (items)", outputName: "items", structured: false, status: "pending", recentTools: [], recentOutput: [] }
						: { agent: "test", model: "test/model", skills: [], sessionFile, attemptedModels: ["test/model"], status: "pending", recentTools: [], recentOutput: [] };
					if (mode === "chain" || mode === "parallel") Object.assign(expectedStep, { structured: false });
					assert.deepEqual(status.steps[mode === "dynamic" ? 1 : 0], expectedStep);
					assert.deepEqual(status.parallelGroups, mode === "parallel" || mode === "dynamic" ? [{ start: mode === "dynamic" ? 1 : 0, count: 1, stepIndex: mode === "dynamic" ? 1 : 0 }] : []);
					observed = true;
					} catch (error) { assertionError = error; }
					throw new Error("stop before spawn");
				}
				return original(file, data, ...rest);
			});
			try {
				const common = { nestedRoute: { rootRunId: id, eventSink: path.join(cwd, "events"), controlInbox: path.join(cwd, "control"), capabilityToken: "secret-capability" }, ctx: { runtime, cwd, currentSessionId: "parent", pi: { events: { emit() {} } } }, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 };
				const agentConfig = { name: "test", model: "test/model", skills: [], systemPrompt: "" };
				const task = { agent: "test", task: "test", output: false, reads: false, progress: false };
				const chain = mode === "parallel" ? [{ parallel: [task] }] : mode === "dynamic" ? [{ ...task, as: "targets", outputSchema: { type: "object" } }, { expand: { from: { output: "targets", path: "/items" }, maxItems: 1 }, parallel: task, collect: { as: "items" } }] : [task];
				const result = mode === "single"
					? executeAsyncSingle(id, { ...common, agent: "test", agentConfig, task: "test", sessionFile } as any)
					: executeAsyncChain(id, { ...common, chain, agents: [agentConfig], sessionFilesByFlatIndex: [sessionFile] } as any);
				assert.equal(result.isError, true);
				if (assertionError) throw assertionError;
				assert.equal(observed, true);
			} finally { spawnMock.mock.restore(); }
		});
	}
	for (const mode of ["single", "chain"] as const) {
		it(`${mode} publishes identity before spawn and retains it on startup failure`, () => {
			const id = `durable-${mode}-${Date.now()}`;
			const cwd = tempDir("async-durable-");
			const failedRuntime = { ...runtime, piEntryPath: path.join(runtime.piPackageRoot, "missing.mjs") };
			const ctx = { runtime: failedRuntime, cwd, currentSessionId: "parent-B", pi: { events: { emit() {} } } };
			const common = { ctx, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 };
			const agentConfig = { name: "test", systemPrompt: "", source: "project", filePath: "test.md" };
			const before = mockPi.callCount();
			const result = mode === "single"
				? executeAsyncSingle(id, { ...common, agent: "test", agentConfig, task: "test" } as any)
				: executeAsyncChain(id, { ...common, chain: [{ agent: "test", task: "test" }], agents: [agentConfig] } as any);
			assert.equal(result.isError, true);
			const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
			assert.deepEqual(status.runtime, failedRuntime);
			assert.equal(status.sessionId, "parent-B");
			assert.equal("starterPid" in status, false);
			assert.equal(status.pid, undefined);
			assert.equal(mockPi.callCount(), before);
			assert.equal(status.runId, id);
			assert.equal(status.steps[0].agent, "test");
			assert.equal(status.state, "failed");
			assert.match(status.error, /missing.mjs/);
		});
	}
	for (const mode of ["single", "chain"] as const) {
		it(`${mode} records failed startup when spawn produces no PID`, () => {
			const id = `no-pid-${mode}-${Date.now()}`;
			const spawnMock = mock.method(childProcess, "spawn", () => ({ on() {}, unref() {} }));
			syncBuiltinESMExports();
			try {
				const common = { ctx: { runtime, cwd: os.tmpdir(), currentSessionId: "parent", pi: { events: { emit() {} } } }, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 };
				const result = mode === "single"
					? executeAsyncSingle(id, { ...common, agent: "test", agentConfig: { name: "test" } } as any)
					: executeAsyncChain(id, { ...common, chain: [{ agent: "test", task: "test", progress: false }], agents: [{ name: "test" }] } as any);
				assert.equal(result.isError, true);
				const status = JSON.parse(fs.readFileSync(path.join(ASYNC_DIR, id, "status.json"), "utf8"));
				assert.equal(status.state, "failed");
				assert.match(status.error, /did not produce a pid/);
				assert.deepEqual(status.runtime, runtime);
				assert.equal(status.pid, undefined);
			} finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
		});
	}
	it("successful spawn leaves queued publication unchanged", () => {
		const id = `owned-start-${Date.now()}`;
		const dir = path.join(ASYNC_DIR, id);
		const statusPath = path.join(dir, "status.json");
		let queued: string | undefined;
		const spawnMock = mock.method(childProcess, "spawn", () => {
			queued = fs.readFileSync(statusPath, "utf8");
			return { pid: 12345, on() {}, unref() {} };
		});
		syncBuiltinESMExports();
		try {
			const ctx = { runtime, cwd: os.tmpdir(), currentSessionId: "parent", pi: { events: { emit() {} } } };
			const result = executeAsyncSingle(id, { agent: "test", task: "test", agentConfig: { name: "test" }, ctx, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 } as any);
			assert.equal(result.isError, undefined);
			assert.equal(fs.readFileSync(statusPath, "utf8"), queued);
			assert.equal(fs.existsSync(path.join(dir, "startup-claim.json")), false);
		} finally { spawnMock.mock.restore(); syncBuiltinESMExports(); }
	});

	it("does not stamp or spawn when queued publication fails", () => {
		const savedEnv = { ...process.env };
		let promptDir: string | undefined;
		let rename: any;
		let write: any;
		let spawnMock: any;
		try {
			const cwd = tempDir("queued-publication-");
			const id = `write-failure-${Date.now()}`;
			const route = createNestedRoute("12345678-1234-4234-8234-123456789abc");
			const built = buildPiArgs({ baseArgs: [], task: "test", cwd, sessionEnabled: false, tools: ["subagent"], parentEventSink: route.eventSink, parentControlInbox: route.controlInbox, parentRootRunId: route.rootRunId, parentCapabilityToken: route.capabilityToken, inheritProjectContext: false, inheritSkills: false, runId: "parent", childAgentName: "parent-agent", childIndex: 0 });
			promptDir = built.tempDir;
			Object.assign(process.env, built.env);
			const dir = path.join(path.dirname(ASYNC_DIR), "nested-subagent-runs", route.rootRunId, id);
			assert.equal(fs.existsSync(dir), false);
			let injected = false;
			let configs = 0;
			let spawns = 0;
			let stamps = 0;
			let acknowledgements = 0;
			const originalRename = fs.renameSync;
			rename = mock.method(fs, "renameSync", (from: any, to: any) => {
				if (String(to) === path.join(dir, "status.json")) {
					injected = true;
					throw new Error("initial queued rename exploded");
				}
				return originalRename(from, to);
			});
			const originalWrite = fs.writeFileSync;
			write = mock.method(fs, "writeFileSync", (file: any, ...args: any[]) => {
				if (String(file).includes("async-cfg-")) configs++;
				return originalWrite(file, ...args);
			});
			spawnMock = mock.method(childProcess, "spawn", () => { spawns++; return { pid: 12345, on() {}, unref() {} }; });
			syncBuiltinESMExports();
			const calls = mockPi.callCount();
			const result = executeAsyncSingle(id, { agent: "test", task: "test", agentConfig: { name: "test" }, ctx: { runtime, cwd, currentSessionId: "parent", pi: { events: { emit() { acknowledgements++; } } } }, artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 1 } as any, () => { stamps++; });
			assert.equal(injected, true);
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /initial queued rename exploded/);
			assert.equal(configs, 0);
			assert.equal(spawns, 0);
			assert.equal(stamps, 0);
			assert.equal(acknowledgements, 0);
			assert.equal(fs.existsSync(path.join(dir, "runner.log")), false);
			assert.equal(fs.existsSync(path.join(dir, "startup-claim.json")), false);
			assert.equal(mockPi.callCount(), calls);
		} finally {
			rename?.mock.restore(); write?.mock.restore(); spawnMock?.mock.restore();
			syncBuiltinESMExports();
			for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
			Object.assign(process.env, savedEnv);
			cleanupTempDir(promptDir);
		}
	});
});

describe("spawnRunner", () => {
	for (const scenario of ["sequential", "repeated-static"] as const) {
		it(`does not borrow an earlier leaf session: ${scenario}`, async () => {
			const dir = tempDir("leaf-isolation-");
			const pi = createMockPi();
			fs.writeFileSync(pi.runtime.piEntryPath, `
				import fs from "node:fs";
				import path from "node:path";
				const args = process.argv.slice(2);
				if (args.at(-1) === "Task: no-session") process.exit(1);
				const sessionDir = args[args.indexOf("--session-dir") + 1];
				fs.mkdirSync(sessionDir, { recursive: true });
				fs.writeFileSync(path.join(sessionDir, "created.jsonl"), "{}\\n");
				console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
			`);
			after(() => { pi.install(); pi.uninstall(); });
			const first = { agent: "test", task: "create-session", completionGuard: false, maxSubagentDepth: 0 };
			const second = { ...first, task: "no-session" };
			const steps = scenario === "sequential" ? [first, second] : [{ parallel: [first] }, { parallel: [second] }];
			const resultPath = path.join(dir, "result.json");
			const launch = spawnRunner({ runtime: pi.runtime, id: scenario, steps, share: false, sessionDir: path.join(dir, "sessions"), placeholder: "{previous}", cwd: dir, asyncDir: dir, resultPath }, scenario, dir, dir);
			assert.equal(launch.error, undefined);
			await waitFor(() => fs.existsSync(resultPath), 10000);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			const status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
			assert.equal(result.results[0].success, true);
			assert.ok(fs.existsSync(result.results[0].sessionFile));
			assert.equal(result.results[1].success, false);
			assert.equal(result.results[1].sessionFile, undefined);
			assert.equal(status.steps[1].sessionFile, undefined);
		});
	}

	for (const failure of ["selection", "external-startup"] as const) {
		it(`preserves reused sessions on ${failure} failure`, async () => {
			const dir = tempDir("leaf-startup-failure-");
			const reused = path.join(dir, "reused.jsonl");
			fs.writeFileSync(reused, "prior conversation\n", { mode: 0o600 });
			fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-startup-failure", type: "module", exports: { "./backend": "./backend.mjs" } }));
			fs.writeFileSync(path.join(dir, "backend.mjs"), `
				export function createBackend() {
					return {
						name: "fixture-startup-failure", protocolVersion: 1,
						async detect() { return { available: true }; },
						async launch() { throw new Error("fixture startup failure"); },
						async reattach() {}, async close() {}
					};
				}
			`);
			const executionBackends = { protocolVersion: 1, userPreference: "fixture-startup-failure", registrations: [{ name: "fixture-startup-failure", ...(failure === "external-startup" ? { reload: { protocolVersion: 1, packageJsonUrl: pathToFileURL(path.join(dir, "package.json")).href, publicSubpath: "./backend", factoryExport: "createBackend" } } : {}) }] };
			const resultPath = path.join(dir, "result.json");
			const statusPath = path.join(dir, "status.json");
			fs.writeFileSync(statusPath, JSON.stringify({ state: "queued", runtime }));
			const launch = spawnRunner({ runtime, id: failure, steps: [{ agent: "test", task: "test", sessionFile: reused }], executionBackends, share: false, placeholder: "{previous}", cwd: dir, asyncDir: dir, resultPath }, failure, dir, dir);
			assert.equal(launch.error, undefined);
			await waitFor(() => fs.existsSync(resultPath), 10000);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			assert.equal(result.success, false);
			assert.match(result.results[0].error, failure === "selection" ? /reload failed: metadata_missing/ : /External execution startup failed/);
			assert.equal(result.results[0].sessionFile, reused);
			assert.equal(status.steps[0].sessionFile, reused);
			assert.equal(status.sessionFile, reused);
			assert.equal(result.sessionFile, reused);
			assert.equal(fs.readFileSync(reused, "utf8"), "prior conversation\n");
		});
	}

	for (const scenario of ["single", "parallel", "dynamic", "reuse", "external-final", "external-reuse"] as const) {
		it(`publishes leaf sessions without sharing: ${scenario}`, { skip: scenario.startsWith("external") && process.platform === "win32" }, async () => {
			mockPi.reset();
			const dir = tempDir("leaf-publication-");
			const sessionDir = path.join(dir, "sessions");
			const reused = path.join(dir, "reused.jsonl");
			fs.writeFileSync(reused, "", { mode: 0o600 });
			const leaf = { agent: "test", task: "test", completionGuard: false, maxSubagentDepth: 0 };
			let steps: any[] = [{ ...leaf, ...(scenario === "reuse" ? { sessionFile: reused } : {}) }];
			if (scenario === "parallel") steps = [{ parallel: [leaf, leaf] }];
			if (scenario === "dynamic") {
				mockPi.onCall({ output: "targets", structuredOutput: { items: ["a", "b"] } } as any);
				steps = [{ ...leaf, outputName: "targets", structuredOutputSchema: { type: "object" } }, { expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: leaf, collect: { as: "reviews" } }];
			}
			mockPi.onCall({ output: "done" });
			let selectedRuntime = runtime;
			let executionBackends: any;
			if (scenario.startsWith("external")) {
				const fixture = path.resolve("test/fixtures/detached-execution-backend");
				const externalPi = createMockPi();
				after(() => { externalPi.install(); externalPi.uninstall(); });
				fs.copyFileSync(path.join(fixture, "scripted-pi.mjs"), externalPi.runtime.piEntryPath);
				selectedRuntime = externalPi.runtime;
				executionBackends = { protocolVersion: 1, userPreference: "fixture-detached", registrations: [{ name: "fixture-detached", reload: { protocolVersion: 1, packageJsonUrl: pathToFileURL(path.join(fixture, "package.json")).href, publicSubpath: "./backend", factoryExport: "createFixtureExecutionBackend" } }] };
				steps = [{ ...leaf, task: "FALLBACK", modelCandidates: scenario === "external-reuse" ? ["good/model"] : ["bad/model", "good/model"], ...(scenario === "external-reuse" ? { sessionFile: reused } : {}) }];
			}
			const resultPath = path.join(dir, "result.json");
			const statusPath = path.join(dir, "status.json");
			fs.writeFileSync(statusPath, JSON.stringify({ state: "queued", runtime: selectedRuntime }));
			const launch = spawnRunner({ runtime: selectedRuntime, id: scenario, steps, executionBackends, share: false, sessionDir, placeholder: "{previous}", cwd: dir, asyncDir: dir, resultPath }, scenario, dir, dir);
			assert.equal(launch.error, undefined);
			await waitFor(() => fs.existsSync(resultPath), 10000);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
			assert.equal(result.success, true, JSON.stringify(result));
			assert.equal(result.results.length, scenario === "parallel" ? 2 : scenario === "dynamic" ? 3 : 1);
			for (const [index, entry] of result.results.entries()) {
				const expectedDir = path.join(sessionDir, scenario === "dynamic" && index > 0 ? `dynamic-1-${index - 1}` : `parallel-${index}`);
				if (scenario === "external-final") assert.ok(entry.sessionFile.startsWith(sessionDir + path.sep), "generated external session must stay inside stamped session root");
				const expected = scenario.endsWith("reuse") ? reused : scenario === "external-final" ? path.join(expectedDir, "session-0-attempt-1.jsonl") : path.join(expectedDir, fs.readdirSync(expectedDir).find(name => name.endsWith(".jsonl"))!);
				assert.equal(entry.sessionFile, expected);
				assert.equal(status.steps[index].sessionFile, expected);
				assert.ok(fs.existsSync(expected));
			}
			assert.equal(status.sessionFile, result.results.at(-1).sessionFile);
			assert.equal(result.sessionFile, status.sessionFile);
		});
	}

	for (const configured of [false, true]) {
		it(`fresh process pins profile at all launch boundaries: configured=${configured}`, () => {
			const dir = tempDir("profile-boundaries-");
			const env = { ...process.env };
			if (configured) env.PI_CODING_AGENT_DIR = "relative-profile";
			else delete env.PI_CODING_AGENT_DIR;
			const script = `
				import assert from 'node:assert/strict';
				import fs from 'node:fs';
				import path from 'node:path';
				import { spawnRunner } from './src/runs/background/async-execution.ts';
				import { runSingleStep } from './src/runs/background/subagent-runner.ts';
				import { runExternalBackgroundAttempt } from './src/runs/background/external-attempt.ts';
				import { createMockPi } from './test/support/mock-pi.ts';
				const pi = createMockPi(); pi.install();
				const dir = ${JSON.stringify(dir)};
				const expected = ${configured} ? path.resolve('relative-profile') : undefined;
				process.chdir(dir);
				try {
					spawnRunner({runtime: pi.runtime}, 'profile', dir, dir, {ensureJiti: () => '/fake/jiti', hostAliases: () => ({}), spawnImpl: (_cmd, _args, opts) => {
						assert.equal(opts.env.PI_CODING_AGENT_DIR, expected, 'runner profile');
						return {pid: 123, on() {}, unref() {}};
					}});
					await runExternalBackgroundAttempt({runtime: pi.runtime, owner: {async runAttempt(req) {
						assert.equal(req.environment.PI_CODING_AGENT_DIR, expected, 'external profile');
						return {outcome: 'success', exit: {code: 0}, messages: [], usage: {}, finalOutput: '', interrupted: false};
					}}, attemptId: 'profile', args: ['test'], environment: {...process.env}, cwd: dir, sessionFile: path.join(dir, 'session')});
					pi.onCall({echoEnv: ['PI_CODING_AGENT_DIR']});
					const result = await runSingleStep({agent: 'test', task: 'test', maxSubagentDepth: 0}, {runtime: pi.runtime, cwd: dir, outputFile: path.join(dir, 'output.log'), id: 'profile', flatIndex: 0, flatStepCount: 1, placeholder: '{previous}', previousOutput: '', sessionEnabled: false});
					assert.equal(result.exitCode, 0);
					assert.equal(JSON.parse(result.output).PI_CODING_AGENT_DIR, expected ?? null, 'native profile');
				} finally { pi.uninstall(); }
			`;
			const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 10000 });
			assert.equal(child.status, 0, child.stderr || child.stdout);
		});
	}

	it("real runner publishes its PID and retains runtime through completion", async () => {
			const dir = tempDir("async-bootstrap-");
			const id = `bootstrap-${Date.now()}`;
			const statusPath = path.join(dir, "status.json");
			fs.writeFileSync(statusPath, JSON.stringify({ runId: id, state: "queued", runtime, sessionId: "parent" }));
			const resultPath = path.join(dir, "result.json");
			mockPi.reset();
			mockPi.onCall({ delay: 300, output: "done" });
			const result = spawnRunner({ runtime, id, nestedRoute: { rootRunId: id, eventSink: path.join(dir, "nested-events"), controlInbox: path.join(dir, "control"), capabilityToken: "secret-capability" }, nestedSelf: { parentRunId: "parent", depth: 1 }, steps: [{ agent: "test", task: "test", maxSubagentDepth: 0 }], placeholder: "{previous}", cwd: dir, asyncDir: dir, sessionDir: path.join(dir, "sessions"), resultPath }, id, dir, dir);
			assert.equal(typeof result.pid, "number");

				await waitFor(() => JSON.parse(fs.readFileSync(statusPath, "utf8")).state === "running");
				const running = JSON.parse(fs.readFileSync(statusPath, "utf8"));
				assert.equal(running.pid, result.pid);
				assert.equal("starterPid" in running, false);
				assert.equal("nestedRoute" in running, false);
				assert.equal("nestedSelf" in running, false);
				await waitFor(() => fs.existsSync(resultPath));
				const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
				assert.equal(status.state, "complete");
				assert.equal("nestedRoute" in status, false);
				assert.equal("nestedSelf" in status, false);
				assert.equal(JSON.stringify(status).includes("secret-capability"), false);
				assert.deepEqual(status.runtime, runtime);
				assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")).runtime, runtime);
	});
	it("throws selected-root launch error and never spawns when jiti cannot be resolved", () => {
		const dir = tempDir("pi-cohort-spawnrunner-nojiti-");
		let spawnCalls = 0;
		const spawnImpl = ((...args: unknown[]) => {
			spawnCalls++;
			return undefined;
		}) as unknown as typeof import("node:child_process").spawn;
		assert.throws(() => spawnRunner({ runtime }, "g4-nojiti", dir, dir, { ensureJiti: () => undefined, spawnImpl }), (error) => error instanceof PiRuntimeLaunchError && error.message.includes(runtime.piPackageRoot));
		assert.equal(spawnCalls, 0);
	});

	it("spawns via the injected spawnImpl when jiti resolves to a valid path", () => {
		const dir = tempDir("pi-cohort-spawnrunner-ok-");
		const nodeA = path.join(dir, path.basename(process.execPath));
		fs.copyFileSync(process.execPath, nodeA);
		fs.chmodSync(nodeA, 0o755);
		const selectedRuntime = { ...runtime, nodeExecPath: fs.realpathSync.native(nodeA) };
		assert.notEqual(selectedRuntime.nodeExecPath, fs.realpathSync.native(process.execPath));
		let spawnCalls = 0;
		const fakeChild = { pid: 4242, on: () => {}, unref: () => {} };
		const spawnImpl = ((...args: unknown[]) => {
			spawnCalls++;
			assert.equal(args[0], selectedRuntime.nodeExecPath);
			return fakeChild as unknown as ReturnType<typeof import("node:child_process").spawn>;
		}) as unknown as typeof import("node:child_process").spawn;
		const result = spawnRunner({ runtime: selectedRuntime }, "g4-ok", dir, dir, { ensureJiti: () => "/fake/jiti-cli.mjs", spawnImpl });
		assert.equal(spawnCalls, 1);
		assert.equal(result.pid, 4242);
		assert.equal(result.error, undefined);
	});

	it("passes the host typebox aliases to the runner through JITI_ALIAS", () => {
		const dir = tempDir("pi-cohort-spawnrunner-alias-");
		let env: NodeJS.ProcessEnv | undefined;
		const fakeChild = { pid: 4243, on: () => {}, unref: () => {} };
		const spawnImpl = ((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
			env = opts.env;
			return fakeChild as unknown as ReturnType<typeof import("node:child_process").spawn>;
		}) as unknown as typeof import("node:child_process").spawn;
		const hostAliases = () => ({ typebox: "/host/typebox/index.mjs", "typebox/compile": "/host/typebox/compile/index.mjs" });
		spawnRunner({ runtime }, "g4-alias", dir, dir, { ensureJiti: () => "/fake/jiti-cli.mjs", spawnImpl, hostAliases });
		assert.deepEqual(JSON.parse(env?.JITI_ALIAS ?? "{}"), hostAliases());
		const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH")!;
		assert.ok(pathKey);
		assert.equal(env?.[pathKey], process.env[pathKey]);
	});
});

describe("resolveHostModuleAliases", () => {
	it("maps typebox and typebox/compile to absolute files", () => {
		const aliases = resolveHostModuleAliases(runtime.piPackageRoot);
		for (const specifier of ["typebox", "typebox/compile"]) {
			assert.ok(path.isAbsolute(aliases[specifier] ?? ""), `${specifier} resolved to ${aliases[specifier]}`);
			assert.ok(fs.existsSync(aliases[specifier]));
		}
	});
});

describe("asyncStartHeadline", () => {
	it("includes 'Async dir: ' followed by the async directory", () => {
		const headline = asyncStartHeadline("Async single: my-agent", "run-123", "/tmp/async-runs/run-123");
		assert.match(headline, /Async dir: \/tmp\/async-runs\/run-123/);
		assert.match(headline, /\[run-123\]/);
	});
});

describe("createJitiCliResolver", () => {
	it("resolves selected root on each call and rejects missing paths", () => {
		let resolved = "/first/jiti-cli.mjs";
		const existing = new Set(["/first/jiti-cli.mjs"]);
		const ensure = createJitiCliResolver({ resolve: () => resolved, exists: (p) => existing.has(p) });
		assert.equal(ensure(runtime.piPackageRoot), "/first/jiti-cli.mjs");
		existing.delete("/first/jiti-cli.mjs");
		resolved = "/second/jiti-cli.mjs";
		existing.add("/second/jiti-cli.mjs");
		assert.equal(ensure(runtime.piPackageRoot), "/second/jiti-cli.mjs");
		existing.clear();
		assert.equal(ensure(runtime.piPackageRoot), undefined);
	});
});
