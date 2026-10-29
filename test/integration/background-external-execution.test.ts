/**
 * Integration test for background external execution routing.
 *
 * Tests runExternalBackgroundAttempt through a registered fake backend,
 * exercising the real child host, control channel, session watcher, and
 * session file creation paths. Unix-only (child host is unsupported on win32).
 *
 * Coverage: single-leaf external attempt, success, failure, observation callback.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { after, test } from "node:test";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { createDetachedExecutionBackendCoordinator } from "../../src/execution-backend/reload.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";
import { createExternalExecution as createExternalExecutionImpl } from "../../src/runs/shared/external-execution.ts";
import { runExternalBackgroundAttempt as runExternalBackgroundAttemptImpl, type OnSynthesizedChildEvent } from "../../src/runs/background/external-attempt.ts";
import { runSingleStep as runSingleStepImpl } from "../../src/runs/background/subagent-runner.ts";
import { getArtifactPaths } from "../../src/shared/artifacts.ts";
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";

const mockPi = createMockPi();
function fixtureRuntime(cwd: string) {
	const script = fs.readFileSync(path.join(cwd, "bin", "pi"), "utf8").replace(/^#![^\n]*\n/, "");
	fs.writeFileSync(mockPi.runtime.piEntryPath, `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n${script}`);
	return mockPi.runtime;
}
const createExternalExecution = (options) => createExternalExecutionImpl({ ...options, runtime: fixtureRuntime(options.cwd) });
const runSingleStep = (step, ctx) => runSingleStepImpl(step, { ...ctx, sessionDir: ctx.sessionDir ?? path.join(ctx.cwd, "sessions"), runtime: fixtureRuntime(ctx.cwd) });
const runExternalBackgroundAttempt = (options) => runExternalBackgroundAttemptImpl({ ...options, runtime: fixtureRuntime(options.cwd) });

const unixOnly = { skip: process.platform === "win32" };

// Fake pi script that implements the reporting protocol.
// It reads --session <file> from args, connects to the control socket, and
// writes session entries directly. The --extension arg (injected by
// runExternalBackgroundAttempt) is silently ignored.
function makeFixtureScript(outcome: "success" | "fail" | "missing-result" | "interrupted", argsPath?: string) {
	return `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
fs.writeFileSync(require("node:path").join(process.cwd(), "child.pid"), String(process.pid));
fs.appendFileSync(require("node:path").join(process.cwd(), "child.pids"), process.pid + "\\n");
${argsPath ? `fs.appendFileSync(${JSON.stringify(`${argsPath}.count`)}, "1\\n"); fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args)); fs.writeFileSync(${JSON.stringify(`${argsPath}.parent-session-id`)}, process.env.PI_SUBAGENT_PARENT_SESSION_ID ?? "");` : ""}
const sessionFile = args[args.indexOf("--session") + 1];
if (!sessionFile) { console.error("no --session"); process.exit(1); }
if (${JSON.stringify(outcome)} === "missing-result") process.exit(0);
const config = JSON.parse(fs.readFileSync(process.env.PI_COHORT_REPORT_CONFIG, "utf8"));
let sequence = 0;
let reportSequence = 0;
let parentId = null;
const append = entry => {
  const id = "entry-" + (++sequence);
  fs.appendFileSync(sessionFile, JSON.stringify({ id, parentId, ...entry }) + "\\n");
  parentId = id;
};
const report = (kind, extra = {}) => append({
  type: "custom",
  customType: "pi-cohort:execution-report:v1",
  data: { protocolVersion: 1, runId: config.runId, childId: config.childId, attemptId: config.attemptId, kind, sequence: ++reportSequence, timestamp: new Date().toISOString(), ...extra }
});
const socket = net.connect(config.controlSocketPath, () => {
  report("ready");
  append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "background answer" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: ${outcome === "success" ? '"stop"' : '"error"'}, timestamp: Date.now() } });
  report("settled");
  report("result", { outcome: ${JSON.stringify(outcome === "success" ? "success" : outcome === "interrupted" ? "interrupted" : "failed")}, finalOutput: "background answer", stopReason: ${outcome === "success" ? '"stop"' : '"error"'} });
});
let buffer = "";
socket.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    report("control", { action: request.action, state: "requested" });
    report("control", { action: request.action, state: "applied" });
    if (request.action === "shutdown") socket.end(() => process.exit(0));
  }
});
socket.on("error", err => { process.exit(1); });
`;
}

interface BackendLifecycle {
	releases: number;
	closes: number;
	launchError?: string;
	releaseError?: string;
	suppressExitEvidence?: boolean;
	onClose?: (reason: string) => void;
}

function makeBackend(
	name: string,
	binDir: string,
	requests: ExecutionSurfaceRequest[],
	hosts: ReturnType<typeof spawn>[],
	lifecycle?: BackendLifecycle,
): ExecutionBackend {
	return {
		name,
		protocolVersion: 1,
		async detect() { return { available: true, version: "1", capabilities: ["interactive"] }; },
		async launch(request) {
			requests.push(request);
			if (lifecycle?.launchError) throw new Error(lifecycle.launchError);
			const host = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env: request.environment,
				stdio: ["ignore", "ignore", "ignore"],
			});
			hosts.push(host);
			const exited = once(host, "exit");
			return {
				handle: {
					protocolVersion: 1, backend: name,
					surface: { kind: "fixture", id: "bg-one" },
					display: { label: "background fixture", hint: "durable" },
					data: null,
				},
				events: (async function*() {
					const [status, signal] = await exited;
					if (lifecycle?.suppressExitEvidence) return;
					yield { type: "exited" as const, timestamp: Date.now(), source: "mux" as const, surface: { kind: "fixture", id: "bg-one" }, status, signal };
				})(),
				async reconcile() { return []; },
				async release() {
					if (lifecycle) lifecycle.releases++;
					if (lifecycle?.releaseError) throw new Error(lifecycle.releaseError);
				},
			};
		},
		async reattach() { return { status: "gone" }; },
		async close(_handle, reason) {
			lifecycle?.onClose?.(reason);
			if (lifecycle) lifecycle.closes++;
			if (reason === "explicit_cleanup") {
				for (const request of requests) {
					const pidFile = path.join(request.cwd, "child.pid");
					if (fs.existsSync(pidFile)) {
						const pid = Number(fs.readFileSync(pidFile, "utf8"));
						try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
						for (let i = 0; i < 100; i++) {
							try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
							await new Promise(resolve => setTimeout(resolve, 10));
						}
					}
				}
				await cleanupHosts(hosts);
			}
		},
	};
}

async function cleanupHosts(hosts: ReturnType<typeof spawn>[]) {
	await Promise.all(hosts.map(async host => {
		if (host.exitCode !== null || host.signalCode !== null) return;
		const exited = once(host, "exit");
		host.kill("SIGKILL");
		await exited;
	}));
}

function fixtureInvocationCount(argsPath: string): number {
	return fs.readFileSync(`${argsPath}.count`, "utf-8").trim().split("\n").length;
}

function promptTempDir(argsPath: string): string {
	const args = JSON.parse(fs.readFileSync(argsPath, "utf-8")) as string[];
	const promptFlagIndex = Math.max(args.indexOf("--system-prompt"), args.indexOf("--append-system-prompt"));
	assert.notEqual(promptFlagIndex, -1, `expected a system prompt flag in ${JSON.stringify(args)}`);
	const promptPath = args[promptFlagIndex + 1];
	assert.ok(promptPath, "expected a prompt path after the system prompt flag");
	return path.dirname(promptPath);
}

test("runExternalBackgroundAttempt: success path writes session, returns exitCode 0 and handle", unixOnly, async () => {
	const tempDir = createTempDir("bg-ext-success-");
	const binDir = path.join(tempDir, "bin");
	const fixturePath = path.join(binDir, "pi");
	fs.mkdirSync(binDir);
	fs.writeFileSync(fixturePath, makeFixtureScript("success"), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const backendName = `fake-bg-success-${process.pid}`;
	const backend = makeBackend(backendName, binDir, requests, hosts);
	const dispose = registerExecutionBackend(backend);
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	const sessionFile = path.join(tempDir, "session-attempt-0.jsonl");
	const abort = new AbortController();

	try {
		const owner = await createExternalExecution({
			runId: "bg-run",
			childId: "worker-0",
			backend,
			cwd: tempDir,
			title: "worker",
			signal: abort.signal,
		});

		const result = await runExternalBackgroundAttempt({
			owner,
			attemptId: "bg-run-0-attempt-0",
			// Include --session so the fixture knows where to write.
			// The task is the last arg; --extension is injected before it by the function.
			args: ["--session", sessionFile, "Task: do something"],
			environment: { ...process.env as Record<string, string>, PATH: process.env.PATH! },
			cwd: tempDir,
			sessionFile,
		});

		await owner.finish("delivered");

		assert.equal(result.exitCode, 0, `expected success but got: ${result.error}`);
		assert.equal(result.finalOutput, "background answer");
		assert.equal(result.interrupted, false);
		assert.ok(!result.error, `unexpected error: ${result.error}`);
		assert.ok(fs.existsSync(sessionFile), "session file must be created");
		assert.ok(fs.readFileSync(sessionFile, "utf8").includes("background answer"), "session file must contain output");
	} finally {
		process.env.PATH = savedPath;
		dispose();
		abort.abort();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

test("runExternalBackgroundAttempt: failed outcome returns exitCode 1 and non-zero error", unixOnly, async () => {
	const tempDir = createTempDir("bg-ext-fail-");
	const binDir = path.join(tempDir, "bin");
	const fixturePath = path.join(binDir, "pi");
	fs.mkdirSync(binDir);
	fs.writeFileSync(fixturePath, makeFixtureScript("fail"), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const backendName = `fake-bg-fail-${process.pid}`;
	const backend = makeBackend(backendName, binDir, requests, hosts);
	const dispose = registerExecutionBackend(backend);
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	const sessionFile = path.join(tempDir, "session-attempt-0.jsonl");
	const abort = new AbortController();

	try {
		const owner = await createExternalExecution({
			runId: "bg-run-fail",
			childId: "worker-0",
			backend,
			cwd: tempDir,
			title: "worker",
			signal: abort.signal,
		});

		const result = await runExternalBackgroundAttempt({
			owner,
			attemptId: "bg-run-fail-0-attempt-0",
			args: ["--session", sessionFile, "Task: do something that fails"],
			environment: { ...process.env as Record<string, string>, PATH: process.env.PATH! },
			cwd: tempDir,
			sessionFile,
		});

		await owner.finish("retained");

		// A "failed" outcome must map to exitCode 1, not 0.
		assert.equal(result.exitCode, 1, "failed durable outcome must not become exitCode 0");
		assert.equal(result.interrupted, false);
	} finally {
		process.env.PATH = savedPath;
		dispose();
		abort.abort();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

test("runExternalBackgroundAttempt: onChildEvent receives synthesized events from session messages", unixOnly, async () => {
	const tempDir = createTempDir("bg-ext-events-");
	const binDir = path.join(tempDir, "bin");
	const fixturePath = path.join(binDir, "pi");
	fs.mkdirSync(binDir);
	fs.writeFileSync(fixturePath, makeFixtureScript("success"), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const backendName = `fake-bg-events-${process.pid}`;
	const backend = makeBackend(backendName, binDir, requests, hosts);
	const dispose = registerExecutionBackend(backend);
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	const sessionFile = path.join(tempDir, "session-attempt-0.jsonl");
	const abort = new AbortController();
	const events: Array<{ type?: string }> = [];
	const onChildEvent: OnSynthesizedChildEvent = (event) => events.push({ type: event.type });

	try {
		const owner = await createExternalExecution({
			runId: "bg-run-events",
			childId: "worker-0",
			backend,
			cwd: tempDir,
			title: "worker",
			signal: abort.signal,
		});

		await runExternalBackgroundAttempt({
			owner,
			attemptId: "bg-run-events-0-attempt-0",
			args: ["--session", sessionFile, "Task: observe events"],
			environment: { ...process.env as Record<string, string>, PATH: process.env.PATH! },
			cwd: tempDir,
			sessionFile,
			onChildEvent,
		});

		await owner.finish("delivered");

		// The fixture appends one assistant message. The session watcher should
		// call onNewSessionMessage which synthesizes a message_end event.
		const hasMessageEnd = events.some(e => e.type === "message_end");
		assert.ok(hasMessageEnd, `expected message_end event, got: ${JSON.stringify(events)}`);
	} finally {
		process.env.PATH = savedPath;
		dispose();
		abort.abort();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

for (const outcome of ["success", "fail", "interrupted", "missing-result", "malformed-terminal", "warning", "warning-success", "warning-fail"] as const) {
	test(`runSingleStep pauses accepted interruption over durable ${outcome} after real process exit`, unixOnly, async () => {
		const tempDir = createTempDir("bg-interrupt-");
		const binDir = path.join(tempDir, "bin");
		const argsPath = path.join(tempDir, "args.json");
		fs.mkdirSync(binDir);
		const durableOutcome = outcome === "warning-success" ? "success" : outcome === "warning-fail" ? "fail" : outcome === "malformed-terminal" || outcome === "warning" ? "interrupted" : outcome;
		let script = makeFixtureScript(durableOutcome, argsPath).replaceAll("background answer", "rate limit timeout");
		if (outcome === "malformed-terminal") script = script
			.replace(/  report\("result",[^\n]+\n/, "")
			.replace('    if (request.action === "shutdown")', '    if (request.action === "abort") report("result", { outcome: "invalid", finalOutput: "rate limit timeout" });\n    if (request.action === "shutdown")');
		if (outcome === "missing-result") script = script
			.replace('if ("missing-result" === "missing-result") process.exit(0);', "")
			.replace(/  report\("result",[^\n]+\n/, "");
		fs.writeFileSync(path.join(binDir, "pi"), script, { mode: 0o755 });
		const hosts: ReturnType<typeof spawn>[] = [];
		const requests: ExecutionSurfaceRequest[] = [];
		const lifecycle = { releases: 0, closes: 0, suppressExitEvidence: outcome.startsWith("warning") };
		const name = `bg-interrupt-${outcome}-${process.pid}`;
		const dispose = registerExecutionBackend(makeBackend(name, binDir, requests, hosts, lifecycle));
		let interrupt: (() => void) | undefined;
		try {
			const result = await runSingleStep({
				agent: "worker", task: "Inspect", modelCandidates: ["first", "second"], completionGuard: false,
				inheritProjectContext: false, inheritSkills: false,
			}, {
				previousOutput: "", outputs: {}, placeholder: "", cwd: tempDir, sessionEnabled: true,
				id: "bg-interrupt", flatIndex: 0, flatStepCount: 1, outputFile: path.join(tempDir, "output.log"),
				registerInterrupt: callback => { interrupt = callback; },
				onChildEvent: event => { if (event.type === "message_end") interrupt?.(); },
				executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
				executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: name },
			});
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.interrupted, true);
			assert.equal(result.modelAttempts.length, 1);
			assert.equal(result.modelAttempts[0].success, true);
			assert.doesNotMatch(result.error ?? "", /External execution (attempt|finish) failed/);
			assert.equal(result.executionSurface.retained, outcome !== "missing-result" && outcome !== "malformed-terminal");
			assert.equal(lifecycle.closes, outcome === "missing-result" || outcome === "malformed-terminal" ? 1 : 0);
			assert.equal(lifecycle.releases, 1);
			assert.equal(requests.length, 1);
			assert.equal(fixtureInvocationCount(argsPath), 1);
			assert.ok(hosts[0].exitCode !== null || hosts[0].signalCode !== null, "host must exit before runSingleStep settles");
			const childPid = Number(fs.readFileSync(path.join(tempDir, "child.pid"), "utf8"));
			assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "direct child must exit before emergency cleanup");
			const session = fs.readFileSync(result.sessionFile, "utf8");
			if (outcome === "missing-result") {
				assert.match(result.error ?? "", /^result_missing/);
				assert.ok(!session.includes('"kind":"result"'), "must not fabricate durable evidence");
			} else if (outcome === "malformed-terminal") {
				assert.match(result.error ?? "", /invalid.*outcome|outcome.*invalid/);
				assert.ok(session.includes('"outcome":"invalid"'), "must not repair malformed durable evidence");
			} else {
				if (outcome.startsWith("warning")) assert.ok(result.error?.includes("Process termination could not be confirmed; manual cleanup may be required."));
				assert.ok(session.includes(`"outcome":"${durableOutcome === "fail" ? "failed" : durableOutcome === "success" ? "success" : "interrupted"}"`), "durable terminal is unchanged");
			}
		} finally {
			dispose();
			await cleanupHosts(hosts);
			removeTempDir(tempDir);
		}
	});
}

test("runSingleStep retains the surface and removes its prompt directory when an external attempt throws", unixOnly, async () => {
	const tempDir = createTempDir("bg-runner-throw-");
	const binDir = path.join(tempDir, "bin");
	const argsPath = path.join(tempDir, "pi-args.json");
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("missing-result", argsPath), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const finishSecret = "SENTINEL_OBSERVER_RELEASE_SECRET";
	const lifecycle: BackendLifecycle = { releases: 0, closes: 0, releaseError: finishSecret };
	const backendName = `fake-bg-runner-throw-${process.pid}`;
	const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	try {
		const result = await runSingleStep({
			agent: "worker",
			task: "Exercise the throwing external attempt",
			systemPrompt: "runner fixture prompt",
			inheritProjectContext: false,
			inheritSkills: false,
			sessionFile: path.join(tempDir, "session-0-attempt-0.jsonl"),
		}, {
			previousOutput: "",
			outputs: {},
			placeholder: "",
			cwd: tempDir,
			sessionEnabled: true,
			id: "bg-runner-throw",
			flatIndex: 0,
			parentSessionLabel: "P",
			parentSessionId: "parent-session-id",
			flatStepCount: 1,
			outputFile: path.join(tempDir, "output-0.log"),
			executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
			executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backendName },
		});

		assert.equal(result.exitCode, 1);
		assert.equal(
			result.error,
			"External execution attempt failed (result_missing)\nExternal execution finish failed",
		);
		assert.ok(!result.error.includes(finishSecret), `must not leak backend finish errors: ${result.error}`);
		assert.equal(result.executionSurface?.retained, true);
		assert.equal(result.executionSurface?.handle.backend, backendName);
		assert.equal(lifecycle.releases, 1);
		assert.equal(lifecycle.closes, 0);
		assert.equal(requests.length, 1);
		assert.equal(fixtureInvocationCount(argsPath), 1, "must not fall back to native execution");
		assert.equal(fs.existsSync(promptTempDir(argsPath)), false);
		const childArgs = JSON.parse(fs.readFileSync(argsPath, "utf-8")) as string[];
		assert.equal(childArgs[childArgs.indexOf("--name") + 1], "worker bg-runne from P");
		assert.equal(fs.readFileSync(`${argsPath}.parent-session-id`, "utf-8"), "parent-session-id");
	} finally {
		process.env.PATH = savedPath;
		dispose();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

test("runSingleStep sanitizes an external startup failure without falling back to native execution", unixOnly, async () => {
	const tempDir = createTempDir("bg-runner-startup-");
	const binDir = path.join(tempDir, "bin");
	const argsPath = path.join(tempDir, "pi-args.json");
	const startupSecret = "SENTINEL_BACKEND_STARTUP_SECRET (result_missing)";
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("success", argsPath), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const lifecycle: BackendLifecycle = { releases: 0, closes: 0, launchError: startupSecret };
	const backendName = `fake-bg-runner-startup-${process.pid}`;
	const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	try {
		const result = await runSingleStep({
			agent: "worker",
			task: "Exercise external startup failure",
			inheritProjectContext: false,
			inheritSkills: false,
		}, {
			previousOutput: "",
			outputs: {},
			placeholder: "",
			cwd: tempDir,
			sessionEnabled: true,
			id: "bg-runner-startup",
			flatIndex: 0,
			flatStepCount: 1,
			outputFile: path.join(tempDir, "output-0.log"),
			executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
			executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backendName },
		});

		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "External execution startup failed");
		assert.ok(!result.error.includes(startupSecret));
		assert.equal(result.executionSurface, undefined);
		assert.equal(requests.length, 1);
		assert.equal(lifecycle.releases, 0);
		assert.equal(lifecycle.closes, 0);
		assert.equal(fs.existsSync(`${argsPath}.count`), false, "must not fall back to native execution");
	} finally {
		process.env.PATH = savedPath;
		dispose();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

test("runSingleStep treats an external output-save EISDIR as a retained failed leaf", unixOnly, async () => {
	const tempDir = createTempDir("bg-runner-output-");
	const binDir = path.join(tempDir, "bin");
	const argsPath = path.join(tempDir, "pi-args.json");
	const outputPath = path.join(tempDir, "output-target");
	fs.mkdirSync(binDir);
	fs.mkdirSync(outputPath);
	fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("success", argsPath), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const lifecycle: BackendLifecycle = { releases: 0, closes: 0 };
	const backendName = `fake-bg-runner-output-${process.pid}`;
	const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	try {
		const result = await runSingleStep({
			agent: "worker",
			task: "Exercise output persistence failure",
			systemPrompt: "runner fixture prompt",
			inheritProjectContext: false,
			inheritSkills: false,
			sessionFile: path.join(tempDir, "session-0-attempt-0.jsonl"),
			outputMode: "file-only",
			outputPath,
			completionGuard: false,
		}, {
			previousOutput: "",
			outputs: {},
			placeholder: "",
			cwd: tempDir,
			sessionEnabled: true,
			id: "bg-runner-output",
			flatIndex: 0,
			flatStepCount: 1,
			outputFile: path.join(tempDir, "output-0.log"),
			executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
			executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backendName },
		});

		assert.equal(result.exitCode, 1);
		assert.match(result.error ?? "", /EISDIR|illegal operation on a directory/);
		assert.equal(result.output, `Output file error: ${outputPath}\n${result.error}\n\nFull reply not preserved (artifact output disabled)`);
		assert.equal(fs.readFileSync(path.join(tempDir, "output-0.log"), "utf8"), result.output);
		assert.equal(result.executionSurface?.retained, true);
		assert.equal(result.executionSurface?.handle.backend, backendName);
		assert.equal(lifecycle.releases, 1);
		assert.equal(lifecycle.closes, 0);
		assert.equal(requests.length, 1);
		assert.equal(fixtureInvocationCount(argsPath), 1, "must not fall back to native execution");
		assert.equal(fs.existsSync(promptTempDir(argsPath)), false);
	} finally {
		process.env.PATH = savedPath;
		dispose();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

test("runSingleStep retains an external leaf when its async output file cannot be persisted", unixOnly, async t => {
	for (const outputMode of ["inline", "file-only"] as const) await t.test(outputMode, async () => {
	const tempDir = createTempDir("bg-runner-async-output-");
	const binDir = path.join(tempDir, "bin");
	const argsPath = path.join(tempDir, "pi-args.json");
	const secretPath = path.join(tempDir, "SENTINEL_PRIVATE_OUTPUT_PATH");
	const outputFile = path.join(secretPath, "output-0.log");
	fs.mkdirSync(binDir);
	fs.mkdirSync(secretPath);
	fs.mkdirSync(outputFile);
	fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("success", argsPath), { mode: 0o755 });

	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	const lifecycle: BackendLifecycle = { releases: 0, closes: 0 };
	const backendName = `fake-bg-runner-async-output-${process.pid}`;
	const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

	try {
		const result = await runSingleStep({
			agent: "worker",
			task: "Exercise async output persistence failure",
			outputMode,
			...(outputMode === "file-only" ? { outputPath: path.join(tempDir, "requested.md") } : {}),
			systemPrompt: "runner fixture prompt",
			inheritProjectContext: false,
			inheritSkills: false,
			completionGuard: false,
		}, {
			previousOutput: "",
			outputs: {},
			placeholder: "",
			cwd: tempDir,
			sessionEnabled: true,
			id: "bg-runner-async-output",
			flatIndex: 0,
			flatStepCount: 1,
			outputFile,
			executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
			executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backendName },
		});

		assert.equal(result.output, outputMode === "file-only"
			? "Full reply not preserved (artifact output disabled)"
			: "background answer");
		if (outputMode === "file-only") assert.equal(fs.readFileSync(path.join(tempDir, "requested.md"), "utf8"), "background answer");
		assert.equal(result.exitCode, 1);
		assert.equal(result.error, "External execution output persistence failed");
		assert.ok(!result.error.includes(secretPath), `must not leak output paths: ${result.error}`);
		assert.equal(result.executionSurface?.retained, true);
		assert.equal(result.executionSurface?.handle.backend, backendName);
		assert.equal(lifecycle.releases, 1);
		assert.equal(lifecycle.closes, 0);
		assert.equal(requests.length, 1);
		assert.equal(fixtureInvocationCount(argsPath), 1, "must not fall back to native execution");
		assert.equal(fs.existsSync(promptTempDir(argsPath)), false);
	} finally {
		process.env.PATH = savedPath;
		dispose();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
	});
});

test("runSingleStep retains external leaves when artifact writes or finish fail", unixOnly, async t => {
	for (const target of ["output", "metadata", "child-failure", "finish-failure"] as const) await t.test(target, async () => {
		const tempDir = createTempDir(`bg-runner-artifact-${target}-`);
		const binDir = path.join(tempDir, "bin");
		const argsPath = path.join(tempDir, "pi-args.json");
		const artifactsDir = path.join(tempDir, "artifacts");
		const runId = `bg-runner-artifact-${target}`;
		const artifactPaths = getArtifactPaths(artifactsDir, runId, "worker");
		fs.mkdirSync(binDir);
		fs.mkdirSync(artifactsDir);
		if (target === "output" || target === "metadata") fs.mkdirSync(target === "output" ? artifactPaths.outputPath : artifactPaths.metadataPath);
		fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript(target === "child-failure" ? "fail" : "success", argsPath), { mode: 0o755 });

		const requests: ExecutionSurfaceRequest[] = [];
		const hosts: ReturnType<typeof spawn>[] = [];
		const lifecycle: BackendLifecycle = { releases: 0, closes: 0 };
		if (target === "finish-failure") lifecycle.releaseError = "SENTINEL_FINISH_SECRET";
		const backendName = `fake-bg-runner-artifact-${target}-${process.pid}`;
		const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
		const savedPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

		try {
			const result = await runSingleStep({
				agent: "worker",
				task: `Exercise artifact ${target} persistence failure`,
				outputMode: "file-only",
				outputPath: path.join(tempDir, "requested.md"),
				inheritProjectContext: false,
				inheritSkills: false,
				sessionFile: path.join(tempDir, "session-0-attempt-0.jsonl"),
				completionGuard: false,
			}, {
				previousOutput: "",
				outputs: {},
				placeholder: "",
				cwd: tempDir,
				sessionEnabled: true,
				artifactsDir,
				artifactConfig: {
					enabled: true,
					includeInput: true,
					includeOutput: true,
					includeJsonl: false,
					includeMetadata: true,
					cleanupDays: 1,
				},
				id: runId,
				flatIndex: 0,
				flatStepCount: 1,
				outputFile: path.join(tempDir, "output-0.log"),
				executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
				executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backendName },
			});

			assert.equal(result.exitCode, 1);
			assert.equal(result.output, target === "output"
				? `Full reply not preserved (artifact write failed: ${result.error})`
				: `Full reply preserved at ${artifactPaths.outputPath}`);
			assert.equal(fs.readFileSync(path.join(tempDir, "output-0.log"), "utf8"), result.output);
			if (target !== "output") assert.equal(fs.readFileSync(artifactPaths.outputPath, "utf8"), "background answer");
			if (target === "child-failure") assert.equal(fs.existsSync(path.join(tempDir, "requested.md")), false);
			if (target === "finish-failure") {
				assert.equal(result.error, "External execution finish failed");
				assert.equal(fs.readFileSync(path.join(tempDir, "requested.md"), "utf8"), "background answer");
				assert.ok(!result.output.includes("Output saved to:"));
			}
			assert.ok(result.error, "artifact write failure must produce a controlled failed result");
			assert.equal(result.executionSurface?.retained, true);
			assert.equal(result.executionSurface?.handle.backend, backendName);
			assert.equal(lifecycle.releases, 1);
			assert.equal(lifecycle.closes, target === "finish-failure" ? 1 : 0);
			assert.equal(requests.length, 1);
			assert.equal(fixtureInvocationCount(argsPath), 1, "must not fall back to native execution");
		} finally {
			process.env.PATH = savedPath;
			dispose();
			await cleanupHosts(hosts);
			removeTempDir(tempDir);
		}
	});
});

test("accepted interruption repeats retained finish without more cleanup", unixOnly, async () => {
	const tempDir = createTempDir("bg-repeat-retained-");
	const binDir = path.join(tempDir, "bin");
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("interrupted"), { mode: 0o755 });
	const hosts: ReturnType<typeof spawn>[] = [];
	const requests: ExecutionSurfaceRequest[] = [];
	const lifecycle = { releases: 0, closes: 0 };
	const backend = makeBackend(`bg-repeat-${process.pid}`, binDir, requests, hosts, lifecycle);
	try {
		const owner = await createExternalExecution({ runId: "repeat", childId: "worker", backend, cwd: tempDir, title: "worker", signal: new AbortController().signal });
		const sessionFile = path.join(tempDir, "session.jsonl");
		const result = await runExternalBackgroundAttempt({ owner, attemptId: "repeat-0", args: ["--session", sessionFile, "Inspect"], environment: process.env, cwd: tempDir, sessionFile });
		assert.equal(result.exitCode, 0);
		assert.equal(result.interrupted, true);
		assert.ok(hosts[0].exitCode !== null || hosts[0].signalCode !== null, "host exit precedes attempt settlement");
		const pid = Number(fs.readFileSync(path.join(tempDir, "child.pid"), "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		const before = { ...lifecycle };
		const first = await owner.finish("retained");
		assert.strictEqual(await owner.finish("retained"), first);
		assert.deepEqual(first, { handle: owner.surface, retained: true });
		await assert.rejects(owner.finish("delivered"), /already finishing as retained/);
		assert.deepEqual(lifecycle, before);
	} finally {
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});

for (const mode of ["sequential", "static", "dynamic", "user-abort"] as const) {
	test(`runner persists mixed completed and warning-paused children for ${mode}`, unixOnly, async () => {
		const tempDir = createTempDir("bg-runner-mixed-");
		const binDir = path.join(tempDir, "bin");
		fs.mkdirSync(binDir);
		const warning = "Process termination could not be confirmed; manual cleanup may be required.";
		const argsPath = path.join(tempDir, "args.json");
		let script = makeFixtureScript("success", argsPath)
			.replace('const sessionFile =', 'if (process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE) fs.writeFileSync(process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE, JSON.stringify({ status: "success", value: { items: ["complete", "pause-one", "pause-two"] } }));\nconst sessionFile =')
			.replace('outcome: "success"', 'outcome: args.at(-1).includes("pause") ? "interrupted" : "success"');
		if (mode === "user-abort") {
			const terminal = 'append({ type: "message", message: { role: "assistant", content: [], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "This operation was aborted", timestamp: Date.now() } }); report("settled"); report("result", { outcome: "interrupted", finalOutput: "", stopReason: "error", error: "This operation was aborted" });';
			script = makeFixtureScript("success", argsPath)
				.replace(/  append\(\{ type: "message"[^\n]+\n  report\("settled"\);\n  report\("result",[^\n]+/, '  append({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "sleep 60" } }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } }); fs.writeFileSync("abort-ready", "1");')
				.replace('    if (request.action === "shutdown")', `    if (request.action === "abort") { ${terminal} }\n    if (request.action === "shutdown")`);
		}
		fs.writeFileSync(path.join(binDir, "pi"), script, { mode: 0o755 });
		const step = (task: string) => ({ agent: "worker", task, completionGuard: false, inheritProjectContext: false, inheritSkills: false, modelCandidates: ["first", "second"] });
		const steps = mode === "user-abort" ? [step("running tool"), step("unreachable")] : mode === "sequential"
			? [step("complete"), { parallel: [step("pause-one"), step("pause-two")], concurrency: 2, failFast: true }, step("unreachable")]
			: mode === "static" ? [{ parallel: [step("complete"), step("pause-one"), step("pause-two")], concurrency: 3, failFast: true }]
			: [{ ...step("produce"), outputName: "items", structuredOutputSchema: { type: "object" } }, { expand: { from: { output: "items", path: "/items" }, item: "target", maxItems: 3 }, parallel: step("{target}"), collect: { as: "collected" }, concurrency: 3, failFast: true }];
		const resultPath = path.join(tempDir, "result.json");
		const configPath = path.join(tempDir, "config.json");
		const runnerPath = path.resolve("src/runs/background/subagent-runner.ts");
		const backendName = `mixed-${mode}`;
		fs.writeFileSync(configPath, JSON.stringify({ id: backendName, steps, resultPath, cwd: tempDir, placeholder: "{previous}", asyncDir: tempDir, sessionDir: path.join(tempDir, "sessions"), runtime: fixtureRuntime(tempDir), executionBackends: { protocolVersion: 1, registrations: [], userPreference: backendName } }));
		const entryPath = path.join(tempDir, "runner.mjs");
		fs.writeFileSync(entryPath, `import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import { spawn } from "node:child_process"; import { once } from "node:events"; import { syncBuiltinESMExports } from "node:module";
import { registerExecutionBackend } from ${JSON.stringify(pathToFileURL(path.resolve("src/execution-backend/registry.ts")).href)};
${cleanupHosts.toString()}
${makeBackend.toString()}
const hosts = [], requests = [], lifecycle = { releases: 0, closes: 0, suppressExitEvidence: ${mode !== "user-abort"} };
${mode === "user-abort" ? 'const interruptTimer = setInterval(() => { if (fs.existsSync("abort-ready")) { clearInterval(interruptTimer); process.kill(process.pid, "SIGUSR2"); } }, 10);' : ''}
registerExecutionBackend(makeBackend(${JSON.stringify(backendName)}, "", requests, hosts, lifecycle));
const rename = fs.renameSync;
let checkedPause = false;
fs.renameSync = (from, to) => {
 if (to === ${JSON.stringify(path.join(tempDir, "status.json"))}) {
  const status = JSON.parse(fs.readFileSync(from, "utf8"));
  if (!checkedPause && status.state === "paused") {
   checkedPause = true;
   for (const host of hosts) assert.ok(host.exitCode !== null || host.signalCode !== null, "every host exits before paused publication");
   for (const pid of fs.readFileSync(${JSON.stringify(path.join(tempDir, "child.pids"))}, "utf8").trim().split("\\n")) {
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" }, "every direct child exits before paused publication");
   }
  }
 }
 return rename(from, to);
};
syncBuiltinESMExports();
process.argv[1] = ${JSON.stringify(runnerPath)}; process.argv[2] = ${JSON.stringify(configPath)};
await import(${JSON.stringify(pathToFileURL(runnerPath).href)});
`);
		const runner = spawn(process.execPath, [entryPath], { cwd: tempDir, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		runner.stderr.on("data", chunk => { stderr += chunk; });
		try {
			const [code] = await once(runner, "exit");
			assert.equal(code, 0, stderr);
			const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
			const status = JSON.parse(fs.readFileSync(path.join(tempDir, "status.json"), "utf8"));
			assert.equal(result.state, "paused", JSON.stringify(result));
			assert.equal(result.exitCode, 0);
			assert.equal(status.state, "paused");
			const affected = result.results.filter(child => child.interrupted);
			assert.equal(affected.length, mode === "user-abort" ? 1 : 2);
			for (const paused of affected) {
				const pausedIndex = result.results.indexOf(paused);
				assert.equal(paused.interrupted, true);
				if (mode === "user-abort") assert.equal(paused.error, "This operation was aborted");
				else assert.ok(paused.error.includes(warning));
				assert.equal(paused.executionSurface.retained, true);
				assert.equal(paused.modelAttempts.length, 1);
				assert.equal(paused.modelAttempts[0].success, true);
				assert.equal(status.steps[pausedIndex].status, "complete");
				assert.equal(status.steps[pausedIndex].interrupted, undefined);
				assert.equal(status.steps[pausedIndex].error, paused.error);
			}
			if (mode === "user-abort") {
				const entries = fs.readFileSync(affected[0].sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
				const applied = entries.findIndex(entry => entry.data?.action === "abort" && entry.data?.state === "applied");
				const terminalMessage = entries.findIndex(entry => entry.message?.errorMessage === "This operation was aborted");
				assert.ok(applied >= 0 && terminalMessage > applied);
				assert.equal(entries[terminalMessage].message.stopReason, "error");
				assert.equal(entries.filter(entry => entry.data?.kind === "result").length, 1);
			}
			for (const completed of result.results.filter(child => !child.interrupted)) {
				assert.equal(completed.success, true);
				assert.equal(completed.interrupted, undefined);
			}
			assert.equal(fixtureInvocationCount(argsPath), mode === "dynamic" ? 4 : mode === "user-abort" ? 1 : 3);
			assert.doesNotMatch(JSON.stringify(result), /External execution (attempt|finish) failed/);
		} finally {
			if (runner.exitCode === null) runner.kill("SIGKILL");
			removeTempDir(tempDir);
		}
	});
}

test("noninterrupted fallback reuses the host and closes only after output persistence", unixOnly, async () => {
	const tempDir = createTempDir("bg-fallback-");
	const binDir = path.join(tempDir, "bin");
	const argsPath = path.join(tempDir, "args.json");
	const outputFile = path.join(tempDir, "output.log");
	fs.mkdirSync(binDir);
	const script = makeFixtureScript("success", argsPath)
		.replace('outcome: "success"', 'outcome: args.includes("first") ? "failed" : "success", error: args.includes("first") ? "rate limit timeout" : ""')
		.replaceAll('"background answer"', 'args.includes("first") ? "rate limit timeout" : "background answer"');
	fs.writeFileSync(path.join(binDir, "pi"), script, { mode: 0o755 });
	const hosts: ReturnType<typeof spawn>[] = [];
	const requests: ExecutionSurfaceRequest[] = [];
	const lifecycle: BackendLifecycle = { releases: 0, closes: 0, onClose(reason) {
		assert.equal(reason, "delivered");
		assert.match(fs.readFileSync(outputFile, "utf8"), /background answer$/);
	} };
	const name = `bg-fallback-${process.pid}`;
	const dispose = registerExecutionBackend(makeBackend(name, binDir, requests, hosts, lifecycle));
	try {
		const result = await runSingleStep({ agent: "worker", task: "Inspect", modelCandidates: ["first", "second"], completionGuard: false, inheritProjectContext: false, inheritSkills: false }, {
			previousOutput: "", outputs: {}, placeholder: "", cwd: tempDir, sessionEnabled: true,
			id: "fallback", flatIndex: 0, flatStepCount: 1, outputFile,
			executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
			executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: name },
		});
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.interrupted, false);
		assert.equal(result.modelAttempts.length, 2);
		assert.deepEqual(result.modelAttempts.map(attempt => attempt.success), [false, true]);
		assert.equal(requests.length, 1);
		assert.equal(fixtureInvocationCount(argsPath), 2);
		assert.equal(lifecycle.closes, 1);
		assert.equal(lifecycle.releases, 1);
		assert.equal(result.executionSurface.retained, false);
	} finally {
		dispose();
		await cleanupHosts(hosts);
		removeTempDir(tempDir);
	}
});
