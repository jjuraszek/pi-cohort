import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ChainOutputValidationError,
	outputEntryFromAsyncResult,
	outputEntryFromResult,
	resolveOutputReferences,
	validateChainOutputBindings,
} from "../../src/runs/shared/chain-outputs.ts";

const schema = { type: "object" };

describe("validateChainOutputBindings - stopOn", () => {
	it("rejects a stopOn step without outputSchema through ChainOutputValidationError", () => {
		assert.throws(
			() => validateChainOutputBindings([{ agent: "a", stopOn: { path: "/v", in: ["FAIL"] } }]),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Chain step 1 has stopOn but no outputSchema.",
		);
	});
	it("accepts a valid stopOn step", () => {
		validateChainOutputBindings([{ parallel: [{ agent: "a", outputSchema: schema, as: "r1" }], stopOn: { path: "/v", in: ["FAIL"] } }]);
	});
});

describe("validateChainOutputBindings - patchPath references", () => {
	it("accepts {outputs.name.patchPath} when the producer is a worktree parallel step", () => {
		validateChainOutputBindings([
			{ parallel: [{ agent: "impl", as: "impl_1" }], worktree: true },
			{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
		]);
	});
	it("rejects {outputs.name.patchPath} when the producer is not a worktree step", () => {
		assert.throws(
			() => validateChainOutputBindings([
				{ parallel: [{ agent: "impl", as: "impl_1" }] },
				{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
			]),
			(error: unknown) => error instanceof ChainOutputValidationError
				&& error.message === "Chain step 2 references {outputs.impl_1.patchPath} but step 1 is not a worktree step.",
		);
		assert.throws(
			() => validateChainOutputBindings([
				{ agent: "impl", as: "impl_1" },
				{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
			]),
			/step 1 is not a worktree step/,
		);
	});
	it("still rejects unknown sub-fields and unknown names", () => {
		assert.throws(
			() => validateChainOutputBindings([
				{ parallel: [{ agent: "impl", as: "impl_1" }], worktree: true },
				{ agent: "reviewer", task: "Review {outputs.impl_1.other}" },
			]),
			/Invalid chain output reference '\{outputs\.impl_1\.other\}'/,
		);
		assert.throws(
			() => validateChainOutputBindings([{ agent: "reviewer", task: "Review {outputs.nope.patchPath}" }]),
			/Unknown chain output reference '\{outputs\.nope\.patchPath\}'/,
		);
	});
});

describe("resolveOutputReferences - patchPath", () => {
	it("substitutes the bound patch path", () => {
		const text = resolveOutputReferences("Read {outputs.impl_1.patchPath} and {outputs.impl_1}", {
			impl_1: { text: "{\"status\":\"DONE\"}", agent: "impl", stepIndex: 0, patchPath: "/run/worktree-diffs/step-0/task-0-impl.patch" },
		});
		assert.equal(text, "Read /run/worktree-diffs/step-0/task-0-impl.patch and {\"status\":\"DONE\"}");
	});
	it("throws naming no changes when the entry has no patch", () => {
		assert.throws(
			() => resolveOutputReferences("{outputs.impl_1.patchPath}", { impl_1: { text: "x", agent: "impl", stepIndex: 0 } }),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Output 'impl_1' has no patch (no changes).",
		);
	});
	it("throws naming the capture failure", () => {
		assert.throws(
			() => resolveOutputReferences("{outputs.impl_1.patchPath}", { impl_1: { text: "x", agent: "impl", stepIndex: 0, patchError: "git diff failed" } }),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Output 'impl_1' has no patch (capture failed: git diff failed).",
		);
	});
});

describe("outputEntryFromResult / outputEntryFromAsyncResult - patch fields", () => {
	const result = { agent: "impl", exitCode: 0, finalOutput: "done", messages: [], structuredOutput: { status: "DONE" } };
	it("binds patchPath only when given, and never patchError at the same time", () => {
		assert.deepEqual(outputEntryFromResult(result as never, 0), { text: "{\"status\":\"DONE\"}", structured: { status: "DONE" }, agent: "impl", stepIndex: 0 });
		assert.equal(outputEntryFromResult(result as never, 0, { patchPath: "/p.patch" }).patchPath, "/p.patch");
		assert.equal(outputEntryFromResult(result as never, 0, { patchError: "boom" }).patchError, "boom");
		assert.equal(outputEntryFromAsyncResult({ agent: "impl", output: "done" }, 2, { patchPath: "/q.patch" }).patchPath, "/q.patch");
		assert.equal(outputEntryFromAsyncResult({ agent: "impl", output: "done" }, 2).patchPath, undefined);
	});
});
