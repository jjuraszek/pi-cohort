import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./worktree.ts";

/** A repository's common dir (shared by its worktrees), distinguishing worktree content from git metadata. */
interface RepoLocation {
	commonDir: string;
	insideWorkTree: boolean;
}

/** The parent session's project-trust decision and the directory it was made for. */
export interface ProjectTrust {
	trusted: boolean;
	root: string;
	/** The root's cached repository location, when it belongs to a repository. */
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
	const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree", "--git-common-dir"]);
	if (result.status !== 0) return undefined;
	const [insideWorkTree, common] = result.stdout.split(/\r?\n/);
	return common ? { commonDir: realpathOrResolve(path.resolve(cwd, common)), insideWorkTree: insideWorkTree === "true" } : undefined;
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
 * Whether a child cwd belongs to the parent's project: any directory in a worktree sharing the parent's git common dir,
 * or, outside git, the parent's directory and its descendants on real paths. Nested repositories and submodules are
 * separate projects; git metadata never inherits trust.
 */
export function inheritsTrust(childCwd: string, trust: ProjectTrust): boolean {
	const child = realpathOrResolve(childCwd);
	const root = realpathOrResolve(trust.root);
	const parentRepo = trust.repo ?? repoLocation(root);
	const repo = repoLocation(child);
	if (parentRepo) {
		return parentRepo.insideWorkTree && repo?.insideWorkTree === true && repo.commonDir === parentRepo.commonDir;
	}
	if (repo) return false;
	const relative = path.relative(root, child);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
