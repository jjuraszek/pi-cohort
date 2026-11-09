import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import { sharesProject } from "../../src/runs/shared/project-trust.ts";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" } });
	assert.equal(result.status, 0, result.stderr);
}

describe("sharesProject", () => {
	let repo: string;
	let worktree: string;
	let elsewhere: string;

	before(() => {
		repo = createTempDir();
		elsewhere = createTempDir();
		git(repo, "init", "-q");
		git(repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		worktree = path.join(createTempDir(), "pi-worktree-x-0");
		git(repo, "worktree", "add", "-q", worktree, "-b", "pi-parallel-x-0", "HEAD");
		fs.mkdirSync(path.join(repo, "sub", "dir"), { recursive: true });
		fs.mkdirSync(path.join(worktree, "sub"), { recursive: true });
	});

	after(() => {
		git(repo, "worktree", "remove", "--force", worktree);
		removeTempDir(path.dirname(worktree));
		removeTempDir(repo);
		removeTempDir(elsewhere);
	});

	it("is true for the root itself and its subdirectories", () => {
		assert.ok(sharesProject(repo, repo));
		assert.ok(sharesProject(path.join(repo, "sub", "dir"), repo));
	});

	it("is true for a git worktree of the root, including a subdirectory of it", () => {
		assert.ok(sharesProject(worktree, repo));
		assert.ok(sharesProject(path.join(worktree, "sub"), path.join(repo, "sub")));
	});

	it("is false for a directory outside the root with no shared repository", () => {
		assert.ok(!sharesProject(elsewhere, repo));
		assert.ok(!sharesProject(repo, elsewhere));
	});

	it("is false for a separately initialized repository nested under the root", () => {
		const nested = path.join(repo, "vendor", "foreign");
		fs.mkdirSync(nested, { recursive: true });
		try {
			git(nested, "init", "-q");
			assert.ok(!sharesProject(nested, repo));
		} finally {
			fs.rmSync(path.join(repo, "vendor"), { recursive: true, force: true });
		}
	});

	it("is true outside git for a child whose name starts with two dots", () => {
		const child = path.join(elsewhere, "..cache");
		fs.mkdirSync(child);
		assert.ok(sharesProject(child, elsewhere));
	});

	it("is false for a sibling whose name merely starts with the root", () => {
		const sibling = repo + "-other";
		fs.mkdirSync(sibling);
		try {
			assert.ok(!sharesProject(sibling, repo));
		} finally {
			fs.rmSync(sibling, { recursive: true, force: true });
		}
	});
});
