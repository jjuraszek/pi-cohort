import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChain, parseJsonChain, serializeChain, serializeJsonChain } from "../../src/agents/chain-serializer.ts";

const chainContent = `---
name: review-chain
description: Review chain
---

## reviewer
output: report.md
outputMode: file-only

Review the diff
`;

describe("chain serializer", () => {
	it("round-trips step outputMode", () => {
		const parsed = parseChain(chainContent, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.outputMode, "file-only");
		assert.match(serializeChain(parsed), /outputMode: file-only/);
	});

	it("round-trips phase, label, as, and path-based outputSchema", () => {
		const parsed = parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
phase: Review
label: correctness pass
as: correctnessFindings
outputSchema: ./schemas/finding.schema.json

Review the diff
`, "project", "/tmp/review-chain.md");

		assert.equal(parsed.steps[0]?.phase, "Review");
		assert.equal(parsed.steps[0]?.label, "correctness pass");
		assert.equal(parsed.steps[0]?.as, "correctnessFindings");
		assert.equal(parsed.steps[0]?.outputSchema, "./schemas/finding.schema.json");
		const serialized = serializeChain(parsed);
		assert.match(serialized, /phase: Review/);
		assert.match(serialized, /label: correctness pass/);
		assert.match(serialized, /as: correctnessFindings/);
		assert.match(serialized, /outputSchema: \.\/schemas\/finding\.schema\.json/);
	});

	it("rejects inline outputSchema values in markdown chains", () => {
		assert.throws(
			() => parseChain(`---
name: review-chain
description: Review chain
---

## reviewer
outputSchema: {"type":"object"}

Review the diff
`, "project", "/tmp/review-chain.md"),
			/Inline outputSchema values are not supported/,
		);
	});

	it("rejects invalid dynamic JSON chains with useful diagnostics", () => {
		assert.throws(
			() => parseJsonChain(JSON.stringify({
				name: "bad-dynamic-review",
				description: "Bad dynamic targets",
				chain: [
					{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
					{
						expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
						parallel: [{ agent: "reviewer", task: "Review" }],
						collect: { as: "reviews" },
					},
				],
			}), "project", "/tmp/bad-dynamic-review.chain.json"),
			/static parallel arrays/,
		);
		assert.throws(
			() => parseJsonChain(JSON.stringify({ name: "bad", description: "Bad", chain: [1] }), "project", "/tmp/bad.chain.json"),
			/step 1 must be an object/,
		);
	});

	it("serializes JSON chains back to JSON", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			package: "code-analysis",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		const serialized = serializeJsonChain(parsed);
		assert.doesNotMatch(serialized, /^---/);
		const reparsed = JSON.parse(serialized) as { name?: string; package?: string; chain?: Array<{ collect?: { as?: string } }> };
		assert.equal(reparsed.name, "dynamic-review");
		assert.equal(reparsed.package, "code-analysis");
		assert.equal(reparsed.chain?.[1]?.collect?.as, "reviews");
	});

	it("parses declarative JSON chains with dynamic fanout", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "dynamic-review",
			description: "Review dynamic targets",
			chain: [
				{ agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 },
					parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } },
					collect: { as: "reviews" },
				},
			],
		}), "project", "/tmp/dynamic-review.chain.json");

		assert.equal(parsed.name, "dynamic-review");
		assert.equal(parsed.steps.length, 2);
		assert.deepEqual((parsed.steps[1] as { collect?: { as?: string } }).collect, { as: "reviews" });
		assert.deepEqual((parsed.steps[0] as { outputSchema?: unknown }).outputSchema, { type: "object" });
	});

	it("parses and validates acceptance in JSON chains", () => {
		const parsed = parseJsonChain(JSON.stringify({
			name: "accepted-chain",
			description: "Chain with acceptance gates",
			chain: [
				{ agent: "worker", task: "Fix bug", acceptance: { level: "checked", evidence: ["changed-files", "commands-run"] } },
				{
					parallel: [
						{ agent: "reviewer", task: "Review", acceptance: "attested" },
					],
				},
			],
		}), "project", "/tmp/accepted-chain.chain.json");

		assert.deepEqual((parsed.steps[0] as { acceptance?: unknown }).acceptance, { level: "checked", evidence: ["changed-files", "commands-run"] });
		assert.equal(((parsed.steps[1] as { parallel?: Array<{ acceptance?: unknown }> }).parallel?.[0]?.acceptance), "attested");
		for (const { chain, label } of [
			{ chain: [{ agent: "worker", acceptance: { level: "none" } }], label: "step 1 acceptance" },
			{ chain: [{ agent: "worker", task: "t", acceptance: "none" }], label: "step 1 acceptance" },
			{ chain: [{ parallel: [{ agent: "worker", task: "t", acceptance: "none" }] }], label: "step 1 parallel task 1 acceptance" },
			{ chain: [
				{ agent: "scout", task: "t", as: "seed", outputSchema: { type: "object" } },
				{ expand: { from: { output: "seed", path: "/items" }, maxItems: 2 }, parallel: { agent: "worker", task: "{item}", acceptance: "none" }, collect: { as: "results" } },
			], label: "step 2 dynamic template acceptance" },
		]) {
			assert.throws(
				() => parseJsonChain(JSON.stringify({ name: "bad-acceptance", description: "Bad acceptance", chain }), "project", "/tmp/bad-acceptance.chain.json"),
				{ message: `Invalid JSON chain '/tmp/bad-acceptance.chain.json': ${label}.reason is required when level is none.` },
			);
		}
	});
});

describe("chain-serializer stopOn", () => {
	const header = "---\nname: verdict-flow\ndescription: stop on FAIL\n---\n\n";

	it("parses a JSON stopOn line and round-trips byte-identically for hard values", () => {
		const conditions = [
			{ path: "/verdict", in: ["FAIL", "BLOCKED"] },
			{ path: "", in: ["FAIL"] },
			{ path: "/verdict", in: ["needs, context", "  padded  ", ""] },
		];
		for (const condition of conditions) {
			const content = `${header}## reviewer\noutputSchema: schemas/verdict.json\nstopOn: ${JSON.stringify(condition)}\n\nReview it\n`;
			const parsed = parseChain(content, "project", "/tmp/verdict-flow.chain.md");
			assert.deepEqual(parsed.steps[0]?.stopOn, condition);
			const serialized = serializeChain(parsed);
			assert.deepEqual(parseChain(serialized, "project", "/tmp/verdict-flow.chain.md").steps[0]?.stopOn, condition);
			assert.equal(serializeChain(parseChain(serialized, "project", "/tmp/verdict-flow.chain.md")), serialized);
		}
	});

	it("matches the key case-insensitively", () => {
		const content = `${header}## reviewer\noutputSchema: schemas/verdict.json\nSTOPON: {"path":"/verdict","in":["FAIL"]}\n\nReview it\n`;
		assert.deepEqual(parseChain(content, "project", "/tmp/x.chain.md").steps[0]?.stopOn, { path: "/verdict", in: ["FAIL"] });
	});

	it("rejects a malformed stopOn line", () => {
		for (const bad of ["/verdict in FAIL", "{\"path\":\"/v\"}", "{\"path\":\"/v\",\"in\":[]}", "{\"path\":\"/v\",\"in\":\"FAIL\"}", "[1]"]) {
			const content = `${header}## reviewer\noutputSchema: schemas/verdict.json\nstopOn: ${bad}\n\nReview it\n`;
			assert.throws(
				() => parseChain(content, "project", "/tmp/x.chain.md"),
				new RegExp(`stopOn line '.*' must be a JSON object \\{"path": "<json-pointer>", "in": \\["<value>", \\.\\.\\.\\]\\}\\.$`),
			);
		}
	});

	it("validates stopOn in .chain.json through the bindings validator", () => {
		const json = JSON.stringify({ name: "j", description: "d", chain: [{ agent: "reviewer", stopOn: { path: "/verdict", in: ["FAIL"] } }] });
		assert.throws(() => parseJsonChain(json, "project", "/tmp/j.chain.json"), /Invalid JSON chain '\/tmp\/j\.chain\.json': Chain step 1 has stopOn but no outputSchema\./);
		const ok = JSON.stringify({ name: "j", description: "d", chain: [{ agent: "reviewer", outputSchema: "schemas/verdict.json", stopOn: { path: "/verdict", in: ["FAIL"] } }] });
		assert.deepEqual(parseJsonChain(ok, "project", "/tmp/j.chain.json").steps[0]?.stopOn, { path: "/verdict", in: ["FAIL"] });
	});
});
