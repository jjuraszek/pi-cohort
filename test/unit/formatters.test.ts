import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as formatters from "../../src/shared/formatters.ts";
import type { ChainTaskOutputEntry, SingleResult, StopRecord } from "../../src/shared/types.ts";

const { buildChainSummary } = formatters;
const cleanupWarning = "Process termination could not be confirmed; manual cleanup may be required.";

describe("formatInterruptedCleanup", () => {
	for (const { name, children, expected } of [
		{ name: "no children", children: [], expected: "" },
		{ name: "clean interrupted children", children: [{ agent: "reviewer", interrupted: true }, { agent: "reviewer", interrupted: true, error: "" }], expected: "" },
		{ name: "ordinary failures", children: [{ agent: "reviewer", exitCode: 1, error: cleanupWarning }], expected: "" },
		{ name: "one uncertain interruption", children: [{ agent: "reviewer", interrupted: true, error: cleanupWarning }], expected: `\n\nChild 1 (reviewer): ${cleanupWarning}` },
		{
			name: "mixed batch with repeated agents and verbatim diagnostics",
			children: [
				{ agent: "reviewer", exitCode: 0 },
				{ agent: "reviewer", interrupted: true, error: cleanupWarning },
				{ agent: "reviewer", interrupted: true, error: `Missing terminal result.\n${cleanupWarning}` },
			],
			expected: `\n\nChild 2 (reviewer): ${cleanupWarning}\nChild 3 (reviewer): Missing terminal result.\n${cleanupWarning}`,
		},
	]) {
		it(name, () => {
			assert.equal(typeof formatters.formatInterruptedCleanup, "function");
			const text = formatters.formatInterruptedCleanup(children as SingleResult[]);
			assert.equal(text, expected);
			assert.equal(`Paused.${text}`, `Paused.${expected}`);
		});
	}
});

const steps = [
	{ parallel: [{ agent: "implementer", as: "impl_1", outputSchema: { type: "object" } }], worktree: true, stopOn: { path: "/status", in: ["BLOCKED"] } },
	{ parallel: [{ agent: "spec-reviewer", as: "sr_1", outputSchema: { type: "object" } }, { agent: "spec-reviewer", as: "sr_2", outputSchema: { type: "object" } }], stopOn: { path: "/verdict", in: ["FAIL"] } },
	{ agent: "code-reviewer" },
];
const results = [
	{ agent: "implementer", exitCode: 0 },
	{ agent: "spec-reviewer", exitCode: 0 },
	{ agent: "spec-reviewer", exitCode: -1 },
] as never[];
const stop: StopRecord = {
	reason: "condition",
	stepIndex: 1,
	condition: { path: "/verdict", in: ["FAIL"] },
	matches: [{ stepIndex: 1, taskIndex: 0, as: "sr_1", label: "task 3 review", agent: "spec-reviewer", value: "FAIL" }],
};
const outputs: ChainTaskOutputEntry[] = [
	{ stepIndex: 0, taskIndex: 0, agent: "implementer", as: "impl_1", text: "Implemented the thing.", structured: { status: "DONE" }, exitCode: 0 },
	{ stepIndex: 1, taskIndex: 0, agent: "spec-reviewer", as: "sr_1", text: "Missing edge case.", structured: { verdict: "FAIL" }, exitCode: 0 },
	{ stepIndex: 1, taskIndex: 1, agent: "spec-reviewer", as: "sr_2", text: "", exitCode: -1 },
];
const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), "formatters-"));

describe("buildChainSummary", () => {
	it("renders a stopped header, the Stop record, and Outputs grouped by step", () => {
		const text = buildChainSummary(steps as never, results, chainDir, "stopped", undefined, { stop, outputs });
		assert.match(text, /^⏹ Chain stopped at step 2\/3 by condition \/verdict in \[FAIL\]/);
		assert.match(text, /📁 Artifacts: /);
		const stopBlock = text.slice(text.indexOf("## Stop"));
		assert.match(stopBlock, /^## Stop\n```json\n/);
		assert.deepEqual(JSON.parse(stopBlock.split("```json\n")[1]!.split("\n```")[0]!), stop);
		assert.match(text, /## Outputs\n### Step 1\n#### Task 1 \(implementer, as impl_1\)\nImplemented the thing\.\n```json\n\{"status":"DONE"\}\n```/);
		assert.match(text, /### Step 2\n#### Task 1 \(spec-reviewer, as sr_1\)\nMissing edge case\.\n```json\n\{"verdict":"FAIL"\}\n```\n#### Task 2 \(spec-reviewer, as sr_2\) - skipped \(fail-fast\)\n/);
		assert.ok(text.indexOf("## Stop") < text.indexOf("## Outputs"));
	});

	it("appends Stop and Outputs to a failed summary", () => {
		const failedOutputs: ChainTaskOutputEntry[] = [
			...outputs.slice(0, 2),
			{ stepIndex: 1, taskIndex: 1, agent: "spec-reviewer", as: "sr_2", text: "", exitCode: 1, error: "crashed" },
		];
		const text = buildChainSummary(steps as never, results, chainDir, "failed", { index: 1, error: "Parallel step 2 failed" }, { stop, outputs: failedOutputs });
		assert.match(text, /^❌ Chain failed at step 2: Parallel step 2 failed/);
		assert.match(text, /## Stop\n```json/);
		assert.match(text, /#### Task 2 \(spec-reviewer, as sr_2\) - failed\ncrashed\n/);
	});

	it("renders Outputs without Stop on a completed chain that carries stopOn", () => {
		const text = buildChainSummary(steps as never, results, chainDir, "completed", undefined, { outputs });
		assert.match(text, /^✅ Chain completed/);
		assert.doesNotMatch(text, /## Stop/);
		assert.match(text, /## Outputs\n### Step 1/);
	});

	it("is unchanged when no options are passed", () => {
		const before = buildChainSummary(steps as never, results, chainDir, "completed");
		assert.doesNotMatch(before, /## Outputs|## Stop/);
		assert.match(before, /^✅ Chain completed: parallel\[1\] → parallel\[2\] → code-reviewer/);
	});

	it("renders a task without structured output as text only, and a sequential step as one task heading", () => {
		const text = buildChainSummary(steps as never, results, chainDir, "completed", undefined, {
			outputs: [{ stepIndex: 2, taskIndex: 0, agent: "code-reviewer", text: "SHIP", exitCode: 0 }],
		});
		assert.match(text, /### Step 3\n#### Task 1 \(code-reviewer\)\nSHIP\n/);
		assert.doesNotMatch(text, /```json/);
	});
});
