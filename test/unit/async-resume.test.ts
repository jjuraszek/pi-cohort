import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import { buildRevivedAsyncTask, resolveAsyncResumeTarget, resolveAsyncRunLocation } from "../../src/runs/background/async-resume.ts";

function writeJson(filePath: string, value: object): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ runtime, ...value }, null, 2), "utf-8");
}

const runtime = { nodeExecPath: "/origin/node", piEntryPath: "/origin/pi/cli.js", piPackageRoot: "/origin/pi" };

describe("async resume lookup", () => {
	for (const source of ["status", "result"] as const) it(`returns the original runtime from ${source}-only metadata across two custom roots`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-source-"));
		try {
			const roots = [path.join(root, "first"), path.join(root, "second")];
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "");
			const resultsDir = path.join(root, "results");
			if (source === "status") writeJson(path.join(roots[1], "run", "status.json"), { runId: "run", state: "complete", steps: [{ agent: "worker", status: "complete", sessionFile }] });
			else writeJson(path.join(resultsDir, "run.json"), { id: "run", agent: "worker", sessionFile, success: true });
			const target = resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: roots, resultsDir });
			assert.deepEqual(target.runtime, runtime);
			assert.equal(target.agent, "worker");
			assert.equal(target.sessionFile, sessionFile);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const fault of ["unreadable", "dangling", "EACCES", "ELOOP"] as const) it(`rejects ${fault} authoritative status despite an otherwise valid result`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-status-fault-"));
		let existsMock: ReturnType<typeof mock.method> | undefined;
		let readMock: ReturnType<typeof mock.method> | undefined;
		let lstatMock: ReturnType<typeof mock.method> | undefined;
		try {
			const statusPath = path.join(root, "runs", "run", "status.json");
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "");
			writeJson(statusPath, { runId: "run", state: "complete", steps: [{ agent: "worker", status: "complete", sessionFile }] });
			writeJson(path.join(root, "results", "run.json"), { id: "run", agent: "worker", sessionFile, success: true });
			if (fault === "dangling") {
				fs.unlinkSync(statusPath);
				fs.symlinkSync(path.join(root, "missing-status.json"), statusPath);
			}
			if (fault === "EACCES" || fault === "ELOOP") {
				const lstat = fs.lstatSync;
				lstatMock = mock.method(fs, "lstatSync", (file, ...args) => {
					if (String(file) === statusPath) throw Object.assign(new Error(fault), { code: fault });
					return lstat(file, ...args);
				});
			}
			const exists = fs.existsSync;
			const read = fs.readFileSync;
			const code = fault === "unreadable" ? "EACCES" : "ENOENT";
			// Permission failures must not depend on whether the harness runs as root.
			existsMock = mock.method(fs, "existsSync", (file) => String(file) === statusPath ? false : exists(file));
			readMock = mock.method(fs, "readFileSync", (file, ...args) => {
				if (String(file) === statusPath) throw Object.assign(new Error(code), { code });
				return read(file, ...args);
			});
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") }), /status|runtime/i);
		} finally {
			lstatMock?.mock.restore();
			readMock?.mock.restore();
			existsMock?.mock.restore();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers an exact ID across roots without inspecting an escaped longer prefix", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-resume-exact-"));
		try {
			const roots = [path.join(root, "first"), path.join(root, "second")];
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "");
			for (const [index, runs] of roots.entries()) writeJson(path.join(runs, "run", "status.json"), { runId: "run", state: "complete", steps: [{ agent: index === 0 ? "first" : "second", status: "complete", sessionFile }] });
			writeJson(path.join(roots[1], "run-long", "status.json"), { runId: "run-long", state: "complete", steps: [] });
			const deps = { asyncDirRoot: roots, resultsDir: path.join(root, "results") };
			assert.equal(resolveAsyncResumeTarget({ id: "run" }, deps).agent, "first");
			assert.throws(() => resolveAsyncResumeTarget({ id: "ru" }, deps), /Ambiguous/);
			fs.rmSync(path.join(roots[1], "run-long"), { recursive: true });
			fs.symlinkSync(root, path.join(roots[1], "run-long"), "dir");
			assert.equal(resolveAsyncResumeTarget({ id: "run" }, deps).agent, "first");
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
	it("rejects identity-less authoritative status despite a valid result", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-authority-"));
		try {
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "");
			writeJson(path.join(root, "runs", "run", "status.json"), { runtime: undefined, runId: "run", state: "complete", steps: [{ agent: "worker", status: "complete", sessionFile }] });
			writeJson(path.join(root, "results", "run.json"), { id: "run", runtime, agent: "worker", sessionFile, success: true });
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") }), /original runtime.*not recorded.*new run/i);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const [name, saved, expected] of [
		["null", null, /not recorded/], ["array", [], /not recorded/],
		["partial", { nodeExecPath: "/node" }, /invalid runtime/],
		["relative", { ...runtime, piEntryPath: "cli.js" }, /invalid runtime/],
		["conflicting", { ...runtime, piPackageRoot: "/different" }, /conflict/],
	] as const) it(`rejects ${name} authoritative runtime`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-shape-"));
		try {
			writeJson(path.join(root, "runs", "run", "status.json"), { runtime: saved, runId: "run", state: "complete", steps: [] });
			writeJson(path.join(root, "results", "run.json"), { runtime, id: "run", success: true });
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") }), expected);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const [name, saved, expected] of [
		["missing", undefined, /not recorded/], ["null", null, /not recorded/],
		["array", [], /not recorded/], ["partial", { nodeExecPath: "/node" }, /invalid runtime/],
		["relative", { ...runtime, nodeExecPath: "node" }, /invalid runtime/],
	] as const) it(`rejects ${name} result-only runtime before session selection`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-runtime-"));
		try {
			writeJson(path.join(root, "results", "run.json"), { runtime: saved, id: "run", success: true });
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: path.join(root, "runs"), resultsDir: path.join(root, "results") }), expected);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("permits canonical contained directories and rejects escaped symlinks", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-canonical-resume-"));
		try {
			const runs = path.join(root, "runs");
			const outside = path.join(root, "outside");
			fs.mkdirSync(path.join(runs, "run"), { recursive: true });
			fs.mkdirSync(outside);
			fs.symlinkSync(outside, path.join(runs, "escape"), "dir");
			assert.equal(resolveAsyncRunLocation({ dir: path.join(runs, "run") }, [runs], root).resolvedId, "run");
			assert.throws(() => resolveAsyncRunLocation({ dir: path.join(runs, "escape") }, [runs], root), /inside/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	for (const raw of ["null", "[]", "{broken"]) it(`rejects present invalid status ${raw} without result fallback`, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-invalid-status-"));
		try {
			writeJson(path.join(root, "run", "status.json"), {});
			fs.writeFileSync(path.join(root, "run", "status.json"), raw);
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "");
			writeJson(path.join(root, "results", "run.json"), { id: "run", success: true, agent: "worker", sessionFile });
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: root, resultsDir: path.join(root, "results") }), /object|parse/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("rejects queued startup before selecting a child", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-queued-resume-"));
		try {
			const statusPath = path.join(root, "run", "status.json");
			writeJson(statusPath, { runId: "run", state: "queued", steps: [] });
			const before = fs.readFileSync(statusPath, "utf8");
			assert.throws(() => resolveAsyncResumeTarget({ id: "run" }, { asyncDirRoot: root, resultsDir: path.join(root, "results") }), /queued/);
			assert.equal(fs.readFileSync(statusPath, "utf8"), before);
			assert.deepEqual(fs.readdirSync(path.dirname(statusPath)), ["status.json"]);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});

	it("resolves a completed single-child run from persisted status", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-abc", "status.json"), {
				runId: "run-abc",
				mode: "single",
				state: "complete",
				startedAt: 100,
				endedAt: 200,
				lastUpdate: 200,
				cwd: root,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			const target = resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });

			assert.equal(target.kind, "revive");
			assert.equal(target.runId, "run-abc");
			assert.equal(target.agent, "worker");
			assert.equal(target.sessionFile, sessionFile);
			assert.equal(target.cwd, root);
			assert.deepEqual(target.runtime, runtime);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects ambiguous run id prefixes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-ambiguous-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-aa", "status.json"), {
				runId: "run-aa",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "scout", status: "running" }],
			});
			writeJson(path.join(asyncRoot, "run-ab", "status.json"), {
				runId: "run-ab",
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-a" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Ambiguous async run id prefix 'run-a' matched: run-aa, run-ab/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects path-like ids and directories outside the async root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paths-"));
		try {
			const asyncRoot = path.join(root, "runs");
			assert.throws(
				() => resolveAsyncResumeTarget({ id: "../run" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/id must be an async run id or prefix, not a path/,
			);
			assert.throws(
				() => resolveAsyncResumeTarget({ dir: path.join(root, "outside") }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Async run directory must be inside/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects non-jsonl session files before reviving", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-session-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "session.txt");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-session", "status.json"), {
				runId: "run-session",
				mode: "single",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				sessionFile,
				steps: [{ agent: "worker", status: "complete" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/session file must be a \.jsonl file/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed result metadata before using session fields", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-result-"));
		try {
			const resultsDir = path.join(root, "results");
			writeJson(path.join(resultsDir, "run-result.json"), {
				id: "run-result",
				agent: "worker",
				success: true,
				state: "complete",
				results: [{ agent: "worker", sessionFile: { path: "session.jsonl" } }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-result" }, { asyncDirRoot: path.join(root, "runs"), resultsDir }),
				/results\[0\].sessionFile must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed status session ids", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-malformed-session-id-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-session-id", "status.json"), {
				runId: "run-session-id",
				sessionId: { value: "session" },
				mode: "single",
				state: "running",
				startedAt: 100,
				steps: [{ agent: "worker", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-session-id" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/sessionId must be a string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a selected running child until it completes", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-live-"));
		try {
			const asyncRoot = path.join(root, "runs");
			writeJson(path.join(asyncRoot, "run-live", "status.json"), {
				runId: "run-live",
				mode: "single",
				state: "running",
				startedAt: 100,
				lastUpdate: 100,
				steps: [{ agent: "scout", status: "running" }],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-live" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Selected child is still active; wait for completion, then resume\./,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a completed child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-partial-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "done.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-partial", "status.json"), {
				runId: "run-partial",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "done", status: "complete", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget({ id: "run-partial", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "done");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a failed child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-failed-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "failed.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-failed", "status.json"), {
				runId: "run-failed",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "failed", status: "failed", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget({ id: "run-failed", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "failed");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("revives a paused child by index while a sibling async child is still running", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-paused-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "paused.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-paused", "status.json"), {
				runId: "run-paused",
				mode: "parallel",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "paused", status: "paused", sessionFile },
					{ agent: "active", status: "running" },
				],
			});

			const target = resolveAsyncResumeTarget({ id: "run-paused", index: 0 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "paused");
			assert.equal(target.sessionFile, sessionFile);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects pending indexed children in still-running async runs", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-pending-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const sessionFile = path.join(root, "pending.jsonl");
			fs.writeFileSync(sessionFile, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-pending", "status.json"), {
				runId: "run-pending",
				mode: "chain",
				state: "running",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "active", status: "running" },
					{ agent: "later", status: "pending", sessionFile },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-pending", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/pending and has not started yet/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves a completed multi-child run when an index and per-child session file are available", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-resume-multi-"));
		try {
			const asyncRoot = path.join(root, "runs");
			const firstSession = path.join(root, "a.jsonl");
			const secondSession = path.join(root, "b.jsonl");
			fs.writeFileSync(firstSession, "", "utf-8");
			fs.writeFileSync(secondSession, "", "utf-8");
			writeJson(path.join(asyncRoot, "run-multi", "status.json"), {
				runId: "run-multi",
				mode: "chain",
				state: "complete",
				startedAt: 100,
				lastUpdate: 200,
				steps: [
					{ agent: "a", status: "complete", sessionFile: firstSession },
					{ agent: "b", status: "complete", sessionFile: secondSession },
				],
			});

			assert.throws(
				() => resolveAsyncResumeTarget({ id: "run-multi" }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") }),
				/Provide index to choose one/,
			);
			const target = resolveAsyncResumeTarget({ id: "run-multi", index: 1 }, { asyncDirRoot: asyncRoot, resultsDir: path.join(root, "results") });
			assert.equal(target.kind, "revive");
			assert.equal(target.agent, "b");
			assert.equal(target.index, 1);
			assert.equal(target.sessionFile, secondSession);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("frames the revived follow-up with original run context", () => {
		const task = buildRevivedAsyncTask({
			kind: "revive",
			runtime,
			runId: "run-old",
			state: "complete",
			agent: "worker",
			index: 0,
			sessionFile: "/tmp/session.jsonl",
		}, "What changed?");

		assert.match(task, /Original run: run-old/);
		assert.doesNotMatch(task, /async subagent conversation/);
		assert.match(task, /Original agent: worker/);
		assert.match(task, /Original session file: \/tmp\/session\.jsonl/);
		assert.match(task, /Follow-up:\nWhat changed\?/);
	});
});
