import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWidgetLines, widgetRenderKey } from "../../src/tui/render.ts";
import { formatNestedRunStatusLines } from "../../src/runs/shared/nested-render.ts";
import type { AsyncJobState, NestedRunSummary } from "../../src/shared/types.ts";

const theme = {
	fg(_name: string, text: string): string { return text; },
	bold(text: string): string { return text; },
};

function nested(id: string, parentRunId: string, state: NestedRunSummary["state"] = "running", extra: Partial<NestedRunSummary> = {}): NestedRunSummary {
	return {
		id,
		parentRunId,
		parentStepIndex: 0,
		depth: 1,
		path: [{ runId: parentRunId, stepIndex: 0 }],
		state,
		agent: id,
		lastUpdate: 1_000,
		...extra,
	};
}

function job(child: NestedRunSummary): AsyncJobState {
	return {
		asyncId: "root-run",
		asyncDir: "/tmp/root-run",
		status: "running",
		mode: "single",
		agents: ["owner"],
		startedAt: 0,
		updatedAt: 1_500,
		steps: [{ id: "owner1-child", index: 0, agent: "owner", status: "running", children: [child] }],
		stepsTotal: 1,
		nestedChildren: [child],
	};
}

describe("nested widget rendering", () => {
	for (const view of ["text", "expanded widget"] as const) it(`${view} retains queued and running rows plus settled ancestors beyond its budgets`, () => {
		const leaves = Array.from({ length: 16 }, (_, index) => nested(`c${String(index).padStart(5, "0")}-child`, "parent-full", index % 2 ? "queued" : "running", { agent: "worker", label: "audit", parentStepIndex: undefined }));
		const root = nested("parent-full", "root-run", "complete", {
			children: [nested("middle-full", "parent-full", "complete", {
				children: [nested("deeper-full", "middle-full", "complete", { children: leaves })],
			})],
		});
		const text = (view === "text"
			? formatNestedRunStatusLines([root], { maxLines: 2, maxDepth: 1, commandHints: true })
			: buildWidgetLines([job(root)], theme as any, 80, view === "expanded widget")).join("\n");
		for (const id of ["parent-full", "middle-full", "deeper-full", ...leaves.map((child) => child.id)]) {
			assert.match(text, new RegExp(`^\\s*${id.slice(0, 6)} `, "m"));
		}
		assert.match(text, /worker - audit/);
	});
	it("keeps nested counts collapsed and draws child rows only when expanded", () => {
		const child = nested("nested-reviewer", "root-run", "running", { currentTool: "read" });
		const collapsed = buildWidgetLines([job(child)], theme as any, 120, false).join("\n");
		assert.match(collapsed, /↳ \+1 nested run \(1 running\)/);
		assert.doesNotMatch(collapsed, /^\s*nested ↳/m);
		assert.doesNotMatch(collapsed, /nested-reviewer/);

		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.equal(expanded.split("\n")[1]?.split(" ")[0], "root-r");
		assert.match(expanded, /^\s*nested ↳ . nested-reviewer · running · read/m);
	});

	it("keeps live descendants beyond the nested depth budget", () => {
		const root = nested("nested-root", "root-run", "running", {
			children: [nested("nested-child", "nested-root", "running", {
				parentStepIndex: undefined,
				children: [nested("nested-grandchild", "nested-child", "running", {
					parentStepIndex: undefined,
					children: [nested("nested-great-grandchild", "nested-grandchild")],
				})],
			})],
		});
		const expanded = buildWidgetLines([job(root)], theme as any, 160, true).join("\n");
		assert.match(expanded, /nested-grandchild/);
		assert.match(expanded, /^\s*nested ↳ . nested-great-grandchild · running/m);
	});

	it("shows running descendants even after the parent step is complete", () => {
		const child = nested("still-running", "root-run", "running");
		const state = job(child);
		state.status = "complete";
		state.steps![0]!.status = "complete";
		const expanded = buildWidgetLines([state], theme as any, 120, true).join("\n");
		assert.match(expanded, /✓ Step 1\/1: owner · complete/);
		assert.match(expanded, /↳ . still-running · running/);
	});

	it("degrades stale child summaries to id and state", () => {
		const child = nested("missing-metadata", "root-run", "failed", { agent: undefined, error: "owner gone" });
		const expanded = buildWidgetLines([job(child)], theme as any, 120, true).join("\n");
		assert.match(expanded, /^\s*missin ↳ . nested run · failed · Failed · owner gone/m);
		assert.doesNotMatch(expanded, /missing-metadata/);
	});

	for (const view of ["text", "widget"] as const) it(`${view} caps settled siblings independently of live siblings at depth`, () => {
		const root = nested("level0-root", "root-run", "complete", { children: [
			nested("level1-run", "level0-root", "complete", { children: [
				nested("level2-run", "level1-run", "complete", { children: [
					nested("alive1-run", "level2-run", "running", { steps: [{ id: "step01-child", agent: "worker", status: "running" }] }),
					nested("ended1-run", "level2-run", "complete"),
				] }),
			] }),
		] });
		const text = (view === "text" ? formatNestedRunStatusLines([root], { maxDepth: 2 }) : buildWidgetLines([job(root)], theme, 120, true)).join("\n");
		assert.match(text, /^\s*alive1 ↳/m);
		assert.match(text, /^\s*step01 ↳/m);
		assert.doesNotMatch(text, /ended1/);
		assert.match(text, /nested run.*complete/);
	});

	for (const active of [true, false]) it(`keeps dynamic group labels on ${active ? "active" : "settled"} widget headers`, () => {
		const steps = [{ id: "workaa-child", index: 0, agent: "worker", label: "audit auth", status: active ? "running" : "completed" }];
		const value = { asyncId: "rootaa-run", asyncDir: "/tmp/group", mode: "chain", status: active ? "running" : "complete", steps, stepsTotal: 1,
			activeParallelGroup: active, currentStep: 0, chainStepCount: 1, parallelGroups: [{ stepIndex: 0, start: 0, count: 1 }],
			workflowGraph: { version: 1, mode: "chain", nodes: [{ id: "step-0", kind: "dynamic-parallel-group", stepIndex: 0, label: "Audit group", status: active ? "running" : "completed", children: [{ id: "node-0", kind: "agent", flatIndex: 0, agent: "worker", label: "audit auth" }] }] } };
		for (const expanded of [false, true]) {
			const text = buildWidgetLines([value] as any, theme, 180, expanded).join("\n");
			assert.match(text, /Parallel group .*Audit group/);
			assert.match(text, /^\s*workaa .*worker - audit auth/m);
			assert.doesNotMatch(text, /worker - Audit group/);
		}
	});

	it("rerenders when only nested state changes", () => {
		const first = job(nested("nested-reviewer", "root-run", "running"));
		const second = job(nested("nested-reviewer", "root-run", "complete"));
		assert.notEqual(widgetRenderKey(first), widgetRenderKey(second));
	});
});
