import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { asyncStartHeadline, createJitiCliResolver, spawnDetachedWithLog, spawnRunner } from "../../src/runs/background/async-execution.ts";

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("spawnDetachedWithLog", () => {
	it("captures child stderr in <asyncDir>/runner.log", async () => {
		const asyncDir = tempDir("pi-cohort-spawnlog-");
		const result = spawnDetachedWithLog(process.execPath, ["-e", "console.error('boom-stderr'); process.exit(1)"], asyncDir, asyncDir);
		assert.equal(result.error, undefined);
		assert.equal(typeof result.pid, "number");
		const logPath = path.join(asyncDir, "runner.log");
		await waitFor(() => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf-8").includes("boom-stderr"));
	});

	it("falls back to ignored stdio when the log fd cannot be opened", () => {
		const asyncDir = path.join(tempDir("pi-cohort-spawnlog-missing-"), "does-not-exist");
		const result = spawnDetachedWithLog(process.execPath, ["-e", "process.exit(0)"], os.tmpdir(), asyncDir);
		assert.equal(result.error, undefined);
		assert.equal(typeof result.pid, "number");
	});

	it("closes the parent fd even when spawn throws", () => {
		const asyncDir = tempDir("pi-cohort-spawnthrow-");
		const logPath = path.join(asyncDir, "runner.log");
		// On POSIX, openSync returns the lowest available fd. Take a baseline probe
		// before the call under test; if spawnDetachedWithLog leaks its fd, the
		// lowest-available fd advances and the post-call probe returns a higher number.
		const baseline = fs.openSync(logPath, "a");
		fs.closeSync(baseline);
		const throwingSpawn = (() => { throw new Error("spawn exploded"); }) as unknown as typeof import("node:child_process").spawn;
		assert.throws(() => spawnDetachedWithLog(process.execPath, [], asyncDir, asyncDir, throwingSpawn), /spawn exploded/);
		const probe = fs.openSync(logPath, "a");
		fs.closeSync(probe);
		assert.equal(probe, baseline);
	});

	it("closes the parent fd when the child process does not produce a pid", () => {
		const asyncDir = tempDir("pi-cohort-spawnnopid-");
		const logPath = path.join(asyncDir, "runner.log");
		const baseline = fs.openSync(logPath, "a");
		fs.closeSync(baseline);
		const noPidSpawn = (() => ({ pid: undefined, on: () => {}, unref: () => {} })) as unknown as typeof import("node:child_process").spawn;
		const result = spawnDetachedWithLog(process.execPath, [], asyncDir, asyncDir, noPidSpawn);
		assert.match(result.error ?? "", /did not produce a pid/);
		const probe = fs.openSync(logPath, "a");
		fs.closeSync(probe);
		assert.equal(probe, baseline);
	});
});

describe("spawnRunner", () => {
	it("returns { error } and never spawns when jiti cannot be resolved", () => {
		const dir = tempDir("pi-cohort-spawnrunner-nojiti-");
		let spawnCalls = 0;
		const spawnImpl = ((...args: unknown[]) => {
			spawnCalls++;
			return undefined;
		}) as unknown as typeof import("node:child_process").spawn;
		const result = spawnRunner({}, "g4-nojiti", dir, dir, { ensureJiti: () => undefined, spawnImpl });
		assert.match(result.error ?? "", /upstream jiti/);
		assert.equal(result.pid, undefined);
		assert.equal(spawnCalls, 0);
	});

	it("spawns via the injected spawnImpl when jiti resolves to a valid path", () => {
		const dir = tempDir("pi-cohort-spawnrunner-ok-");
		let spawnCalls = 0;
		const fakeChild = { pid: 4242, on: () => {}, unref: () => {} };
		const spawnImpl = ((...args: unknown[]) => {
			spawnCalls++;
			return fakeChild as unknown as ReturnType<typeof import("node:child_process").spawn>;
		}) as unknown as typeof import("node:child_process").spawn;
		const result = spawnRunner({}, "g4-ok", dir, dir, { ensureJiti: () => "/fake/jiti-cli.mjs", spawnImpl });
		assert.equal(spawnCalls, 1);
		assert.equal(result.pid, 4242);
		assert.equal(result.error, undefined);
	});
});

describe("asyncStartHeadline", () => {
	it("includes 'Async dir: ' followed by the async directory", () => {
		const headline = asyncStartHeadline("Async single: my-agent", "run-123", "/tmp/async-runs/run-123");
		assert.match(headline, /Async dir: \/tmp\/async-runs\/run-123/);
		assert.match(headline, /\[run-123\]/);
	});
});

describe("createJitiCliResolver", () => {
	it("returns cached path while it exists, re-resolves when it disappears, undefined when re-resolution fails", () => {
		let resolved = "/first/jiti-cli.mjs";
		const existing = new Set(["/first/jiti-cli.mjs"]);
		const ensure = createJitiCliResolver({ resolve: () => resolved, exists: (p) => existing.has(p) });
		assert.equal(ensure(), "/first/jiti-cli.mjs");
		existing.delete("/first/jiti-cli.mjs");
		resolved = "/second/jiti-cli.mjs";
		existing.add("/second/jiti-cli.mjs");
		assert.equal(ensure(), "/second/jiti-cli.mjs");
		existing.clear();
		assert.equal(ensure(), undefined);
	});
});
