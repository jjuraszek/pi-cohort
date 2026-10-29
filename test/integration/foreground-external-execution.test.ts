import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { once } from "node:events";
import * as path from "node:path";
import { test } from "node:test";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { createChildHostController } from "../../src/execution-backend/child-host-controller.ts";
import { createExternalExecution } from "../../src/runs/shared/external-execution.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { getArtifactPaths } from "../../src/shared/artifacts.ts";
import { createMockPi } from "../support/mock-pi.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const unixOnly = { skip: process.platform === "win32" };

const PI_FIXTURE = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
const config = JSON.parse(fs.readFileSync(process.env.PI_COHORT_REPORT_CONFIG, "utf8"));
const previous = fs.readFileSync(sessionFile, "utf8").trim().split("\\n").filter(Boolean).map(line => JSON.parse(line));
let sequence = previous.length;
let reportSequence = 0;
let parentId = previous.at(-1)?.id ?? null;
const durableFailure = process.env.FIXTURE_MODE?.startsWith("failed") || (process.env.FIXTURE_MODE === "fallback" && args[args.indexOf("--model") + 1].includes("gpt-6"));
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
  append({ type: "session", version: 3, cwd: process.cwd(), args, parentSessionId: process.env.PI_SUBAGENT_PARENT_SESSION_ID, timestamp: new Date().toISOString() });
  report("ready");
  if (process.env.FIXTURE_MODE) {
    fs.writeFileSync(process.env.FIXTURE_PID, String(process.pid));
    if (!process.env.FIXTURE_MODE.startsWith("failed") && process.env.FIXTURE_MODE !== "fallback") return;
  }
  append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "durable answer" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
  report("settled");
  report("result", { outcome: durableFailure ? "failed" : "success", finalOutput: "durable answer", stopReason: "stop", ...(durableFailure ? { error: process.env.FIXTURE_MODE === "failed-rate" ? "rate limit" : "request timeout" } : {}) });
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
    if (request.action === "abort" && !process.env.FIXTURE_MODE?.startsWith("failed") && process.env.FIXTURE_MODE !== "timeout") {
      append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "partial" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "This operation was aborted", timestamp: Date.now() } });
      report("settled");
      report("result", { outcome: process.env.FIXTURE_MODE === "protocol" ? "invalid" : process.env.FIXTURE_MODE === "success-terminal" ? "success" : process.env.FIXTURE_MODE === "error-terminal" ? "failed" : "interrupted", finalOutput: "partial", stopReason: "error", error: "This operation was aborted" });
    }
    if (request.action === "shutdown" && process.env.FIXTURE_MODE !== "busy" && process.env.FIXTURE_MODE !== "timeout") socket.end(() => process.exit(0));
  }
});
`;

for (const outcome of ["success", "artifact failure", "save and artifact failure", "interrupted", "success-terminal", "error-terminal", "failed-rate", "failed-timeout", "timeout", "busy", "uncertain-success", "uncertain-failed", "uncertain-interrupted", "close-failure", "fallback", "protocol", "pre-ready", "busy-shutdown"] as const) {
test(`runSync drives one real child host surface through a registered backend (${outcome})`, unixOnly, async () => {
	const tempDir = createTempDir("foreground-external-");
	const binDir = path.join(tempDir, "bin");
	const fixturePath = path.join(binDir, "pi");
	fs.mkdirSync(binDir);
	fs.writeFileSync(fixturePath, PI_FIXTURE, { mode: 0o755 });
	const mockPi = createMockPi();
	fs.writeFileSync(mockPi.runtime.piEntryPath, `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);\n${PI_FIXTURE.replace(/^#![^\n]*\n/, "")}`);
	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	let releases = 0;
	let closes = 0;
	const interrupted = !["success", "artifact failure", "save and artifact failure", "fallback"].includes(outcome);
	const fallback = outcome === "fallback";
	const forced = outcome === "timeout" || outcome === "busy" || outcome === "close-failure" || outcome === "protocol" || outcome === "busy-shutdown";
	const uncertain = outcome.startsWith("uncertain");
	const fixtureMode = outcome === "pre-ready" || outcome === "busy-shutdown" ? "interrupted" : outcome === "uncertain-success" ? "success-terminal" : outcome === "uncertain-failed" ? "failed-rate" : outcome === "uncertain-interrupted" ? "interrupted" : outcome === "close-failure" ? "busy" : outcome;
	const interrupt = new AbortController();
	const childPidFile = path.join(tempDir, "child.pid");
	let hostExited = false;
	const closeReasons: string[] = [];
	let owner: Awaited<ReturnType<typeof createExternalExecution>>;
	let afterAttempt: { releases: number; closes: number } | undefined;
	const dispositions: string[] = [];
	const backend: ExecutionBackend = {
		name: `fake-foreground-${process.pid}`,
		protocolVersion: 1,
		async detect() { return { available: true, version: "1", capabilities: ["interactive"] }; },
		async launch(request) {
			requests.push(request);
			const host = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env: { ...request.environment, ...(interrupted ? { FIXTURE_MODE: outcome, FIXTURE_PID: childPidFile } : {}) },
				stdio: ["ignore", "ignore", "ignore"],
			});
			hosts.push(host);
			if (outcome === "pre-ready") interrupt.abort();
			const exit = once(host, "exit").then(([status, signal]) => { hostExited = true; return { status, signal }; });
			return {
				handle: { protocolVersion: 1, backend: backend.name, surface: { kind: "fixture", id: "one" }, display: { label: "fixture surface", hint: "durable" }, data: null },
				events: (async function*() {
					const { status, signal } = await exit;
					if (uncertain) return;
					yield { type: "exited" as const, source: "mux" as const, timestamp: Date.now(), surface: { kind: "fixture", id: "one" }, status, signal };
				})(),
				async reconcile() { return []; },
				async release() { releases++; },
			};
		},
		async reattach() { return { status: "gone" }; },
		async close(_handle, reason) {
			if (outcome === "success") {
				const preserved = getArtifactPaths(path.join(tempDir, "artifacts"), "external-integration", "worker");
				assert.equal(fs.readFileSync(preserved.outputPath, "utf8"), "durable answer", "delivery persists before close");
			}
			closes++;
			closeReasons.push(reason);
			if (reason === "explicit_cleanup") {
				if (fs.existsSync(childPidFile)) {
					try { process.kill(Number(fs.readFileSync(childPidFile, "utf8")), "SIGKILL"); } catch {}
				}
				const host = hosts.at(-1)!;
				if (host.exitCode === null && host.signalCode === null) {
					const exited = once(host, "exit");
					host.kill("SIGKILL");
					await exited;
				}
				if (outcome === "close-failure") throw new Error("fixture close failed");
			}
		},
	};
	const dispose = registerExecutionBackend(backend);
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
	try {
		const sessionFile = path.join(tempDir, "session.jsonl");
		const artifactPaths = getArtifactPaths(path.join(tempDir, "artifacts"), "external-integration", "worker");
		const outputPath = path.join(tempDir, "blocker", "report.md");
		if (!interrupted && !fallback && outcome !== "success") fs.mkdirSync(artifactPaths.outputPath, { recursive: true });
		if (outcome === "save and artifact failure") fs.writeFileSync(path.dirname(outputPath), "not a directory");
		const output = await runSync(tempDir, [makeAgent("worker", { completionGuard: false, ...(interrupted || fallback ? { fallbackModels: ["github-copilot/second-model"] } : {}) })], "worker", "Task", {
			runtime: mockPi.runtime,
			runId: "external-integration",
			...(outcome === "success" ? { artifactsDir: path.join(tempDir, "artifacts"), artifactConfig: { enabled: true, includeJsonl: false, includeMetadata: false } } : {}),
			...(!interrupted && !fallback && outcome !== "success" ? {
				outputMode: "file-only" as const, outputPath,
				artifactsDir: path.dirname(artifactPaths.outputPath),
				artifactConfig: { enabled: true, includeJsonl: false, includeMetadata: false },
			} : {}),
			executionBackend: backend.name,
			sessionFile,
			interruptSignal: interrupt.signal,
			parentModel: "github-copilot/gpt-6",
			parentThinking: "high",
			parentSessionLabel: "P",
			parentSessionId: "parent-session-id",
			acceptance: { level: "none", reason: "integration fixture" },
		}, interrupted || fallback ? {
			async createExternalOwner(options) {
				owner = await createExternalExecution({ ...options, controlTimeoutMs: 300 }, outcome === "busy-shutdown" ? {
					createController: async controllerOptions => {
						const controller = await createChildHostController(controllerOptions);
						return { ...controller, shutdown: async () => { throw new Error("child host is busy"); } };
					},
				} : {});
				return {
					...owner,
					async runAttempt(request) {
						const timer = setInterval(() => {
							if (fallback || !fs.existsSync(request.sessionFile)) return;
							const text = fs.readFileSync(request.sessionFile, "utf8");
							if (text.includes(fixtureMode.startsWith("failed") ? '"kind":"result"' : '"kind":"ready"')) interrupt.abort();
						}, 2);
						try {
							const result = await owner.runAttempt({ ...request, environment: { ...request.environment, FIXTURE_MODE: fixtureMode, FIXTURE_PID: childPidFile } });
							if (interrupted) assert.equal(hostExited, true, "host exit must precede attempt settlement");
							return result;
						}
						finally {
							clearInterval(timer);
							if (interrupted) assert.equal(hostExited, true, "host exit must precede attempt settlement, including rejection");
							const pid = Number(fs.readFileSync(childPidFile, "utf8"));
							assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
							afterAttempt = { releases, closes };
						}
					},
					async finish(disposition) { dispositions.push(disposition); return owner.finish(disposition); },
				};
			},
		} : {});
		if (interrupted) {
			assert.equal(output.exitCode, 0, output.error);
			assert.equal(output.interrupted, true);
			assert.equal(output.modelAttempts?.length, 1);
			assert.equal(output.attemptedModels?.length, 1);
			assert.equal(output.modelAttempts?.[0].success, true);
			assert.doesNotMatch(output.error ?? "", /External execution (attempt|finish) failed/);
			assert.equal(hostExited, true, "host must exit before fixture finalization");
			const childPid = Number(fs.readFileSync(childPidFile, "utf8"));
			assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" }, "direct child must exit before fixture finalization");
			assert.deepEqual(dispositions, ["retained"]);
			const settledSession = fs.readFileSync(sessionFile, "utf8");
			assert.deepEqual(output.executionSurface, await owner!.finish("retained"));
			assert.deepEqual(await owner!.finish("retained"), output.executionSurface);
			assert.deepEqual({ releases, closes }, afterAttempt);
			assert.equal(fs.readFileSync(sessionFile, "utf8"), settledSession, "retained finish sends no additional child control");
			assert.equal(requests.length, 1);
			assert.equal(output.executionSurface?.retained, !forced || outcome === "close-failure");
			if (uncertain || (forced && outcome !== "protocol" && outcome !== "busy-shutdown")) assert.match(output.error ?? "", /Process termination could not be confirmed; manual cleanup may be required\./);
			assert.deepEqual(closeReasons, forced ? ["explicit_cleanup"] : []);
			if (outcome === "timeout") assert.match(output.error ?? "", /result_missing/);
			if (outcome === "protocol") assert.match(output.error ?? "", /outcome/);
			if (outcome.startsWith("failed")) {
				const results = fs.readFileSync(sessionFile, "utf8").split("\n").filter(line => line.includes('"kind":"result"')).map(line => JSON.parse(line).data);
				assert.equal(results.length, 1);
				assert.equal(results[0].outcome, "failed");
			}
			return;
		}
		if (fallback) {
			assert.equal(output.modelAttempts?.length, 2);
			assert.deepEqual(output.modelAttempts?.map(attempt => attempt.success), [false, true]);
		}
		assert.equal(output.exitCode, outcome === "success" || fallback ? 0 : 1, output.error);
		if (outcome === "success" || fallback) assert.equal(output.finalOutput, "durable answer");
		else {
			let writeMessage = "";
			try { fs.writeFileSync(artifactPaths.outputPath, "durable answer", "utf8"); }
			catch (error) { writeMessage = (error as Error).message; }
			assert.ok(writeMessage);
			const pointer = `Full reply not preserved (artifact write failed: ${writeMessage})`;
			assert.equal(output.finalOutput, outcome === "save and artifact failure"
				? `Output file error: ${outputPath}\n${output.outputSaveError}\n\n${pointer}` : pointer);
			assert.equal(output.error, "External execution cleanup failed");
			assert.doesNotMatch(output.finalOutput, /durable answer/);
		}
		assert.equal(output.messages?.length, fallback ? 2 : 1);
		assert.deepEqual(output.executionSurface, {
			handle: { protocolVersion: 1, backend: backend.name, surface: { kind: "fixture", id: "one" }, display: { label: "fixture surface", hint: "durable" }, data: null },
			retained: outcome !== "success" && !fallback,
		});
		assert.equal(requests.length, 1);
		const sessionEntry = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]) as { args: string[]; parentSessionId?: string };
		assert.ok(sessionEntry.args.includes("--model"));
		assert.equal(sessionEntry.args[sessionEntry.args.indexOf("--model") + 1], "github-copilot/gpt-6:high");
		assert.equal(sessionEntry.args[sessionEntry.args.indexOf("--name") + 1], "worker external from P");
		assert.equal(sessionEntry.parentSessionId, "parent-session-id");
		assert.deepEqual(requests[0].awareness, { title: "worker" });
		assert.equal(releases, 1);
		assert.equal(closes, outcome === "success" || fallback ? 1 : 0);
		assert.ok(fs.readFileSync(sessionFile, "utf8").includes("durable answer"));
		assert.equal("stdout" in output, false);
	} finally {
		process.env.PATH = savedPath;
		dispose();
		await Promise.all(hosts.map(async host => {
			if (host.exitCode !== null || host.signalCode !== null) return;
			const exited = once(host, "exit");
			host.kill("SIGKILL");
			await exited;
		}));
		removeTempDir(tempDir);
	}
});
}
