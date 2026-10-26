/**
 * Real child startup with inherited and allowlisted extensions. Before index.ts
 * stops registering in child mode, lead-omitted fails with "conflicts with";
 * after deletion it calls the inherited ping tool and delegates to worker.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { discoverAgents } from "../../src/agents/agents.ts";
import { buildPiArgs } from "../../src/runs/shared/pi-args.ts";
import { createEventBus, createTempDir, makeMinimalCtx, removeTempDir } from "../support/helpers.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dirname, "../..");
let realPiEntry: string | undefined;
let sdkUrl: string | undefined;
try {
	sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
	const packageRoot = path.resolve(path.dirname(fileURLToPath(sdkUrl)), "..");
	const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
	const entry = path.resolve(packageRoot, manifest.bin.pi);
	if (fs.existsSync(entry)) realPiEntry = entry;
} catch (error) {
	if (error.code !== "ERR_MODULE_NOT_FOUND" && error.code !== "ENOENT") throw error;
}

describe("fanout children inherit extensions without duplicate tool ownership", { skip: !realPiEntry ? "real pi binary unavailable" : undefined }, () => {
	let tempDir: string;
	let profile: string;
	let originalCwd: string;
	let originalEnv: NodeJS.ProcessEnv;
	let originalArgv: string[];
	let shutdown: Array<() => unknown>;
	let tool;

	beforeEach(() => {
		originalEnv = { ...process.env };
		originalArgv = [...process.argv];
		originalCwd = process.cwd();
		tempDir = createTempDir("pi-fanout-inherit-");
		profile = path.join(tempDir, "profile");
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
		process.argv[1] = fs.realpathSync.native(realPiEntry!);
		fs.writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
			defaultProjectTrust: "always",
			packages: [path.join(projectRoot, "src/extension/index.ts")],
		}));
		const fixtures = path.join(dirname, "fixtures/fanout-child-inherit-extensions");
		for (const [directory, names] of [
			["extensions", ["provider.ts", "ping-fixture.ts"]],
			["agents", ["lead-omitted.md", "lead-allowlist.md", "lead-empty.md", "worker.md", "plain.md"]],
		] as const) {
			const target = path.join(tempDir, ".pi", directory);
			fs.mkdirSync(target, { recursive: true });
			for (const name of names) fs.copyFileSync(path.join(fixtures, name), path.join(target, name));
		}
		shutdown = [];
		tool = undefined;
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
	});

	afterEach(async () => {
		try {
			for (const handler of shutdown) await handler();
		} finally {
			process.chdir(originalCwd);
			process.argv = originalArgv;
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, originalEnv);
			removeTempDir(tempDir);
		}
	});

	for (const agent of ["lead-omitted", "lead-allowlist", "plain"]) {
		it(`starts ${agent} through the depth-0 parent`, async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 45_000);
			try {
				const result = await tool.execute("fixture-dispatch", { agent, task: "Run the fixture.", async: false }, controller.signal, () => {}, makeMinimalCtx(tempDir));
				const text = result.content.map((part) => part.text ?? "").join("\n");
				assert.doesNotMatch(text, /conflicts with/);
				assert.equal(result.isError, undefined, text);
				assert.match(text, /FIXTURE_DONE/);
				if (agent === "lead-omitted") assert.match(text, /ping=pong/);
				if (agent !== "plain") assert.match(text, /worker=WORKER_TOKEN/);
				const inventory = /tools=([^\s]*)/.exec(text);
				assert.ok(inventory, text);
				const names = inventory[1].split(",");
				if (agent === "plain") assert.ok(!names.includes("subagent"), text);
				if (agent === "lead-omitted") {
					for (const name of ["read", "bash", "subagent", "ping_fixture"]) assert.ok(names.includes(name), text);
				}
			} finally {
				clearTimeout(timer);
			}
		});
	}

	it("configures subagent with an empty extension allowlist before any model turn", () => {
		const persona = discoverAgents(tempDir, "project").agents.find((agent) => agent.name === "lead-empty");
		assert.ok(persona);
		assert.deepEqual(persona.extensions, []);
		const built = buildPiArgs({
			baseArgs: ["-p", "--mode", "json", "--offline"],
			task: "Startup inventory only.",
			sessionEnabled: false,
			inheritProjectContext: false,
			inheritSkills: false,
			tools: persona.tools,
			extensions: persona.extensions,
			cwd: tempDir,
			model: "startup-fixture/inventory",
		});
		assert.ok(built.args.includes("--no-extensions"));
		assert.ok(!built.args.includes("[]"));
		fs.writeFileSync(path.join(profile, "models.json"), JSON.stringify({ providers: {
			"startup-fixture": { baseUrl: "http://127.0.0.1:9/never-contacted", api: "openai-completions", apiKey: "fixture-no-credential", models: [{ id: "inventory" }] },
		} }));
		const preload = path.join(tempDir, "inventory.mjs");
		const bundleDir = path.dirname(fs.realpathSync.native(realPiEntry!));
		const cliSource = fs.readFileSync(realPiEntry!, "utf-8");
		assert.match(cliSource, /["']\.\/cli-runtime\.js["']/);
		const runtimeSource = fs.readFileSync(path.join(bundleDir, "cli-runtime.js"), "utf-8");
		const bundledSdk = fs.realpathSync.native(path.join(bundleDir, "index.js"));
		const sdkSource = fs.readFileSync(bundledSdk, "utf-8");
		const namedImport = (source: string, name: string) => {
			const imports = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)];
			const found = imports.find((match) => match[1].split(",").some((item) => item.trim() === name));
			assert.ok(found, `missing named import ${name}`);
			return fs.realpathSync.native(path.resolve(bundleDir, found[2]));
		};
		const sharedChunk = namedImport(runtimeSource, "main");
		assert.equal(namedImport(sdkSource, "AgentSession"), sharedChunk);
		const sessionUrl = pathToFileURL(bundledSdk).href;
		const chunkUrl = pathToFileURL(sharedChunk).href;
		fs.writeFileSync(preload, `import { AgentSession } from ${JSON.stringify(sessionUrl)};
import { AgentSession as SharedAgentSession } from ${JSON.stringify(chunkUrl)};
import assert from "node:assert/strict";
import { writeSync } from "node:fs";
assert.equal(AgentSession, SharedAgentSession);
assert.equal(typeof AgentSession.prototype.bindExtensions, "function");
assert.equal(typeof AgentSession.prototype.getActiveToolNames, "function");
const original = AgentSession.prototype.bindExtensions;
AgentSession.prototype.bindExtensions = async function(options) {
	await original.call(this, options);
	writeSync(1, JSON.stringify({type:"fixture-inventory", tools:this.getActiveToolNames()}) + "\\n");
	process.exit(0);
};
`);
		const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, realPiEntry!, ...built.args], {
			cwd: tempDir,
			env: { ...process.env, ...built.env, PI_SUBAGENT_DEPTH: "1" },
			encoding: "utf-8", timeout: 20_000, maxBuffer: 1024 * 1024,
		});
		const output = result.stdout + result.stderr;
		assert.doesNotMatch(output, /conflicts with/);
		assert.equal(result.status, 0, output);
		const rows = result.stdout.split("\n").filter((line) => line.startsWith('{"type":"fixture-inventory"')).map((line) => JSON.parse(line));
		assert.equal(rows.length, 1, output);
		assert.ok(rows[0].tools.includes("subagent"), output);
	});
});
