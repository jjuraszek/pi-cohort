import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupOldArtifacts } from "../../src/shared/artifacts.ts";

const tempDirs: string[] = [];

function makeDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-artifacts-"));
	tempDirs.push(dir);
	return dir;
}

function age(target: string, days: number): void {
	const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
	fs.utimesSync(target, when, when);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("cleanupOldArtifacts", () => {
	it("removes a stale run directory recursively and keeps a fresh one", () => {
		const dir = makeDir();
		const stale = path.join(dir, "run-old");
		fs.mkdirSync(path.join(stale, "worktree-diffs"), { recursive: true });
		fs.writeFileSync(path.join(stale, "worktree-diffs", "task-0-worker.patch"), "patch\n", "utf-8");
		const fresh = path.join(dir, "run-new");
		fs.mkdirSync(fresh, { recursive: true });
		age(stale, 30);

		cleanupOldArtifacts(dir, 7);

		assert.equal(fs.existsSync(stale), false);
		assert.equal(fs.existsSync(fresh), true);
	});

	it("removes stale files and keeps fresh files", () => {
		const dir = makeDir();
		const staleFile = path.join(dir, "old_output.md");
		const freshFile = path.join(dir, "new_output.md");
		fs.writeFileSync(staleFile, "old\n", "utf-8");
		fs.writeFileSync(freshFile, "new\n", "utf-8");
		age(staleFile, 30);

		cleanupOldArtifacts(dir, 7);

		assert.equal(fs.existsSync(staleFile), false);
		assert.equal(fs.existsSync(freshFile), true);
	});

	it("skips the sweep when the cleanup marker is fresh", () => {
		const dir = makeDir();
		const stale = path.join(dir, "run-old");
		fs.mkdirSync(stale, { recursive: true });
		age(stale, 30);
		fs.writeFileSync(path.join(dir, ".last-cleanup"), String(Date.now()), "utf-8");

		cleanupOldArtifacts(dir, 7);

		assert.equal(fs.existsSync(stale), true);
	});

	it("writes the cleanup marker after a sweep", () => {
		const dir = makeDir();
		cleanupOldArtifacts(dir, 7);
		assert.equal(fs.existsSync(path.join(dir, ".last-cleanup")), true);
	});

	it("swallows an unreadable entry and still removes the stale sibling", () => {
		const dir = makeDir();
		const staleFile = path.join(dir, "old_output.md");
		fs.writeFileSync(staleFile, "old\n", "utf-8");
		age(staleFile, 30);
		const dangling = path.join(dir, "dangling");
		fs.symlinkSync("/nonexistent/target", dangling);

		assert.doesNotThrow(() => cleanupOldArtifacts(dir, 7));

		assert.equal(fs.existsSync(staleFile), false);
		assert.equal(fs.existsSync(path.join(dir, ".last-cleanup")), true);
	});
});
