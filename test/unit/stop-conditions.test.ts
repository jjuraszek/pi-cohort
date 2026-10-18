import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateStopCondition, formatStopCondition, stopConditionShapeError, validateStopConditions } from "../../src/runs/shared/stop-conditions.ts";

const schema = { type: "object" };

describe("stopConditionShapeError", () => {
	it("accepts a pointer and a non-empty string list", () => {
		for (const path of ["/verdict", ""]) assert.equal(stopConditionShapeError({ path, in: ["FAIL"] }, "x.stopOn"), undefined);
	});
	it("rejects malformed conditions", () => {
		for (const [value, expected] of [
			["nope", "x.stopOn must be an object with path and in."],
			[{ path: 1, in: ["FAIL"] }, 'x.stopOn.path \'1\' is not a JSON Pointer (must be "" or start with "/").'],
			[{ path: "verdict", in: ["FAIL"] }, 'x.stopOn.path \'verdict\' is not a JSON Pointer (must be "" or start with "/").'],
			...[[], "FAIL", ["FAIL", 1]].map((list) => [{ path: "/v", in: list }, "x.stopOn.in must be a non-empty array of strings."]),
		] as const) assert.equal(stopConditionShapeError(value, "x.stopOn"), expected);
		assert.equal(stopConditionShapeError({ path: 5, in: ["FAIL"] }, "Chain step 1 stopOn"), 'Chain step 1 stopOn.path \'5\' is not a JSON Pointer (must be "" or start with "/").');
	});
});

describe("validateStopConditions", () => {
	it("accepts absent conditions and schema-backed step shapes", () => {
		assert.equal(validateStopConditions([{ agent: "a" }]), undefined);
		assert.equal(validateStopConditions([{ agent: "a", outputSchema: schema, stopOn: { path: "/v", in: ["FAIL"] } }]), undefined);
		assert.equal(validateStopConditions([{ parallel: [{ agent: "a", outputSchema: schema }, { agent: "b", outputSchema: schema }], stopOn: { path: "/v", in: ["FAIL"] } }]), undefined);
		assert.equal(validateStopConditions([{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "r", outputSchema: schema }, collect: { as: "reviews" }, stopOn: { path: "/v", in: ["FAIL"] } }]), undefined);
	});
	it("rejects missing schemas on each step shape", () => {
		assert.equal(validateStopConditions([{ agent: "a", stopOn: { path: "/v", in: ["FAIL"] } }]), "Chain step 1 has stopOn but no outputSchema.");
		assert.equal(validateStopConditions([{ agent: "x" }, { parallel: [{ agent: "a", outputSchema: schema }, { agent: "b" }], stopOn: { path: "/v", in: ["FAIL"] } }]), "Chain step 2 task 2 has no outputSchema; stopOn requires one on every task.");
		assert.equal(validateStopConditions([{ expand: { from: { output: "targets", path: "/items" }, maxItems: 2 }, parallel: { agent: "r" }, collect: { as: "reviews" }, stopOn: { path: "/v", in: ["FAIL"] } }]), "Chain step 1 task 1 has no outputSchema; stopOn requires one on every task.");
	});
	it("prefixes condition errors with the step number", () => {
		assert.equal(validateStopConditions([{ agent: "a", outputSchema: schema, stopOn: { path: "bad", in: ["FAIL"] } }]), 'Chain step 1 stopOn.path \'bad\' is not a JSON Pointer (must be "" or start with "/").');
		assert.equal(validateStopConditions([{ agent: "a", outputSchema: schema, stopOn: { path: "/v", in: [] } }]), "Chain step 1 stopOn.in must be a non-empty array of strings.");
	});
});

describe("evaluateStopCondition", () => {
	const condition = { path: "/verdict", in: ["FAIL", "BLOCKED"] };
	it("matches strings in task order with zero-based indices and metadata", () => {
		assert.deepEqual(evaluateStopCondition(condition, 1, [
			{ agent: "r", exitCode: 0, structuredOutput: { verdict: "PASS" } },
			{ agent: "r", as: "sr_2", label: "two", exitCode: 0, structuredOutput: { verdict: "FAIL" } },
			{ agent: "r", as: "sr_3", exitCode: 0, structuredOutput: { verdict: "BLOCKED" } },
		]), [
			{ stepIndex: 1, taskIndex: 1, as: "sr_2", label: "two", agent: "r", value: "FAIL" },
			{ stepIndex: 1, taskIndex: 2, as: "sr_3", agent: "r", value: "BLOCKED" },
		]);
	});
	it("omits taskIndex for sequential steps", () => {
		assert.deepEqual(evaluateStopCondition(condition, 0, [{ agent: "r", exitCode: 0, structuredOutput: { verdict: "FAIL" } }], { sequential: true }), [{ stepIndex: 0, agent: "r", value: "FAIL" }]);
	});
	it("ignores non-strings, missing paths, and invalid array indices", () => {
		assert.deepEqual(evaluateStopCondition(condition, 0, [1, null, ["FAIL"]].map((verdict) => ({ agent: "r", exitCode: 0, structuredOutput: { verdict } }))), []);
		for (const [path, structuredOutput] of [["/verdict", {}], ["/verdict", "FAIL"], ["/verdict/5", { verdict: ["FAIL"] }], ["/verdict/x", { verdict: ["FAIL"] }]] as const) {
			assert.deepEqual(evaluateStopCondition({ path, in: ["FAIL"] }, 0, [{ agent: "r", exitCode: 0, structuredOutput }]), []);
		}
	});
	it("matches a root string", () => {
		assert.deepEqual(evaluateStopCondition({ path: "", in: ["FAIL"] }, 0, [{ agent: "r", exitCode: 0, structuredOutput: "FAIL" }]), [{ stepIndex: 0, taskIndex: 0, agent: "r", value: "FAIL" }]);
	});
	it("skips unsuccessful tasks and absent structured output", () => {
		assert.deepEqual(evaluateStopCondition(condition, 0, [
			{ agent: "r", exitCode: 1, structuredOutput: { verdict: "FAIL" } },
			{ agent: "r", exitCode: -1, structuredOutput: { verdict: "FAIL" } },
			{ agent: "r", exitCode: 0 },
		]), []);
	});
});

describe("formatStopCondition", () => {
	it("renders pointer and bracketed list", () => {
		assert.equal(formatStopCondition({ path: "/verdict", in: ["FAIL", "BLOCKED"] }), "/verdict in [FAIL, BLOCKED]");
		assert.equal(formatStopCondition({ path: "", in: ["FAIL"] }), '"" in [FAIL]');
	});
});
