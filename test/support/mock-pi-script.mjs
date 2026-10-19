import fs from "node:fs";
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

function claimNextResponse(dir) {
	for (const fileName of listPendingFiles(dir)) {
		const sourcePath = path.join(dir, fileName);
		const targetPath = path.join(dir, fileName.replace(/^pending-/, "consumed-"));
		try {
			fs.renameSync(sourcePath, targetPath);
			return JSON.parse(fs.readFileSync(targetPath, "utf-8"));
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

function writeSessionFile(args) {
	if (args.includes("--no-session")) return;
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--session") continue;
		const sessionFile = args[i + 1];
		if (!sessionFile) return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "", { flag: "a" });
		return sessionFile;
	}
	const directoryIndex = args.indexOf("--session-dir");
	const directory = directoryIndex < 0 ? undefined : args[directoryIndex + 1];
	if (!directory) return;
	fs.mkdirSync(directory, { recursive: true });
	const sessionFile = path.join(directory, `${randomUUID()}.jsonl`);
	fs.writeFileSync(sessionFile, "", { flag: "wx" });
	return sessionFile;
}

function sessionWriter(sessionFile) {
	if (!sessionFile) return () => {};
	const content = fs.readFileSync(sessionFile, "utf8");
	let parentId = null;
	for (const line of content.split("\n")) {
		try {
			const entry = JSON.parse(line);
			if (entry.type !== "session" && typeof entry.id === "string") parentId = entry.id;
		} catch {
			// Existing fixture sentinels are retained even when they are not JSONL.
		}
	}
	if (!content) {
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
	} else if (!content.endsWith("\n")) {
		fs.appendFileSync(sessionFile, "\n");
	}
	return (message) => {
		const id = randomUUID();
		fs.appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message })}\n`);
		parentId = id;
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

async function writeResponseEntries(entries, jsonMode, args, persistMessage) {
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
		if (entry?.type === "message_end" && entry.message?.role === "assistant") persistMessage(entry.message);
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
	const response = claimNextResponse(queueDir) ?? defaultResponse();
	if (response.requireAcceptanceStructuredOrder && taskRequestsAcceptance(args) && !taskIncludesOrdering(args)) {
		fail("Expected report-then-structured-output ordering sentence.");
	}
	if (response.echoCwd || response.echoFiles !== undefined) {
		const observation = {};
		if (response.echoCwd) observation.cwd = process.cwd();
		if (response.echoFiles !== undefined) {
			observation.files = Object.fromEntries(response.echoFiles.map((file) => [
				file, fs.readFileSync(path.resolve(process.cwd(), file), "utf-8"),
			]));
		}
		response.output = `${response.output ?? ""}\n${JSON.stringify(observation)}`;
	}
	const persistMessage = sessionWriter(writeSessionFile(args));
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
				await writeResponseEntries(step.jsonl, jsonMode, args, persistMessage);
			}
			if (typeof step?.stderr === "string" && step.stderr.length > 0) {
				process.stderr.write(step.stderr);
			}
		}
	} else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
		await writeResponseEntries(response.jsonl, jsonMode, args, persistMessage);
	} else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
		const envSnapshot = Object.fromEntries(response.echoEnv.map((key) => [key, process.env[key] ?? null]));
		await writeResponseEntries([defaultAssistantMessage(JSON.stringify(envSnapshot))], jsonMode, args, persistMessage);
	} else if (typeof response.output === "string") {
		const entry = defaultAssistantMessage(response.output);
		await writeResponseEntries([entry], jsonMode, args, persistMessage);
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
