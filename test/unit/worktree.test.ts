import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	findWorktreeTaskCwdConflict,
	formatWorktreeDiffSummary,
	materializeTree,
	removeTrees,
	resolveExpectedWorktreeAgentCwd,
	type WorktreeSetup,
} from "../../src/runs/shared/worktree.ts";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(message);
	}
	return result.stdout.trim();
}

function createRepo(prefix: string): string {
	const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	git(repoDir, ["init"]);
	git(repoDir, ["config", "user.email", "tests@example.com"]);
	git(repoDir, ["config", "user.name", "Worktree Tests"]);
	fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n", "utf-8");
	fs.writeFileSync(path.join(repoDir, "tracked.txt"), "initial\n", "utf-8");
	git(repoDir, ["add", "-A"]);
	git(repoDir, ["commit", "-m", "initial commit"]);
	return repoDir;
}

function cleanupRepo(repoDir: string): void {
	try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
}

function createHookScript(_repoDir: string, fileName: string, source: string): string {
	const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-hook-script-"));
	const hookPath = path.join(hooksDir, fileName);
	fs.writeFileSync(hookPath, `#!/usr/bin/env node\n${source}\n`, "utf-8");
	fs.chmodSync(hookPath, 0o755);
	return hookPath;
}

const hookScriptSkip = process.platform === "win32"
	? "Hook script execution differs on Windows CI environments."
	: undefined;

describe("worktree", () => {
	it("createWorktrees returns expected structure", () => {
		const repoDir = createRepo("pi-worktree-structure-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "structure", 2);
			assert.equal(setup.worktrees.length, 2);
			assert.equal(setup.cwd, git(repoDir, ["rev-parse", "--show-toplevel"]));
			for (let i = 0; i < setup.worktrees.length; i++) {
				const worktree = setup.worktrees[i]!;
				assert.equal(worktree.branch, `pi-parallel-structure-${i}`);
				assert.equal(worktree.index, i);
				assert.equal(worktree.agentCwd, worktree.path);
				assert.equal(worktree.nodeModulesLinked, false);
				assert.deepEqual(worktree.syntheticPaths, []);
				assert.ok(fs.existsSync(worktree.path), `worktree path missing: ${worktree.path}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees maps subdirectory cwd to each agentCwd", () => {
		const repoDir = createRepo("pi-worktree-subdir-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(nestedDir, "subdir", 1);
			assert.equal(setup.worktrees[0]!.agentCwd, path.join(setup.worktrees[0]!.path, "packages", "app"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("previews expected worktree agent cwd for repository subdirectories", () => {
		const repoDir = createRepo("pi-worktree-preview-");
		const nestedDir = path.join(repoDir, "packages", "app");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "index.ts"), "export const value = 1;\n", "utf-8");
		git(repoDir, ["add", "-A"]);
		git(repoDir, ["commit", "-m", "add nested dir"]);

		try {
			assert.equal(
				resolveExpectedWorktreeAgentCwd(nestedDir, "preview", 2),
				path.join(os.tmpdir(), "pi-worktree-preview-2", "packages", "app"),
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees rejects dirty repositories", () => {
		const repoDir = createRepo("pi-worktree-dirty-");
		try {
			fs.writeFileSync(path.join(repoDir, "tracked.txt"), "dirty\n", "utf-8");
			assert.throws(
				() => createWorktrees(repoDir, "dirty", 1),
				/worktree isolation requires a clean git working tree/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("findWorktreeTaskCwdConflict allows omitted or matching task cwd values", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[
					{ agent: "worker-a" },
					{ agent: "worker-b", cwd: sharedCwd },
				],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict treats relative task cwd values as relative to the shared cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		assert.equal(
			findWorktreeTaskCwdConflict(
				[{ agent: "worker-a", cwd: "." }],
				sharedCwd,
			),
			undefined,
		);
	});

	it("findWorktreeTaskCwdConflict returns the first conflicting task cwd", () => {
		const sharedCwd = path.join("/tmp", "repo");
		const conflict = findWorktreeTaskCwdConflict(
			[
				{ agent: "worker-a", cwd: sharedCwd },
				{ agent: "worker-b", cwd: path.join(sharedCwd, "packages", "app") },
			],
			sharedCwd,
		);
		assert.deepEqual(conflict, {
			index: 1,
			agent: "worker-b",
			cwd: path.join(sharedCwd, "packages", "app"),
		});
	});

	it("diffWorktrees captures committed, modified, and new files without staging the node_modules symlink", () => {
		const repoDir = createRepo("pi-worktree-diff-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "diff", 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "committed.ts"), "export const committed = true;\n", "utf-8");
			git(worktree.path, ["add", "committed.ts"]);
			git(worktree.path, ["commit", "-m", "committed change"]);
			fs.writeFileSync(path.join(worktree.path, "tracked.txt"), "modified\n", "utf-8");
			fs.writeFileSync(path.join(worktree.path, "new-file.ts"), "export const added = true;\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "worktree-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			assert.equal(diffs.length, 1);
			assert.equal(diffs[0]!.agent, "agent-a");
			assert.equal(diffs[0]!.filesChanged, 3, `expected 3 files, got ${diffs[0]!.filesChanged}`);
			assert.ok(diffs[0]!.insertions > 0, "expected insertions > 0");
			assert.ok(fs.existsSync(diffs[0]!.patchPath), "expected patch file to exist");

			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /committed\.ts/);
			assert.match(patch, /tracked\.txt/);
			assert.match(patch, /new-file\.ts/);
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);

			const summary = formatWorktreeDiffSummary(diffs);
			assert.match(summary, /=== Worktree Changes ===/);
			assert.match(summary, /Full patches:/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees patches round-trip binary modification, addition, and deletion", () => {
		const repoDir = createRepo("pi-worktree-binary-");
		const original = Buffer.from([0, 1, 128, 255, 10]);
		const modified = Buffer.from([0, 2, 254, 129, 10, 0]);
		// Incompressible payload must exceed spawnSync's default stdout buffer.
		const added = randomBytes(1024 * 1024);
		let setup: WorktreeSetup | undefined;
		try {
			fs.writeFileSync(path.join(repoDir, "modified.bin"), original);
			fs.writeFileSync(path.join(repoDir, "deleted.bin"), original);
			git(repoDir, ["add", "-A"]);
			git(repoDir, ["commit", "-m", "add binary fixtures"]);
			setup = createWorktrees(repoDir, path.basename(repoDir), 1);
			const worktree = setup.worktrees[0]!;
			fs.writeFileSync(path.join(worktree.path, "modified.bin"), modified);
			fs.writeFileSync(path.join(worktree.path, "added.bin"), added);
			fs.unlinkSync(path.join(worktree.path, "deleted.bin"));

			const [captured] = diffWorktrees(setup, ["worker"], path.relative(process.cwd(), path.join(repoDir, "diffs")));
			assert.ok(captured);
			assert.ok(!captured.captureError, `capture failed (${captured.captureError?.length ?? 0} error characters)`);
			assert.ok(fs.statSync(captured.patchPath).size > 1024 * 1024);
			assert.equal(captured.filesChanged, 3);
			assert.equal(captured.insertions, 0);
			assert.equal(captured.deletions, 0);
			git(repoDir, ["apply", path.resolve(captured.patchPath)]);
			assert.deepEqual(fs.readFileSync(path.join(repoDir, "modified.bin")), modified);
			assert.deepEqual(fs.readFileSync(path.join(repoDir, "added.bin")), added);
			assert.equal(fs.existsSync(path.join(repoDir, "deleted.bin")), false);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleanupWorktrees removes worktrees and branches", () => {
		const repoDir = createRepo("pi-worktree-cleanup-");
		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "cleanup", 2);
			const worktreePaths = setup.worktrees.map((worktree) => worktree.path);
			const branches = setup.worktrees.map((worktree) => worktree.branch);
			cleanupWorktrees(setup);
			setup = undefined;

			for (const worktreePath of worktreePaths) {
				assert.equal(fs.existsSync(worktreePath), false, `worktree path still exists: ${worktreePath}`);
			}
			for (const branch of branches) {
				const branchResult = git(repoDir, ["branch", "--list", branch]);
				assert.equal(branchResult.trim(), "", `branch still exists: ${branch}`);
			}
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("createWorktrees creates node_modules symlink when node_modules exists", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-node-modules-");
		const nodeModulesDir = path.join(repoDir, "node_modules");
		fs.mkdirSync(nodeModulesDir, { recursive: true });
		fs.writeFileSync(path.join(nodeModulesDir, "fixture.txt"), "fixture\n", "utf-8");

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "node-modules", 1);
			const symlinkPath = path.join(setup.worktrees[0]!.path, "node_modules");
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, true);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, ["node_modules"]);
			assert.ok(fs.existsSync(symlinkPath), "node_modules link should exist");
			assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true, "node_modules should be a symlink");
			assert.equal(fs.realpathSync(symlinkPath), fs.realpathSync(nodeModulesDir));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("diffWorktrees preserves a tracked node_modules symlink", {
		skip: process.platform === "win32" ? "Symlink behavior differs on Windows CI environments." : undefined,
	}, () => {
		const repoDir = createRepo("pi-worktree-tracked-node-modules-");
		const vendorDir = path.join(repoDir, "vendor-modules");
		fs.mkdirSync(vendorDir, { recursive: true });
		fs.writeFileSync(path.join(vendorDir, "fixture.txt"), "fixture\n", "utf-8");
		fs.symlinkSync("vendor-modules", path.join(repoDir, "node_modules"));
		git(repoDir, ["add", "vendor-modules", "-f", "node_modules"]);
		git(repoDir, ["commit", "-m", "track node_modules symlink"]);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "tracked-node-modules", 1);
			assert.equal(setup.worktrees[0]!.nodeModulesLinked, false);
			assert.deepEqual(setup.worktrees[0]!.syntheticPaths, []);
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified\n", "utf-8");

			const diffsDir = path.join(repoDir, "artifacts", "tracked-node-modules-diffs");
			const diffs = diffWorktrees(setup, ["agent-a"], diffsDir);
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.doesNotMatch(patch, /diff --git a\/node_modules b\/node_modules/);
			assert.equal(fs.lstatSync(path.join(setup.worktrees[0]!.path, "node_modules")).isSymbolicLink(), true);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs a repo-relative worktree setup hook and records synthetic paths", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-relative-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.mkdirSync(path.join(payload.worktreePath, ".venv"), { recursive: true });
fs.writeFileSync(path.join(payload.worktreePath, ".venv", "pyvenv.cfg"), "home=/tmp\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".venv"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-relative", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			assert.ok(setup.worktrees[0]!.syntheticPaths.includes(".venv"));
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("runs an absolute worktree setup hook path", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-");
		const hookPath = createHookScript(repoDir, "setup-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-absolute", 1, {
				setupHook: { hookPath },
			});
			assert.equal(setup.worktrees.length, 1);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("rejects bare command names for worktree setup hooks", () => {
		const repoDir = createRepo("pi-worktree-hook-bare-");
		try {
			assert.throws(
				() => createWorktrees(repoDir, "hook-bare", 1, { setupHook: { hookPath: "node" } }),
				/worktree setup hook must be an absolute path or a repo-relative path/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects tracked synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-tracked-");
		const hookPath = createHookScript(repoDir, "tracked-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: ["tracked.txt"] }));
`);
		const runId = `hook-tracked-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/cannot mark tracked paths as synthetic/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("rejects absolute synthetic paths from hook output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-absolute-synthetic-");
		const hookPath = createHookScript(repoDir, "absolute-path-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
process.stdout.write(JSON.stringify({ syntheticPaths: [payload.worktreePath + "/.venv"] }));
`);
		const runId = `hook-absolute-synthetic-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/synthetic path must be relative/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("excludes hook-created synthetic files from captured patch output", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-diff-");
		const hookPath = createHookScript(repoDir, "setup-copy-hook.mjs", `
import * as fs from "node:fs";
import * as path from "node:path";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
fs.writeFileSync(path.join(payload.worktreePath, ".env.local"), "TOKEN=secret\\n", "utf-8");
process.stdout.write(JSON.stringify({ syntheticPaths: [".env.local"] }));
`);

		let setup: WorktreeSetup | undefined;
		try {
			setup = createWorktrees(repoDir, "hook-diff", 1, {
				setupHook: { hookPath: path.relative(repoDir, hookPath) },
			});
			fs.writeFileSync(path.join(setup.worktrees[0]!.path, "tracked.txt"), "modified-by-agent\n", "utf-8");
			const diffs = diffWorktrees(setup, ["agent-a"], path.join(repoDir, "artifacts", "hook-diff"));
			const patch = fs.readFileSync(diffs[0]!.patchPath, "utf-8");
			assert.match(patch, /tracked\.txt/);
			assert.doesNotMatch(patch, /\.env\.local/);
		} finally {
			if (setup) cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("cleans up created worktrees when a later hook setup fails", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-cleanup-");
		const runId = `hook-cleanup-${Date.now().toString(36)}`;
		const hookPath = createHookScript(repoDir, "flaky-hook.mjs", `
import * as fs from "node:fs";
const payload = JSON.parse(fs.readFileSync(0, "utf-8"));
if (payload.index === 1) {
	console.error("intentional failure");
	process.exit(1);
}
process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
`);
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 2, { setupHook: { hookPath: path.relative(repoDir, hookPath) } }),
				/worktree setup hook failed with exit code 1/i,
			);
			const branchList = git(repoDir, ["branch", "--list", `pi-parallel-${runId}-*`]);
			assert.equal(branchList.trim(), "", "temporary branches should be cleaned up after setup failure");
		} finally {
			cleanupRepo(repoDir);
		}
	});

	it("fails when the hook exceeds the configured timeout", { skip: hookScriptSkip }, () => {
		const repoDir = createRepo("pi-worktree-hook-timeout-");
		const hookPath = createHookScript(repoDir, "slow-hook.mjs", `
import * as fs from "node:fs";
JSON.parse(fs.readFileSync(0, "utf-8"));
setTimeout(() => {
	process.stdout.write(JSON.stringify({ syntheticPaths: [] }));
}, 1000);
`);
		const runId = `hook-timeout-${Date.now().toString(36)}`;
		try {
			assert.throws(
				() => createWorktrees(repoDir, runId, 1, {
					setupHook: { hookPath: path.relative(repoDir, hookPath), timeoutMs: 50 },
				}),
				/timed out/i,
			);
		} finally {
			cleanupRepo(repoDir);
		}
	});
});

describe("diffWorktrees capture failures", () => {
	it("reports a diffs-directory creation failure instead of an empty result", () => {
		const repoDir = createRepo("pi-subagent-diff-mkdir-");
		const setup = createWorktrees(repoDir, "run-mkdir", 1);
		try {
			const blocker = path.join(repoDir, "blocker");
			fs.writeFileSync(blocker, "not a directory\n", "utf-8");
			const diffs = diffWorktrees(setup, ["worker"], path.join(blocker, "diffs"));
			assert.equal(diffs.length, 1);
			assert.ok(diffs[0]?.captureError, "expected a captureError on the diff entry");
			assert.match(formatWorktreeDiffSummary(diffs), /patch capture FAILED/);
		} finally {
			cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("reports a per-task capture failure instead of an empty patch", () => {
		const repoDir = createRepo("pi-subagent-diff-capture-");
		const setup = createWorktrees(repoDir, "run-capture", 1);
		try {
			fs.rmSync(setup.worktrees[0]!.path, { recursive: true, force: true });
			const diffs = diffWorktrees(setup, ["worker"], path.join(repoDir, "diffs"));
			assert.equal(diffs.length, 1);
			assert.ok(diffs[0]?.captureError, "expected a captureError on the diff entry");
			const summary = formatWorktreeDiffSummary(diffs);
			assert.match(summary, /Task 1 \(worker\): patch capture FAILED/);
		} finally {
			cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});

	it("degrades a failed placeholder-patch write into captureError instead of throwing", () => {
		const repoDir = createRepo("pi-subagent-diff-placeholder-");
		const setup = createWorktrees(repoDir, "run-placeholder", 1);
		try {
			const diffsDir = path.join(repoDir, "diffs");
			const patchPath = path.join(diffsDir, "task-0-worker.patch");
			// Pre-create a directory at the exact patch path so both the real
			// and the recovery placeholder write fail with EISDIR.
			fs.mkdirSync(patchPath, { recursive: true });
			// Break the worktree so capture fails before it ever touches patchPath.
			fs.rmSync(setup.worktrees[0]!.path, { recursive: true, force: true });

			const diffs = diffWorktrees(setup, ["worker"], diffsDir);

			assert.equal(diffs.length, 1);
			assert.ok(diffs[0]?.captureError, "expected a captureError on the diff entry");
		} finally {
			cleanupWorktrees(setup);
			cleanupRepo(repoDir);
		}
	});
});

describe("detached trees", () => {
	it("replays a removed subdirectory producer's patch at the detached root", () => {
		const repoCwd = createRepo("pi-tree-replay-");
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-output-"));
		const dir = path.join(temp, "nested", "tree");
		let setup: WorktreeSetup | undefined;
		try {
			fs.mkdirSync(path.join(repoCwd, "app"));
			fs.writeFileSync(path.join(repoCwd, "app", "source.txt"), "source\n");
			fs.writeFileSync(path.join(repoCwd, "data.bin"), Buffer.from([0, 1, 255]));
			git(repoCwd, ["add", "-A"]);
			git(repoCwd, ["commit", "-m", "fixtures"]);
			const baseCommit = git(repoCwd, ["rev-parse", "HEAD"]);
			setup = createWorktrees(path.join(repoCwd, "app"), path.basename(repoCwd), 1);
			const producer = setup.worktrees[0]!;
			const binary = Buffer.from([0, 255, 2, 0]);
			fs.writeFileSync(path.join(producer.agentCwd, "added.txt"), "added\n");
			fs.unlinkSync(path.join(producer.path, "tracked.txt"));
			fs.writeFileSync(path.join(producer.path, "data.bin"), binary);
			const [diff] = diffWorktrees(setup, ["worker"], path.join(temp, "patches"));
			assert.ok(diff && !diff.captureError);
			cleanupWorktrees(setup);
			setup = undefined;
			fs.writeFileSync(path.join(repoCwd, "tracked.txt"), "dirty primary\n");
			assert.equal(materializeTree({ repoCwd, baseCommit, patchPath: diff.patchPath, dir }), dir);
			assert.equal(fs.readFileSync(path.join(dir, "app", "added.txt"), "utf-8").replace(/\r\n/g, "\n"), "added\n");
			assert.equal(fs.readFileSync(path.join(dir, "app", "source.txt"), "utf-8").replace(/\r\n/g, "\n"), "source\n");
			assert.deepEqual(fs.readFileSync(path.join(dir, "data.bin")), binary);
			assert.equal(fs.existsSync(path.join(dir, "tracked.txt")), false);
			assert.equal(git(dir, ["rev-parse", "HEAD"]), baseCommit);
			assert.equal(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD");
			assert.equal(git(dir, ["diff", "--name-only"]), "");
			assert.equal(git(dir, ["diff", "--cached", "--name-only"]), "app/added.txt\ndata.bin\ntracked.txt");
		} finally {
			if (setup) cleanupWorktrees(setup);
			removeTrees([{ repoCwd, dir }]);
			cleanupRepo(repoCwd);
			cleanupRepo(temp);
		}
	});

	for (const failure of ["add", "apply"]) {
		it(`reports the first stderr line on ${failure} failure and permits cleanup`, () => {
			const repoCwd = createRepo("pi-tree-failure-");
			const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-failure-output-"));
			const dir = path.join(temp, "tree");
			try {
				const patchPath = path.join(temp, "invalid.patch");
				fs.writeFileSync(patchPath, "not a patch\n");
				const baseCommit = failure === "add" ? "missing-commit" : git(repoCwd, ["rev-parse", "HEAD"]);
				assert.throws(() => materializeTree({ repoCwd, baseCommit, patchPath, dir }), (error: Error) => {
					assert.equal(error.message.includes("\n"), false);
					assert.match(error.message, failure === "add" ? /fatal: invalid reference: missing-commit/ : /error: No valid patches in input/);
					return true;
				});
				assert.equal(fs.existsSync(dir), failure === "apply");
			} finally {
				removeTrees([{ repoCwd, dir }]);
				assert.equal(fs.existsSync(dir), false);
				assert.equal(git(repoCwd, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 1);
				cleanupRepo(repoCwd);
				cleanupRepo(temp);
			}
		});
	}

	it("removes across repositories, skips missing dirs, and prunes each repository once", () => {
		const repos = [createRepo("pi-tree-clean-a-"), createRepo("pi-tree-clean-b-")];
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-clean-output-"));
		const entries = [repos[0]!, repos[0]!, repos[1]!].map((repoCwd, i) => ({ repoCwd, dir: path.join(temp, `tree-${i}`) }));
		const trace = path.join(temp, "trace");
		const previousTrace = process.env.GIT_TRACE;
		try {
			for (const { repoCwd, dir } of entries) git(repoCwd, ["worktree", "add", "--detach", dir, "HEAD"]);
			process.env.GIT_TRACE = trace;
			removeTrees([...entries, { repoCwd: repos[0]!, dir: path.join(temp, "missing") }]);
			if (previousTrace === undefined) delete process.env.GIT_TRACE;
			else process.env.GIT_TRACE = previousTrace;
			assert.equal((fs.readFileSync(trace, "utf-8").match(/built-in: git worktree prune/g) ?? []).length, 2);
			for (const { dir } of entries) assert.equal(fs.existsSync(dir), false);
			for (const repo of repos) assert.equal(git(repo, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 1);
		} finally {
			if (previousTrace === undefined) delete process.env.GIT_TRACE;
			else process.env.GIT_TRACE = previousTrace;
			removeTrees(entries);
			for (const repo of repos) cleanupRepo(repo);
			cleanupRepo(temp);
		}
	});

	it("logs failed removal and prune without preventing later removal", () => {
		const repoCwd = createRepo("pi-tree-best-effort-");
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tree-best-effort-output-"));
		const dir = path.join(temp, "tree");
		const failingDir = path.join(temp, "ordinary-dir");
		const warnings: string[] = [];
		const warn = console.warn;
		try {
			fs.mkdirSync(failingDir);
			git(repoCwd, ["worktree", "add", "--detach", dir, "HEAD"]);
			console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
			removeTrees([{ repoCwd: failingDir, dir: failingDir }, { repoCwd, dir }]);
			assert.ok(warnings.some((message) => message.includes(failingDir)));
			assert.ok(warnings.some((message) => message.includes("prune")));
			assert.equal(fs.existsSync(dir), false);
		} finally {
			console.warn = warn;
			removeTrees([{ repoCwd, dir }]);
			cleanupRepo(repoCwd);
			cleanupRepo(temp);
		}
	});
});

describe("worktree teardown", () => {
	for (const [name, hookPath, timeoutMs, message] of [
		["bare", "node", undefined, /absolute path or a repo-relative path/],
		["missing", "./missing", undefined, /not found/],
		["directory", "./", undefined, /got directory/],
		["empty", "", undefined, /cannot be empty/],
		["whitespace", "  ", undefined, /cannot be empty/],
		...[0, -1, 1.5, NaN, Infinity].map((value) => [`timeout-${value}`, "./tracked.txt", value, /timeout must be an integer greater than 0/]),
	] as const) {
		it(`rejects ${name} before creating a checkout`, () => {
			const repo = createRepo("pi-teardown-validation-");
			const runId = randomBytes(8).toString("hex");
			try {
				assert.throws(() => createWorktrees(repo, runId, 1, { teardownHook: { hookPath, timeoutMs } }), (error: Error) => {
					assert.match(error.message, /worktree teardown hook/);
					assert.match(error.message, message);
					return true;
				});
				assert.equal(fs.existsSync(path.join(os.tmpdir(), `pi-worktree-${runId}-0`)), false);
				assert.equal(git(repo, ["branch", "--list", `pi-parallel-${runId}-*`]), "");
			} finally { cleanupRepo(repo); }
		});
	}
});

describe("teardown lifecycle", () => {
	for (const mode of ["normal", "only", "rollback", "add-failure"] as const) {
		it(`retains payload and tears down successful adds: ${mode}`, { skip: hookScriptSkip }, () => {
			const repo = createRepo("pi-teardown-lifecycle-");
			const runId = randomBytes(8).toString("hex");
			const logs = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-records-"));
			fs.mkdirSync(path.join(repo, "nested"));
			fs.writeFileSync(path.join(repo, "nested", "file"), "x");
			git(repo, ["add", "."]); git(repo, ["commit", "-m", "nested"]);
			const record = `import fs from 'node:fs';\nconst p = JSON.parse(fs.readFileSync(0, 'utf8'));\nif (!fs.existsSync(p.worktreePath) || process.cwd() !== fs.realpathSync(p.worktreePath)) throw Error('missing checkout');\n`;
			const setupHook = createHookScript(repo, "setup.mjs", record + `fs.appendFileSync(${JSON.stringify(path.join(logs, "setup"))}, JSON.stringify(p)+'\\n');\nif (${mode === "rollback"} && p.index === 1) { console.error('original failure'); process.exit(7); }\nconsole.log('{}');`);
			const teardown = createHookScript(repo, "teardown.mjs", record + `fs.appendFileSync(${JSON.stringify(path.join(logs, "teardown"))}, JSON.stringify(p)+'\\n');`);
			let setup: WorktreeSetup | undefined;
			try {
				if (mode === "add-failure") git(repo, ["branch", `pi-parallel-${runId}-1`]);
				const create = () => createWorktrees(path.join(repo, "nested"), runId, 2, {
					setupHook: mode === "only" ? undefined : { hookPath: setupHook },
					teardownHook: { hookPath: path.relative(repo, teardown) }, agents: mode === "only" ? undefined : ["a", "b"],
				});
				if (mode === "rollback" || mode === "add-failure") assert.throws(create, mode === "rollback" ? /original failure/ : /already exists/);
				else { setup = create(); assert.equal(cleanupWorktrees(setup), undefined); setup = undefined; }
				const records = fs.readFileSync(path.join(logs, "teardown"), "utf8").trim().split("\n").map(JSON.parse);
				assert.deepEqual(records.map(p => p.index), mode === "add-failure" ? [0] : [1, 0]);
				if (mode !== "only") {
					const originals = fs.readFileSync(path.join(logs, "setup"), "utf8").trim().split("\n").map(JSON.parse);
					for (const p of records) assert.deepEqual(p, originals[p.index]);
				}
				for (const p of records) {
					assert.equal(p.version, 1); assert.equal(p.runId, runId);
					assert.equal(p.repoRoot, fs.realpathSync(repo));
					assert.equal(p.baseCommit, git(repo, ["rev-parse", "HEAD"]));
					assert.equal(p.agentCwd, path.join(p.worktreePath, "nested"));
					assert.equal(p.agent, mode === "only" ? undefined : ["a", "b"][p.index]);
					assert.equal(fs.existsSync(p.worktreePath), false);
					assert.equal(git(repo, ["branch", "--list", p.branch]), "");
				}
			} finally { if (setup) cleanupWorktrees(setup); cleanupRepo(repo); cleanupRepo(logs); }
		});
	}
});

describe("teardown failures", () => {
	for (const failure of ["exit", "missing", "permissions", "stdout", "remove", "branch", "throw", "callback", "backpressure"] as const) {
		it(`continues cleanup on ${failure}`, { skip: hookScriptSkip }, () => {
			const repo = createRepo("pi-teardown-failure-");
			const warnings: string[] = [];
			const write = fs.write;
			const hookPath = createHookScript(repo, "teardown.mjs", failure === "stdout"
				? `process.stdout.write('x'.repeat(4 * 1024 * 1024));`
				: `console.error('  detail  '); process.exit(7);`);
			const setup = createWorktrees(repo, randomBytes(8).toString("hex"), 2, {
				teardownHook: ["remove", "branch"].includes(failure) ? undefined : { hookPath },
			});
			try {
				fs.write = ((fd, message, callback) => {
					assert.equal(fd, 2); warnings.push(String(message));
					if (failure === "throw") throw Error("sink");
					if (failure !== "backpressure") callback(failure === "callback" ? Error("sink") : null);
				}) as typeof fs.write;
				if (failure === "missing") fs.unlinkSync(hookPath);
				if (failure === "permissions") fs.chmodSync(hookPath, 0o644);
				if (failure === "remove") {
					fs.rmSync(setup.worktrees[1]!.path, { recursive: true, force: true });
					git(repo, ["worktree", "prune"]);
				}
				if (failure === "branch") git(repo, ["update-ref", "-d", `refs/heads/${setup.worktrees[1]!.branch}`]);
				assert.equal(cleanupWorktrees(setup), undefined);
				for (const w of setup.worktrees) {
					assert.equal(fs.existsSync(w.path), false);
					assert.equal(git(repo, ["branch", "--list", w.branch]), "");
				}
				assert.equal(warnings.length, failure === "stdout" ? 0 : ["remove", "branch"].includes(failure) ? 1 : 2);
				for (const warning of warnings) {
					assert.ok(setup.worktrees.some(w => warning.includes(w.path)));
					assert.match(warning, failure === "missing" ? /ENOENT/ : failure === "permissions" ? /EACCES/ : failure === "remove" ? /worktree remove/ : failure === "branch" ? /branch -D/ : /exit code 7: detail\n$/);
				}
			} finally { fs.write = write; cleanupRepo(repo); }
		});
	}

	it("hard-kills a SIGTERM-ignoring hook within the timeout", { skip: hookScriptSkip }, () => {
		const repo = createRepo("pi-teardown-timeout-");
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-timeout-marker-"));
		const marker = path.join(temp, "started");
		const hookPath = createHookScript(repo, "hang.mjs", `import fs from 'node:fs'; process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(marker)}, 'yes'); setInterval(() => {}, 100);`);
		const modulePath = new URL("../../src/runs/shared/worktree.ts", import.meta.url).href;
		try {
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { createWorktrees, cleanupWorktrees } from ${JSON.stringify(modulePath)}; const s = createWorktrees(${JSON.stringify(repo)}, ${JSON.stringify(randomBytes(8).toString("hex"))}, 1, {teardownHook: {hookPath: ${JSON.stringify(hookPath)}, timeoutMs: 1000}}); const started = Date.now(); cleanupWorktrees(s); if (Date.now() - started >= 5000) throw Error('cleanup exceeded 5000ms'); console.log(s.worktrees[0].path);`], { encoding: "utf8", timeout: 8000, killSignal: "SIGKILL" });
			assert.equal(result.status, 0, result.stderr);
			assert.ok(fs.existsSync(marker)); assert.match(result.stderr, /timed out after 1000ms/);
			assert.equal(fs.existsSync(result.stdout.trim()), false);
		} finally { cleanupRepo(repo); cleanupRepo(temp); }
	});
});

describe("teardown resolution", () => {
	it("accepts absolute, repo-relative from nested cwd, and home paths", () => {
		const repo = createRepo("pi-teardown-paths-");
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-home-"));
		const previousHome = process.env.HOME;
		try {
			process.env.HOME = home;
			fs.writeFileSync(path.join(home, "hook"), "");
			fs.mkdirSync(path.join(repo, "nested"));
			fs.writeFileSync(path.join(repo, "nested", "hook"), "");
			git(repo, ["add", "."]); git(repo, ["commit", "-m", "nested"]);
			for (const hookPath of [path.join(home, "hook"), "./nested/hook", "~/hook"]) {
				const setup = createWorktrees(path.join(repo, "nested"), randomBytes(8).toString("hex"), 0, { teardownHook: { hookPath } });
				assert.equal(setup.worktrees.length, 0);
				cleanupWorktrees(setup);
			}
			const setup = createWorktrees(repo, randomBytes(8).toString("hex"), 1);
			cleanupWorktrees(setup);
		} finally {
			if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
			cleanupRepo(repo); cleanupRepo(home);
		}
	});
});

describe("teardown review regressions", () => {
	it("uses the default timeout and ignores absent raw hook configuration while prune stays silent", () => {
		const repo = createRepo("pi-teardown-default-");
		const hookPath = createHookScript(repo, "unused.mjs", "throw Error('must be mocked');");
		const originalSpawn = childProcess.spawnSync;
		const originalWrite = fs.write;
		const timeouts: number[] = [];
		const warnings: string[] = [];
		let prunes = 0;
		try {
			childProcess.spawnSync = ((command, args, options) => {
				if (command === hookPath) {
					timeouts.push(options.timeout);
					return { status: 0, stderr: "", stdout: null };
				}
				if (command === "git" && args.includes("prune")) {
					prunes++;
					return { status: 1, stderr: "prune deliberately failed", stdout: "" };
				}
				return originalSpawn(command, args, options);
			}) as typeof childProcess.spawnSync;
			syncBuiltinESMExports();
			fs.write = ((_fd, message, callback) => { warnings.push(String(message)); callback(null); }) as typeof fs.write;
			for (const teardownHook of [{ hookPath }, undefined]) {
				const setup = createWorktrees(repo, randomBytes(8).toString("hex"), 1, { teardownHook });
				assert.equal(cleanupWorktrees(setup), undefined);
				assert.equal(fs.existsSync(setup.worktrees[0]!.path), false);
				assert.equal(git(repo, ["branch", "--list", setup.worktrees[0]!.branch]), "");
			}
			assert.deepEqual(timeouts, [30000]);
			assert.equal(prunes, 2);
			assert.deepEqual(warnings, []);
		} finally {
			childProcess.spawnSync = originalSpawn;
			syncBuiltinESMExports();
			fs.write = originalWrite;
			cleanupRepo(repo);
		}
	});

	for (const sink of ["record", "throw", "callback", "never-callback"] as const) {
		it(`preserves setup failure through rollback git failures and ${sink} sink`, { skip: hookScriptSkip }, () => {
			const repo = createRepo("pi-teardown-rollback-sink-");
			const runId = randomBytes(8).toString("hex");
			const checkout = path.join(os.tmpdir(), `pi-worktree-${runId}-0`);
			const branch = `pi-parallel-${runId}-0`;
			const hookPath = createHookScript(repo, "fail.mjs", `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.rmSync(p.worktreePath, { recursive: true, force: true });
execFileSync('git', ['-C', p.repoRoot, 'worktree', 'prune']);
execFileSync('git', ['-C', p.repoRoot, 'branch', '-D', p.branch]);
console.error('original setup failure'); process.exit(7);
`);
			const write = fs.write;
			const warnings: string[] = [];
			try {
				fs.write = ((_fd, message, callback) => {
					warnings.push(String(message));
					if (sink === "throw") throw Error("sink submission failed");
					if (sink !== "never-callback") callback(sink === "callback" ? Error("sink callback failed") : null);
				}) as typeof fs.write;
				assert.throws(() => createWorktrees(repo, runId, 1, { setupHook: { hookPath } }), {
					message: "worktree setup hook failed with exit code 7: original setup failure",
				});
				assert.equal(warnings.length, 2);
				assert.ok(warnings.every(w => w.includes(checkout)));
				assert.match(warnings[0]!, /worktree remove.*fatal:/);
				assert.ok(warnings[1]!.includes(branch));
				assert.match(warnings[1]!, /branch -D.*error:/);
				assert.equal(fs.existsSync(checkout), false);
				assert.equal(git(repo, ["branch", "--list", branch]), "");
			} finally { fs.write = write; cleanupRepo(repo); }
		});
	}

	it("continues to earlier records when teardown removes its own checkout", { skip: hookScriptSkip }, () => {
		const repo = createRepo("pi-teardown-self-remove-");
		const records = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teardown-self-records-"));
		const recordPath = path.join(records, "records");
		const hookPath = createHookScript(repo, "remove.mjs", `
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(recordPath)}, p.index + '\\n');
if (p.index === 1) {
	fs.rmSync(p.worktreePath, { recursive: true, force: true });
	const { execFileSync } = await import('node:child_process');
	execFileSync('git', ['-C', p.repoRoot, 'worktree', 'prune']);
}
`);
		const setup = createWorktrees(repo, randomBytes(8).toString("hex"), 2, { teardownHook: { hookPath } });
		const write = fs.write;
		const warnings: string[] = [];
		try {
			fs.write = ((_fd, message, callback) => { warnings.push(String(message)); callback(null); }) as typeof fs.write;
			assert.equal(cleanupWorktrees(setup), undefined);
			assert.equal(fs.readFileSync(recordPath, "utf8"), "1\n0\n");
			for (const w of setup.worktrees) {
				assert.equal(fs.existsSync(w.path), false);
				assert.equal(git(repo, ["branch", "--list", w.branch]), "");
			}
			assert.equal(warnings.length, 1);
			assert.ok(warnings[0]!.includes(setup.worktrees[1]!.path));
			assert.match(warnings[0]!, /worktree remove.*fatal:/);
			assert.equal(git(repo, ["worktree", "list", "--porcelain"]).split("worktree ").length - 1, 1);
		} finally { fs.write = write; cleanupRepo(repo); cleanupRepo(records); }
	});
});
