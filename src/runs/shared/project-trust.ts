import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./worktree.ts";

/** Where a directory sits in a git repository: the repository's common dir (shared by all its worktrees) and the path below the worktree root. */
interface RepoLocation {
	commonDir: string;
	prefix: string;
}

/** The parent session's project-trust decision and the directory it was made for. */
export interface ProjectTrust {
	trusted: boolean;
	root: string;
	/** The root's repository location, resolved once so each child launch spawns git for the child only. */
	repo?: RepoLocation;
}

// The native realpath also canonicalizes Windows 8.3 short names and drive-letter case, which the JS one keeps as given.
function realpathOrResolve(dir: string): string {
	try {
		return fs.realpathSync.native(dir);
	} catch {
		return path.resolve(dir);
	}
}

function repoLocation(cwd: string): RepoLocation | undefined {
	const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree", "--git-common-dir", "--show-prefix"]);
	if (result.status !== 0) return undefined;
	const [insideWorkTree, common, prefix = ""] = result.stdout.split(/\r?\n/);
	return insideWorkTree === "true" && common ? { commonDir: realpathOrResolve(path.resolve(cwd, common)), prefix } : undefined;
}

/**
 * The decision children inherit, or undefined when there is none to pass on: pi trusts a directory without
 * trust-requiring resources by default, and that default must not become an explicit --approve for a child elsewhere.
 */
export function resolveProjectTrust(cwd: string, trusted: boolean, hasTrustRequiringResources: (cwd: string) => boolean): ProjectTrust | undefined {
	if (trusted && !hasTrustRequiringResources(cwd)) return undefined;
	const root = realpathOrResolve(cwd);
	const repo = repoLocation(root);
	return repo ? { trusted, root, repo } : { trusted, root };
}

/**
 * Whether a child cwd is the directory the parent's decision was made for: the parent's cwd itself, or the same path in
 * another worktree of its repository. pi keys trust by directory, so any other directory, including one below the
 * parent's, resolves its own decision; a saved decision for an ancestor still reaches it through pi's nearest-ancestor lookup.
 */
export function inheritsTrust(childCwd: string, trust: ProjectTrust): boolean {
	const child = realpathOrResolve(childCwd);
	if (child === realpathOrResolve(trust.root)) return true;
	if (!trust.repo) return false;
	const repo = repoLocation(child);
	return repo?.commonDir === trust.repo.commonDir && repo.prefix === trust.repo.prefix;
}
