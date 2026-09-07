import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachNestedChildrenToResultChildren, resolveSubagentResultStatus } from "../../src/runs/shared/result-children.ts";

describe("result children", () => {
	it("classifies result status", () => {
		assert.equal(resolveSubagentResultStatus({ interrupted: true }), "paused");
		assert.equal(resolveSubagentResultStatus({ success: true }), "completed");
		assert.equal(resolveSubagentResultStatus({ exitCode: 1 }), "failed");
	});

	it("attaches compact nested children without control secrets", () => {
		const children = attachNestedChildrenToResultChildren("root", [{ agent: "owner", status: "completed", summary: "done" }], [{
			id: "nested", parentRunId: "root", depth: 1, path: [{ runId: "root" }], state: "complete", controlInbox: "/tmp/secret", capabilityToken: "secret",
		}]);
		assert.equal(children[0]?.children?.[0]?.id, "nested");
		assert.equal(Object.hasOwn(children[0]?.children?.[0] ?? {}, "controlInbox"), false);
		assert.equal(Object.hasOwn(children[0]?.children?.[0] ?? {}, "capabilityToken"), false);
	});

	it("routes nested children by parent step and preserves step summaries", () => {
		const children = attachNestedChildrenToResultChildren("root-run", [
			{ agent: "owner-a", status: "completed", summary: "done", index: 0 },
			{ agent: "owner-b", status: "completed", summary: "done", index: 1 },
		], [{
			id: "nested-a",
			parentRunId: "root-run",
			parentStepIndex: 1,
			depth: 1,
			path: [{ runId: "root-run", stepIndex: 1 }],
			state: "complete",
			steps: [{
				agent: "reviewer",
				status: "complete",
				activityState: "active_long_running",
				lastActivityAt: 1,
				currentTool: "read",
				currentToolStartedAt: 2,
				currentPath: "/tmp/input",
				turnCount: 3,
				toolCount: 4,
				startedAt: 5,
				endedAt: 6,
				error: "failure",
			}],
			children: [{
				id: "nested-grandchild",
				parentRunId: "nested-a",
				depth: 2,
				path: [{ runId: "root-run", stepIndex: 1 }, { runId: "nested-a" }],
				state: "complete",
			}],
		}]);

		const nested = children[1]?.children?.[0];
		const step = nested?.steps?.[0];
		assert.equal(children[0]?.children, undefined);
		assert.equal(nested?.id, "nested-a");
		assert.equal(nested?.children?.[0]?.id, "nested-grandchild");
		assert.deepEqual(step, {
			agent: "reviewer",
			status: "complete",
			activityState: "active_long_running",
			lastActivityAt: 1,
			currentTool: "read",
			currentToolStartedAt: 2,
			currentPath: "/tmp/input",
			turnCount: 3,
			toolCount: 4,
			startedAt: 5,
			endedAt: 6,
			error: "failure",
		});
	});
});
