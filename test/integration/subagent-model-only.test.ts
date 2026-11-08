import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentParams } from "../../src/extension/schemas.ts";
import type { Details } from "../../src/shared/types.ts";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const caseMode = process.argv[2];
assert.ok(caseMode === undefined || caseMode === "on" || caseMode === "only");
const fixtures = fileURLToPath(new URL("./fixtures/subagent-model-only/", import.meta.url));
const piRoot = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const piManifest = JSON.parse(fs.readFileSync(path.join(piRoot, "package.json"), "utf8"));

function readJsonl(file: string) {
	return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sessionMessages(file: string) {
	return readJsonl(file).filter((entry) => entry.type === "message").map((entry) => entry.message);
}

function textOf(message: { content: Array<{ text?: string }> }) {
	return message.content.map((part) => part.text ?? "").join("\n");
}

// Cohort pins its agent directory at import time; each mode needs a fresh process.
if (!caseMode) {
	describe("subagent is direct-only in a real offline Pi child", () => {
		for (const mode of ["on", "only"] as const) {
			it(`preserves direct dispatch in codemode ${mode} mode`, () => {
				execFileSync(process.execPath, [
					"--import", fileURLToPath(new URL("../support/register-loader.mjs", import.meta.url)),
					fileURLToPath(import.meta.url), mode,
				], { env: { ...process.env, PI_OFFLINE: "1" }, stdio: "pipe" });
			});
		}
	});
} else describe(`offline codemode ${caseMode} fixture`, () => {
	let tempDir: string;
	let originalCwd: string;
	let originalArgv1: string | undefined;
	let environment: NodeJS.ProcessEnv;

	beforeEach(() => {
		environment = { ...process.env };
		originalCwd = process.cwd();
		originalArgv1 = process.argv[1];
		tempDir = createTempDir("pi-subagent-model-only-");
		const home = path.join(tempDir, "home");
		const profile = path.join(home, ".pi", "agent");
		fs.mkdirSync(profile, { recursive: true });
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
		}
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_CODING_AGENT_DIR = profile;
		process.env.PI_OFFLINE = "1";
		process.env.SUBAGENT_FIXTURE_LOG = path.join(profile, "requests.jsonl");
		process.argv[1] = fs.realpathSync.native(path.join(piRoot, piManifest.bin.pi));
		process.chdir(tempDir);
		new ProjectTrustStore(profile).set(tempDir, true);
		fs.mkdirSync(path.join(tempDir, ".pi", "extensions"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, ".pi", "agents"));
		fs.copyFileSync(path.join(fixtures, "provider.ts"), path.join(tempDir, ".pi", "extensions", "provider.ts"));
		for (const agent of ["lead", "leaf"]) {
			fs.copyFileSync(path.join(fixtures, `${agent}.md`), path.join(tempDir, ".pi", "agents", `${agent}.md`));
		}
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.argv[1] = originalArgv1;
		for (const key of Object.keys(process.env)) {
			if (!(key in environment)) delete process.env[key];
		}
		Object.assign(process.env, environment);
		removeTempDir(tempDir);
	});

	it(`rejects scripted dispatch and preserves direct progress in codemode ${caseMode} mode`, async () => {
		process.env.SUBAGENT_FIXTURE_CODEMODE_MODE = caseMode;
		const profile = process.env.PI_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		const { default: registerSubagentExtension } = await import("../../src/extension/index.ts");
		const { findNestedRouteForRootId, projectNestedEvents, NESTED_EVENTS_DIR } = await import("../../src/runs/shared/nested-events.ts");
		process.env.PI_CODING_AGENT_DIR = profile;
		let tool: ToolDefinition<typeof SubagentParams, Details> | undefined;
		registerSubagentExtension(new Proxy({
			events: createEventBus(),
			registerTool(registered: ToolDefinition<typeof SubagentParams, Details>) { if (registered.name === "subagent") tool = registered; },
			getSessionName() { return undefined; },
		}, { get(target, key) { return key in target ? target[key as keyof typeof target] : () => undefined; } }) as ExtensionAPI);
		assert.ok(tool, "parent subagent registration is required");
		const snapshots: Details[] = [];
		const result = await tool.execute("root-dispatch", { agent: "lead", task: "Exercise scripted and direct leaf dispatch.", async: false },
			new AbortController().signal,
			(update) => { if (update.details) snapshots.push(structuredClone(update.details)); },
			makeMinimalCtx(tempDir) as Parameters<typeof tool.execute>[4]);
		assert.ok(!result.isError, JSON.stringify(result));
		assert.match(textOf(result), /FIXTURE_DONE/);
		assert.equal(result.details?.results.length, 1);
		const lead = result.details!.results[0];
		assert.equal(lead.agent, "lead");
		assert.equal(lead.exitCode, 0);
		assert.ok(lead.sessionFile);
		const messages = sessionMessages(lead.sessionFile);
		const calls = messages.flatMap((message, index) => message.role === "assistant"
			? message.content.filter((part) => part.type === "toolCall").map((call) => ({ ...call, index })) : []);
		assert.deepEqual(calls.map((call) => call.name), ["codemode", "subagent"]);
		const scriptResults = messages.filter((message) => message.role === "toolResult" && message.toolName === "codemode");
		assert.equal(scriptResults.length, 1);
		const rejected = scriptResults[0];
		assert.equal(rejected.isError, true);
		assert.match(textOf(rejected), /tools\.subagent does not exist/);
		assert.deepEqual(rejected.details.calls, []);
		assert.equal(rejected.details.runId, undefined);
		assert.equal(rejected.details.results, undefined);
		assert.equal(rejected.details.progress, undefined);
		assert.equal(rejected.details.sessionFile, undefined);
		assert.ok(calls[0].index < messages.indexOf(rejected));
		assert.ok(calls[1].index > messages.indexOf(rejected), "direct dispatch follows script rejection");
		const directResults = messages.filter((message) => message.role === "toolResult" && message.toolName === "subagent");
		assert.equal(directResults.length, 1);
		const direct = directResults[0];
		assert.ok(!direct.isError, JSON.stringify(direct));
		assert.equal(direct.toolCallId, calls[1].id);
		assert.equal(direct.details.results.length, 1);
		const leaf = direct.details.results[0];
		assert.equal(leaf.agent, "leaf");
		assert.equal(leaf.exitCode, 0);
		assert.notEqual(leaf.interrupted, true);
		assert.ok(leaf.sessionFile);
		assert.ok(fs.existsSync(leaf.sessionFile));
		assert.ok(snapshots.some((snapshot) => snapshot.progress?.some((progress) =>
			progress.currentTool === "subagent" && JSON.stringify(progress.currentToolArgs).includes("leaf"))),
			"parent receives the lead's live leaf-dispatch tool line");
		const route = findNestedRouteForRootId(result.details!.runId!);
		assert.ok(route, "parent run has a nested-event route");
		assert.equal(path.dirname(path.dirname(route.eventSink)), NESTED_EVENTS_DIR);
		const children = projectNestedEvents(route).children;
		assert.equal(children.length, 1, "script attempt creates no phantom nested child");
		assert.equal(children[0].agent, "leaf");
		assert.equal(children[0].parentRunId, result.details!.runId);
		const sessionRoot = path.dirname(lead.sessionFile);
		const leafSessions = fs.readdirSync(sessionRoot, { recursive: true }).map((file) => path.join(sessionRoot, String(file)))
			.filter((file) => file.endsWith(".jsonl") && file !== lead.sessionFile)
			.filter((file) => readJsonl(file)[0]?.type === "session");
		assert.deepEqual(leafSessions, [leaf.sessionFile], "only the direct call creates a leaf session");
		assert.ok(sessionMessages(leaf.sessionFile).some((message) =>
			message.role === "assistant" && textOf(message) === "LEAF_DONE"));
		const requests = readJsonl(process.env.SUBAGENT_FIXTURE_LOG!);
		const leadRequests = requests.filter((row) => row.depth === "1");
		assert.deepEqual(leadRequests.map((row) => row.decision), ["script", "direct", "finish"]);
		assert.ok(leadRequests.every((row) => row.declaredSubagent === true),
			"subagent stays declared on every lead request, including in only mode");
		assert.equal(requests.filter((row) => row.depth === "2").length, 1);
	});
});
