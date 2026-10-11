import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from "node:test";
import { createMockPi } from "../support/mock-pi.ts";
import { capturePiRuntime } from "../../src/runs/shared/pi-spawn.ts";

const exec = promisify(execFile);
const native = fs.realpathSync.native;

it("isolates home and temporary roots before imports without replacing an explicit profile", async () => {
	const preload = pathToFileURL(fileURLToPath(new URL("../support/isolate-test-env.mjs", import.meta.url))).href;
	const profile = path.join(process.env.HOME!, "selected-profile");
	fs.mkdirSync(profile);
	fs.writeFileSync(path.join(profile, "sentinel"), "retained");
	const inheritedTemp = path.join(process.env.TMPDIR!, "long-inherited-temp-" + "x".repeat(80));
	fs.mkdirSync(inheritedTemp);
	const script = `
		const { execFileSync } = require("node:child_process");
		const worker = JSON.parse(execFileSync(process.execPath,
			["--import", ${JSON.stringify(preload)}, "-e", "console.log(JSON.stringify(process.env))"],
			{ encoding: "utf8", timeout: 5000 }));
		console.log(JSON.stringify([process.env, worker]));
	`;
	const { stdout } = await exec(process.execPath, ["--import", preload, "-e", script], {
		timeout: 10000,
		env: { ...process.env, TMPDIR: inheritedTemp, TEMP: inheritedTemp, TMP: inheritedTemp, PI_CODING_AGENT_DIR: profile },
	});
	const environments = JSON.parse(stdout);
	try {
		assert.notEqual(environments[0].HOME, environments[1].HOME);
		const controller = fs.readFileSync(new URL("../../src/execution-backend/child-host-controller.ts", import.meta.url), "utf8");
		const hostPrefix = controller.match(/mkdtempSync\(path.join\(os.tmpdir\(\), "([^"]+)"\)\)/)![1];
		const socketName = controller.match(/socketPath = path.join\(directory, "([^"]+)"\)/)![1];
		const socketLimit = Number(controller.match(/Buffer.byteLength\(socketPath\) >= (\d+)/)![1]);
		for (const env of environments) {
			assert.notEqual(env.HOME, process.env.HOME);
			assert.equal(env.USERPROFILE, env.HOME);
			assert.equal(env.TEMP, env.TMPDIR);
			assert.equal(env.TMP, env.TMPDIR);
			assert.equal(path.dirname(env.HOME), path.dirname(env.TMPDIR));
			assert.ok(fs.statSync(env.HOME).isDirectory());
			assert.ok(fs.statSync(env.TMPDIR).isDirectory());
			assert.equal(env.PI_CODING_AGENT_DIR, profile);
			if (process.platform !== "win32") {
				const hostDirectory = fs.mkdtempSync(path.join(env.TMPDIR, hostPrefix));
				assert.ok(Buffer.byteLength(path.join(hostDirectory, socketName)) < socketLimit,
					"isolated temp leaves room for the production host socket");
				assert.equal(path.dirname(path.dirname(env.HOME)), "/tmp");
			}
		}
		assert.equal(fs.readFileSync(path.join(profile, "sentinel"), "utf8"), "retained");
	} finally {
		for (const env of environments) fs.rmSync(path.dirname(env.HOME), { recursive: true, force: true });
		fs.rmSync(inheritedTemp, { recursive: true, force: true });
		fs.rmSync(profile, { recursive: true, force: true });
	}
});

it("captures a manifest-backed fixture and observes real child identity with normal JSONL", async () => {
	const mock = createMockPi();
	mock.install();
	try {
		const runtime = mock.captureRuntime();
		assert.deepEqual(mock.runtime, runtime);
		assert.deepEqual(capturePiRuntime({ execPath: process.execPath, argv1: runtime.piEntryPath }), runtime);
		assert.equal(runtime.nodeExecPath, native(process.execPath));
		assert.equal(runtime.piPackageRoot, native(runtime.piPackageRoot));
		const pkg = JSON.parse(fs.readFileSync(path.join(runtime.piPackageRoot, "package.json"), "utf8"));
		assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
		assert.equal(native(path.resolve(runtime.piPackageRoot, pkg.bin.pi)), runtime.piEntryPath);
		const require = createRequire(runtime.piEntryPath);
		for (const dependency of ["jiti", "typebox"]) assert.ok(fs.existsSync(require.resolve(dependency)));
		mock.onCall({ echoRuntime: true, output: "normal final output" });
		const { stdout } = await exec(runtime.nodeExecPath, [runtime.piEntryPath, "--mode", "json"], { timeout: 5000 });
		const entries = stdout.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(entries[0], { type: "mock_runtime", nodeExecPath: runtime.nodeExecPath, piPackageRoot: runtime.piPackageRoot });
		assert.equal(entries[1].type, "message_end");
		assert.equal(entries[1].message.content[0].text, "normal final output");
		assert.equal(mock.callCount(), 1);
	} finally {
		mock.uninstall();
	}
});

it("preserves queue order, fallback, sessions, echoEnv, custom JSONL, and acceptance reports", async () => {
	const mock = createMockPi();
	mock.install();
	try {
		const runtime = mock.captureRuntime();
		const launch = async (args: string[] = []) => (await exec(runtime.nodeExecPath, [runtime.piEntryPath, "--mode", "json", ...args], { timeout: 5000 })).stdout.trim().split("\n").map((line) => JSON.parse(line));
		const session = path.join(mock.dir, "sessions", "child.jsonl");
		mock.onCall({ echoEnv: ["MOCK_PI_QUEUE_DIR", "MOCK_MISSING_ENV"], delay: 1 });
		mock.onCall({ jsonl: [{ type: "custom", value: 7 }], stderr: "diagnostic" });
		const first = await launch(["--session", session]);
		assert.deepEqual(JSON.parse(first[0].message.content[0].text), { MOCK_PI_QUEUE_DIR: mock.dir, MOCK_MISSING_ENV: null });
		const persisted = fs.readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(persisted[0].type, "session");
		assert.equal(persisted[0].version, 3);
		assert.equal(persisted[1].type, "message");
		assert.equal(persisted[1].parentId, null);
		assert.ok(persisted[1].id);
		assert.ok(Number.isFinite(Date.parse(persisted[1].timestamp)));
		assert.deepEqual(persisted[1].message, first[0].message);
		assert.deepEqual(await launch(), [{ type: "custom", value: 7 }]);
		assert.deepEqual(await launch(), [{ type: "custom", value: 7 }]);
		assert.equal(mock.callCount(), 3);
		mock.reset();
		assert.equal(mock.callCount(), 0);
		mock.onCall({ output: "accepted" });
		assert.match((await launch(["## Acceptance Contract"]))[0].message.content[0].text, /accepted\n```acceptance-report/);
	} finally {
		mock.uninstall();
	}
});

it("persists discoverable unique session-dir files without replacing existing sessions", async () => {
	const mock = createMockPi();
	mock.install();
	try {
		const runtime = mock.captureRuntime();
		const directory = path.join(mock.dir, "fresh-sessions");
		const launch = () => exec(runtime.nodeExecPath, [runtime.piEntryPath, "--session-dir", directory], { timeout: 5000 });
		const { stdout } = await launch();
		const discover = () => fs.readdirSync(directory).filter((name) => name.endsWith(".jsonl") && fs.statSync(path.join(directory, name)).isFile());
		const first = discover();
		assert.equal(first.length, 1);
		const original = fs.readFileSync(path.join(directory, first[0]), "utf8");
		const entries = original.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(entries[0].type, "session");
		assert.equal(entries[1].message.content[0].text + "\n", stdout);
		assert.equal(entries[1].message.usage.input, 100);
		assert.equal(entries[1].message.usage.output, 50);
		await launch();
		const second = discover();
		assert.equal(second.length, 2);
		assert.equal(fs.readFileSync(path.join(directory, first[0]), "utf8"), original);
		const next = fs.readFileSync(path.join(directory, second.find((name) => name !== first[0])!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(next[1].message, entries[1].message);
		assert.notEqual(next[0].id, entries[0].id);
		mock.onCall({ output: "" });
		assert.equal((await launch()).stdout, "\n");
	} finally {
		mock.uninstall();
	}
});

for (const scenario of [
	{ name: "explicit file takes precedence and preserves content", noSession: false },
	{ name: "no-session prevents explicit and directory persistence", noSession: true },
]) {
	it(scenario.name, async () => {
		const mock = createMockPi();
		mock.install();
		try {
			const runtime = mock.captureRuntime();
			const directory = path.join(mock.dir, "unused-sessions");
			const session = path.join(mock.dir, "existing.jsonl");
			fs.writeFileSync(session, "retained\n");
			const launch = (args: string[]) => exec(runtime.nodeExecPath, [runtime.piEntryPath, ...args], { timeout: 5000 });
			const flags = scenario.noSession ? ["--no-session"] : [];
			await launch(["--session-dir", directory, "--session", session, ...flags]);
			const content = fs.readFileSync(session, "utf8");
			assert.ok(content.startsWith("retained\n"));
			if (scenario.noSession) assert.equal(content, "retained\n");
			else assert.equal(JSON.parse(content.slice("retained\n".length)).message.content[0].text, "ok");
			assert.equal(fs.existsSync(directory), false);
			if (scenario.noSession) {
				await launch(["--session-dir", directory, "--no-session"]);
				await launch(["--session", path.join(directory, "disabled.jsonl"), "--no-session"]);
				assert.equal(fs.existsSync(directory), false);
			}
		} finally {
			mock.uninstall();
		}
	});
}

for (const stepped of [false, true]) {
	it(`persists ${stepped ? "stepped" : "custom"} assistant messages and usage while appending`, async () => {
		const mock = createMockPi();
		mock.install();
		try {
			const runtime = mock.captureRuntime();
			const session = path.join(mock.dir, "responses.jsonl");
			const messages = [11, 23].map((input) => ({
				type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `used ${input}` }],
					usage: { input, output: 3, cacheRead: 5, cacheWrite: 7, cost: { total: 0.02 } } },
			}));
			const entries = [{ type: "custom", value: 7 }, ...messages];
			mock.onCall(stepped ? { steps: entries.map((entry) => ({ jsonl: [entry] })) } : { jsonl: entries });
			const launch = () => exec(runtime.nodeExecPath, [runtime.piEntryPath, "--mode", "json", "--session", session, "## Acceptance Contract"], { timeout: 5000 });
			const emitted = JSON.parse(`[${(await launch()).stdout.trim().split("\n").join(",")}]`);
			const original = fs.readFileSync(session, "utf8");
			await launch();
			assert.ok(fs.readFileSync(session, "utf8").startsWith(original));
			const persisted = fs.readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(persisted.length, 5);
			assert.deepEqual(persisted.slice(1).map((entry) => entry.message), [...emitted.slice(1), ...emitted.slice(1)].map((entry) => entry.message));
			for (let i = 1; i < persisted.length; i++) {
				assert.equal(persisted[i].type, "message");
				assert.equal(persisted[i].parentId, i === 1 ? null : persisted[i - 1].id);
			}
		} finally {
			mock.uninstall();
		}
	});
}

it("restores per-instance environment and argv after children exit", async () => {
	const before = { PATH: process.env.PATH, queue: process.env.MOCK_PI_QUEUE_DIR, argv1: process.argv[1] };
	const mock = createMockPi();
	mock.install();
	mock.install();
	assert.equal(process.argv[1], before.argv1);
	try {
		const runtime = mock.captureRuntime();
		mock.onCall({ output: "done" });
		await exec(runtime.nodeExecPath, [runtime.piEntryPath], { timeout: 5000 });
	} finally {
		mock.uninstall();
		mock.uninstall();
	}
	assert.deepEqual({ PATH: process.env.PATH, queue: process.env.MOCK_PI_QUEUE_DIR, argv1: process.argv[1] }, before);
	assert.equal(fs.existsSync(mock.dir), false);
});
