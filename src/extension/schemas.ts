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

const TaskItem = Type.Object({
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat N times (same settings)." })),
	output: Type.Optional(brief(OutputOverride, "Output file path, or false.")),
	outputMode: Type.Optional(brief(OutputModeOverride, "Default: inline.")),
	reads: Type.Optional(ReadsOverride),
	progress: Type.Optional(Type.Boolean({ description: "true enables progress.md tracking; omit or false disables." })),
	model: Type.Optional(Type.String()),
	skill: Type.Optional(brief(SkillOverride, "Skill override.")),
	acceptance: Type.Optional(AcceptanceOverrideStub),
});

// Parallel task item (within a parallel step)
const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "{task},{previous},{chain_dir} template; defaults to {previous}." })),
	phase: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	as: Type.Optional(Type.String({ description: "Identifier for {outputs.name}." })),
	outputSchema: Type.Optional(brief(JsonSchemaObject, "Output JSON Schema.")),
	cwd: Type.Optional(Type.String()),
	count: Type.Optional(Type.Integer({ minimum: 1, description: "Repeat N times." })),
	output: Type.Optional(brief(OutputOverride, "Output file path, or false.")),
	outputMode: Type.Optional(brief(OutputModeOverride, "Default: inline.")),
	reads: Type.Optional(brief(ReadsOverride, "Reads first, or false.")),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking." })),
	model: Type.Optional(Type.String()),
	skill: Type.Optional(brief(SkillOverride, "Skill override.")),
	acceptance: Type.Optional(AcceptanceOverrideStub),
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

const DynamicParallelTemplateSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "{item},{item.path},{task},{previous},{chain_dir},{outputs.name} template." })),
	phase: Type.Optional(Type.String()),
	label: Type.Optional(Type.String({ description: "Label; item templates supported." })),
	outputSchema: Type.Optional(brief(JsonSchemaObject, "Output JSON Schema.")),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(brief(OutputOverride, "Output file path, or false.")),
	outputMode: Type.Optional(brief(OutputModeOverride, "Default: inline.")),
	reads: Type.Optional(brief(ReadsOverride, "Reads first, or false.")),
	progress: Type.Optional(Type.Boolean({ description: "Enable progress.md tracking." })),
	model: Type.Optional(Type.String()),
	skill: Type.Optional(brief(SkillOverride, "Skill override.")),
	acceptance: Type.Optional(AcceptanceOverrideStub),
}, { additionalProperties: false });

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
	allOf: [
		{ if: { required: ["expand"] }, then: { required: ["parallel", "collect"], properties: { parallel: { type: "object" } } } },
		{ if: { required: ["collect"] }, then: { required: ["expand", "parallel"], properties: { parallel: { type: "object" } } } },
		{ not: { required: ["expand"], properties: { parallel: { type: "array", items: {} } } } },
	],
});

const ControlOverrides = Type.Object({
	enabled: Type.Optional(Type.Boolean({ description: "Toggle attention tracking." })),
	needsAttentionAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "No-activity window before needs_attention." })),
	activeNoticeAfterMs: Type.Optional(Type.Integer({ minimum: 1, description: "Elapsed-ms notice threshold (default: 240000)." })),
	inFlightSilenceCeilingMs: Type.Optional(Type.Integer({ minimum: 1, description: "Silent ms before escalation (default: 600000)." })),
	inFlightSilenceKillMs: Type.Optional(Type.Integer({ minimum: 1, description: "SIGTERM child (default: 1800000, clamped above needs_attention)." })),
	activeNoticeAfterTurns: Type.Optional(Type.Integer({ minimum: 1, description: "Notice by assistant turns (off by default)." })),
	activeNoticeAfterTokens: Type.Optional(Type.Integer({ minimum: 1, description: "Notice by total tokens (off by default)." })),
	failedToolAttemptsBeforeAttention: Type.Optional(Type.Integer({ minimum: 1, description: "Mutating-tool failures before needs_attention (default: 3)." })),
	notifyOn: Type.Optional(Type.Array(Type.String({ enum: ["active_long_running", "needs_attention"] }), {
		description: "To parent (default: active_long_running, needs_attention).",
	})),
	notifyChannels: Type.Optional(Type.Array(Type.String({ enum: ["event", "async", "intercom"] }), {
		description: "Default: event, async, intercom.",
	})),
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
	runId: Type.Optional(Type.String({
		description: "Run ID (interrupt/resume); defaults to latest. Prefer id."
	})),
	dir: Type.Optional(Type.String({
		description: "Async run dir for status/resume."
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
