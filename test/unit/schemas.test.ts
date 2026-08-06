import assert from "node:assert/strict";
import { describe, it } from "node:test";

type JsonSchemaNode = Record<string, unknown>;

interface SubagentParamsSchema {
	properties?: {
		context?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		tasks?: {
			items?: {
				properties?: {
					count?: {
						minimum?: number;
						description?: string;
					};
					output?: JsonSchemaNode;
					reads?: JsonSchemaNode;
					progress?: JsonSchemaNode;
				};
			};
		};
		concurrency?: {
			minimum?: number;
			description?: string;
		};
		id?: {
			type?: string;
			description?: string;
		};
		runId?: {
			type?: string;
			description?: string;
		};
		dir?: {
			type?: string;
			description?: string;
		};
		action?: {
			type?: string;
			enum?: string[];
			description?: string;
		};
		control?: {
			properties?: {
				needsAttentionAfterMs?: { minimum?: number };
				activeNoticeAfterMs?: { minimum?: number };
				activeNoticeAfterTurns?: { minimum?: number };
				activeNoticeAfterTokens?: { minimum?: number };
				failedToolAttemptsBeforeAttention?: { minimum?: number };
				notifyOn?: { items?: { enum?: string[] } };
				notifyChannels?: { items?: { enum?: string[] } };
			};
		};
		skill?: JsonSchemaNode;
		output?: JsonSchemaNode;
		config?: JsonSchemaNode;
		chain?: {
			items?: JsonSchemaNode & {
				properties?: Record<string, JsonSchemaNode>;
			};
		};
	};
}

function missingPackageName(error: unknown): string | undefined {
	const message = error instanceof Error ? error.message : String(error);
	return message.match(/Cannot find package ['"]([^'"]+)['"]/i)?.[1];
}

function anyOfBranches(schema: JsonSchemaNode | undefined): JsonSchemaNode[] {
	const anyOf = schema?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf.filter((branch): branch is JsonSchemaNode => !!branch && typeof branch === "object");
}

function hasAnyOfType(schema: JsonSchemaNode | undefined, type: string): boolean {
	return anyOfBranches(schema).some((branch) => branch.type === type);
}

function hasAnyOfArrayWithStringItems(schema: JsonSchemaNode | undefined): boolean {
	return anyOfBranches(schema).some((branch) => {
		if (branch.type !== "array") return false;
		const items = branch.items;
		return !!items && typeof items === "object" && (items as JsonSchemaNode).type === "string";
	});
}

let schemas: Record<string, JsonSchemaNode> = {};
let SubagentParams: SubagentParamsSchema | undefined;
let schemasAvailable = true;
try {
	schemas = await import("../../src/extension/schemas.ts") as Record<string, JsonSchemaNode>;
	SubagentParams = schemas.SubagentParams as SubagentParamsSchema;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	schemasAvailable = false;
}
let CompileSchema: ((schema: unknown) => { Check(value: unknown): boolean; Errors(value: unknown): Iterable<{ message: string }> }) | undefined;
try {
	const compileModule = await import("typebox/compile") as { Compile: typeof CompileSchema };
	CompileSchema = compileModule.Compile;
} catch (error) {
	if (missingPackageName(error) !== "typebox") throw error;
	// The structural schema assertions below do not need the optional compiler package.
}

describe("SubagentParams schema", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("includes context field for fresh/fork execution mode", () => {
		const contextSchema = SubagentParams?.properties?.context;
		assert.ok(contextSchema, "context schema should exist");
		assert.equal(contextSchema.type, "string");
		assert.deepEqual(contextSchema.enum, ["fresh", "fork"]);
		const description = String(contextSchema.description ?? "");
		assert.match(description, /fresh/);
		assert.match(description, /fork/);
		assert.match(description, /whole invocation/);
	});

	it("includes count and concurrency on top-level parallel mode", () => {
		const taskSchema = SubagentParams?.properties?.tasks?.items?.properties;
		const taskCountSchema = taskSchema?.count;
		assert.ok(taskCountSchema, "tasks[].count schema should exist");
		assert.equal(taskCountSchema.minimum, 1);
		assert.match(String(taskCountSchema.description ?? ""), /repeat/i);
		const outputSchema = taskSchema?.output as JsonSchemaNode | undefined;
		assert.equal(outputSchema?.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
		const readsSchema = taskSchema?.reads as JsonSchemaNode | undefined;
		assert.equal(readsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(readsSchema), true);
		assert.equal(hasAnyOfType(readsSchema, "boolean"), true);
		assert.equal(taskSchema?.progress?.type, "boolean");
		assert.match(String(taskSchema?.progress?.description ?? ""), /omit.*false.*disable/i);
		assert.match(String(taskSchema?.progress?.description ?? ""), /true.*enable/i);

		const concurrencySchema = SubagentParams?.properties?.concurrency;
		assert.ok(concurrencySchema, "concurrency schema should exist");
		assert.equal(concurrencySchema.minimum, 1);
		assert.match(String(concurrencySchema.description ?? ""), /parallel/i);
	});

	it("documents top-level output as opt-in", () => {
		const outputSchema = SubagentParams?.properties?.output;
		assert.ok(outputSchema, "top-level output schema should exist");
		assert.equal(outputSchema.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);
		const description = String(outputSchema.description ?? "");
		assert.match(description, /omit.*false.*disable/i);
		assert.match(description, /true.*agent-configured filename/i);
		assert.match(description, /string.*path/i);
	});

	it("preserves chain output and progress contracts", () => {
		const chainItem = SubagentParams?.properties?.chain?.items;
		assert.ok(chainItem, "chain item schema should exist");
		const assertChainArtifactFields = (properties: Record<string, JsonSchemaNode> | undefined) => {
			const output = properties?.output;
			assert.equal(output?.type, undefined);
			assert.equal(hasAnyOfType(output, "string"), true);
			assert.equal(hasAnyOfType(output, "boolean"), true);
			assert.equal(output?.description, "Output file path, or false.");
			assert.equal(properties?.progress?.type, "boolean");
			assert.match(String(properties?.progress?.description ?? ""), /progress\.md tracking/i);
		};

		assertChainArtifactFields(chainItem.properties);
		assert.equal(chainItem.properties?.progress?.description, "Enable progress.md tracking in {chain_dir}");
		const parallelBranches = anyOfBranches(chainItem.properties?.parallel);
		const staticParallel = parallelBranches.find((branch) => branch.type === "array");
		assertChainArtifactFields((staticParallel?.items as { properties?: Record<string, JsonSchemaNode> } | undefined)?.properties);
		const dynamicParallel = parallelBranches.find((branch) => branch.type === "object");
		assertChainArtifactFields((dynamicParallel?.properties as Record<string, JsonSchemaNode> | undefined));
	});

	it("uses an enum for management and control actions", () => {
		const actionSchema = SubagentParams?.properties?.action;
		assert.ok(actionSchema, "action schema should exist");
		assert.equal(actionSchema.type, "string");
		assert.deepEqual(actionSchema.enum, ["list", "get", "create", "update", "delete", "status", "interrupt", "resume", "doctor"]);
		const description = String(actionSchema.description ?? "");
		assert.match(description, /Management\/control action/);
		assert.match(description, /Omit for execution mode/);
		assert.doesNotMatch(description, /orchestration\./);
	});

	it("includes subagent control fields", () => {
		const idSchema = SubagentParams?.properties?.id;
		assert.ok(idSchema, "id schema should exist");
		assert.equal(idSchema.type, "string");
		assert.match(String(idSchema.description ?? ""), /status/i);
		assert.match(String(idSchema.description ?? ""), /interrupt/i);

		const runIdSchema = SubagentParams?.properties?.runId;
		assert.ok(runIdSchema, "runId schema should exist");
		assert.equal(runIdSchema.type, "string");
		assert.match(String(runIdSchema.description ?? ""), /interrupt/i);

		const dirSchema = SubagentParams?.properties?.dir;
		assert.ok(dirSchema, "dir schema should exist");
		assert.equal(dirSchema.type, "string");
		assert.match(String(dirSchema.description ?? ""), /status/i);

		const controlSchema = SubagentParams?.properties?.control;
		assert.ok(controlSchema, "control schema should exist");
		assert.equal(controlSchema.properties?.needsAttentionAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterMs?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTurns?.minimum, 1);
		assert.equal(controlSchema.properties?.activeNoticeAfterTokens?.minimum, 1);
		assert.equal(controlSchema.properties?.failedToolAttemptsBeforeAttention?.minimum, 1);
		assert.deepEqual(controlSchema.properties?.notifyOn?.items?.enum, ["active_long_running", "needs_attention"]);
		assert.deepEqual(controlSchema.properties?.notifyChannels?.items?.enum, ["event", "async", "intercom"]);
	});

	it("does not emit description-only schema nodes", () => {
		const descriptionOnlyPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Object.hasOwn(node, "description") && !Object.hasOwn(node, "type") && !Object.hasOwn(node, "anyOf")) {
					descriptionOnlyPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(descriptionOnlyPaths, []);
	});

	it("does not emit array-typed schema nodes without items", () => {
		const missingItemsPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (node.type === "array" && !Object.hasOwn(node, "items")) {
					missingItemsPaths.push(current.path);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(missingItemsPaths, []);
	});

	it("does not emit provider-rejected union schema shapes", () => {
		const rejectedPaths: string[] = [];

		for (const [name, schema] of Object.entries(schemas)) {
			const stack: Array<{ path: string; value: unknown }> = [{ path: name, value: schema }];
			while (stack.length > 0) {
				const current = stack.pop()!;
				if (!current.value || typeof current.value !== "object") continue;

				const node = current.value as JsonSchemaNode;
				if (Array.isArray(node.type)) {
					rejectedPaths.push(`${current.path}.type`);
				}
				if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "type")) {
					rejectedPaths.push(`${current.path}.type+anyOf`);
				}

				if (Array.isArray(current.value)) {
					current.value.forEach((value, index) => stack.push({ path: `${current.path}[${index}]`, value }));
					continue;
				}

				for (const [key, value] of Object.entries(node)) {
					stack.push({ path: `${current.path}.${key}`, value });
				}
			}
		}

		assert.deepEqual(rejectedPaths, []);
	});

	it("uses provider-friendly anyOf unions for flexible fields and chain items", () => {
		const skillSchema = SubagentParams?.properties?.skill;
		assert.ok(skillSchema, "skill schema should exist");
		assert.equal(skillSchema.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(skillSchema), true);
		assert.equal(hasAnyOfType(skillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(skillSchema, "string"), true);

		const outputSchema = SubagentParams?.properties?.output;
		assert.ok(outputSchema, "output schema should exist");
		assert.equal(outputSchema.type, undefined);
		assert.equal(hasAnyOfType(outputSchema, "string"), true);
		assert.equal(hasAnyOfType(outputSchema, "boolean"), true);

		const configSchema = SubagentParams?.properties?.config;
		assert.ok(configSchema, "config schema should exist");
		assert.equal(configSchema.type, undefined);
		assert.equal(anyOfBranches(configSchema).some((branch) => branch.type === "object" && branch.additionalProperties === true), true);
		assert.equal(hasAnyOfType(configSchema, "string"), true);

		const chainItem = SubagentParams?.properties?.chain?.items;
		assert.ok(chainItem, "chain item schema should exist");
		assert.equal(chainItem.type, "object");
		assert.equal(chainItem.anyOf, undefined);
		assert.equal(chainItem.oneOf, undefined);
		assert.equal(chainItem.properties?.agent?.type, "string");
		assert.equal(chainItem.properties?.phase?.type, "string");
		assert.equal(chainItem.properties?.label?.type, "string");
		assert.equal(chainItem.properties?.as?.type, "string");
		assert.equal(chainItem.properties?.outputSchema?.type, "object");
			assert.equal(chainItem.properties?.parallel?.type, undefined);
			const parallelBranches = anyOfBranches(chainItem.properties?.parallel);
			const staticParallelBranch = parallelBranches.find((branch) => branch.type === "array");
			const dynamicParallelBranch = parallelBranches.find((branch) => branch.type === "object");
			assert.ok(staticParallelBranch, "parallel should support static task arrays");
			assert.ok(dynamicParallelBranch, "parallel should support a dynamic task template object");
			const chainParallelTask = (staticParallelBranch.items as { properties?: Record<string, JsonSchemaNode> } | undefined)?.properties;
			assert.equal(chainParallelTask?.agent?.type, "string");
		assert.equal(chainParallelTask?.phase?.type, "string");
		assert.equal(chainParallelTask?.label?.type, "string");
		assert.equal(chainParallelTask?.as?.type, "string");
		assert.equal(chainParallelTask?.outputSchema?.type, "object");
		const chainParallelOutputSchema = chainParallelTask?.output;
		assert.equal(chainParallelOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainParallelOutputSchema, "boolean"), true);
		const chainParallelReadsSchema = chainParallelTask?.reads;
		assert.equal(chainParallelReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelReadsSchema), true);
			assert.equal(hasAnyOfType(chainParallelReadsSchema, "boolean"), true);
			assert.equal(chainItem.properties?.expand?.type, "object");
			assert.equal(chainItem.properties?.collect?.type, "object");
		const chainParallelSkillSchema = chainParallelTask?.skill;
		assert.equal(chainParallelSkillSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainParallelSkillSchema), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "boolean"), true);
		assert.equal(hasAnyOfType(chainParallelSkillSchema, "string"), true);
		const chainOutputSchema = chainItem.properties?.output as JsonSchemaNode | undefined;
		assert.equal(chainOutputSchema?.type, undefined);
		assert.equal(hasAnyOfType(chainOutputSchema, "string"), true);
		assert.equal(hasAnyOfType(chainOutputSchema, "boolean"), true);
		const chainReadsSchema = chainItem.properties?.reads as JsonSchemaNode | undefined;
		assert.equal(chainReadsSchema?.type, undefined);
		assert.equal(hasAnyOfArrayWithStringItems(chainReadsSchema), true);
		assert.equal(hasAnyOfType(chainReadsSchema, "boolean"), true);
	});

	it("validates representative flexible field values with TypeBox compiler", { skip: !CompileSchema ? "typebox compiler not available" : undefined }, () => {
		assert.ok(SubagentParams, "SubagentParams schema should exist");
		assert.ok(CompileSchema, "TypeBox compiler should exist");
		const validator = CompileSchema(SubagentParams);
		const validValues = [
			{ skill: "review" },
			{ skill: false },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: "review" }] },
			{ tasks: [{ agent: "reviewer", task: "check this", skill: false }] },
			{ tasks: [{ agent: "reviewer", task: "check this", output: "review.md", reads: ["input.md"], progress: true }] },
			{ chain: [{ agent: "reviewer", reads: false }] },
			{ chain: [{ agent: "reviewer", phase: "Review", label: "Correctness", as: "findings", outputSchema: { type: "object" } }] },
			{ chain: [{ agent: "reviewer", skill: "review" }] },
			{ chain: [{ agent: "reviewer", skill: false }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: false, skill: false }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", phase: "Review", label: "Security", as: "security", outputSchema: { type: "object" } }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: "review.md", reads: ["input.md"], skill: "review" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 4 }, parallel: { agent: "reviewer", task: "Review {target.path}", outputSchema: { type: "object" } }, collect: { as: "reviews" } }] },
			{ agent: "worker", task: "Fix", acceptance: false },
			{ agent: "worker", task: "Fix", acceptance: { level: "checked", review: false } },
			{ config: { name: "reviewer", description: "Review things" } },
			{ config: JSON.stringify({ name: "reviewer", description: "Review things" }) },
		];
		const invalidValues = [
			{ skill: 123 },
			{ skill: [123] },
			{ output: 123 },
			{ tasks: [{ agent: "reviewer", task: "check this", reads: "input.md" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", output: 123 }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", reads: "input.md" }] }] },
			{ chain: [{ parallel: [{ agent: "reviewer", skill: 123 }] }] },
			{ chain: [{ agent: "reviewer", outputSchema: "schema.json" }] },
			{ chain: [{ parallel: [{ agent: "reviewer", outputSchema: "schema.json" }] }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: [{ agent: "reviewer" }], collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4, expression: "items" }, parallel: { agent: "reviewer" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer", as: "child" }, collect: { as: "reviews" } }] },
			{ chain: [{ expand: { from: { output: "targets", path: "/items" }, maxItems: 4 }, parallel: { agent: "reviewer" }, collect: { as: "reviews" }, when: "later" }] },
			{ agent: "worker", task: "Fix", acceptance: true },
			{ agent: "worker", task: "Fix", acceptance: { level: "checked", review: true } },
			{ config: [] },
			{ config: null },
		];

		for (const value of validValues) {
			assert.doesNotThrow(() => validator.Check(value), `validator should not throw for ${JSON.stringify(value)}`);
			assert.equal(
				validator.Check(value),
				true,
				`${JSON.stringify(value)} should validate: ${[...validator.Errors(value)].map((error) => error.message).join(", ")}`,
			);
		}
		for (const value of invalidValues) {
			assert.equal(validator.Check(value), false, `${JSON.stringify(value)} should not validate`);
		}
	});
});

const stripDescriptions = (n: unknown): unknown =>
	Array.isArray(n)
		? n.map(stripDescriptions)
		: n && typeof n === "object"
			? Object.fromEntries(
					Object.entries(n as Record<string, unknown>)
						.filter(([k]) => k !== "description")
						.map(([k, v]) => [k, stripDescriptions(v)]),
				)
			: n;

describe("schema size budget", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	it("serialized SubagentParams stays within the API payload budget", () => {
		// Budget measures our canonical JSON, not provider re-serialization or tokenizer counts.
		// Baseline before the diet: 23,151 bytes at eb7c74b. This ceiling also gates future field additions.
		const bytes = Buffer.byteLength(JSON.stringify(SubagentParams), "utf8");
		assert.ok(bytes <= 18_000, `SubagentParams schema is ${bytes} bytes; budget is 18,000 (pre-diet baseline: 23,151)`);
	});
});

describe("schema shape guard", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	// Regenerate fixture: see doc/plans/2026-08-06-subagent-schema-diet.md Task 1 Step 1.
	it("description-stripped schema matches the pre-diet baseline fixture", async () => {
		const fs = await import("node:fs");
		const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/subagent-params.shape.json", import.meta.url), "utf8"));
		assert.deepEqual(stripDescriptions(SubagentParams), fixture);
	});
});

describe("acceptance accepted at all positions", { skip: !schemasAvailable || !CompileSchema ? "typebox not available" : undefined }, () => {
	const objectForm = {
		level: "checked",
		criteria: ["works", { id: "g1", must: "tests pass", severity: "required" }],
		verify: [{ id: "v1", command: "npm test" }],
	};
	const shapes: Array<[string, unknown]> = [["object form", objectForm], ["string form", "checked"], ["false", false]];
	const positions: Array<[string, (acc: unknown) => Record<string, unknown>]> = [
		["top-level", (acc) => ({ agent: "worker", task: "t", acceptance: acc })],
		["tasks[] item", (acc) => ({ tasks: [{ agent: "worker", task: "t", acceptance: acc }] })],
		["chain step", (acc) => ({ chain: [{ agent: "worker", task: "t", acceptance: acc }] })],
		["static parallel member", (acc) => ({ chain: [{ parallel: [{ agent: "worker", task: "t", acceptance: acc }] }] })],
		["dynamic fanout template", (acc) => ({
			chain: [
				{ agent: "worker", task: "t", as: "seed", outputSchema: { type: "object" } },
				{
					expand: { from: { output: "seed", path: "/items" }, maxItems: 3 },
					parallel: { agent: "worker", task: "{item}", acceptance: acc },
					collect: { as: "results" },
				},
			],
		})],
	];
	const invalidAcceptanceValues: unknown[] = [true, { level: "checked", bogus: 1 }];
	for (const [posName, build] of positions) {
		for (const [shapeName, acc] of shapes) {
			it(`${posName} accepts acceptance ${shapeName}`, () => {
				const check = CompileSchema!(SubagentParams);
				const value = build(acc);
				assert.ok(check.Check(value), `expected valid: ${JSON.stringify([...check.Errors(value)].map((e) => e.message))}`);
			});
		}
		for (const invalid of invalidAcceptanceValues) {
			it(`${posName} rejects invalid acceptance ${JSON.stringify(invalid)}`, () => {
				const check = CompileSchema!(SubagentParams);
				const value = build(invalid);
				assert.equal(check.Check(value), false, `expected invalid: ${JSON.stringify(value)}`);
			});
		}
	}
});

describe("chain step accepts override field shapes", { skip: !schemasAvailable || !CompileSchema ? "typebox not available" : undefined }, () => {
	const cases: Array<[string, Record<string, unknown>]> = [
		["skill array", { skill: ["tdd", "debug"] }],
		["output string", { output: "out.md" }],
		["output boolean", { output: false }],
		["outputMode inline", { outputMode: "inline" }],
		["outputMode file-only", { outputMode: "file-only" }],
		["reads array", { reads: ["a.md"] }],
	];
	for (const [name, extra] of cases) {
		it(`chain step accepts ${name}`, () => {
			const check = CompileSchema!(SubagentParams);
			const value = { chain: [{ agent: "worker", task: "t", ...extra }] };
			assert.ok(check.Check(value), `expected valid: ${JSON.stringify([...check.Errors(value)].map((e) => e.message))}`);
		});
	}
});

describe("brief() clone invariants", { skip: !schemasAvailable ? "typebox not available" : undefined }, () => {
	const params = SubagentParams as unknown as Record<string, any>;
	const chainStep = params.properties.chain.items.properties;
	const taskItem = params.properties.tasks.items.properties;
	const parallelAnyOf = chainStep.parallel.anyOf as any[];
	const staticParallel = (parallelAnyOf.find((b) => b.type === "array") as any).items.properties;
	const dynamicTemplate = (parallelAnyOf.find((b) => b.type === "object") as any).properties;

	// Non-enumerable TypeBox metadata marker survives the descriptor clone: Type.Unsafe-based
	// consts (AcceptanceOverride/SkillOverride/OutputOverride/ReadsOverride/JsonSchemaObject) carry
	// exactly "~unsafe"; the Type.String-based const (OutputModeOverride) carries exactly "~kind".
	// Assert the exact expected marker per const, not a generic either-marker check.
	const expectedMarker: Record<string, "~unsafe" | "~kind"> = {
		acceptance: "~unsafe",
		skill: "~unsafe",
		outputMode: "~kind",
		reads: "~unsafe",
		output: "~unsafe",
		outputSchema: "~unsafe",
	};
	const assertMetadataPreserved = (node: object, label: string, name: string) => {
		const expected = expectedMarker[name];
		const other = expected === "~unsafe" ? "~kind" : "~unsafe";
		const descriptor = Object.getOwnPropertyDescriptor(node, expected);
		assert.ok(descriptor, `${label}: expected a ${expected} marker to survive the clone`);
		assert.equal(descriptor!.enumerable, false, `${label}: ${expected} must stay non-enumerable`);
		assert.ok(!Object.getOwnPropertyDescriptor(node, other), `${label}: unexpected ${other} marker present`);
	};

	// acceptance/skill/outputMode: canonical lives at top-level SubagentParams; all 4 nested
	// positions (tasks[] item, chain step, static parallel member, dynamic fanout template) wrap it.
	const canonicalPositions: Array<[string, unknown, Array<[string, unknown]>]> = [
		[
			"acceptance",
			params.properties.acceptance,
			[
				["tasks-item", taskItem.acceptance],
				["chain-step", chainStep.acceptance],
				["static-parallel-member", staticParallel.acceptance],
				["dynamic-template", dynamicTemplate.acceptance],
			],
		],
		[
			"skill",
			params.properties.skill,
			[
				["tasks-item", taskItem.skill],
				["chain-step", chainStep.skill],
				["static-parallel-member", staticParallel.skill],
				["dynamic-template", dynamicTemplate.skill],
			],
		],
		[
			"outputMode",
			params.properties.outputMode,
			[
				["tasks-item", taskItem.outputMode],
				["chain-step", chainStep.outputMode],
				["static-parallel-member", staticParallel.outputMode],
				["dynamic-template", dynamicTemplate.outputMode],
			],
		],
		// reads: canonical moved to tasks[] item (TaskItem.reads is the unwrapped ReadsOverride
		// const itself); the other 3 nested positions wrap it.
		[
			"reads",
			taskItem.reads,
			[
				["chain-step", chainStep.reads],
				["static-parallel-member", staticParallel.reads],
				["dynamic-template", dynamicTemplate.reads],
			],
		],
	];
	for (const [name, canonical, wrappedSites] of canonicalPositions) {
		for (const [posName, wrapped] of wrappedSites) {
			it(`${name} at ${posName}: nested clone differs from canonical only in description`, () => {
				const a = JSON.parse(JSON.stringify(canonical));
				const b = JSON.parse(JSON.stringify(wrapped));
				assert.notEqual(a.description, b.description, "one-liner should differ from canonical text");
				delete a.description;
				delete b.description;
				assert.deepEqual(b, a);
			});
			it(`${name} at ${posName}: descriptor clone preserves non-enumerable TypeBox metadata`, () => {
				assertMetadataPreserved(wrapped as object, `${name} at ${posName}`, name);
			});
		}
	}

	// output/outputSchema are the exceptions: their canonical full descriptions live at
	// differently-shaped sites (top-level `output` is a separate inline Type.Unsafe, not the
	// OutputOverride const; JsonSchemaObject's canonical is ChainItem.outputSchema, which is
	// unwrapped but structurally identical rather than description-bearing in the same way).
	// So every wrapped nested copy is compared pairwise against the others AND against one
	// designated reference copy, instead of against a differently-shaped "canonical".
	const outputSites: Array<[string, unknown]> = [
		["tasks-item", taskItem.output],
		["chain-step", chainStep.output],
		["static-parallel-member", staticParallel.output],
		["dynamic-template", dynamicTemplate.output],
	];
	const outputSchemaSites: Array<[string, unknown]> = [
		["static-parallel-member", staticParallel.outputSchema],
		["dynamic-template", dynamicTemplate.outputSchema],
		["dynamic-collect", chainStep.collect.properties.outputSchema],
	];
	const wrappedSiteGroups: Array<[string, Array<[string, unknown]>]> = [
		["output", outputSites],
		["outputSchema", outputSchemaSites],
	];
	for (const [name, sites] of wrappedSiteGroups) {
		const [referenceName, reference] = sites[0];
		for (const [posName, wrapped] of sites) {
			it(`${name} at ${posName}: descriptor clone preserves non-enumerable TypeBox metadata`, () => {
				assertMetadataPreserved(wrapped as object, `${name} at ${posName}`, name);
			});
		}
		for (let i = 0; i < sites.length; i++) {
			for (let j = i + 1; j < sites.length; j++) {
				const [posA, wrappedA] = sites[i];
				const [posB, wrappedB] = sites[j];
				it(`${name}: ${posA} and ${posB} wrapped copies serialize identically`, () => {
					assert.deepEqual(JSON.parse(JSON.stringify(wrappedA)), JSON.parse(JSON.stringify(wrappedB)));
				});
			}
		}
		for (const [posName, wrapped] of sites) {
			it(`${name} at ${posName}: matches the designated reference copy (${referenceName})`, () => {
				assert.deepEqual(JSON.parse(JSON.stringify(wrapped)), JSON.parse(JSON.stringify(reference)));
			});
		}
	}

	it("no TypeBox internal '~' keys leak into serialized JSON", () => {
		assert.ok(!JSON.stringify(SubagentParams).includes('"~'), "serialized schema must not contain ~-prefixed keys");
	});
});
