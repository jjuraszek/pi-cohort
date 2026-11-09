import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { createTempDir, removeTempDir } from "../support/helpers.ts";
import { inheritsTrust, resolveProjectTrust, type ProjectTrust } from "../../src/runs/shared/project-trust.ts";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" } });
	assert.equal(result.status, 0, result.stderr);
}

function trustIn(cwd: string): ProjectTrust {
	const trust = resolveProjectTrust(cwd, true, () => true);
	assert.ok(trust);
	return trust;
}

describe("resolveProjectTrust", () => {
	let dir: string;

	before(() => {
		dir = createTempDir();
	});

	after(() => {
		removeTempDir(dir);
	});

	it("passes nothing on for a trusted parent whose cwd has no trust-requiring resources", () => {
		assert.equal(resolveProjectTrust(dir, true, hasTrustRequiringProjectResources), undefined);
	});

	it("passes trust on once the parent's cwd has project extensions", () => {
		const parent = path.join(dir, "with-pi");
		fs.mkdirSync(path.join(parent, ".pi", "extensions"), { recursive: true });
		assert.equal(resolveProjectTrust(parent, true, hasTrustRequiringProjectResources)?.trusted, true);
	});

	it("passes an untrusted decision on even without resources", () => {
		assert.equal(resolveProjectTrust(dir, false, hasTrustRequiringProjectResources)?.trusted, false);
	});
});

describe("inheritsTrust", () => {
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

	it("is true for the parent's own directory", () => {
		assert.ok(inheritsTrust(repo, trustIn(repo)));
		assert.ok(inheritsTrust(path.join(repo, "sub"), trustIn(path.join(repo, "sub"))));
	});

	it("is true for the same path in another worktree of the parent's repository", () => {
		assert.ok(inheritsTrust(worktree, trustIn(repo)));
		assert.ok(inheritsTrust(path.join(worktree, "sub"), trustIn(path.join(repo, "sub"))));
	});

	it("is false for a subdirectory, which may hold a saved decision of its own", () => {
		assert.ok(!inheritsTrust(path.join(repo, "sub", "dir"), trustIn(repo)));
	});

	it("is false for an ancestor of the parent's cwd, in the repository or another worktree", () => {
		assert.ok(!inheritsTrust(repo, trustIn(path.join(repo, "sub"))));
		assert.ok(!inheritsTrust(worktree, trustIn(path.join(repo, "sub"))));
	});

	it("is false for a separately initialized repository nested under the parent's cwd", () => {
		const nested = path.join(repo, "vendor", "foreign");
		fs.mkdirSync(nested, { recursive: true });
		try {
			git(nested, "init", "-q");
			assert.ok(!inheritsTrust(nested, trustIn(repo)));
		} finally {
			fs.rmSync(path.join(repo, "vendor"), { recursive: true, force: true });
		}
	});

	it("outside git, is true only for the parent's own directory", () => {
		const child = path.join(elsewhere, "..cache");
		fs.mkdirSync(child);
		assert.ok(inheritsTrust(elsewhere, trustIn(elsewhere)));
		assert.ok(!inheritsTrust(child, trustIn(elsewhere)));
		assert.ok(!inheritsTrust(elsewhere, trustIn(repo)));
		assert.ok(!inheritsTrust(repo, trustIn(elsewhere)));
	});
});
