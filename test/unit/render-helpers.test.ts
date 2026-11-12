import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth } from "@earendil-works/pi-tui";
import { budgetLines, detailLine, row, targetLine } from "../../src/tui/render-helpers.ts";
import { renderSubagentResult } from "../../src/tui/render.ts";

const theme = {
	fg(_name: string, text: string): string {
		return text;
	},
	bold(text: string): string {
		return text;
	},
};

function componentText(component: unknown): string {
	if (typeof component !== "object" || component === null) return "";
	if ("text" in component && typeof component.text === "string") return component.text;
	if ("children" in component && Array.isArray(component.children)) return component.children.map(componentText).filter(Boolean).join("\n");
	return "";
}

function result(agent: string, output: string) {
	return {
		id: `${agent.padEnd(6, "x")}-child`,
		agent,
		task: `${agent} task`,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		finalOutput: output,
	};
}

for (const mode of ["single", "parallel", "chain"] as const) {
	for (const expanded of [false, true]) test(`${mode} ${expanded ? "expanded" : "compact"} rows use their own six-character ids and labels`, () => {
		const results = ["scout", ...(mode === "single" ? [] : ["writer"])].map((agent, index) => ({
			...result(agent, "done"), id: `collid-${agent}`, label: "audit auth",
			progress: { id: `collid-${agent}`, agent, index, status: "completed", children: [{ id: `n-${agent}-full`, parentRunId: "abcdef-root", depth: 1, path: [], state: "running", agent: "worker", label: "nested audit", lastUpdate: 1 }] },
		}));
		const text = componentText(renderSubagentResult({ content: [], details: { mode, runId: "abcdef-root", results } }, { expanded }, theme as any));
		const lines = text.split("\n");
		assert.equal(lines[0]!.trim().split(" ")[0], mode === "single" ? "collid" : "abcdef");
		for (const child of results) {
			assert.ok(lines.some((line) => line.trim().startsWith(`${child.id.slice(0, 6)} `) && line.includes(`${child.agent} - audit auth`)));
			assert.ok(!text.includes(child.id));
			const nestedId = child.progress.children[0]!.id;
			assert.equal(lines.some((line) => line.trim().startsWith(`${nestedId.slice(0, 6)} `) && line.includes("worker - nested audit")), expanded, "only expanded foreground views draw nested rows");
		}
		assert.equal(lines.filter((line) => line.trim().startsWith("collid ")).length, results.length, "collisions never widen settled row tokens");
		assert.ok(!text.includes("abcdef-root"));
		assert.ok(!lines.filter((line) => /Task:|task:/.test(line)).some((line) => /^\s*\S{6} /.test(line)));
	});
}

for (const expanded of [false, true]) test(`chain ${expanded ? "expanded" : "compact"} separates unallocated workflow details from pending target rows`, () => {
	const progress = { id: "queued-child", agent: "writer", label: "later", index: 1, status: "pending", toolCount: 0, tokens: 0, durationMs: 0, recentTools: [], recentOutput: [] };
	const text = componentText(renderSubagentResult({ content: [], details: {
		mode: "chain", runId: "abcdef-root", chainAgents: ["scout", "writer", "auditor"],
		results: [result("scout", "done")], progress: [progress],
	} }, { expanded }, theme as any));
	assert.match(text, /^\s*queued .*Step 2: writer - later.*pending/m);
	assert.match(text, /Workflow step 3: auditor.*pending/);
	assert.doesNotMatch(text, /^\s*(?:◦ )?Step 3:/m);
});

test("line budgets discard details before settled rows and never discard live targets", () => {
	const lines = [targetLine("settled", false), detailLine("activity"), targetLine("running", true), targetLine("queued", true)];
	for (const { name, budget, expected } of [
		{ name: "detail first", budget: 3, expected: ["settled", "running", "queued"] },
		{ name: "live overflow", budget: 1, expected: ["running", "queued"] },
	]) assert.deepEqual(budgetLines(lines, budget).map((line) => line.text), expected, name);
});

test("row clips content to the available width", () => {
	const rendered = row("abcdef", 6, theme as any);
	assert.equal(visibleWidth(rendered), 6);
});

test("row normalizes multiline content before clipping", () => {
	const rendered = row("bash failed: line 1\nline 2\tvalue", 20, theme as any);
	assert.equal(visibleWidth(rendered), 20);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});

test("row keeps styled multiline content within the available width", () => {
	const rendered = row("\u001b[31merror line 1\nline 2\tvalue\u001b[39m", 18, theme as any);
	assert.equal(visibleWidth(rendered), 18);
	assert.doesNotMatch(rendered, /[\r\n\t]/);
});

test("compact chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
	assert.match(text, /Parallel group 2: Review targets/);
	assert.doesNotMatch(text, /reviewer - Review targets/);
});

test("compact chain rendering shows failed zero-child dynamic fanout groups", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "failed" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets")],
			workflowGraph: {
				runId: "render-empty-dynamic-failed",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "failed",
						stepIndex: 1,
						children: [],
						error: "No review targets materialized",
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "pending", stepIndex: 2 },
				],
			},
		},
	}, { expanded: false }, theme as any);

	const text = componentText(component);
	assert.match(text, /step 1\/3/);
	assert.doesNotMatch(text, /step 3\/3/);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Parallel group 2: Review targets .* failed/);
	assert.match(text, /No review targets materialized/);
	assert.match(text, /Workflow step 3: writer .* pending/);
});

test("expanded chain rendering uses workflow graph spans for dynamic fanout results", () => {
	const component = renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "expand:reviewer", "writer"],
			totalSteps: 3,
			results: [result("scout", "targets"), result("reviewer", "a"), result("reviewer", "b"), result("writer", "final")],
			workflowGraph: {
				runId: "render-dynamic-expanded",
				mode: "chain",
				phases: [],
				nodes: [
					{ id: "step-0", kind: "step", agent: "scout", label: "Scout", status: "completed", flatIndex: 0, stepIndex: 0 },
					{
						id: "step-1",
						kind: "dynamic-parallel-group",
						label: "Review targets",
						status: "completed",
						stepIndex: 1,
						children: [
							{ id: "step-1-item-a", kind: "agent", agent: "reviewer", label: "Review A", status: "completed", flatIndex: 1, stepIndex: 1 },
							{ id: "step-1-item-b", kind: "agent", agent: "reviewer", label: "Review B", status: "completed", flatIndex: 2, stepIndex: 1 },
						],
						dynamic: { sourceOutput: "targets", sourcePath: "/items", itemName: "target", collectAs: "reviews" },
					},
					{ id: "step-2", kind: "step", agent: "writer", label: "Writer", status: "completed", flatIndex: 3, stepIndex: 2 },
				],
			},
		},
	}, { expanded: true }, theme as any);

	const text = componentText(component);
	assert.match(text, /Step 1: scout/);
	assert.match(text, /Agent 1\/2: reviewer/);
	assert.match(text, /Agent 2\/2: reviewer/);
	assert.match(text, /Step 3: writer/);
});

test("static sequential and static parallel chain rendering keep existing labels", () => {
	const sequential = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "writer"],
			totalSteps: 2,
			results: [result("scout", "a"), result("writer", "b")],
		},
	}, { expanded: false }, theme as any));
	assert.match(sequential, /Step 1: scout/);
	assert.match(sequential, /Step 2: writer/);

	const parallel = componentText(renderSubagentResult({
		content: [{ type: "text", text: "done" }],
		details: {
			mode: "chain",
			chainAgents: ["scout", "[reviewer+auditor]", "writer"],
			totalSteps: 3,
			results: [result("scout", "a"), result("reviewer", "b"), result("auditor", "c"), result("writer", "d")],
		},
	}, { expanded: false }, theme as any));
	assert.match(parallel, /Step 1: scout/);
	assert.match(parallel, /Agent 1\/2: reviewer/);
	assert.match(parallel, /Agent 2\/2: auditor/);
	assert.match(parallel, /Step 3: writer/);
});
