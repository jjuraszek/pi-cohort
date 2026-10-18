import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchPathForDiff, type WorktreeDiff } from "../../src/runs/shared/worktree.ts";

function diff(overrides: Partial<WorktreeDiff>): WorktreeDiff {
	return {
		index: 0,
		agent: "implementer",
		branch: "tmp",
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath: "/tmp/run/worktree-diffs/step-0/task-0-implementer.patch",
		...overrides,
	};
}

describe("patchPathForDiff", () => {
	it("returns the patch path when the diff has changes and no capture error", () => {
		assert.equal(patchPathForDiff(diff({ filesChanged: 1, insertions: 2 })), "/tmp/run/worktree-diffs/step-0/task-0-implementer.patch");
		assert.equal(patchPathForDiff(diff({ diffStat: " a.ts | 1 +" })), "/tmp/run/worktree-diffs/step-0/task-0-implementer.patch");
	});
	it("returns undefined for an unchanged worktree", () => {
		assert.equal(patchPathForDiff(diff({})), undefined);
	});
	it("returns undefined when capture failed, even with counts", () => {
		assert.equal(patchPathForDiff(diff({ filesChanged: 3, captureError: "git diff failed" })), undefined);
	});
});
