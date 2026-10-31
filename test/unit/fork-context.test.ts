import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createForkContextResolver, resolveSubagentContext } from "../../src/shared/fork-context.ts";

function writeMinimalSessionFile(filePath: string, id = "session"): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `{"type":"session","version":1,"id":"${id}","timestamp":"2026-04-16T00:00:00.000Z","cwd":"/tmp"}\n`, "utf-8");
}

describe("resolveSubagentContext", () => {
	it("defaults to fresh", () => {
		assert.equal(resolveSubagentContext(undefined), "fresh");
		assert.equal(resolveSubagentContext("anything"), "fresh");
	});

	it("accepts fork", () => {
		assert.equal(resolveSubagentContext("fork"), "fork");
	});
});

describe("createForkContextResolver", () => {
	it("fresh mode never calls createBranchedSession", () => {
		let calls = 0;
		const resolver = createForkContextResolver({
			getSessionFile: () => "/tmp/parent.jsonl",
			getLeafId: () => "leaf-123",
		}, "fresh", {
			openSession: () => ({
				createBranchedSession: () => {
					calls++;
					return "/tmp/child.jsonl";
				},
			}),
		});

		assert.equal(resolver.sessionFileForIndex(0, "/tmp"), undefined);
		assert.equal(calls, 0);
	});

	it("fails fast when parent session file is missing", () => {
		assert.throws(
			() => createForkContextResolver({
				getSessionFile: () => undefined,
				getLeafId: () => "leaf-123",
			}, "fork", { openSession: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) }),
			/Forked subagent context requires a persisted parent session\./,
		);
	});

	it("fails fast when leaf id is missing", () => {
		assert.throws(
			() => createForkContextResolver({
				getSessionFile: () => "/tmp/parent.jsonl",
				getLeafId: () => null,
			}, "fork", { openSession: () => ({ createBranchedSession: () => "/tmp/child.jsonl" }) }),
			/Forked subagent context requires a current leaf to fork from\./,
		);
	});

	it("opens a throwaway manager from the persisted parent session file", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-open-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			const openedPaths: [string, string | undefined, string][] = [];
			const childCwd = path.join(tempDir, "B");
			const seenLeafIds: string[] = [];
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-xyz",
			}, "fork", {
				openSession: (sessionFile: string, sessionDir: string | undefined, cwd: string) => {
					openedPaths.push([sessionFile, sessionDir, cwd]);
					return {
						createBranchedSession: (leafId: string) => {
							seenLeafIds.push(leafId);
							const childSessionFile = path.join(tempDir, `child-${seenLeafIds.length}.jsonl`);
							writeMinimalSessionFile(childSessionFile, `child-${seenLeafIds.length}`);
							return childSessionFile;
						},
					};
				},
			});

			resolver.sessionFileForIndex(0, childCwd);
			resolver.sessionFileForIndex(1, childCwd);
			resolver.sessionFileForIndex(2, childCwd);

			assert.deepEqual(openedPaths, Array(3).fill([parentSessionFile, undefined, childCwd]));
			assert.deepEqual(seenLeafIds, ["leaf-xyz", "leaf-xyz", "leaf-xyz"]);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("forks a persisted user-only parent through the default package opener", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-default-"));
		try {
			const sessionDir = path.join(tempDir, "sessions");
			const parentCwd = path.join(tempDir, "A");
			const childCwd = path.join(tempDir, "B");
			fs.mkdirSync(parentCwd);
			fs.mkdirSync(childCwd);
			const parent = SessionManager.create(parentCwd, sessionDir);
			parent.appendMessage({ role: "user", content: "parent prompt" });
			const parentSessionFile = parent.getSessionFile();
			const leafId = parent.getLeafId();

			assert.ok(parentSessionFile);
			assert.ok(leafId);

			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => leafId,
				getSessionDir: () => sessionDir,
			}, "fork", { sessionDirForIndex: (index) => path.join(tempDir, `run-${index}`) });

			const parentBytes = fs.readFileSync(parentSessionFile, "utf-8");
			const childSessionFile = resolver.sessionFileForIndex(0, childCwd);
			assert.ok(childSessionFile);
			assert.notEqual(childSessionFile, parentSessionFile);
			assert.equal(path.dirname(childSessionFile), fs.realpathSync.native(path.join(tempDir, "run-0")));
			assert.equal(resolver.sessionFileForIndex(0, childCwd), childSessionFile);
			assert.equal(JSON.parse(fs.readFileSync(childSessionFile, "utf-8").split("\n")[0]).cwd, childCwd);
			assert.equal(JSON.parse(parentBytes.split("\n")[0]).cwd, parentCwd);
			assert.equal(fs.readFileSync(parentSessionFile, "utf-8"), parentBytes);
			assert.equal(fs.existsSync(childSessionFile), true);
			assert.deepEqual(SessionManager.open(childSessionFile).getBranch(leafId), parent.getBranch(leafId));
			assert.equal(parent.getSessionFile(), parentSessionFile);
			assert.equal(parent.getLeafId(), leafId);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails clearly for an unflushed setup-only parent", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-user-only-"));
		try {
			const sessionDir = path.join(tempDir, "sessions");
			const parent = SessionManager.create(tempDir, sessionDir);
			parent.appendThinkingLevelChange("off");
			const parentSessionFile = parent.getSessionFile();
			const leafId = parent.getLeafId();

			assert.ok(parentSessionFile);
			assert.ok(leafId);
			assert.equal(fs.existsSync(parentSessionFile), false);

			const resolver = createForkContextResolver(parent, "fork");
			assert.throws(
				() => resolver.sessionFileForIndex(0, tempDir),
				/Failed to create forked subagent session: Parent session file does not exist: .*Pi has not persisted enough history to fork yet\./,
			);
			assert.equal(parent.getSessionFile(), parentSessionFile);
			assert.equal(parent.getLeafId(), leafId);
			assert.equal(fs.existsSync(parentSessionFile), false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("creates isolated branched sessions per index (parallel and chain compatible)", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-index-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			let count = 0;
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-abc",
			}, "fork", {
				openSession: () => ({
					createBranchedSession: () => {
						count++;
						const childSessionFile = path.join(tempDir, `fork-${count}.jsonl`);
						writeMinimalSessionFile(childSessionFile, `child-${count}`);
						return childSessionFile;
					},
				}),
			});

			const singleSession = resolver.sessionFileForIndex(0, tempDir);
			const parallelSessions = [resolver.sessionFileForIndex(1, tempDir), resolver.sessionFileForIndex(2, tempDir)];
			const chainSessions = [resolver.sessionFileForIndex(3, tempDir), resolver.sessionFileForIndex(4, tempDir)];

			assert.equal(singleSession, path.join(tempDir, "fork-1.jsonl"));
			assert.deepEqual(parallelSessions, [path.join(tempDir, "fork-2.jsonl"), path.join(tempDir, "fork-3.jsonl")]);
			assert.deepEqual(chainSessions, [path.join(tempDir, "fork-4.jsonl"), path.join(tempDir, "fork-5.jsonl")]);
			assert.equal(count, 5);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("memoizes per index to keep behavior deterministic", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-memo-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			let calls = 0;
			const openedArgs: [string, string | undefined, string][] = [];
			const destination = path.join(tempDir, "destination");
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-abc",
				openSession: (file, dir, cwd) => {
					openedArgs.push([file, dir, cwd]);
					return {
						createBranchedSession: () => {
							calls++;
							const childSessionFile = path.join(destination, `fork-${calls}.jsonl`);
							writeMinimalSessionFile(childSessionFile, `child-${calls}`);
							return childSessionFile;
						},
					};
				},
			}, "fork", { sessionDirForIndex: () => destination });

			const first = resolver.sessionFileForIndex(7, tempDir);
			const second = resolver.sessionFileForIndex(7, tempDir);
			assert.deepEqual(openedArgs, [[parentSessionFile, destination, tempDir]]);
			assert.equal(first, second);
			assert.equal(calls, 1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails clearly when branch extraction returns a missing child file", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-missing-child-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const missingChildSessionFile = path.join(tempDir, "missing-child.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-abc",
			}, "fork", {
				openSession: () => ({
					createBranchedSession: () => missingChildSessionFile,
				}),
			});

			assert.throws(
				() => resolver.sessionFileForIndex(0, tempDir),
				/Failed to create forked subagent session: Session manager returned a forked session file that does not exist: .*missing-child\.jsonl/,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not silently fallback to fresh when branch extraction fails", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-fork-no-path-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			writeMinimalSessionFile(parentSessionFile, "parent");
			const resolver = createForkContextResolver({
				getSessionFile: () => parentSessionFile,
				getLeafId: () => "leaf-abc",
			}, "fork", {
				openSession: () => ({
					createBranchedSession: () => undefined,
				}),
			});

			assert.throws(
				() => resolver.sessionFileForIndex(0, tempDir),
				/Failed to create forked subagent session: Session manager did not return a forked session file\./,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
