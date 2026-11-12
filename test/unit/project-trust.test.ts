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
		fs.mkdirSync(path.join(worktree, "sub", "dir"), { recursive: true });
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

	for (const childTree of ["parent", "linked"] as const) {
		it(`is true for a subdirectory at a different path in the ${childTree} worktree`, () => {
			const childRoot = childTree === "parent" ? repo : worktree;
			assert.ok(inheritsTrust(path.join(childRoot, "sub", "dir"), trustIn(repo)));
		});
	}

	for (const relative of [".git", ".git/objects", ".git/worktrees/pi-worktree-x-0"]) {
		it(`is false for ${relative}, which is not the parent's directory`, () => {
			const child = path.join(repo, relative);
			assert.ok(fs.statSync(child).isDirectory());
			assert.equal(inheritsTrust(child, trustIn(repo)), false);
		});
	}

	it("is true for an ancestor of the parent's cwd, in the repository or another worktree", () => {
		assert.ok(inheritsTrust(repo, trustIn(path.join(repo, "sub"))));
		assert.ok(inheritsTrust(worktree, trustIn(path.join(repo, "sub"))));
	});

	for (const kind of ["repository", "submodule"]) {
		it(`is false for a separate ${kind} nested under the parent's cwd`, () => {
			const nested = path.join(repo, "vendor", "foreign");
			try {
				if (kind === "repository") {
					fs.mkdirSync(nested, { recursive: true });
					git(nested, "init", "-q");
				} else {
					git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", repo, "vendor/foreign");
				}
				fs.mkdirSync(path.join(nested, "sub"));
				for (const child of [nested, path.join(nested, "sub")]) {
					assert.equal(inheritsTrust(child, trustIn(repo)), false);
				}
			} finally {
				fs.rmSync(path.join(repo, "vendor"), { recursive: true, force: true });
			}
		});
	}

	it("outside git, uses path-segment containment and excludes nested repositories and metadata", () => {
		const root = path.join(elsewhere, "parent");
		const nested = path.join(root, "nested");
		for (const relative of ["parent/sub/dir", "parent/..cache", "parent-other", "..cache", "parent/nested/sub"]) {
			fs.mkdirSync(path.join(elsewhere, relative), { recursive: true });
		}
		git(nested, "init", "-q");
		const cases: Array<[string, boolean]> = [
			[root, true],
			[path.join(root, "sub", "dir"), true],
			[path.join(root, "..cache"), true],
			[`${root}-other`, false],
			[path.join(root, "..", "..cache"), false],
			[elsewhere, false],
			[repo, false],
			[nested, false],
			[path.join(nested, "sub"), false],
			[path.join(nested, ".git"), false],
			[path.join(nested, ".git", "objects"), false],
		];
		if (process.platform === "win32") {
			const otherDrive = path.parse(root).root[0].toUpperCase() === "C" ? "D:\\" : "C:\\";
			cases.push([otherDrive, false]);
		}
		for (const [child, expected] of cases) {
			assert.equal(inheritsTrust(child, trustIn(root)), expected, child);
		}
		assert.equal(inheritsTrust(elsewhere, trustIn(repo)), false);
		assert.equal(inheritsTrust(nested, trustIn(repo)), false);
	});

	it("uses real paths for containment, including symlinks into and out of the parent's tree", () => {
		const root = path.join(elsewhere, "links");
		fs.mkdirSync(path.join(root, "sub"), { recursive: true });
		const alias = path.join(elsewhere, "alias");
		const escape = path.join(root, "escape");
		const foreign = path.join(root, "foreign");
		fs.symlinkSync(root, alias, "junction");
		fs.symlinkSync(elsewhere, escape, "junction");
		fs.symlinkSync(repo, foreign, "junction");
		for (const [child, expected] of [[path.join(alias, "sub"), true], [escape, false], [foreign, false]] as const) {
			assert.equal(inheritsTrust(child, trustIn(alias)), expected, child);
		}
	});
});
