/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "typebox";
import { SUBAGENT_ACTIONS } from "../shared/types.ts";

// Descriptor-preserving clone: typebox 1.3.11 metadata ("~kind", "~unsafe",
// "~optional") lives in NON-ENUMERABLE string-keyed properties. Object spread
// would drop them, and Type.Optional on a plain clone would re-add "~optional"
// as an enumerable key, leaking "~optional":true into the serialized JSON.
const brief = <T extends object>(schema: T, description: string): T =>
	Object.defineProperties(
		Object.defineProperties(Object.create(null), Object.getOwnPropertyDescriptors(schema)),
		{ description: { value: description, enumerable: true, writable: true, configurable: true } },
	) as T;

const SkillOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
		{ type: "string" },
	],
	description: "CSV/array/boolean (false disables, true default).",
});

const OutputOverride = Type.Unsafe({
	anyOf: [
		{ type: "string" },
		{ type: "boolean" },
	],
	description: "Output filename/path (string), or false to disable file output",
});

const OutputModeOverride = Type.String({
	enum: ["inline", "file-only"],
	description: "inline (default) or file-only (needs output path).",
});

const ReadsOverride = Type.Unsafe({
	anyOf: [
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
	description: "Files to read before running (array of filenames), or false to disable",
});

const JsonSchemaObject = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	description: "Structured output; non-object rejected.",
});

const AcceptanceEvidenceKind = Type.String({
	enum: [
		"changed-files",
		"tests-added",
		"commands-run",
		"validation-output",
		"residual-risks",
		"no-staged-files",
		"diff-summary",
		"review-findings",
		"manual-notes",
	],
});

// Gate-level `evidence`/`severity` are accepted at runtime (normalizeCriteria) but omitted
// from the schema: dead flexibility from a tool call, and the evidence enum is heavy.
// additionalProperties stays open so inputs carrying them are not provider-rejected.
const AcceptanceGateSchema = Type.Object({
	id: Type.String(),
	must: Type.String(),
}, { additionalProperties: true });

const AcceptanceVerifyCommandSchema = Type.Object({
	id: Type.String(),
	command: Type.String(),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	cwd: Type.Optional(Type.String()),
	env: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: { type: "string" } })),
	allowFailure: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const AcceptanceReviewGateSchema = Type.Object({
	agent: Type.Optional(Type.String()),
	focus: Type.Optional(Type.String()),
	required: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const AcceptanceOverride = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "none", "attested", "checked", "verified", "reviewed"] },
		{ const: false },
		{
			type: "object",
			properties: {
				level: { type: "string", enum: ["auto", "none", "attested", "checked", "verified", "reviewed"] },
				criteria: {
					type: "array",
					items: {
						anyOf: [
							{ type: "string" },
							AcceptanceGateSchema,
						],
					},
				},
				evidence: { type: "array", items: AcceptanceEvidenceKind },
				verify: { type: "array", items: AcceptanceVerifyCommandSchema },
				review: {
					anyOf: [
						{ const: false },
						AcceptanceReviewGateSchema,
					],
				},
				stopRules: { type: "array", items: { type: "string" } },
				reason: { type: "string" },
			},
			additionalProperties: false,
		},
	],
	description: "Acceptance: auto if omitted; verified needs cmds.",
});

// Nested acceptance sites carry a compact stub instead of the full AcceptanceOverride:
// inlined 5x it was 44% of the serialized schema. The full shape is documented once at
// top-level `acceptance`; deep validation happens at the executor boundary
// (validateAcceptanceInput), not provider-side. The object branch keeps a non-empty
// `properties` because some providers reject bare {type:"object"} in function
// declarations - the same wall that rules out $defs/$ref (see issue #6).
// {const:false} is intentionally absent: deprecated shorthand, use level:"none".
const AcceptanceOverrideStub = Type.Unsafe({
	anyOf: [
		{ type: "string", enum: ["auto", "none", "attested", "checked", "verified", "reviewed"] },
		{ type: "object", additionalProperties: true, properties: { level: { type: "string" } } },
	],
	description: "Acceptance override; same shape as top-level acceptance.",
});

// tasks[] stub (round three): same treatment as ParallelTaskSchema below; structural keys
// stay explicit (agent/task required, count = arity); every per-task override (model, output,
// outputMode, reads, progress, skill, cwd, acceptance) passes through additionalProperties
// and is documented in the pi-cohort skill. No `as` (no {outputs.name} wiring here) and no
// `label` (TaskParam has no such field at this position). Widening-only: unknown keys were
// already ignored at runtime.
const TaskItem = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	required: ["agent", "task"],
	properties: {
		agent: { type: "string" },
		task: { type: "string" },
		count: { type: "integer", minimum: 1, description: "Repeat N times (same settings)." },
	},
	description: "Per-task overrides (model, output, reads, skill, ...): pi-cohort skill.",
});

// Parallel-item stubs (round two): structural/wiring keys stay explicit (agent/task,
// count/as = arity + {outputs.name} routing); every per-task override (model, label,
// phase, output, outputMode, reads, skill, cwd, progress, outputSchema, acceptance)
// passes through additionalProperties and is documented in the pi-cohort skill.
// Widening-only: dynamic-arm unknown keys are still rejected at runtime by
// assertOnlyKeys (dynamic-fanout.ts); static-arm unknown keys were always ignored.
const ParallelTaskSchema = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	required: ["agent"],
	properties: {
		agent: { type: "string" },
		task: { type: "string", description: "{task},{previous},{chain_dir} template; defaults to {previous}." },
		count: { type: "integer", minimum: 1, description: "Repeat N times." },
		as: { type: "string", description: "Identifier for {outputs.name}." },
	},
	description: "Per-task overrides (model, label, output, skill, ...): pi-cohort skill.",
});

const DynamicExpandSchema = Type.Object({
	from: Type.Object({
		output: Type.String({ description: "Named prior output." }),
		path: Type.String({ description: "JSON Pointer into it." }),
	}, { additionalProperties: false }),
	item: Type.Optional(Type.String({ description: "Defaults to item." })),
	key: Type.Optional(Type.String({ description: "Pointer per item; stable child id." })),
	maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Required unless chain.dynamicFanout.maxItems is configured." })),
	onEmpty: Type.Optional(Type.String({ enum: ["skip", "fail"], description: "Defaults to skip." })),
}, { additionalProperties: false });

const DynamicParallelTemplateSchema = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	required: ["agent"],
	properties: {
		agent: { type: "string" },
		task: { type: "string", description: "{item},{item.path},{task},{previous},{chain_dir},{outputs.name} template." },
	},
	description: "Per-task overrides (model, label, output, skill, ...): pi-cohort skill.",
});

const DynamicCollectSchema = Type.Object({
	as: Type.String({ description: "Collected result array name." }),
	outputSchema: Type.Optional(brief(JsonSchemaObject, "Output JSON Schema.")),
}, { additionalProperties: false });

// Flattened so chain steps do not need an object-shape anyOf/oneOf union.
const ChainItem = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String({
		description: "{task},{previous},{chain_dir},{outputs.name}; required first else '{previous}'."
	})),
	phase: Type.Optional(Type.String({ description: "Phase/group label (status/graph)." })),
	label: Type.Optional(Type.String({ description: "Chain step label." })),
	as: Type.Optional(Type.String({ description: "Id for {outputs.name} in later steps." })),
	outputSchema: Type.Optional(JsonSchemaObject),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(brief(OutputOverride, "Output file path, or false.")),
	outputMode: Type.Optional(brief(OutputModeOverride, "Default: inline.")),
	reads: Type.Optional(brief(ReadsOverride, "Reads first, or false.")),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking in {chain_dir}" })),
	model: Type.Optional(Type.String()),
	skill: Type.Optional(brief(SkillOverride, "Skill override.")),
	acceptance: Type.Optional(AcceptanceOverrideStub),
	parallel: Type.Optional(Type.Unsafe({
		anyOf: [
			Type.Array(ParallelTaskSchema, { minItems: 1 }),
			DynamicParallelTemplateSchema,
		],
		description: "Static array, or dynamic fanout template (expand/collect).",
	})),
	expand: Type.Optional(DynamicExpandSchema),
	collect: Type.Optional(DynamicCollectSchema),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated worktree per task."
	})),
}, {
	description: "{agent,task?} seq; {parallel:[..]} concurrent; {expand,parallel,collect} fanout.",
	additionalProperties: false,
});

// Control stub (round two): 10 fields collapsed; the full table lives in the pi-cohort
// skill reference/config-fields.md. resolveControlConfig (subagent-control.ts) re-parses
// every field defensively at runtime, so mistyped values degrade to defaults.
const ControlOverrides = Type.Unsafe({
	type: "object",
	additionalProperties: true,
	properties: { enabled: { type: "boolean" } },
	description: "Attention-tracking overrides (needsAttentionAfterMs, notifyOn, ...); fields: pi-cohort skill reference/config-fields.md.",
});

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "SINGLE mode agent, or management target." })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode; optional if self-contained)." })),
	// Management action (when present, tool operates in management mode)
	action: Type.Optional(Type.String({
		enum: [...SUBAGENT_ACTIONS],
		description: "Management/control action. Omit for execution mode."
	})),
	id: Type.Optional(Type.String({
		description: "Run id/prefix for status/interrupt/resume."
	})),
	index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based index for per-child actions." })),
	message: Type.Optional(Type.String({ description: "Follow-up message for resume." })),
	// Chain identifier for management (can't reuse 'chain' — that's the execution array)
	chainName: Type.Optional(Type.String({
		description: "Chain name."
	})),
	// Agent/chain configuration for create/update (nested to avoid conflicts with execution fields)
	config: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "object", additionalProperties: true },
			{ type: "string" },
		],
		description: "Create/update config; fields: pi-cohort skill reference/config-fields.md; string=JSON."
	})),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode tasks: [{agent, task, ...}]." })),
	concurrency: Type.Optional(Type.Integer({ minimum: 1, description: "Default: config.parallel.concurrency or 4." })),
	worktree: Type.Optional(Type.Boolean({
		description: "Isolated worktree per task; clean git; diffs in output."
	})),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN: sequential; step response becomes {previous}." })),
	context: Type.Optional(Type.String({
		enum: ["fresh", "fork"],
		description: "fresh (default) or fork; defaultContext:fork forces whole invocation.",
	})),
	chainDir: Type.Optional(Type.String({ description: "Default temp <tmpdir>/, 24h clean." })),
	async: Type.Optional(Type.Boolean({ description: "Background run (default: false, or per config)." })),
	agentScope: Type.Optional(Type.String({ description: "user/project/both (default both, project wins)." })),
	cwd: Type.Optional(Type.String()),
	artifacts: Type.Optional(Type.Boolean({ description: "(default: true)." })),
	includeProgress: Type.Optional(Type.Boolean({ description: "(default: false)." })),
	share: Type.Optional(Type.Boolean({ description: "Upload session to GitHub Gist (default: false)." })),
	sessionDir: Type.Optional(
		Type.String({ description: "Default temp; enables sessions even if share=false." }),
	),
	// Clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Preview/edit TUI; omitted/false runs directly; true=foreground (if supported); parallel-step chains skip it." })),
	control: Type.Optional(ControlOverrides),
	// Solo agent overrides
	output: Type.Optional(Type.Unsafe({
		anyOf: [
			{ type: "string" },
			{ type: "boolean" },
		],
		description: "Omit or false disables; true=agent-configured filename; string=path (rel. cwd).",
	})),
	outputMode: Type.Optional(OutputModeOverride),
	skill: Type.Optional(SkillOverride),
	model: Type.Optional(Type.String({ description: "Model override, e.g. 'anthropic/claude-sonnet-4'." })),
	acceptance: Type.Optional(AcceptanceOverride),
});
