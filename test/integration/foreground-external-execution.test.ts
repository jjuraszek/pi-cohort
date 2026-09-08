import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { once } from "node:events";
import * as path from "node:path";
import { test } from "node:test";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createTempDir, makeAgent, removeTempDir } from "../support/helpers.ts";

const unixOnly = { skip: process.platform === "win32" };

const PI_FIXTURE = `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf("--session") + 1];
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
  append({ type: "session", version: 3, cwd: process.cwd(), timestamp: new Date().toISOString() });
  report("ready");
  append({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "durable answer" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } });
  report("settled");
  report("result", { outcome: "success", finalOutput: "durable answer", stopReason: "stop" });
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
`;

test("runSync drives one real child host surface through a registered backend", unixOnly, async () => {
	const tempDir = createTempDir("foreground-external-");
	const binDir = path.join(tempDir, "bin");
	const fixturePath = path.join(binDir, "pi");
	fs.mkdirSync(binDir);
	fs.writeFileSync(fixturePath, PI_FIXTURE, { mode: 0o755 });
	const requests: ExecutionSurfaceRequest[] = [];
	const hosts: ReturnType<typeof spawn>[] = [];
	let releases = 0;
	let closes = 0;
	const backend: ExecutionBackend = {
		name: `fake-foreground-${process.pid}`,
		protocolVersion: 1,
		async detect() { return { available: true, version: "1", capabilities: ["interactive"] }; },
		async launch(request) {
			requests.push(request);
			const host = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env: request.environment,
				stdio: ["ignore", "ignore", "ignore"],
			});
			hosts.push(host);
			return {
				handle: { protocolVersion: 1, backend: backend.name, surface: { kind: "fixture", id: "one" }, display: { label: "fixture surface", hint: "durable" }, data: null },
				events: (async function*() {})(),
				async reconcile() { return []; },
				async release() { releases++; },
			};
		},
		async reattach() { return { status: "gone" }; },
		async close() { closes++; },
	};
	const dispose = registerExecutionBackend(backend);
	const savedPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ""}`;
	try {
		const sessionFile = path.join(tempDir, "session.jsonl");
		const output = await runSync(tempDir, [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
			runId: "external-integration",
			executionBackend: backend.name,
			sessionFile,
			acceptance: { level: "none", reason: "integration fixture" },
		});
		assert.equal(output.exitCode, 0, output.error);
		assert.equal(output.finalOutput, "durable answer");
		assert.equal(output.messages?.length, 1);
		assert.deepEqual(output.executionSurface, {
			handle: { protocolVersion: 1, backend: backend.name, surface: { kind: "fixture", id: "one" }, display: { label: "fixture surface", hint: "durable" }, data: null },
			retained: false,
		});
		assert.equal(requests.length, 1);
		assert.deepEqual(requests[0].awareness, { title: "worker" });
		assert.equal(releases, 1);
		assert.equal(closes, 1);
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
