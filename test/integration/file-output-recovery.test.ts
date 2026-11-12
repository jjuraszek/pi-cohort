import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { RunSyncOptions } from "../../src/shared/types.ts";
import { finalizeSingleAttempt, initializeAttempt } from "../../src/runs/foreground/attempt-finalization.ts";
import { runSingleStep } from "../../src/runs/background/subagent-runner.ts";
import { captureSingleOutputSnapshot, formatSavedOutputReference } from "../../src/runs/shared/single-output.ts";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { createDetachedExecutionBackendCoordinator } from "../../src/execution-backend/reload.ts";
import type { ExecutionBackend, ExecutionSurfaceRequest } from "../../src/execution-backend/types.ts";
import { createMockPi, createTempDir, removeTempDir } from "../support/helpers.ts";

const mockPi = createMockPi();
mockPi.install();
after(() => mockPi.uninstall());
const agent: AgentConfig = {
	name: "reporter",
	description: "Writes a report",
	systemPrompt: "Write a report.",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
	source: "project",
	filePath: "reporter.md",
};
const report = "# Findings\nThe report is complete.\n";
const toolResults = [
	{ name: "recovered grep error", toolName: "grep", isError: true, text: "Path not found: missing-directory" },
	{ name: "successful bash printing an exit expression", toolName: "bash", isError: false, text: 'REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1' },
];
const outputs = [
	{ name: "created", existed: false, changed: true, enabled: true },
	{ name: "updated", existed: true, changed: true, enabled: true },
	{ name: "unchanged", existed: true, changed: false, enabled: true },
	{ name: "missing", existed: false, changed: false, enabled: true },
	{ name: "disabled", existed: false, changed: false, enabled: false },
	{ name: "report written, then a final read error, exit 0", existed: false, changed: true, enabled: true, finalToolError: true },
	{ name: "changed with nonzero exit", existed: false, changed: true, enabled: true, exitCode: 7 },
	{ name: "changed with explicit error", existed: false, changed: true, enabled: true, error: "Provider failed" },
];

function externalFixture(messages: unknown[], writeReport: string, failed: boolean): string {
	return `
import fs from "node:fs";
import net from "node:net";
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
  type: "custom", customType: "pi-cohort:execution-report:v1",
  data: { protocolVersion: 1, runId: config.runId, childId: config.childId, attemptId: config.attemptId, kind, sequence: ++reportSequence, timestamp: new Date().toISOString(), ...extra }
});
const socket = net.connect(config.controlSocketPath, () => {
  report("ready");
  ${writeReport}
  for (const message of ${JSON.stringify(messages)}) append({ type: "message", message });
  report("settled");
  report("result", { outcome: ${JSON.stringify(failed ? "failed" : "success")}, finalOutput: "", stopReason: ${JSON.stringify(failed ? "error" : "stop")} });
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
socket.on("error", () => process.exit(1));
`;
}

function makeBackend(
	name: string,
	requests: ExecutionSurfaceRequest[],
	hosts: ReturnType<typeof spawn>[],
	lifecycle: { releases: number; closes: number },
): ExecutionBackend {
	return {
		name,
		protocolVersion: 1,
		async detect() { return { available: true, version: "1", capabilities: ["interactive"] }; },
		async launch(request) {
			requests.push(request);
			const host = spawn(request.command, [...request.args], {
				cwd: request.cwd, env: request.environment, stdio: ["ignore", "ignore", "ignore"],
			});
			hosts.push(host);
			const exited = once(host, "exit");
			return {
				handle: {
					protocolVersion: 1, backend: name,
					surface: { kind: "fixture", id: "file-output" },
					display: { label: "file output fixture", hint: "durable" }, data: null,
				},
				events: (async function*() {
					const [status, signal] = await exited;
					yield { type: "exited" as const, timestamp: Date.now(), source: "mux" as const, surface: { kind: "fixture", id: "file-output" }, status, signal };
				})(),
				async reconcile() { return []; },
				async release() { lifecycle.releases++; },
			};
		},
		async reattach() { return { status: "gone" }; },
		async close() { lifecycle.closes++; },
	};
}

for (const backend of ["foreground", "native", "external"] as const) {
	for (const tool of toolResults) {
		for (const output of outputs) {
			if (backend !== "foreground" && output.error) continue;
			test(`file output recovery: ${backend}, ${tool.name}, ${output.name}`, { skip: backend === "external" && process.platform === "win32" }, async () => {
				const tempDir = createTempDir("file-output-");
				const outputPath = output.enabled ? path.join(tempDir, "report.md") : undefined;
				if (output.existed) fs.writeFileSync(outputPath!, "stale report");
				const outputSnapshot = captureSingleOutputSnapshot(outputPath);
				const success = output.changed && !output.exitCode && !output.error && !output.finalToolError;
				const writtenReport = output.finalToolError ? "# Findings\n" : report;
				const failedTool = output.finalToolError ? "read" : tool.toolName;
				const messages = [{
					role: "toolResult", toolCallId: "inspect", toolName: tool.toolName, isError: tool.isError,
					content: [{ type: "text", text: tool.text }], timestamp: 1,
				}];
				if (output.changed) messages.push({
					role: "toolResult", toolCallId: "save", toolName: "write", isError: false,
					content: [{ type: "text", text: "Report written" }], timestamp: 2,
				});
				if (output.finalToolError) messages.push({
					role: "toolResult", toolCallId: "read", toolName: "read", isError: true,
					content: [{ type: "text", text: "Path not found: missing-file" }], timestamp: 3,
				});
				const hosts: ReturnType<typeof spawn>[] = [];
				const requests: ExecutionSurfaceRequest[] = [];
				const lifecycle = { releases: 0, closes: 0 };
				const name = `file-output-${process.pid}`;
				const dispose = backend === "external"
					? registerExecutionBackend(makeBackend(name, requests, hosts, lifecycle))
					: () => {};
				try {
					if (backend === "foreground") {
						const options = { outputPath, outputMode: "file-only", runId: "report" } as RunSyncOptions;
						const attempt = initializeAttempt(agent, "Review the files and write a report", undefined, options, {
							sessionEnabled: false, systemPrompt: agent.systemPrompt, attemptNotes: [],
						});
						attempt.result.messages.push(...messages);
						if (output.changed) fs.writeFileSync(outputPath!, writtenReport);
						attempt.result.exitCode = output.exitCode ?? 0;
						attempt.result.error = output.error;
						const result = finalizeSingleAttempt(attempt.result, attempt.progress, {
							agent, options, outputSnapshot, observedMutationAttempt: output.changed, interruptedByControl: false,
							allControlEvents: attempt.allControlEvents, emitControlEvent: attempt.emitControlEvent, startTime: attempt.startTime,
						});
						if (success) {
							assert.equal(result.exitCode, 0, result.error);
							assert.equal(result.error, undefined);
							assert.equal(result.savedOutputPath, outputPath);
							assert.deepEqual(result.outputReference, formatSavedOutputReference(outputPath!, report.trimEnd()));
							assert.equal(result.finalOutput, result.outputReference.message);
						} else {
							assert.equal(result.exitCode, output.exitCode ?? 1);
							if (output.error) assert.equal(result.error, output.error);
							else if (!output.exitCode) assert.ok(result.error?.startsWith(`${failedTool} failed (exit 1):`), result.error);
							assert.equal(result.savedOutputPath, undefined);
							assert.equal(result.outputReference, undefined);
							assert.equal(result.finalOutput, "");
						}
					} else {
						const writeReport = output.changed ? `fs.writeFileSync(${JSON.stringify(outputPath)}, ${JSON.stringify(writtenReport)});` : "";
						const script = backend === "native"
							? `import fs from "node:fs"; ${writeReport}\nfor (const message of ${JSON.stringify(messages)}) console.log(JSON.stringify({ type: "tool_result_end", message }));\nprocess.exit(${output.exitCode ?? 0});`
							: externalFixture(messages, writeReport, Boolean(output.exitCode));
						fs.writeFileSync(mockPi.runtime.piEntryPath, script);
						const result = await runSingleStep({
							agent: "reporter", task: "Review the files and write a report", outputPath, outputMode: "file-only",
							inheritProjectContext: false, inheritSkills: false,
						}, {
							cwd: tempDir, previousOutput: "", placeholder: "{previous}", sessionEnabled: false,
							sessionDir: path.join(tempDir, "sessions"), runtime: mockPi.runtime,
							id: "file-output", flatIndex: 0, flatStepCount: 1, outputFile: path.join(tempDir, "output.log"),
							executionBackendCoordinator: createDetachedExecutionBackendCoordinator({ protocolVersion: 1, registrations: [] }),
							executionBackendConfig: { protocolVersion: 1, registrations: [], userPreference: backend === "native" ? "native" : name },
						});
						if (success) {
							assert.equal(result.exitCode, 0, result.error);
							assert.equal(result.error, undefined);
							assert.equal(result.output, formatSavedOutputReference(outputPath!, report).message);
						} else {
							assert.equal(result.exitCode, output.exitCode && backend === "native" ? output.exitCode : 1);
							if (!output.exitCode) assert.ok(result.error?.startsWith(`${failedTool} failed (exit 1):`), result.error);
							assert.doesNotMatch(result.output, /Output saved to:/);
						}
						assert.equal(result.modelAttempts.length, 1);
						assert.equal(result.modelAttempts[0].success, success);
						if (backend === "external") {
							assert.equal(result.executionSurface.retained, !success);
							assert.equal(lifecycle.closes, success ? 1 : 0);
							assert.equal(lifecycle.releases, 1);
							assert.equal(requests.length, 1);
						}
					}
					if (output.changed) assert.equal(fs.readFileSync(outputPath!, "utf8"), writtenReport);
					else if (output.existed) assert.equal(fs.readFileSync(outputPath!, "utf8"), "stale report");
					else if (outputPath) assert.equal(fs.existsSync(outputPath), false);
				} finally {
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
	}
}
