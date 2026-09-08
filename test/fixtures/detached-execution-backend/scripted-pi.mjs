#!/usr/bin/env node
/**
 * Scripted Pi fixture binary for detached-external-orchestration tests.
 *
 * Implements the pi-cohort execution reporting protocol: connects to the
 * control socket from PI_COHORT_REPORT_CONFIG, writes session JSONL entries,
 * and responds to abort/shutdown control requests.
 *
 * Writes trace events to PI_COHORT_FIXTURE_TRACE so tests can assert
 * attempt lifecycle ordering and model fallback behavior. Dynamic leaves can
 * synchronize through PI_COHORT_FIXTURE_BARRIER_DIR before completing.
 *
 * Task dispatch (from last arg):
 *   SINGLE / CHAIN-* / PARALLEL * -> reply:${task}
 *   DYNAMIC-PRODUCER               -> structured output {items:[...]}
 *   DYNAMIC-REVIEW <path>          -> structured output {reviewed:<path>}
 *   FALLBACK (--model bad/model)   -> failed outcome "model not found"
 *   FALLBACK (--model good/model)  -> success "reply:FALLBACK"
 *   WAIT-FOR-INTERRUPT             -> wait for abort control
 *   ACCEPTANCE-REJECT              -> success + acceptance-report JSON
 */

import * as fs from "node:fs";
import * as net from "node:net";

const args = process.argv.slice(2);

// Parse --session <file>
const sessionIdx = args.indexOf("--session");
const sessionFile = sessionIdx !== -1 ? args[sessionIdx + 1] : undefined;

// Parse --model <model>
const modelIdx = args.indexOf("--model");
const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

// Extract the task from the last arg.
// Could be "Task: XYZ" or "@/path/to/task.md"
let taskRaw = args[args.length - 1] ?? "";
if (taskRaw.startsWith("@")) {
	try { taskRaw = fs.readFileSync(taskRaw.slice(1), "utf8"); } catch {}
}
// Strip "Task: " prefix if present.
const task = taskRaw.startsWith("Task: ") ? taskRaw.slice(6).trim() : taskRaw.trim();

// Structured output path (set by buildPiArgs via PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE).
const structuredOutputPath = process.env["PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE"];

// Trace writer.
function writeTrace(type, fields) {
	const tracePath = process.env["PI_COHORT_FIXTURE_TRACE"];
	if (!tracePath) return;
	try {
		fs.appendFileSync(tracePath, JSON.stringify({ type, ...fields, ts: Date.now() }) + "\n");
	} catch {}
}

// Native execution does not provide the external execution reporting config.
const reportConfigPath = process.env["PI_COHORT_REPORT_CONFIG"];
if (!reportConfigPath && args.includes("--mode")) {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: `reply:${task}` }],
		model: model ?? "fixture",
		usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		stopReason: "stop",
	};
	await new Promise(resolve => process.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`, resolve));
	process.exit(0);
}
if (!reportConfigPath || !sessionFile) {
	console.error("[scripted-pi] missing PI_COHORT_REPORT_CONFIG or --session");
	process.exit(1);
}
const config = JSON.parse(fs.readFileSync(reportConfigPath, "utf8"));
const { runId, childId, attemptId, controlSocketPath } = config;

// Write attempt-start trace immediately.
writeTrace("attempt-start", { runId, childId, attemptId, cwd: process.cwd(), model, task });

async function waitAtFixtureBarrier() {
	const barrierDir = process.env["PI_COHORT_FIXTURE_BARRIER_DIR"];
	const participants = Number(process.env["PI_COHORT_FIXTURE_BARRIER_PARTICIPANTS"]);
	const taskPrefix = process.env["PI_COHORT_FIXTURE_BARRIER_TASK_PREFIX"];
	if (!barrierDir || !Number.isInteger(participants) || participants < 2 || !taskPrefix || !task.startsWith(taskPrefix)) return;

	fs.writeFileSync(`${barrierDir}/${attemptId}.ready`, task);
	const deadline = Date.now() + 2_000;
	while (fs.readdirSync(barrierDir).filter(file => file.endsWith(".ready")).length < participants) {
		if (Date.now() >= deadline) {
			throw new Error(`Fixture barrier timed out waiting for ${participants} participants for ${taskPrefix}`);
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

// Session JSONL helpers.
let sequence = 0;
let parentId = null;
let reportSequence = 0;

function appendEntry(entry) {
	const id = `entry-${++sequence}`;
	fs.appendFileSync(sessionFile, JSON.stringify({ id, parentId, ...entry }) + "\n");
	parentId = id;
}

function appendMessage(text, failed = false) {
	appendEntry({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "fixture",
			provider: "fixture",
			model: model ?? "fixture",
			usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: failed ? "error" : "stop",
			timestamp: Date.now(),
		},
	});
}

function appendReport(kind, extra = {}) {
	appendEntry({
		type: "custom",
		customType: "pi-cohort:execution-report:v1",
		data: {
			protocolVersion: 1,
			runId,
			childId,
			attemptId,
			kind,
			sequence: ++reportSequence,
			timestamp: new Date().toISOString(),
			...extra,
		},
	});
}

// Control socket decoder (newline-delimited JSON).
class ControlDecoder {
	#buf = "";
	feed(data) {
		this.#buf += data.toString();
		const requests = [];
		for (;;) {
			const nl = this.#buf.indexOf("\n");
			if (nl < 0) break;
			const line = this.#buf.slice(0, nl).trim();
			this.#buf = this.#buf.slice(nl + 1);
			if (line) {
				try { requests.push(JSON.parse(line)); } catch {}
			}
		}
		return requests;
	}
}

// Task logic - determine what to do and return handler.
function buildTaskHandler(socket, onAbort) {
	// Handle WAIT-FOR-INTERRUPT: send ready, then wait for abort.
	if (task === "WAIT-FOR-INTERRUPT") {
		return async () => {
			appendReport("ready");
			writeTrace("ready", { runId, childId, attemptId });
			// Wait for abort signal from onAbort callback.
			await new Promise((resolve) => onAbort(resolve));
			// After abort: write interrupted result.
			appendReport("settled");
			appendReport("result", {
				outcome: "interrupted",
				finalOutput: "",
				stopReason: "interrupted",
			});
		};
	}

	// Handle FALLBACK with bad/model: return a provider error.
	if (task === "FALLBACK" && model && model.includes("bad")) {
		return async () => {
			appendReport("ready");
			// No message - just report failure directly.
			appendMessage(`model not found: ${model}`, true);
			appendReport("settled");
			appendReport("result", {
				outcome: "failed",
				finalOutput: `model not found: ${model}`,
				error: `model not found: ${model}`,
				stopReason: "error",
			});
		};
	}

	// Handle DYNAMIC-PRODUCER: write structured output and reply.
	if (task === "DYNAMIC-PRODUCER") {
		return async () => {
			appendReport("ready");
			const structuredData = { items: [{ path: "src/a.ts" }, { path: "src/b.ts" }] };
			if (structuredOutputPath) {
				fs.writeFileSync(structuredOutputPath, JSON.stringify(structuredData), "utf8");
			}
			const output = "produced";
			appendMessage(output);
			appendReport("settled");
			appendReport("result", { outcome: "success", finalOutput: output, stopReason: "stop" });
		};
	}

	// Handle DYNAMIC-REVIEW <path>: extract path from task string.
	if (task.startsWith("DYNAMIC-REVIEW ")) {
		const reviewPath = task.slice("DYNAMIC-REVIEW ".length).trim();
		return async () => {
			appendReport("ready");
			const structuredData = { reviewed: reviewPath };
			if (structuredOutputPath) {
				fs.writeFileSync(structuredOutputPath, JSON.stringify(structuredData), "utf8");
			}
			const output = `reviewed ${reviewPath}`;
			appendMessage(output);
			appendReport("settled");
			appendReport("result", { outcome: "success", finalOutput: output, stopReason: "stop" });
		};
	}

	// Handle ACCEPTANCE-REJECT: produce a valid acceptance report that will be rejected at "reviewed" level.
	if (task.startsWith("ACCEPTANCE-REJECT")) {
		return async () => {
			appendReport("ready");
			const acceptanceReport = {
				criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "implemented the requested change" }],
				changedFiles: ["src/fixture.ts"],
				residualRisks: [],
				noStagedFiles: true,
			};
			const output = `ACCEPTANCE-REJECT done\n\n\`\`\`acceptance-report\n${JSON.stringify(acceptanceReport)}\n\`\`\``;
			appendMessage(output);
			appendReport("settled");
			appendReport("result", { outcome: "success", finalOutput: output, stopReason: "stop" });
		};
	}

	// Default: reply with "reply:<task>" for SINGLE, CHAIN-*, PARALLEL *, FALLBACK good/model, etc.
	const reply = `reply:${task}`;
	return async () => {
		appendReport("ready");
		appendMessage(reply);
		appendReport("settled");
		appendReport("result", { outcome: "success", finalOutput: reply, stopReason: "stop" });
	};
}

// Connect to control socket and drive the protocol.
async function run() {
	const socket = await new Promise((resolve, reject) => {
		const s = net.createConnection(controlSocketPath, () => resolve(s));
		s.once("error", reject);
	});

	const decoder = new ControlDecoder();
	let abortResolve = null;
	let shutdownResolve = null;

	socket.on("data", (chunk) => {
		const requests = decoder.feed(chunk);
		for (const req of requests) {
			if (req.action === "abort") {
				appendReport("control", { action: "abort", state: "requested" });
				appendReport("control", { action: "abort", state: "applied" });
				writeTrace("abort", { runId, childId, attemptId });
				if (abortResolve) abortResolve();
			} else if (req.action === "shutdown") {
				appendReport("control", { action: "shutdown", state: "requested" });
				appendReport("control", { action: "shutdown", state: "applied" });
				if (shutdownResolve) shutdownResolve();
			}
		}
	});

	socket.once("error", () => process.exit(1));
	socket.once("close", () => {
		// If shutdown was already resolved, clean exit happened.
	});

	// Build and run the task handler.
	const handler = buildTaskHandler(socket, (resolve) => { abortResolve = resolve; });
	await waitAtFixtureBarrier();
	await handler();

	// Wait for shutdown control request.
	await new Promise((resolve) => { shutdownResolve = resolve; });

	writeTrace("attempt-end", { runId, childId, attemptId, task });
	socket.end();
	// Give the socket a moment to flush.
	await new Promise((resolve) => setTimeout(resolve, 20));
	process.exit(0);
}

run().catch((err) => {
	console.error("[scripted-pi] error:", err);
	writeTrace("attempt-end", { runId, childId, attemptId, error: String(err) });
	process.exit(1);
});
