import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createMockPi, type MockPi } from "../support/mock-pi.ts";
import { createTempDir, removeTempDir } from "../support/helpers.ts";

const REPLY = "SDK_HOST_DONE"; // the fixed text test/integration/fixtures/sdk-host/provider.ts answers with

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "..", "..");
const hostSource = path.join(repo, "test/support/sdk-host-parent.mjs");
const providerPath = path.join(__dirname, "fixtures", "sdk-host", "provider.ts");
// Install A: the pi package the executor's import graph resolves to from this repo.
const loadedPiRoot = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), ".."));

function owningPackageRoot(entry: string): string {
	let dir = path.dirname(entry);
	while (!fs.existsSync(path.join(dir, "package.json"))) {
		assert.notEqual(dir, path.dirname(dir), `${entry}: no package.json above it`);
		dir = path.dirname(dir);
	}
	return dir;
}

describe("SDK-hosted session resolves the Pi installation it loaded", () => {
	let tempDir = "";
	let hostDir = "";
	let B: MockPi;
	let sequence = 0;

	beforeEach(() => {
		tempDir = fs.realpathSync.native(createTempDir("pi-sdk-host-"));
		hostDir = path.join(tempDir, "sdk-host");
		fs.mkdirSync(hostDir);
		fs.writeFileSync(path.join(hostDir, "package.json"), JSON.stringify({ name: "@test/sdk-host", type: "module" }));
		fs.copyFileSync(hostSource, path.join(hostDir, "host.mjs"));
		B = createMockPi();
		B.install();
	});

	afterEach(() => {
		B.uninstall();
		removeTempDir(tempDir);
	});

	function runHost(agent: Record<string, unknown>, extra: { renameAfterCapture?: string; env?: Record<string, string> } = {}) {
		const output = path.join(tempDir, `result-${++sequence}.json`);
		const requestPath = path.join(tempDir, `request-${sequence}.json`);
		fs.writeFileSync(requestPath, JSON.stringify({ cwd: tempDir, task: "Reply with the fixture text.", agent, output, renameAfterCapture: extra.renameAfterCapture }));
		const profile = path.join(tempDir, "profile");
		fs.mkdirSync(profile, { recursive: true });
		const env: Record<string, string | undefined> = { ...process.env, RUNTIME_TEST_REPO: repo, HOME: profile, USERPROFILE: profile, PI_CODING_AGENT_DIR: profile, SDK_HOST_LOG: path.join(tempDir, "child.jsonl") };
		delete env.PI_PACKAGE_DIR;
		Object.assign(env, extra.env);
		const run = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(repo, "test/support/register-loader.mjs")).href, path.join(hostDir, "host.mjs"), requestPath], { env, encoding: "utf8", timeout: 90000 });
		assert.equal(run.status, 0, `host failed: ${run.error ?? run.stderr}`);
		return JSON.parse(fs.readFileSync(output, "utf8")) as { argv1: string; result: { isError?: boolean; content: Array<{ text?: string }> } };
	}

	it("starts the child on the installation the host loaded, not the PATH one", () => {
		const outcome = runHost({ model: "sdk-host-fixture/scripted", extensions: [providerPath], tools: [] });
		assert.equal(outcome.argv1, path.join(hostDir, "host.mjs"));
		assert.equal(outcome.result.isError, undefined, JSON.stringify(outcome.result));
		assert.match(outcome.result.content.map((part) => part.text ?? "").join("\n"), new RegExp(REPLY));
		const rows = fs.readFileSync(path.join(tempDir, "child.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv1: string });
		assert.equal(rows.length, 1, "exactly one child ran");
		assert.equal(fs.realpathSync.native(owningPackageRoot(rows[0].argv1)), loadedPiRoot);
		assert.equal(B.callCount(), 0, "the PATH installation was never started");
	});

	it("fails the dispatch and starts no other installation when the resolved entry is renamed before spawn", () => {
		const pathEnv = process.env.PATH!;
		const queueDir = process.env.MOCK_PI_QUEUE_DIR!;
		const A = createMockPi();
		A.install();
		try {
			const outcome = runHost({ fallbackModels: ["mock/fallback"] }, { renameAfterCapture: A.runtime.piEntryPath, env: { PI_PACKAGE_DIR: A.runtime.piPackageRoot, PATH: pathEnv, MOCK_PI_QUEUE_DIR: queueDir } });
			assert.equal(outcome.result.isError, true);
			assert.match(outcome.result.content.map((part) => part.text ?? "").join("\n"), /ENOENT|no such file/i);
			assert.equal(A.callCount(), 0, "the renamed installation was never started");
			assert.equal(B.callCount(), 0, "the PATH installation was never started");
		} finally {
			A.uninstall();
		}
	});
});
