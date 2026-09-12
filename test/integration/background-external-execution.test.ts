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
import * as path from "node:path";
import { after, test } from "node:test";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { createDetachedExecutionBackendCoordinator } from "../../src/execution-backend/reload.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";
import { createExternalExecution } from "../../src/runs/shared/external-execution.ts";
import { runExternalBackgroundAttempt, type OnSynthesizedChildEvent } from "../../src/runs/background/external-attempt.ts";
import { runSingleStep } from "../../src/runs/background/subagent-runner.ts";
import { getArtifactPaths } from "../../src/shared/artifacts.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const unixOnly = { skip: process.platform === "win32" };

// Fake pi script that implements the reporting protocol.
// It reads --session <file> from args, connects to the control socket, and
// writes session entries directly. The --extension arg (injected by
// runExternalBackgroundAttempt) is silently ignored.
function makeFixtureScript(outcome: "success" | "fail" | "missing-result", argsPath?: string) {
	return `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
${argsPath ? `fs.appendFileSync(${JSON.stringify(`${argsPath}.count`)}, "1\\n"); fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));` : ""}
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
  report("result", { outcome: ${outcome === "success" ? '"success"' : '"failed"'}, finalOutput: "background answer", stopReason: ${outcome === "success" ? '"stop"' : '"error"'} });
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
			return {
				handle: {
					protocolVersion: 1, backend: name,
					surface: { kind: "fixture", id: "bg-one" },
					display: { label: "background fixture", hint: "durable" },
					data: null,
				},
				events: (async function*() {})(),
				async reconcile() { return []; },
				async release() {
					if (lifecycle) lifecycle.releases++;
					if (lifecycle?.releaseError) throw new Error(lifecycle.releaseError);
				},
			};
		},
		async reattach() { return { status: "gone" }; },
		async close() {
			if (lifecycle) lifecycle.closes++;
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

test("runSingleStep retains an external leaf when its async output file cannot be persisted", unixOnly, async () => {
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

		assert.equal(result.output, "background answer");
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

test("runSingleStep retains external leaves when enabled artifact output or metadata writes fail", unixOnly, async t => {
	for (const target of ["output", "metadata"] as const) await t.test(target, async () => {
		const tempDir = createTempDir(`bg-runner-artifact-${target}-`);
		const binDir = path.join(tempDir, "bin");
		const argsPath = path.join(tempDir, "pi-args.json");
		const artifactsDir = path.join(tempDir, "artifacts");
		const runId = `bg-runner-artifact-${target}`;
		const artifactPaths = getArtifactPaths(artifactsDir, runId, "worker");
		fs.mkdirSync(binDir);
		fs.mkdirSync(artifactsDir);
		fs.mkdirSync(target === "output" ? artifactPaths.outputPath : artifactPaths.metadataPath);
		fs.writeFileSync(path.join(binDir, "pi"), makeFixtureScript("success", argsPath), { mode: 0o755 });

		const requests: ExecutionSurfaceRequest[] = [];
		const hosts: ReturnType<typeof spawn>[] = [];
		const lifecycle: BackendLifecycle = { releases: 0, closes: 0 };
		const backendName = `fake-bg-runner-artifact-${target}-${process.pid}`;
		const dispose = registerExecutionBackend(makeBackend(backendName, binDir, requests, hosts, lifecycle));
		const savedPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;

		try {
			const result = await runSingleStep({
				agent: "worker",
				task: `Exercise artifact ${target} persistence failure`,
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
					includeOutput: target === "output",
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
			assert.ok(result.error, "artifact write failure must produce a controlled failed result");
			assert.equal(result.executionSurface?.retained, true);
			assert.equal(result.executionSurface?.handle.backend, backendName);
			assert.equal(lifecycle.releases, 1);
			assert.equal(lifecycle.closes, 0);
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
