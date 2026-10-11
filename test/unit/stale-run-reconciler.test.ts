import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkPidLiveness, reconcileAsyncRun } from "../../src/runs/background/stale-run-reconciler.ts";

function tempRoot(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeStatus(asyncDir: string, status: Record<string, unknown>): void {
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify(status, null, 2), "utf-8");
}

function errno(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("async stale-run reconciliation", () => {
	for (const withResult of [false, true]) it(`leaves queued startup unresolved (${withResult ? "with" : "without"} result)`, () => {
		const root = tempRoot("pi-queued-reconcile-");
		try {
			const asyncDir = path.join(root, "queued");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, { runId: "queued", mode: "single", state: "queued", pid: 123, startedAt: 1, steps: [] });
			const statusPath = path.join(asyncDir, "status.json");
			const before = fs.readFileSync(statusPath, "utf8");
			const resultPath = path.join(resultsDir, "queued.json");
			if (withResult) {
				fs.mkdirSync(resultsDir);
				fs.writeFileSync(resultPath, '{"success":true,"state":"complete"}');
			}
			let probes = 0;
			const result = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 10 ** 12, kill: () => { probes++; return true; } });
			assert.equal(result.repaired, false);
			assert.equal(result.status?.state, "queued");
			assert.match(result.message ?? "", /unresolved async startup/i);
			assert.equal(probes, 0);
			assert.equal(fs.readFileSync(statusPath, "utf8"), before);
			assert.deepEqual(fs.readdirSync(asyncDir), ["status.json"]);
			assert.equal(fs.existsSync(resultPath), withResult);
			if (withResult) assert.equal(fs.readFileSync(resultPath, "utf8"), '{"success":true,"state":"complete"}');
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const state of ["complete", "failed", "paused"] as const) it(`leaves ${state} history unchanged without probing`, () => {
		const root = tempRoot("pi-terminal-reconcile-");
		try {
			writeStatus(root, { runId: "terminal", mode: "single", state, pid: 123, startedAt: 1 });
			const before = fs.readFileSync(path.join(root, "status.json"), "utf8");
			const result = reconcileAsyncRun(root, { resultsDir: path.join(root, "results"), kill: () => { assert.fail("must not probe terminal history"); } });
			assert.equal(result.repaired, false);
			assert.equal(fs.readFileSync(path.join(root, "status.json"), "utf8"), before);
			assert.deepEqual(fs.readdirSync(root), ["status.json"]);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("classifies pid liveness without treating EPERM as dead", () => {
		assert.equal(checkPidLiveness(123, () => true), "alive");
		assert.equal(checkPidLiveness(123, () => { throw errno("ESRCH"); }), "dead");
		assert.equal(checkPidLiveness(123, () => { throw errno("EPERM"); }), "unknown");
		assert.equal(checkPidLiveness(123, () => { throw new Error("boom"); }), "unknown");
	});

	it("marks a running async run failed when the runner pid is dead and no result exists", () => {
		const root = tempRoot("pi-stale-run-");
		try {
			const asyncDir = path.join(root, "run-dead");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-dead",
				sessionId: "session-current",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				currentStep: 0,
				runtime: { nodeExecPath: "/origin/node", piEntryPath: "/origin/pi/cli.js", piPackageRoot: "/origin/pi" },
				sessionFile: path.join(root, "session.jsonl"),
				sessionDir: root,
				steps: [{ agent: "scout", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /process 12345 exited or disappeared/);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			assert.equal(status.state, "failed");
			assert.equal(status.sessionId, "session-current");
			assert.equal(Object.hasOwn(status, "error"), false);
			assert.equal(status.steps[0].status, "failed");
			assert.match(status.steps[0].error, /process 12345 exited or disappeared/);
			const resultJson = JSON.parse(fs.readFileSync(path.join(resultsDir, "run-dead.json"), "utf-8"));
			assert.deepEqual(resultJson.runtime, status.runtime);
			assert.equal(resultJson.sessionFile, status.sessionFile);
			assert.equal(resultJson.sessionDir, root);
			assert.equal(resultJson.success, false);
			assert.equal(resultJson.sessionId, "session-current");
			assert.equal(resultJson.state, "failed");
			assert.equal(resultJson.exitCode, 1);
			assert.match(resultJson.summary, /process 12345 exited or disappeared/);
			assert.match(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8"), /subagent\.run\.repaired_stale/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("repairs stale status with per-child result outcomes", () => {
		const root = tempRoot("pi-stale-mixed-result-");
		try {
			const asyncDir = path.join(root, "run-mixed");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-mixed",
				mode: "chain",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [
					{ agent: "scout", status: "running", startedAt: 1000 },
					{ agent: "worker", status: "running", startedAt: 1100 },
				],
			});
			const scoutSession = path.join(root, "scout.jsonl");
			const workerSession = path.join(root, "worker.jsonl");
			fs.writeFileSync(path.join(resultsDir, "run-mixed.json"), JSON.stringify({
				id: "run-mixed",
				success: false,
				state: "failed",
				results: [
					{ agent: "scout", success: true, sessionFile: scoutSession, model: "fast" },
					{ agent: "worker", success: false, error: "boom", sessionFile: workerSession, model: "careful" },
				],
			}, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.equal(result.status?.steps?.[0]?.status, "complete");
			assert.equal(result.status?.steps?.[0]?.exitCode, 0);
			assert.equal(result.status?.steps?.[0]?.model, "fast");
			assert.equal(result.status?.steps?.[0]?.sessionFile, scoutSession);
			assert.equal(result.status?.steps?.[1]?.status, "failed");
			assert.equal(result.status?.steps?.[1]?.exitCode, 1);
			assert.equal(result.status?.steps?.[1]?.error, "boom");
			assert.equal(result.status?.steps?.[1]?.model, "careful");
			assert.equal(result.status?.steps?.[1]?.sessionFile, workerSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	for (const liveness of ["alive", "unknown"] as const) it(`fails a stale run when a live pid has not updated beyond the stale threshold (${liveness})`, () => {
		const root = tempRoot("pi-stale-live-pid-");
		try {
			const asyncDir = path.join(root, "run-reused-pid");
			const resultsDir = path.join(root, "results");
			writeStatus(asyncDir, {
				runId: "run-reused-pid",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { if (liveness === "unknown") throw errno("EPERM"); return true; },
				now: () => 5000,
				staleAlivePidMs: 1000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "failed");
			assert.match(result.message ?? "", /live PID, but status has not updated/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves an existing result instead of overwriting it with stale-run failure", () => {
		const root = tempRoot("pi-stale-existing-result-");
		try {
			const asyncDir = path.join(root, "run-result");
			const resultsDir = path.join(root, "results");
			fs.mkdirSync(resultsDir, { recursive: true });
			writeStatus(asyncDir, {
				runId: "run-result",
				mode: "single",
				state: "running",
				pid: 12345,
				startedAt: 1000,
				lastUpdate: 1000,
				steps: [{ agent: "worker", status: "running", startedAt: 1000 }],
			});
			const resultPath = path.join(resultsDir, "run-result.json");
			fs.writeFileSync(resultPath, JSON.stringify({ id: "run-result", success: true, state: "complete", summary: "already done" }, null, 2), "utf-8");

			const result = reconcileAsyncRun(asyncDir, {
				resultsDir,
				kill: () => { throw errno("ESRCH"); },
				now: () => 2000,
			});

			assert.equal(result.repaired, true);
			assert.equal(result.status?.state, "complete");
			assert.equal(JSON.parse(fs.readFileSync(resultPath, "utf-8")).summary, "already done");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("appends runner.log tail to failed repair message when log is non-empty", () => {
		const asyncDir = path.join(tempRoot("pi-cohort-reconcile-log-"), "run");
		writeStatus(asyncDir, { runId: "r1", state: "running", pid: 999999, mode: "single", startedAt: Date.now() - 60_000, steps: [{ agent: "worker", status: "running" }] });
		fs.writeFileSync(path.join(asyncDir, "runner.log"), "Error: Cannot find module 'jiti'\n    at resolve\n");
		const resultsDir = tempRoot("pi-cohort-results-");
		const result = reconcileAsyncRun(asyncDir, { resultsDir, kill: () => { throw errno("ESRCH"); } });
		assert.ok(result.repaired);
		assert.match(result.message ?? "", /Runner log tail \(.*runner\.log\):/);
		assert.match(result.message ?? "", /Cannot find module 'jiti'/);
	});

	it("appends path hint when runner.log is empty and when it is missing (identical behavior)", () => {
		for (const writeEmpty of [true, false]) {
			const asyncDir = path.join(tempRoot("pi-cohort-reconcile-hint-"), "run");
			writeStatus(asyncDir, { runId: "r2", state: "running", pid: 999999, mode: "single", startedAt: Date.now() - 60_000, steps: [{ agent: "worker", status: "running" }] });
			if (writeEmpty) fs.writeFileSync(path.join(asyncDir, "runner.log"), "");
			const result = reconcileAsyncRun(asyncDir, { resultsDir: tempRoot("pi-cohort-results-"), kill: () => { throw errno("ESRCH"); } });
			assert.match(result.message ?? "", /Runner log \(empty or missing\): expected at .*runner\.log/);
		}
	});

	it("bounds the tail to the last lines of a large log and enriches the stale-live-pid path", () => {
		const asyncDir = path.join(tempRoot("pi-cohort-reconcile-big-"), "run");
		writeStatus(asyncDir, { runId: "r3", state: "running", pid: 999999, mode: "single", startedAt: Date.now() - 60_000, lastUpdate: Date.now() - 25 * 60 * 60 * 1000, steps: [{ agent: "worker", status: "running" }] });
		fs.writeFileSync(path.join(asyncDir, "runner.log"), Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n"));
		const result = reconcileAsyncRun(asyncDir, { resultsDir: tempRoot("pi-cohort-results-"), kill: () => true });
		assert.ok(result.repaired);
		assert.match(result.message ?? "", /still has a live PID/);
		assert.match(result.message ?? "", /line-499/);
		assert.doesNotMatch(result.message ?? "", /line-100\b/);
	});
});
