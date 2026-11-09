import * as fs from "node:fs";
import * as path from "node:path";
import { runGit } from "./worktree.ts";

/** The parent session's project-trust decision and the directory it was made for. */
export interface ProjectTrust {
	trusted: boolean;
	root: string;
}

// The native realpath also canonicalizes Windows 8.3 short names and drive-letter case, which the JS one keeps as given.
function realpathOrResolve(dir: string): string {
	try {
		return fs.realpathSync.native(dir);
	} catch {
		return path.resolve(dir);
	}
}

function gitCommonDir(cwd: string): string | undefined {
	const result = runGit(cwd, ["rev-parse", "--git-common-dir"]);
	if (result.status !== 0) return undefined;
	const common = result.stdout.trim();
	return common ? realpathOrResolve(path.resolve(cwd, common)) : undefined;
}

/** Whether a child cwd runs the same project as root: the same git repository (any of its worktrees), or, outside git, inside root's tree. */
export function sharesProject(childCwd: string, root: string): boolean {
	const child = realpathOrResolve(childCwd);
	const base = realpathOrResolve(root);
	// A repository initialized inside root's tree is a separate project.
	const childRepo = gitCommonDir(child);
	if (childRepo !== gitCommonDir(base)) return false;
	if (childRepo !== undefined) return true;
	const relative = path.relative(base, child);
	return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
