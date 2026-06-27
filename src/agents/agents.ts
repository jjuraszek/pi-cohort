/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptanceInput, OutputMode } from "../shared/types.ts";
import { getAgentDir } from "../shared/utils.ts";
import { KNOWN_FIELDS } from "./agent-serializer.ts";
import { parseChain, parseJsonChain } from "./chain-serializer.ts";
import { mergeAgentsForScope } from "./agent-selection.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { buildRuntimeName, parsePackageName } from "./identity.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";
type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";

export function defaultSystemPromptMode(name: string): SystemPromptMode {
	return name === "delegate" ? "append" : "replace";
}

export function defaultInheritProjectContext(name: string): boolean {
	return name === "delegate";
}

export function defaultInheritSkills(): boolean {
	return false;
}

export function assertNoMcpDirectTools(tools: readonly string[], context: string): void {
	const offending = tools.find((tool) => tool.startsWith("mcp:"));
	if (offending) {
		throw new Error(`${context}: MCP direct tools are no longer supported ('${offending}'). Remove the 'mcp:' entry.`);
	}
}

export interface BuiltinAgentOverrideBase {
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	disabled?: boolean;
	systemPrompt: string;
	skills?: string[];
	tools?: string[];
	completionGuard?: boolean;
}

interface BuiltinAgentOverrideConfig {
	model?: string | false;
	fallbackModels?: string[] | false;
	thinking?: string | false;
	systemPromptMode?: SystemPromptMode;
	inheritProjectContext?: boolean;
	inheritSkills?: boolean;
	defaultContext?: AgentDefaultContext | false;
	disabled?: boolean;
	systemPrompt?: string;
	skills?: string[] | false;
	tools?: string[] | false;
	toolsPrepend?: string[];
	toolsAppend?: string[];
	completionGuard?: boolean;
}

interface BuiltinAgentOverrideInfo {
	scope: "user" | "project";
	path: string;
	base: BuiltinAgentOverrideBase;
}

export interface AgentConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	tools?: string[];
	model?: string;
	fallbackModels?: string[];
	thinking?: string;
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	defaultContext?: AgentDefaultContext;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	maxSubagentDepth?: number;
	completionGuard?: boolean;
	disabled?: boolean;
	extraFields?: Record<string, string>;
	override?: BuiltinAgentOverrideInfo;
}

interface SubagentSettings {
	overrides: Record<string, BuiltinAgentOverrideConfig>;
	disableBuiltins?: boolean;
}

const EMPTY_SUBAGENT_SETTINGS: SubagentSettings = { overrides: {} };

export interface ChainStepConfig {
	agent?: string;
	task?: string;
	phase?: string;
	label?: string;
	as?: string;
	outputSchema?: string | Record<string, unknown>;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
	parallel?: unknown;
	expand?: unknown;
	collect?: unknown;
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
	acceptance?: AcceptanceInput;
}

export interface ChainConfig {
	name: string;
	localName?: string;
	packageName?: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface ChainDiscoveryDiagnostic {
	source: "user" | "project";
	filePath: string;
	error: string;
}

interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function getUserChainDir(): string {
	return path.join(getAgentDir(), "chains");
}

function arraysEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function cloneOverrideBase(agent: AgentConfig): BuiltinAgentOverrideBase {
	return {
		model: agent.model,
		fallbackModels: agent.fallbackModels ? [...agent.fallbackModels] : undefined,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		defaultContext: agent.defaultContext,
		disabled: agent.disabled,
		systemPrompt: agent.systemPrompt,
		skills: agent.skills ? [...agent.skills] : undefined,
		tools: agent.tools ? [...agent.tools] : undefined,
		completionGuard: agent.completionGuard,
	};
}

function cloneOverrideValue(override: BuiltinAgentOverrideConfig): BuiltinAgentOverrideConfig {
	return {
		...(override.model !== undefined ? { model: override.model } : {}),
		...(override.fallbackModels !== undefined
			? { fallbackModels: override.fallbackModels === false ? false : [...override.fallbackModels] }
			: {}),
		...(override.thinking !== undefined ? { thinking: override.thinking } : {}),
		...(override.systemPromptMode !== undefined ? { systemPromptMode: override.systemPromptMode } : {}),
		...(override.inheritProjectContext !== undefined ? { inheritProjectContext: override.inheritProjectContext } : {}),
		...(override.inheritSkills !== undefined ? { inheritSkills: override.inheritSkills } : {}),
		...(override.defaultContext !== undefined ? { defaultContext: override.defaultContext } : {}),
		...(override.disabled !== undefined ? { disabled: override.disabled } : {}),
		...(override.systemPrompt !== undefined ? { systemPrompt: override.systemPrompt } : {}),
		...(override.skills !== undefined ? { skills: override.skills === false ? false : [...override.skills] } : {}),
		...(override.tools !== undefined ? { tools: override.tools === false ? false : [...override.tools] } : {}),
		...(override.toolsPrepend !== undefined ? { toolsPrepend: [...override.toolsPrepend] } : {}),
		...(override.toolsAppend !== undefined ? { toolsAppend: [...override.toolsAppend] } : {}),
		...(override.completionGuard !== undefined ? { completionGuard: override.completionGuard } : {}),
	};
}

function resolveRealPath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function findGitRoot(startDir: string): string | null {
	let currentDir = startDir;
	while (true) {
		if (fs.existsSync(path.join(currentDir, ".git"))) {
			return resolveRealPath(currentDir);
		}
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

// Project levels from cwd up to and including the git root, FARTHEST-FIRST.
// Marker predicate matches findNearestProjectRoot (.pi OR .agents), so a level
// carrying only .pi/settings.json or only .pi/chains still participates.
// Returns raw (non-realpath) paths so callers build file paths consistent with
// how they received cwd. Realpath is used only internally for dedup. Falls back
// to at most the single nearest project root when not inside a git repo.
function enumerateProjectLevels(cwd: string): string[] {
	const gitRoot = findGitRoot(cwd);
	if (!gitRoot) {
		const nearest = findNearestProjectRoot(cwd);
		return nearest ? [nearest] : [];
	}

	const levels: string[] = [];
	const seen = new Set<string>();
	let currentDir = cwd;
	while (true) {
		const resolved = resolveRealPath(currentDir);
		const hasMarker = isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"));
		if (hasMarker && !seen.has(resolved)) {
			seen.add(resolved);
			levels.push(currentDir);
		}
		if (resolved === gitRoot) break;
		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return levels.reverse();
}

function findNearestProjectRoot(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		if (isDirectory(path.join(currentDir, ".pi")) || isDirectory(path.join(currentDir, ".agents"))) {
			return currentDir;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function getUserAgentSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

function getProjectAgentSettingsPath(cwd: string): string | null {
	const projectRoot = findNearestProjectRoot(cwd);
	return projectRoot ? path.join(projectRoot, ".pi", "settings.json") : null;
}

function readSettingsFileStrict(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeSettingsFile(filePath: string, settings: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

function parseOverrideStringArrayOrFalse(
	value: unknown,
	meta: { filePath: string; name: string; field: string },
): string[] | false | undefined {
	if (value === undefined) return undefined;
	if (value === false) return false;
	if (!Array.isArray(value)) {
		throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
	}

	const items: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`Builtin override '${meta.name}' in '${meta.filePath}' has invalid '${meta.field}'; expected an array of strings or false.`);
		}
		const trimmed = item.trim();
		if (trimmed) items.push(trimmed);
	}
	return items;
}

function parseBuiltinOverrideEntry(
	name: string,
	value: unknown,
	filePath: string,
): BuiltinAgentOverrideConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Builtin override '${name}' in '${filePath}' must be an object.`);
	}

	const input = value as Record<string, unknown>;
	const override: BuiltinAgentOverrideConfig = {};

	if ("model" in input) {
		if (typeof input.model === "string" || input.model === false) override.model = input.model;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'model'; expected a string or false.`);
	}

	if ("thinking" in input) {
		if (typeof input.thinking === "string" || input.thinking === false) override.thinking = input.thinking;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'thinking'; expected a string or false.`);
	}

	if ("systemPromptMode" in input) {
		if (input.systemPromptMode === "append" || input.systemPromptMode === "replace") {
			override.systemPromptMode = input.systemPromptMode;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPromptMode'; expected 'append' or 'replace'.`);
		}
	}

	if ("inheritProjectContext" in input) {
		if (typeof input.inheritProjectContext === "boolean") {
			override.inheritProjectContext = input.inheritProjectContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritProjectContext'; expected a boolean.`);
		}
	}

	if ("inheritSkills" in input) {
		if (typeof input.inheritSkills === "boolean") {
			override.inheritSkills = input.inheritSkills;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'inheritSkills'; expected a boolean.`);
		}
	}

	if ("defaultContext" in input) {
		if (input.defaultContext === "fresh" || input.defaultContext === "fork" || input.defaultContext === false) {
			override.defaultContext = input.defaultContext;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'defaultContext'; expected 'fresh', 'fork', or false.`);
		}
	}

	if ("disabled" in input) {
		if (typeof input.disabled === "boolean") {
			override.disabled = input.disabled;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
		}
	}

	if ("completionGuard" in input) {
		if (typeof input.completionGuard === "boolean") {
			override.completionGuard = input.completionGuard;
		} else {
			throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'completionGuard'; expected a boolean.`);
		}
	}

	if ("systemPrompt" in input) {
		if (typeof input.systemPrompt === "string") override.systemPrompt = input.systemPrompt;
		else throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'systemPrompt'; expected a string.`);
	}

	const fallbackModels = parseOverrideStringArrayOrFalse(input.fallbackModels, { filePath, name, field: "fallbackModels" });
	if (fallbackModels !== undefined) override.fallbackModels = fallbackModels;

	const skills = parseOverrideStringArrayOrFalse(input.skills, { filePath, name, field: "skills" });
	if (skills !== undefined) override.skills = skills;

	const tools = parseOverrideStringArrayOrFalse(input.tools, { filePath, name, field: "tools" });
	if (Array.isArray(tools)) assertNoMcpDirectTools(tools, `Builtin override '${name}' in '${filePath}'`);
	if (tools !== undefined) override.tools = tools;

	const toolsPrepend = parseOverrideStringArrayOrFalse(input.toolsPrepend, { filePath, name, field: "toolsPrepend" });
	if (toolsPrepend === false) {
		throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolsPrepend'; expected an array of strings.`);
	}
	if (toolsPrepend !== undefined) {
		assertNoMcpDirectTools(toolsPrepend, `Builtin override '${name}' in '${filePath}'`);
		override.toolsPrepend = toolsPrepend;
	}
	const toolsAppend = parseOverrideStringArrayOrFalse(input.toolsAppend, { filePath, name, field: "toolsAppend" });
	if (toolsAppend === false) {
		throw new Error(`Builtin override '${name}' in '${filePath}' has invalid 'toolsAppend'; expected an array of strings.`);
	}
	if (toolsAppend !== undefined) {
		assertNoMcpDirectTools(toolsAppend, `Builtin override '${name}' in '${filePath}'`);
		override.toolsAppend = toolsAppend;
	}

	return Object.keys(override).length > 0 ? override : undefined;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
	if (!filePath) return EMPTY_SUBAGENT_SETTINGS;
	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return EMPTY_SUBAGENT_SETTINGS;

	const subagentsObject = subagents as Record<string, unknown>;
	let disableBuiltins: boolean | undefined;
	if ("disableBuiltins" in subagentsObject) {
		if (typeof subagentsObject.disableBuiltins === "boolean") {
			disableBuiltins = subagentsObject.disableBuiltins;
		} else {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
		}
	}

	const parsed: Record<string, BuiltinAgentOverrideConfig> = {};
	const agentOverrides = subagentsObject.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) {
		return { overrides: parsed, disableBuiltins };
	}
	for (const [name, value] of Object.entries(agentOverrides)) {
		const override = parseBuiltinOverrideEntry(name, value, filePath);
		if (override) parsed[name] = override;
	}
	return { overrides: parsed, disableBuiltins };
}

// Merge project .pi/settings.json across every enumerated level, farthest-first
// so the nearest level's values land last and win. agentOverrides merge per
// name with whole-object replacement (disjoint fields do NOT compose);
// disableBuiltins takes the nearest-defined value as-is. A malformed level
// (readSubagentSettings throws) is warned and skipped, never aborting the merge.
function readMergedProjectSubagentSettings(cwd: string): SubagentSettings {
	const levels = enumerateProjectLevels(cwd);
	if (levels.length === 0) return EMPTY_SUBAGENT_SETTINGS;

	const overrides: Record<string, BuiltinAgentOverrideConfig> = {};
	let disableBuiltins: boolean | undefined;
	for (const level of levels) {
		const settingsPath = path.join(level, ".pi", "settings.json");
		let levelSettings: SubagentSettings;
		try {
			levelSettings = readSubagentSettings(settingsPath);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`Skipping malformed subagent settings at '${settingsPath}': ${message}`);
			continue;
		}
		for (const [name, override] of Object.entries(levelSettings.overrides)) {
			overrides[name] = override;
		}
		if (levelSettings.disableBuiltins !== undefined) {
			disableBuiltins = levelSettings.disableBuiltins;
		}
	}
	return { overrides, disableBuiltins };
}

function composeOverrideTools(
	effective: string[],
	prepend: string[] | undefined,
	append: string[] | undefined,
): string[] | undefined {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tool of [...(prepend ?? []), ...effective, ...(append ?? [])]) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		result.push(tool);
	}
	return result.length > 0 ? result : undefined;
}

function applyBuiltinOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = {
		...agent,
		override: { ...meta, base: cloneOverrideBase(agent) },
	};

	if (override.model !== undefined) next.model = override.model === false ? undefined : override.model;
	if (override.fallbackModels !== undefined) {
		next.fallbackModels = override.fallbackModels === false ? undefined : [...override.fallbackModels];
	}
	if (override.thinking !== undefined) next.thinking = override.thinking === false ? undefined : override.thinking;
	if (override.systemPromptMode !== undefined) next.systemPromptMode = override.systemPromptMode;
	if (override.inheritProjectContext !== undefined) next.inheritProjectContext = override.inheritProjectContext;
	if (override.inheritSkills !== undefined) next.inheritSkills = override.inheritSkills;
	if (override.defaultContext !== undefined) next.defaultContext = override.defaultContext === false ? undefined : override.defaultContext;
	if (override.disabled !== undefined) next.disabled = override.disabled;
	if (override.systemPrompt !== undefined) next.systemPrompt = override.systemPrompt;
	if (override.skills !== undefined) next.skills = override.skills === false ? undefined : [...override.skills];
	if (override.tools !== undefined || override.toolsPrepend !== undefined || override.toolsAppend !== undefined) {
		const effective = override.tools === false
			? []
			: override.tools !== undefined
				? override.tools
				: (agent.tools ?? []);
		next.tools = composeOverrideTools(effective, override.toolsPrepend, override.toolsAppend);
	}
	if (override.completionGuard !== undefined) next.completionGuard = override.completionGuard;

	return next;
}

function applyBuiltinOverrides(
	builtinAgents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	const projectBulkDisabled = projectSettings.disableBuiltins === true && projectSettingsPath !== null;
	const userBulkDisabled = projectSettings.disableBuiltins === undefined && userSettings.disableBuiltins === true;

	return builtinAgents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyBuiltinOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}

		if (projectBulkDisabled && projectSettingsPath) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "project", path: projectSettingsPath });
		}

		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyBuiltinOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}

		if (userBulkDisabled) {
			return applyBuiltinOverride(agent, { disabled: true }, { scope: "user", path: userSettingsPath });
		}

		return agent;
	});
}

// Custom (user/project) agents pre-fill fields from their frontmatter, so
// agentOverrides[name] only fills fields the frontmatter left unset. This
// keeps frontmatter as the per-agent source of truth and lets settings.json
// supply per-harness defaults (model, thinking, ...) for shared personas.
// Bulk disableBuiltins intentionally does not touch custom agents.
function applyCustomAgentOverride(
	agent: AgentConfig,
	override: BuiltinAgentOverrideConfig,
	meta: { scope: "user" | "project"; path: string },
): AgentConfig {
	const next: AgentConfig = { ...agent };
	let anyFilled = false;

	const fill = <T>(field: keyof AgentConfig, currentlyUnset: boolean, value: T) => {
		if (!currentlyUnset) return;
		(next as Record<string, unknown>)[field as string] = value;
		anyFilled = true;
	};

	if (override.model !== undefined) {
		fill("model", agent.model === undefined, override.model === false ? undefined : override.model);
	}
	if (override.fallbackModels !== undefined) {
		fill(
			"fallbackModels",
			agent.fallbackModels === undefined,
			override.fallbackModels === false ? undefined : [...override.fallbackModels],
		);
	}
	if (override.thinking !== undefined) {
		fill("thinking", agent.thinking === undefined, override.thinking === false ? undefined : override.thinking);
	}
	if (override.systemPromptMode !== undefined) {
		fill("systemPromptMode", agent.systemPromptMode === undefined, override.systemPromptMode);
	}
	if (override.inheritProjectContext !== undefined) {
		fill("inheritProjectContext", agent.inheritProjectContext === undefined, override.inheritProjectContext);
	}
	if (override.inheritSkills !== undefined) {
		fill("inheritSkills", agent.inheritSkills === undefined, override.inheritSkills);
	}
	if (override.defaultContext !== undefined) {
		fill(
			"defaultContext",
			agent.defaultContext === undefined,
			override.defaultContext === false ? undefined : override.defaultContext,
		);
	}
	if (override.disabled !== undefined) {
		fill("disabled", agent.disabled === undefined, override.disabled);
	}
	if (override.systemPrompt !== undefined) {
		fill("systemPrompt", agent.systemPrompt === undefined, override.systemPrompt);
	}
	if (override.skills !== undefined) {
		fill(
			"skills",
			agent.skills === undefined,
			override.skills === false ? undefined : [...override.skills],
		);
	}
	if (override.tools !== undefined || override.toolsPrepend !== undefined || override.toolsAppend !== undefined) {
		const replacementApplies = agent.tools === undefined && override.tools !== undefined;
		const effective = replacementApplies
			? (override.tools === false ? [] : override.tools as string[])
			: (agent.tools ?? []);
		if (replacementApplies || override.toolsPrepend !== undefined || override.toolsAppend !== undefined) {
			next.tools = composeOverrideTools(effective, override.toolsPrepend, override.toolsAppend);
			anyFilled = true;
		}
	}
	if (override.completionGuard !== undefined) {
		fill("completionGuard", agent.completionGuard === undefined, override.completionGuard);
	}

	if (!anyFilled) return agent;
	next.override = { ...meta, base: cloneOverrideBase(agent) };
	return next;
}

function applyCustomAgentOverrides(
	agents: AgentConfig[],
	userSettings: SubagentSettings,
	projectSettings: SubagentSettings,
	userSettingsPath: string,
	projectSettingsPath: string | null,
): AgentConfig[] {
	return agents.map((agent) => {
		const projectOverride = projectSettings.overrides[agent.name];
		if (projectOverride && projectSettingsPath) {
			return applyCustomAgentOverride(agent, projectOverride, { scope: "project", path: projectSettingsPath });
		}
		const userOverride = userSettings.overrides[agent.name];
		if (userOverride) {
			return applyCustomAgentOverride(agent, userOverride, { scope: "user", path: userSettingsPath });
		}
		return agent;
	});
}

export function buildBuiltinOverrideConfig(
	base: BuiltinAgentOverrideBase,
	draft: Pick<AgentConfig, "model" | "fallbackModels" | "thinking" | "systemPromptMode" | "inheritProjectContext" | "inheritSkills" | "defaultContext" | "disabled" | "systemPrompt" | "skills" | "tools" | "completionGuard">,
): BuiltinAgentOverrideConfig | undefined {
	const override: BuiltinAgentOverrideConfig = {};

	if (draft.model !== base.model) override.model = draft.model ?? false;
	if (!arraysEqual(draft.fallbackModels, base.fallbackModels)) override.fallbackModels = draft.fallbackModels ? [...draft.fallbackModels] : false;
	if (draft.thinking !== base.thinking) override.thinking = draft.thinking ?? false;
	if (draft.systemPromptMode !== base.systemPromptMode) override.systemPromptMode = draft.systemPromptMode;
	if (draft.inheritProjectContext !== base.inheritProjectContext) override.inheritProjectContext = draft.inheritProjectContext;
	if (draft.inheritSkills !== base.inheritSkills) override.inheritSkills = draft.inheritSkills;
	if (draft.defaultContext !== base.defaultContext) override.defaultContext = draft.defaultContext ?? false;
	if (draft.disabled !== base.disabled) override.disabled = draft.disabled ?? false;
	if (draft.systemPrompt !== base.systemPrompt) override.systemPrompt = draft.systemPrompt;
	if (!arraysEqual(draft.skills, base.skills)) override.skills = draft.skills ? [...draft.skills] : false;
	if (!arraysEqual(draft.tools, base.tools)) override.tools = draft.tools ? [...draft.tools] : false;
	if ((draft.completionGuard !== false) !== (base.completionGuard !== false)) {
		override.completionGuard = draft.completionGuard !== false;
	}

	return Object.keys(override).length > 0 ? override : undefined;
}

export function saveBuiltinAgentOverride(
	cwd: string,
	name: string,
	scope: "user" | "project",
	override: BuiltinAgentOverrideConfig,
): string {
	// Reads merge project settings across every level cwd->git root (see
	// readMergedProjectSubagentSettings), but writes target only the NEAREST
	// project root: edits from a subdir land at the closest writable anchor
	// instead of silently mutating an ancestor's settings.
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents && typeof settings.subagents === "object" && !Array.isArray(settings.subagents)
		? { ...(settings.subagents as Record<string, unknown>) }
		: {};
	const agentOverrides = subagents.agentOverrides && typeof subagents.agentOverrides === "object" && !Array.isArray(subagents.agentOverrides)
		? { ...(subagents.agentOverrides as Record<string, unknown>) }
		: {};

	agentOverrides[name] = cloneOverrideValue(override);
	subagents.agentOverrides = agentOverrides;
	settings.subagents = subagents;
	writeSettingsFile(filePath, settings);
	return filePath;
}

export function removeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project"): string {
	const filePath = scope === "project" ? getProjectAgentSettingsPath(cwd) : getUserAgentSettingsPath();
	if (!filePath) throw new Error("Project override is not available here. No project config root was found.");
	if (!fs.existsSync(filePath)) return filePath;

	const settings = readSettingsFileStrict(filePath);
	const subagents = settings.subagents;
	if (!subagents || typeof subagents !== "object" || Array.isArray(subagents)) return filePath;
	const nextSubagents = { ...(subagents as Record<string, unknown>) };
	const agentOverrides = nextSubagents.agentOverrides;
	if (!agentOverrides || typeof agentOverrides !== "object" || Array.isArray(agentOverrides)) return filePath;

	const nextOverrides = { ...(agentOverrides as Record<string, unknown>) };
	delete nextOverrides[name];
	if (Object.keys(nextOverrides).length > 0) nextSubagents.agentOverrides = nextOverrides;
	else delete nextSubagents.agentOverrides;

	if (Object.keys(nextSubagents).length > 0) settings.subagents = nextSubagents;
	else delete settings.subagents;

	writeSettingsFile(filePath, settings);
	return filePath;
}

// Subtrees never scanned for agents/chains. `skills/` holds skill packages
// (each with a `SKILL.md` carrying name+description frontmatter that would
// otherwise be mistaken for an agent persona).
// Discovery reads agent/chain roots FLAT (top-level entries only). Subdirectories
// are reserved for typed content (skills/, chains/) and are never scanned for
// personas, so a repo's skills/<name>/SKILL.md is never mistaken for an agent.
function listFilesFlat(dir: string, predicate: (fileName: string) => boolean): string[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		if (!predicate(entry.name)) continue;
		files.push(path.join(dir, entry.name));
	}
	return files;
}

// A persona file is a top-level *.md that is neither a chain definition nor a
// skill manifest. SKILL.md is excluded by name because it carries name+description
// frontmatter and would otherwise be loaded as an agent.
function isAgentFileName(fileName: string): boolean {
	return fileName.endsWith(".md") && !fileName.endsWith(".chain.md") && fileName !== "SKILL.md";
}

function isChainFileName(fileName: string): boolean {
	return fileName.endsWith(".chain.md") || fileName.endsWith(".chain.json");
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	for (const filePath of listFilesFlat(dir, isAgentFileName)) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const localName = frontmatter.name;
		const parsedPackage = parsePackageName(frontmatter.package, `Agent '${localName}' package`);
		if (parsedPackage.error) continue;
		const packageName = parsedPackage.packageName;
		const runtimeName = buildRuntimeName(localName, packageName);

		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (tools) assertNoMcpDirectTools(tools, `Agent '${localName}' in '${filePath}'`);

		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const fallbackModels = frontmatter.fallbackModels
			?.split(",")
			.map((model) => model.trim())
			.filter(Boolean);
		const systemPromptMode = frontmatter.systemPromptMode === "replace"
			? "replace"
			: frontmatter.systemPromptMode === "append"
				? "append"
				: defaultSystemPromptMode(localName);
		const inheritProjectContext = frontmatter.inheritProjectContext === "true"
			? true
			: frontmatter.inheritProjectContext === "false"
				? false
				: defaultInheritProjectContext(localName);
		const inheritSkills = frontmatter.inheritSkills === "true"
			? true
			: frontmatter.inheritSkills === "false"
				? false
				: defaultInheritSkills();
		const defaultContext = frontmatter.defaultContext === "fork"
			? "fork" as const
			: frontmatter.defaultContext === "fresh"
				? "fresh" as const
				: undefined;

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		const parsedMaxSubagentDepth = Number(frontmatter.maxSubagentDepth);
		const completionGuard = frontmatter.completionGuard === "false"
			? false
			: frontmatter.completionGuard === "true"
				? true
				: undefined;

		agents.push({
			name: runtimeName,
			localName,
			packageName,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
			thinking: frontmatter.thinking,
			systemPromptMode,
			inheritProjectContext,
			inheritSkills,
			defaultContext,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			maxSubagentDepth:
				Number.isInteger(parsedMaxSubagentDepth) && parsedMaxSubagentDepth >= 0
					? parsedMaxSubagentDepth
					: undefined,
			completionGuard,
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: "user" | "project"): { chains: ChainConfig[]; diagnostics: ChainDiscoveryDiagnostic[] } {
	const chains = new Map<string, ChainConfig>();
	const diagnostics: ChainDiscoveryDiagnostic[] = [];

	for (const filePath of listFilesFlat(dir, isChainFileName)) {
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			const chain = filePath.endsWith(".chain.json") ? parseJsonChain(content, source, filePath) : parseChain(content, source, filePath);
			const existing = chains.get(chain.name);
			if (existing && existing.filePath.endsWith(".chain.json") && filePath.endsWith(".chain.md")) continue;
			chains.set(chain.name, chain);
		} catch (error) {
			diagnostics.push({ source, filePath, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
	}

	return { chains: Array.from(chains.values()), diagnostics };
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

// Single source of truth for agent persona discovery precedence.
//
// Roots are listed LOWEST -> HIGHEST priority. Downstream merging is
// last-writer-wins (Map.set / mergeAgentsForScope), so a later root overrides an
// earlier one on name collision. Builtins are loaded separately from
// BUILTIN_AGENTS_DIR and sit BELOW every root here. Project discovery is NOT a
// single root: enumerateProjectLevels walks cwd -> git root and aggregates every
// level that has .pi or .agents (farthest-first), so each level contributes its
// own .agents / .pi/agents pair and nearest wins:
//
//   builtin
//     < ~/.agents                              global, cross-harness convention
//     < <PI_CODING_AGENT_DIR>/agents            pi profile (PI_CODING_AGENT_DIR defaults to ~/.pi/agent)
//     < <farthest project level>/.agents        project, legacy layout
//     < <farthest project level>/.pi/agents     project, preferred layout
//     < ...                                     intermediate levels
//     < <nearest project level>/.agents
//     < <nearest project level>/.pi/agents      (highest)
//
// Any project level outranks all user roots; nearest project level wins; within a
// level .pi/agents beats .agents. With no git root, the walk falls back to the
// single nearest project root (findNearestProjectRoot). PI_CODING_AGENT_DIR
// relocates the pi profile root; it does NOT sandbox discovery. ~/.agents is
// always scanned regardless of PI_CODING_AGENT_DIR.
//
// All roots are read flat (see listFilesFlat): only top-level *.md personas are
// loaded; subdirectories such as skills/ are never scanned.
function resolveUserAgentDirs(): string[] {
	return [
		path.join(os.homedir(), ".agents"),
		path.join(getAgentDir(), "agents"),
	];
}

// Highest-priority user root: the canonical location for creating new user
// agents and the value surfaced as `userDir`.
function preferredUserAgentDir(): string {
	const dirs = resolveUserAgentDirs();
	return dirs[dirs.length - 1];
}

// Dedup expanded read dirs by realpath, keeping the NEAREST occurrence and
// repositioning it last among distinct dirs (the consuming Map is last-writer-
// wins). Walking from the end makes a nearest .pi that symlinks to a farther
// real dir win over a same-level .agents, which first-position dedup inverts.
function dedupeByRealPath(dirs: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (let i = dirs.length - 1; i >= 0; i--) {
		const real = resolveRealPath(dirs[i]);
		if (seen.has(real)) continue;
		seen.add(real);
		result.push(dirs[i]);
	}
	return result.reverse();
}

function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const levels = enumerateProjectLevels(cwd);
	if (levels.length === 0) return { readDirs: [], preferredDir: null };

	const candidates: string[] = [];
	for (const level of levels) {
		const legacyDir = path.join(level, ".agents");
		const preferredDir = path.join(level, ".pi", "agents");
		if (isDirectory(legacyDir)) candidates.push(legacyDir);
		if (isDirectory(preferredDir)) candidates.push(preferredDir);
	}
	const nearestLevel = levels[levels.length - 1];
	return { readDirs: dedupeByRealPath(candidates), preferredDir: path.join(nearestLevel, ".pi", "agents") };
}

function resolveNearestProjectChainDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
	const levels = enumerateProjectLevels(cwd);
	if (levels.length === 0) return { readDirs: [], preferredDir: null };

	const candidates: string[] = [];
	for (const level of levels) {
		const chainsDir = path.join(level, ".pi", "chains");
		if (isDirectory(chainsDir)) candidates.push(chainsDir);
	}
	const nearestLevel = levels[levels.length - 1];
	return { readDirs: dedupeByRealPath(candidates), preferredDir: path.join(nearestLevel, ".pi", "chains") };
}
const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agents");

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirs = resolveUserAgentDirs();
	const { readDirs: projectAgentDirs, preferredDir: projectAgentsDir } = resolveNearestProjectAgentDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = scope === "project" ? EMPTY_SUBAGENT_SETTINGS : readSubagentSettings(userSettingsPath);
	const projectSettings = scope === "user" ? EMPTY_SUBAGENT_SETTINGS : readMergedProjectSubagentSettings(cwd);

	const builtinAgents = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const userAgents = applyCustomAgentOverrides(
		scope === "project" ? [] : userDirs.flatMap((dir) => loadAgentsFromDir(dir, "user")),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const projectAgents = applyCustomAgentOverrides(
		scope === "user" ? [] : projectAgentDirs.flatMap((dir) => loadAgentsFromDir(dir, "project")),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const agents = mergeAgentsForScope(scope, userAgents, projectAgents, builtinAgents)
		.filter((agent) => agent.disabled !== true);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	chainDiagnostics: ChainDiscoveryDiagnostic[];
	userDir: string;
	projectDir: string | null;
	userChainDir: string;
	projectChainDir: string | null;
	userSettingsPath: string;
	projectSettingsPath: string | null;
} {
	const userDirs = resolveUserAgentDirs();
	const userChainDir = getUserChainDir();
	const { readDirs: projectDirs, preferredDir: projectDir } = resolveNearestProjectAgentDirs(cwd);
	const { readDirs: projectChainDirs, preferredDir: projectChainDir } = resolveNearestProjectChainDirs(cwd);
	const userSettingsPath = getUserAgentSettingsPath();
	const projectSettingsPath = getProjectAgentSettingsPath(cwd);
	const userSettings = readSubagentSettings(userSettingsPath);
	const projectSettings = readMergedProjectSubagentSettings(cwd);

	const builtin = applyBuiltinOverrides(
		loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin"),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const user = applyCustomAgentOverrides(
		userDirs.flatMap((dir) => loadAgentsFromDir(dir, "user")),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);
	const projectMap = new Map<string, AgentConfig>();
	for (const dir of projectDirs) {
		for (const agent of loadAgentsFromDir(dir, "project")) {
			projectMap.set(agent.name, agent);
		}
	}
	const project = applyCustomAgentOverrides(
		Array.from(projectMap.values()),
		userSettings,
		projectSettings,
		userSettingsPath,
		projectSettingsPath,
	);

	const chainMap = new Map<string, ChainConfig>();
	const projectChainDiagnostics: ChainDiscoveryDiagnostic[] = [];
	for (const dir of projectChainDirs) {
		const loaded = loadChainsFromDir(dir, "project");
		projectChainDiagnostics.push(...loaded.diagnostics);
		for (const chain of loaded.chains) {
			chainMap.set(chain.name, chain);
		}
	}
	const userChains = loadChainsFromDir(userChainDir, "user");
	const chains = [
		...userChains.chains,
		...Array.from(chainMap.values()),
	];
	const chainDiagnostics = [
		...userChains.diagnostics,
		...projectChainDiagnostics,
	];

	const userDir = preferredUserAgentDir();

	return { builtin, user, project, chains, chainDiagnostics, userDir, projectDir, userChainDir, projectChainDir, userSettingsPath, projectSettingsPath };
}
