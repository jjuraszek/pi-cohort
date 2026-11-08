import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, "../..");

it("excludes structured_output from a real child's script namespace but captures its direct call", async () => {
	const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const packageRoot = path.resolve(path.dirname(fileURLToPath(sdkUrl)), "..");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
	const realPiEntry = fs.realpathSync.native(path.resolve(packageRoot, manifest.bin.pi));
	const originalEnv = { ...process.env };
	const originalArgv = [...process.argv];
	const originalCwd = process.cwd();
	const tempDir = createTempDir("pi-structured-output-");
	const shutdown: Array<() => unknown> = [];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	try {
		const profile = path.join(tempDir, "profile");
		fs.mkdirSync(profile);
		process.chdir(tempDir);
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
		}
		process.env.HOME = profile;
		process.env.USERPROFILE = profile;
		process.env.PI_CODING_AGENT_DIR = profile;
		process.env.PI_OFFLINE = "1";
		process.env.PATH = `${originalEnv.PI_TEST_PI_BIN_DIR ?? path.join(projectRoot, "node_modules/.bin")}${path.delimiter}${originalEnv.PATH ?? ""}`;
		process.argv[1] = realPiEntry;
		fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
		const fixtures = path.join(dirname, "fixtures/structured-output-model-only");
		for (const [directory, name] of [["extensions", "provider.ts"], ["agents", "worker.md"]]) {
			const target = path.join(tempDir, ".pi", directory);
			fs.mkdirSync(target, { recursive: true });
			fs.copyFileSync(path.join(fixtures, name), path.join(target, name));
		}
		let tool;
		registerSubagentExtension(new Proxy({
			events: createEventBus(),
			registerTool(registered) { tool = registered; },
			on(event, handler) { if (event === "session_shutdown") shutdown.push(handler); },
			registerCommand() {},
			registerShortcut() {},
			registerMessageRenderer() {},
			getSessionName() { return undefined; },
		}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } }));
		assert.ok(tool, "depth-0 parent must register subagent");
		const value = { ok: true, note: "direct capture" };
		const result = await tool.execute("fixture-dispatch", {
			chain: [{ agent: "structured-worker", task: "Run the structured output fixture.", outputSchema: {
				type: "object",
				properties: { ok: { type: "boolean" }, note: { type: "string" } },
				required: ["ok", "note"],
				additionalProperties: false,
			}, acceptance: { level: "none", reason: "Observe tool reachability, not implementation acceptance" } }],
			async: false,
		}, controller.signal, () => {}, makeMinimalCtx(tempDir));
		assert.equal(result.details.results.length, 1);
		const child = result.details.results[0];
		assert.ok(child.sessionFile, "child must retain its session file");
		const messages = fs.readFileSync(child.sessionFile, "utf-8").trim().split("\n")
			.map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);
		const scriptIndex = messages.findIndex((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.ok(scriptIndex >= 0, "session must contain the codemode result");
		const scriptResult = messages[scriptIndex];
		assert.match(scriptResult.content.map((part) => part.text ?? "").join("\n"), /tools\.structured_output does not exist/);
		assert.equal(scriptResult.isError, true);
		assert.deepEqual(scriptResult.details.calls, [], "the script cannot call the capture writer");
		const directCalls = messages.flatMap((message, index) => message.role === "assistant"
			? message.content.filter((part) => part.type === "toolCall" && part.name === "structured_output").map((call) => ({ index, call })) : []);
		assert.equal(directCalls.length, 1, "only the later direct call may write the capture");
		assert.ok(directCalls[0].index > scriptIndex, "no structured_output call precedes the script error");
		assert.deepEqual(directCalls[0].call.arguments, { value });
		const directIndex = messages.findIndex((message) => message.role === "toolResult" && message.toolCallId === directCalls[0].call.id);
		assert.ok(directIndex > directCalls[0].index, "direct result follows its call");
		assert.equal(messages[directIndex].isError, false);
		assert.match(messages[directIndex].content.map((part) => part.text ?? "").join("\n"), /Structured output captured/);
		assert.deepEqual(JSON.parse(fs.readFileSync(messages[directIndex].details.path, "utf-8")), { status: "success", value });
		assert.equal(child.exitCode, 0, child.error);
		assert.equal(result.isError, undefined);
		assert.deepEqual(child.structuredOutput, value);
	} finally {
		clearTimeout(timer);
		try {
			for (const handler of shutdown) await handler();
		} finally {
			process.chdir(originalCwd);
			process.argv = originalArgv;
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, originalEnv);
			removeTempDir(tempDir);
		}
	}
});
