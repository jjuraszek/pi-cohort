import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

export async function createRuntimeFixture() {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
	const { createMockPi } = await import(pathToFileURL(path.join(repo, "test/support/mock-pi.ts")));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime proof "));
	const A = createMockPi();
	const B = createMockPi();
	const fixtures = { A, B };
	const nodeB = path.join(root, process.platform === "win32" ? "node.exe" : "node");
	try {
		fs.copyFileSync(process.execPath, nodeB);
		fs.chmodSync(nodeB, 0o755);
		const check = spawnSync(nodeB, ["--version"], { encoding: "utf8", timeout: 10000 });
		assert.equal(check.status, 0, `Copied Node cannot start: ${check.error ?? check.stderr}`);
		for (const [name, fixture] of Object.entries(fixtures)) {
			fixture.entry = fixture.runtime.piEntryPath;
			fixture.node = name === "A" ? process.execPath : nodeB;
			fs.copyFileSync(fixture.entry, path.join(path.dirname(fixture.entry), "mock-body.mjs"));
			fs.copyFileSync(fileURLToPath(import.meta.url), fixture.entry);
			for (const name of ["jiti", "typebox"]) {
				const dependency = path.join(fixture.runtime.piPackageRoot, "node_modules", name);
				const source = fs.realpathSync.native(dependency);
				fs.rmSync(dependency, { recursive: true });
				fs.cpSync(source, dependency, { recursive: true });
			}
			fixture.onCall({ output: "runtime proof completed", echoRuntime: true });
		}
		const binB = path.join(path.dirname(B.dir), "bin");
		fs.copyFileSync(nodeB, path.join(binB, path.basename(nodeB)));
		fs.writeFileSync(path.join(binB, "pi"), `#!/bin/sh\nexec "${nodeB}" "${B.entry}" "$@"\n`, { mode: 0o755 });
		fs.writeFileSync(path.join(binB, "pi.cmd"), `@echo off\r\n"${nodeB}" "${B.entry}" %*\r\n`);
		const observer = path.join(root, "observe-runner.mjs");
		fs.writeFileSync(observer, `import fs from 'node:fs';\nif (process.argv[1]?.endsWith('jiti-cli.mjs')) fs.appendFileSync(${JSON.stringify(path.join(root, "runners.jsonl"))}, JSON.stringify({ nodeExecPath: fs.realpathSync.native(process.execPath), argv1: fs.realpathSync.native(process.argv[1]), aliases: JSON.parse(process.env.JITI_ALIAS) }) + '\\n');\nif (process.argv[1]?.endsWith('jiti-cli.mjs') && process.env.RUNTIME_TEST_REMOVE_ENTRY) fs.renameSync(process.env.RUNTIME_TEST_REMOVE_ENTRY, process.env.RUNTIME_TEST_REMOVE_ENTRY + '.missing');\n`);
		const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(observer).href}`,  HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), PI_CODING_AGENT_DIR: path.join(root, "profile"), RUNTIME_TEST_REPO: repo, RUNTIME_TEST_B_ENTRY: B.entry, RUNTIME_TEST_B_QUEUE: B.dir, RUNTIME_TEST_OBSERVATIONS: path.join(root, "observations.jsonl"), MOCK_PI_QUEUE_DIR: A.dir, PATH: `${binB}${path.delimiter}${process.env.PATH ?? ""}` };
		fs.mkdirSync(env.HOME);
		fs.mkdirSync(env.TMPDIR);
		const aliasRoot = path.join(root, "A linked package");
		fs.symlinkSync(A.runtime.piPackageRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
		let sequence = 0;
		return {
			A, B, root, env,
			assertDistinct() {
				assert.notEqual(fs.realpathSync.native(A.node), fs.realpathSync.native(B.node));
				assert.notEqual(A.runtime.piPackageRoot, B.runtime.piPackageRoot);
			},
			run(name, operations, extra = {}) {
				const request = { cwd: root, operations, ...extra, output: path.join(root, `result-${++sequence}.json`) };
				const input = path.join(root, `request-${sequence}.json`);
				fs.writeFileSync(input, JSON.stringify(request));
				const result = spawnSync(fixtures[name].node, ["--import", pathToFileURL(path.join(repo, "test/support/register-loader.mjs")).href, extra.aliasLaunch ? path.join(aliasRoot, "dist", "cli.mjs") : fixtures[name].entry, "--runtime-parent", input], { env: { ...env, ...(extra.runnerMissingEntry ? { RUNTIME_TEST_REMOVE_ENTRY: A.entry } : {}) }, encoding: "utf8", timeout: 45000 });
				assert.equal(result.status, 0, `Parent ${name} failed: ${result.error ?? result.stderr}`);
				return JSON.parse(fs.readFileSync(request.output, "utf8"));
			},
			assertObservedA(count) {
				const observations = fs.existsSync(env.RUNTIME_TEST_OBSERVATIONS) ? fs.readFileSync(env.RUNTIME_TEST_OBSERVATIONS, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
				assert.equal(observations.length, count, "launched children must record actual runtime observations");
				for (const observation of observations) {
					assert.equal(observation.nodeExecPath, A.runtime.nodeExecPath);
					assert.equal(observation.piPackageRoot, A.runtime.piPackageRoot);
					assert.equal(observation.argv1, A.entry);
					if (observation.aliases) {
						const aliases = JSON.parse(observation.aliases);
						const require = createRequire(path.join(A.runtime.piPackageRoot, "package.json"));
						for (const specifier of ["typebox", "typebox/compile", "typebox/value"]) assert.equal(aliases[specifier], require.resolve(specifier));
					}
				}
				assert.equal(B.callCount(), 0, "B sentinel must not launch");
			},
			assertObservedRunnerA(count) {
				const file = path.join(root, "runners.jsonl");
				const observations = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
				assert.equal(observations.length, count, "detached runners must report actual executable and loader aliases");
				const require = createRequire(path.join(A.runtime.piPackageRoot, "package.json"));
				for (const observation of observations) {
					assert.equal(observation.nodeExecPath, A.runtime.nodeExecPath);
					assert.ok(observation.argv1.startsWith(A.runtime.piPackageRoot + path.sep));
					for (const specifier of ["typebox", "typebox/compile", "typebox/value"]) assert.equal(observation.aliases[specifier], require.resolve(specifier));
				}
			},
			close() {
				for (const fixture of Object.values(fixtures)) fs.rmSync(path.dirname(fixture.dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
				fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			},
		};
	} catch (error) {
		for (const fixture of Object.values(fixtures)) fs.rmSync(path.dirname(fixture.dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); throw error;
	}
}

const repo = process.env.RUNTIME_TEST_REPO;
if (repo && process.argv[2] === "--runtime-parent") {
	const { createSubagentExecutor } = await import(pathToFileURL(path.join(repo, "src/runs/foreground/subagent-executor.ts")));
	const { createEventBus, makeAgent, makeMinimalCtx } = await import(pathToFileURL(path.join(repo, "test/support/helpers.ts")));
	const types = await import(pathToFileURL(path.join(repo, "src/shared/types.ts")));
	const request = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
	const nested = await import(pathToFileURL(path.join(repo, "src/runs/shared/nested-events.ts")));
	const args = await import(pathToFileURL(path.join(repo, "src/runs/shared/pi-args.ts")));
	const route = request.inheritedRoute ?? (request.nested ? nested.createNestedRoute(randomUUID()) : undefined);
	if (route) {
		for (const [key, value] of [
			[args.SUBAGENT_PARENT_ROOT_RUN_ID_ENV, route.rootRunId],
			[args.SUBAGENT_PARENT_RUN_ID_ENV, route.rootRunId],
			[args.SUBAGENT_PARENT_CHILD_INDEX_ENV, "0"],
			[args.SUBAGENT_PARENT_DEPTH_ENV, "1"],
			[args.SUBAGENT_PARENT_EVENT_SINK_ENV, route.eventSink],
			[args.SUBAGENT_PARENT_CONTROL_INBOX_ENV, route.controlInbox],
			[args.SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV, route.capabilityToken],
		]) process.env[key] = value;
	}
	const context = makeMinimalCtx(request.cwd);
	let parentBefore;
	let parentFile;
	if (request.parentSession) {
		const { SessionManager } = await import(pathToFileURL(path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js")));
		const manager = SessionManager.create(request.cwd, path.join(request.cwd, "parent sessions"));
		manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Parent conversation" }], api: "mock", provider: "mock", model: "mock", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
		context.sessionManager = manager;
		parentFile = manager.getSessionFile();
		parentBefore = fs.readFileSync(parentFile, "utf8");
	}
	let cleanup;
	if (request.cleanup) {
		const { cleanupAllArtifactDirs } = await import(pathToFileURL(path.join(repo, "src/shared/artifacts.ts")));
		const { cleanupOldChainDirs } = await import(pathToFileURL(path.join(repo, "src/shared/settings.ts")));
		const oldChain = path.join(types.CHAIN_RUNS_DIR, "expired-proof");
		const oldArtifact = path.join(types.TEMP_ARTIFACTS_DIR, "expired-proof.md");
		fs.mkdirSync(oldChain, { recursive: true });
		fs.mkdirSync(types.TEMP_ARTIFACTS_DIR, { recursive: true });
		fs.writeFileSync(oldArtifact, "temporary");
		const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(oldChain, expired, expired);
		fs.utimesSync(oldArtifact, expired, expired);
		for (const file of request.ageDurable ?? []) {
			fs.utimesSync(file, expired, expired);
			assert.ok(fs.statSync(file).mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000);
		}
		cleanupOldChainDirs();
		cleanupAllArtifactDirs(7);
		cleanup = { chainRemoved: !fs.existsSync(oldChain), artifactRemoved: !fs.existsSync(oldArtifact) };
	}
	const state = { baseCwd: request.cwd, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null };
	const events = createEventBus();
	const started = [];
	events.on(types.SUBAGENT_ASYNC_STARTED_EVENT, event => started.push(event));
	const executor = createSubagentExecutor({
		pi: { events, getSessionName: () => undefined }, state, resolveConfig: () => request.config ?? {},
		tempArtifactsDir: types.TEMP_ARTIFACTS_DIR,
		getSubagentSessionRoot: () => path.join(types.RUN_STATE_ROOT_DIR, "sessions"), allowMutatingManagementActions: route ? false : undefined,
		expandTilde: value => value, discoverAgents: () => ({ agents: [makeAgent("worker", { fallbackModels: ["mock/fallback"] })] }),
	});
	const results = [];
	if (request.collisionId || request.external) {
		const { capturePiRuntime } = await import(pathToFileURL(path.join(repo, "src/runs/shared/pi-spawn.ts")));
		const runtime = capturePiRuntime();
		if (request.collisionId) {
			const { executeAsyncSingle } = await import(pathToFileURL(path.join(repo, "src/runs/background/async-execution.ts")));
			results.push({ result: executeAsyncSingle(request.collisionId, {
				agent: "worker", task: "Collision", agentConfig: makeAgent("worker"),
				ctx: { runtime, pi: { events }, cwd: request.cwd, currentSessionId: "proof" },
				artifactConfig: { enabled: false }, shareEnabled: false, maxSubagentDepth: 2,
			}) });
		} else {
			const { createExternalExecution } = await import(pathToFileURL(path.join(repo, "src/runs/shared/external-execution.ts")));
			const { runExternalBackgroundAttempt } = await import(pathToFileURL(path.join(repo, "src/runs/background/external-attempt.ts")));
			const hosts = [];
			const abort = new AbortController();
			let owner;
			const backend = {
				name: "runtime-proof", protocolVersion: 1,
				async detect() { return { available: true, version: "1", capabilities: ["interactive"] }; },
				async launch(input) {
					const host = spawn(input.command, input.args, { cwd: input.cwd, env: input.environment, stdio: "ignore" });
					hosts.push(host);
					return { handle: { protocolVersion: 1, backend: "runtime-proof", surface: { kind: "fixture", id: "proof" }, display: { label: "proof", hint: "proof" }, data: null }, events: (async function*() {})(), async reconcile() { return []; }, async release() {} };
				},
				async reattach() { return { status: "gone" }; }, async close() {},
			};
			try {
				owner = await createExternalExecution({ runtime, backend, runId: "external-proof", childId: "worker", cwd: request.cwd, title: "proof", signal: abort.signal });
				const sessionFile = path.join(request.cwd, "external.jsonl");
				const { runExternalSingleAttempt } = await import(pathToFileURL(path.join(repo, "src/runs/foreground/external-single-attempt.ts")));
				const result = request.external === "foreground"
					? await runExternalSingleAttempt({ owner, attemptId: "attempt-0", runtimeCwd: request.cwd, agent: makeAgent("worker"), model: undefined, task: "Observe external runtime", options: { runtime, cwd: request.cwd, sessionFile }, shared: { sessionEnabled: true, systemPrompt: "", attemptNotes: [] } })
					: await runExternalBackgroundAttempt({ runtime, owner, attemptId: "attempt-0", args: ["--session", sessionFile, "Observe external runtime"], environment: process.env, cwd: request.cwd, sessionFile });
				await owner.finish("delivered");
				results.push({ result, sessionFile });
			} catch (error) { results.push({ error: error.message }); }
			finally {
				abort.abort();
				try { if (owner) await owner.finish("delivered"); }
				finally {
					await Promise.all(hosts.map(async host => {
						if (host.exitCode !== null || host.signalCode !== null) return;
						const exited = once(host, "exit"); host.kill(); await exited;
					}));
				}
			}
		}
	}
	const originalEntry = process.argv[1];
	const renamedEntry = `${originalEntry}.missing`;
	if (request.renameAfterCapture) fs.renameSync(originalEntry, renamedEntry);
	try {
	for (const input of request.operations) {
		const params = input.id === "$last" ? { ...input, id: results.at(-1).result.details.runId } : input;
		const result = await executor.execute("runtime-proof", params, new AbortController().signal, undefined, context);
		let status;
		if (result.details?.asyncDir) {
			const statusPath = path.join(result.details.asyncDir, "status.json");
			const deadline = Date.now() + 30000;
			while (Date.now() < deadline) {
				if (fs.existsSync(statusPath)) status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
				if (["complete", "failed", "paused"].includes(status?.state)) break;
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			if (!["complete", "failed", "paused"].includes(status?.state)) {
				if (status?.pid) { try { process.kill(status.pid); } catch {} }
				const runnerLogPath = path.join(result.details.asyncDir, "runner.log");
				const runnerLog = fs.existsSync(runnerLogPath) ? fs.readFileSync(runnerLogPath, "utf8") : "(runner.log missing)";
				throw new Error(`Detached runtime proof timed out: ${JSON.stringify(status)}\nrunner.log:\n${runnerLog}`);
			}
		}
		if (status?.pid) {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				try { process.kill(status.pid, 0); } catch { break; }
				await new Promise(resolve => setTimeout(resolve, 25));
			}
			try { process.kill(status.pid, 0); process.kill(status.pid); } catch {}
		}
		let completion;
		if (status) {
			const completionPath = route ? nested.nestedResultsPath(route.rootRunId, status.runId) : path.join(types.RESULTS_DIR, `${status.runId}.json`);
			const deadline = Date.now() + 10000;
			while (!fs.existsSync(completionPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
			completion = JSON.parse(fs.readFileSync(completionPath, "utf8"));
		}
		results.push({ result, status, completion });
	}
	} finally {
		if (request.renameAfterCapture) fs.renameSync(renamedEntry, originalEntry);
	}
	fs.writeFileSync(request.output, JSON.stringify({ results, started, cleanup, route, registry: route ? nested.projectNestedEvents(route) : undefined, parentBefore, parentAfter: parentFile ? fs.readFileSync(parentFile, "utf8") : undefined, roots: { temp: types.TEMP_ROOT_DIR, durable: types.RUN_STATE_ROOT_DIR, results: types.RESULTS_DIR } }));
} else if (repo && process.argv[2] !== "--runtime-parent") {
	const entry = fs.realpathSync.native(process.argv[1]);
	fs.appendFileSync(process.env.RUNTIME_TEST_OBSERVATIONS, `${JSON.stringify({ nodeExecPath: fs.realpathSync.native(process.execPath), piPackageRoot: fs.realpathSync.native(path.resolve(path.dirname(entry), "..")), argv1: entry, aliases: process.env.JITI_ALIAS })}\n`);
	if (entry === process.env.RUNTIME_TEST_B_ENTRY) process.env.MOCK_PI_QUEUE_DIR = process.env.RUNTIME_TEST_B_QUEUE;
	if (process.env.PI_COHORT_REPORT_CONFIG) {
		const { connect } = await import("node:net");
		const config = JSON.parse(fs.readFileSync(process.env.PI_COHORT_REPORT_CONFIG, "utf8"));
		const sessionFile = process.argv[process.argv.indexOf("--session") + 1];
		let sequence = 0;
		let parentId = null;
		const append = entry => {
			const id = randomUUID();
			fs.appendFileSync(sessionFile, JSON.stringify({ id, parentId, timestamp: new Date().toISOString(), ...entry }) + "\n");
			parentId = id;
		};
		const report = (kind, extra = {}) => append({ type: "custom", customType: "pi-cohort:execution-report:v1", data: { protocolVersion: 1, runId: config.runId, childId: config.childId, attemptId: config.attemptId, kind, sequence: ++sequence, timestamp: new Date().toISOString(), ...extra } });
		const socket = connect(config.controlSocketPath, () => {
			report("ready");
			append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "external runtime completed" }], api: "mock", provider: "mock", model: "mock", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
			report("settled");
			report("result", { outcome: "success", finalOutput: "external runtime completed", stopReason: "stop" });
		});
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
				report("control", { action: request.action, state: "requested" });
				report("control", { action: request.action, state: "applied" });
				if (request.action === "shutdown") socket.end(() => process.exit(0));
			}
		});
		socket.on("error", () => process.exit(1));
	} else await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "mock-body.mjs")));
}
