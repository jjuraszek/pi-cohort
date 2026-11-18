import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const queueDir = process.env.MOCK_PI_QUEUE_DIR;

function fail(message, exitCode = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(exitCode);
}

function listPendingFiles(dir) {
	return fs.readdirSync(dir)
		.filter((name) => name.startsWith("pending-") && name.endsWith(".json"))
		.sort();
}

function claimNextResponse(dir, args) {
	for (const fileName of listPendingFiles(dir)) {
		const sourcePath = path.join(dir, fileName);
		try {
			const candidate = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
			if (candidate.taskIncludes && !args.some((arg) => {
				if (arg.includes(candidate.taskIncludes)) return true;
				if (!arg.startsWith("@")) return false;
				try { return fs.readFileSync(arg.slice(1), "utf-8").includes(candidate.taskIncludes); }
				catch { return false; }
			})) continue;
			// Claim once without renaming a response another child may have open on Windows.
			fs.writeFileSync(`${sourcePath}.claimed`, "", { flag: "wx" });
			return candidate;
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) {
				const code = error.code;
				if (code === "ENOENT" || code === "EEXIST") continue;
			}
			throw error;
		}
	}

	const defaultPath = path.join(dir, "default-response.json");
	if (!fs.existsSync(defaultPath)) return undefined;
	return JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
}

function defaultAssistantMessage(output) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
			model: "mock/test-model",
			stopReason: "stop",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

function taskRequestsAcceptance(args) {
	for (const arg of args) {
		if (typeof arg !== "string") continue;
		if (arg.includes("## Acceptance Contract")) return true;
		if (!arg.startsWith("@")) continue;
		try {
			if (fs.readFileSync(arg.slice(1), "utf-8").includes("## Acceptance Contract")) return true;
		} catch {
			// Ignore unreadable temp prompt references in the mock harness.
		}
	}
	return false;
}

function taskIncludesOrdering(args) {
	const sentence = "Write a fenced JSON block tagged `acceptance-report` in your final text message, then call `structured_output` as your final action. Shape:";
	return args.some((arg) => {
		if (arg.includes(sentence)) return true;
		if (!arg.startsWith("@")) return false;
		try {
			return fs.readFileSync(arg.slice(1), "utf-8").includes(sentence);
		} catch {
			return false;
		}
	});
}

function defaultAcceptanceReport() {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "mock acceptance evidence" },
				{ id: "criterion-2", status: "satisfied", evidence: "mock acceptance evidence" },
			],
			changedFiles: ["mock-file.ts"],
			testsAddedOrUpdated: ["mock-file.test.ts"],
			commandsRun: [{ command: "mock validation", result: "passed", summary: "passed" }],
			validationOutput: ["mock validation passed"],
			residualRisks: [],
			noStagedFiles: true,
			reviewFindings: [],
			manualNotes: "mock run completed",
			notes: "mock run completed",
		}),
		"```",
	].join("\n");
}

function withAcceptanceReport(output, args) {
	if (!taskRequestsAcceptance(args) || output.includes("```acceptance-report")) return output;
	return `${output}\n${defaultAcceptanceReport()}`;
}

function defaultResponse() {
	return { output: "ok", exitCode: 0 };
}

function isJsonMode(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--mode") {
			return args[i + 1] === "json";
		}
	}
	return false;
}

function resolveSessionFile(args) {
	if (args.includes("--no-session")) return;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--session") continue;
		const sessionFile = args[i + 1];
		if (!sessionFile) return;
		return sessionFile;
	}
	const directoryIndex = args.indexOf("--session-dir");
	const directory = directoryIndex < 0 ? undefined : args[directoryIndex + 1];
	if (!directory) return;
	return path.join(directory, `${randomUUID()}.jsonl`);
}

async function sessionWriter(sessionFile, cwd, jsonMode) {
	if (!sessionFile) return () => {};
	let flushed = fs.existsSync(sessionFile);
	const content = flushed ? fs.readFileSync(sessionFile, "utf8") : "";
	let parentId = null;
	let header;
	for (const line of content.split("\n")) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session") header ??= entry;
			else if (typeof entry.id === "string") parentId = entry.id;
		} catch {
			// Existing fixture sentinels are retained even when they are not JSONL.
		}
	}
	if (!content) {
		header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd };
		if (flushed) fs.appendFileSync(sessionFile, `${JSON.stringify(header)}\n`);
	} else if (!content.endsWith("\n")) {
		fs.appendFileSync(sessionFile, "\n");
	}
	if (jsonMode && header) await writeJsonlLine(header);
	const pending = [header];
	return (entry) => {
		const id = entry.id ?? randomUUID();
		const saved = { id, parentId, timestamp: new Date().toISOString(), ...entry };
		parentId = id;
		if (flushed) {
			fs.appendFileSync(sessionFile, `${JSON.stringify(saved)}\n`);
			return;
		}
		pending.push(saved);
		if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
			fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
			fs.writeFileSync(sessionFile, pending.map(value => `${JSON.stringify(value)}\n`).join(""), { flag: "wx" });
			flushed = true;
		}
	};
}

async function writeStdout(text) {
	if (process.stdout.write(text)) return;
	await new Promise((resolve) => process.stdout.once("drain", resolve));
}

async function writeJsonlLine(entry) {
	const line = typeof entry === "string" ? entry : JSON.stringify(entry);
	await writeStdout(`${line}\n`);
}

function extractPlainText(entry) {
	if (!entry || typeof entry !== "object") return "";
	if (entry.type === "message_end") {
		const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
		return typeof text === "string" ? text : "";
	}
	if (entry.type === "tool_result_end") {
		const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
		return typeof text === "string" ? text : "";
	}
	return "";
}

async function writeResponseEntries(entries, jsonMode, args, persistEntry) {
	let sawProviderError = false;
	for (const entry of entries) {
		if (entry?.type === "message_end") {
			const textPart = entry.message?.content?.find?.((part) => part?.type === "text");
			const isProviderError = Boolean(entry.message?.errorMessage || entry.message?.stopReason === "error");
			if (isProviderError) sawProviderError = true;
			if (!isProviderError && textPart && typeof textPart.text === "string" && (!sawProviderError || textPart.text.trim())) {
				textPart.text = withAcceptanceReport(textPart.text, args);
			}
		}
		if (entry?.type === "message_end") {
			const message = entry.message;
			switch (message?.role) {
				case "system":
				case "user":
				case "assistant":
				case "toolResult":
					persistEntry({ type: "message", message });
					break;
				case "custom": {
					const { customType, content, display, details } = message;
					persistEntry({ type: "custom_message", customType, content, display, details });
					break;
				}
			}
		} else if (entry?.type === "entry_appended" && entry.entry) {
			persistEntry(entry.entry);
		}
		if (jsonMode) {
			await writeJsonlLine(entry);
			continue;
		}
		const text = extractPlainText(entry);
		if (text) await writeStdout(`${text}\n`);
	}
}

async function maybeWriteStructuredOutput(response, jsonMode) {
	const isError = typeof response.structuredOutputError === "string";
	if (!isError && !Object.prototype.hasOwnProperty.call(response, "structuredOutput")) return;
	const outputPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (!outputPath) return;
	const envelope = isError
		? { status: "error", message: response.structuredOutputError }
		: { status: "success", value: response.structuredOutput };
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, JSON.stringify(envelope), { encoding: "utf-8", mode: 0o600 });
	if (!jsonMode || isError) return;
	await writeJsonlLine({ type: "tool_execution_start", toolName: "structured_output", args: { value: response.structuredOutput } });
	await writeJsonlLine({
		type: "tool_result_end",
		message: {
			role: "toolResult",
			toolName: "structured_output",
			content: [{ type: "text", text: "Structured output captured." }],
		},
	});
	await writeJsonlLine({ type: "tool_execution_end", toolName: "structured_output" });
}

async function main() {
	if (!queueDir) fail("MOCK_PI_QUEUE_DIR is required.");
	if (!fs.existsSync(queueDir)) fail(`Mock queue dir does not exist: ${queueDir}`);

	const args = process.argv.slice(2);
	const jsonMode = isJsonMode(args);
	const response = claimNextResponse(queueDir, args) ?? defaultResponse();
	if (response.ignoreSigterm) process.on("SIGTERM", () => {});
	if (response.exitOnSigtermWithOpenStdout) {
		const { pidFile } = response.exitOnSigtermWithOpenStdout;
		const holder = spawn(process.execPath, ["--input-type=module", "-e", `
			const stop = () => process.exit(0);
			process.on("SIGTERM", stop);
			process.stdout.on("error", stop);
			setInterval(() => process.stdout.write("\\n"), 100);
			setTimeout(stop, 60_000);
			process.send("ready");
		`], { stdio: ["ignore", "inherit", "ignore", "ipc"] });
		fs.writeFileSync(pidFile, String(holder.pid));
		await new Promise((resolve, reject) => {
			holder.once("message", resolve);
			holder.once("error", reject);
			holder.once("exit", () => reject(new Error("stdout holder exited before readiness")));
		});
		holder.disconnect();
		holder.unref();
		process.on("SIGTERM", () => process.exit(0));
	}
	if (response.requireAcceptanceStructuredOrder && taskRequestsAcceptance(args) && !taskIncludesOrdering(args)) {
		fail("Expected report-then-structured-output ordering sentence.");
	}
	let selectedCwd = process.cwd();
	const sessionIndex = args.indexOf("--session");
	const sessionFile = sessionIndex < 0 ? undefined : args[sessionIndex + 1];
	if (sessionFile && fs.existsSync(sessionFile)) {
		try {
			const header = JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]);
			if (header?.type === "session" && typeof header.cwd === "string" && header.cwd.length > 0) selectedCwd = header.cwd;
		} catch {}
	}
	if (response.echoCwd || response.echoFiles !== undefined) {
		const observation = {};
		if (response.echoCwd) observation.cwd = fs.realpathSync.native(selectedCwd);
		if (response.echoFiles !== undefined) {
			observation.files = Object.fromEntries(response.echoFiles.map((file) => [
				file, fs.readFileSync(path.resolve(process.cwd(), file), "utf-8"),
			]));
		}
		response.output = `${response.output ?? ""}\n${JSON.stringify(observation)}`;
	}
	const persistEntry = await sessionWriter(resolveSessionFile(args), selectedCwd, jsonMode);
	for (const summary of response.sessionSummaries ?? []) persistEntry({ type: "branch_summary", ...summary });
	fs.writeFileSync(
		path.join(queueDir, `call-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`),
		JSON.stringify({ args }),
		"utf-8",
	);

	if (typeof response.delay === "number" && response.delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, response.delay));
	}

	if (response.echoRuntime) {
		const observation = {
			type: "mock_runtime",
			nodeExecPath: fs.realpathSync.native(process.execPath),
			piPackageRoot: fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")),
		};
		if (jsonMode) await writeJsonlLine(observation);
		else await writeStdout(`${JSON.stringify(observation)}\n`);
	}

	if (Array.isArray(response.steps) && response.steps.length > 0) {
		for (const step of response.steps) {
			if (typeof step?.delay === "number" && step.delay > 0) {
				await new Promise((resolve) => setTimeout(resolve, step.delay));
			}
			await maybeWriteStructuredOutput(step, false);
			if (Array.isArray(step?.jsonl) && step.jsonl.length > 0) {
				await writeResponseEntries(step.jsonl, jsonMode, args, persistEntry);
			}
			if (typeof step?.stderr === "string" && step.stderr.length > 0) {
				process.stderr.write(step.stderr);
			}
		}
	} else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
		await writeResponseEntries(response.jsonl, jsonMode, args, persistEntry);
	} else if (response.echoAgentSettings) {
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
		const settings = fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8");
		await writeResponseEntries([defaultAssistantMessage(settings)], jsonMode, args, persistEntry);
	} else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
		const envSnapshot = Object.fromEntries(response.echoEnv.map((key) => [key, process.env[key] ?? null]));
		await writeResponseEntries([defaultAssistantMessage(JSON.stringify(envSnapshot))], jsonMode, args, persistEntry);
	} else if (typeof response.output === "string") {
		const entry = defaultAssistantMessage(response.output);
		await writeResponseEntries([entry], jsonMode, args, persistEntry);
		if (!jsonMode && entry.message.content[0].text === "") await writeStdout("\n");
	}
	await maybeWriteStructuredOutput(response, jsonMode);

	if (typeof response.stderr === "string" && response.stderr.length > 0) {
		process.stderr.write(response.stderr);
	}

	if (typeof response.keepAliveAfterFinalMessageMs === "number" && response.keepAliveAfterFinalMessageMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, response.keepAliveAfterFinalMessageMs));
	}

	process.exit(typeof response.exitCode === "number" ? response.exitCode : 0);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
