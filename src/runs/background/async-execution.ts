/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import { PINNED_AGENT_DIR_OVERRIDE } from "../../shared/agent-dir.ts";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveParallelTaskOutputPath, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { isDynamicRunnerGroup, isParallelGroup, type RunnerStep } from "../shared/parallel-utils.ts";
import { getPiSpawnCommand, PiRuntimeLaunchError, type PiRuntimeIdentity } from "../shared/pi-spawn.ts";
import { ensureJitiCliPath, resolveHostModuleAliases } from "../shared/jiti-cli.ts";
export { createJitiCliResolver } from "../shared/jiti-cli.ts";
import { buildSkillInjection, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveModelCandidate, type AvailableModelInfo } from "../shared/model-fallback.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import { executionBackendRegistrations } from "../../execution-backend/registry.ts";
import type { DetachedExecutionBackendConfig } from "../../execution-backend/types.ts";
import {
	type AcceptanceInput,
	type ArtifactConfig,
	type Details,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type SubagentRunMode,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	TEMP_ROOT_DIR,
	RUN_STATE_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";

interface AsyncExecutionContext {
	runtime: PiRuntimeIdentity;
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	currentModelProvider?: string;
	/** Parent session model as provider/id, captured at dispatch */
	parentModel?: string;
	/** Parent session thinking level, captured at dispatch */
	parentThinking?: string;
	/** Parent session display name, or its id when unnamed, captured at dispatch */
	parentSessionLabel?: string;
	executionBackend?: string;
}

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	resultMode?: Exclude<SubagentRunMode, "single">;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	originSessionRoot?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeTeardownHook?: string;
	worktreeTeardownHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	nestedRoute?: NestedRouteInfo;
	forwardedFlags?: string[];
	acceptance?: AcceptanceInput;
}

function detachedExecutionBackends(userPreference: string | undefined): DetachedExecutionBackendConfig {
	return {
		protocolVersion: 1,
		...(userPreference === undefined ? {} : { userPreference }),
		registrations: executionBackendRegistrations(),
	};
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionFile?: string;
	originSessionRoot?: string;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	modelOverride?: string;
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeTeardownHook?: string;
	worktreeTeardownHookTimeoutMs?: number;
	controlConfig?: ResolvedControlConfig;
	nestedRoute?: NestedRouteInfo;
	forwardedFlags?: string[];
	acceptance?: AcceptanceInput;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export function formatAsyncStartedMessage(headline: string): string {
	return [
		headline,
		"",
		"The async run is running in the background. Do not run sleep timers or polling loops just to wait for it.",
		"If you have independent work, continue that work. If you have nothing else to do until the async result arrives, end your turn now; Pi will deliver the completion when the run finishes.",
		"Use subagent({ action: \"status\", id: \"...\" }) when you need the current status/result, or to inspect a blocked/stale run. Do not poll just to wait.",
	].join("\n");
}

/**
 * Check if jiti is available for async execution
 */
export function isAsyncAvailable(runtime: PiRuntimeIdentity): boolean {
	return ensureJitiCliPath(runtime.piPackageRoot) !== undefined;
}

/**
 * Spawn a background process with stderr/stdout captured to <asyncDir>/runner.log.
 * Falls back to ignored stdio if the log file cannot be opened; the parent always
 * closes its copy of the fd, on every exit path.
 */
export function spawnDetachedWithLog(command: string, args: string[], cwd: string, asyncDir: string, spawnImpl: typeof spawn = spawn, env?: NodeJS.ProcessEnv): { pid?: number; error?: string } {
	let fd: number | undefined;
	try {
		try {
			fd = fs.openSync(path.join(asyncDir, "runner.log"), "a");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[pi-cohort] could not open runner.log in ${asyncDir}: ${message}`);
		}
		const proc = spawnImpl(command, args, {
			cwd,
			env,
			detached: true,
			stdio: fd === undefined ? "ignore" : ["ignore", fd, fd],
			windowsHide: true,
		});
		proc.on("error", (error) => {
			console.error(`[pi-cohort] async spawn failed: ${error.message}`);
		});
		if (typeof proc.pid !== "number") {
			return { error: `async runner did not produce a pid for cwd: ${cwd}` };
		}
		proc.unref();
		return { pid: proc.pid };
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// parent-side close failure never misreports a launched child
			}
		}
	}
}

/**
 * Spawn the async runner process
 */
export function spawnRunner(
	cfg: { runtime: PiRuntimeIdentity },
	suffix: string,
	cwd: string,
	asyncDir: string,
	deps: { ensureJiti?: (root: string) => string | undefined; spawnImpl?: typeof spawn; hostAliases?: (root: string) => Record<string, string> } = {},
): { pid?: number; error?: string } {
	const ensureJiti = deps.ensureJiti ?? ensureJitiCliPath;
	const jitiCliPath = ensureJiti(cfg.runtime.piPackageRoot);
	if (!jitiCliPath) {
		throw new PiRuntimeLaunchError(`Cannot resolve jiti from selected Pi installation ${cfg.runtime.piPackageRoot}`);
	}

	getPiSpawnCommand([], cfg.runtime);
	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) {
			return { error: `cwd is not a directory: ${cwd}` };
		}
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	fs.writeFileSync(cfgPath, JSON.stringify(cfg));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");

	const aliases = (deps.hostAliases ?? resolveHostModuleAliases)(cfg.runtime.piPackageRoot);
	const env = Object.keys(aliases).length > 0
		? { ...process.env, JITI_ALIAS: JSON.stringify(aliases) }
		: { ...process.env };
	if (PINNED_AGENT_DIR_OVERRIDE) env.PI_CODING_AGENT_DIR = PINNED_AGENT_DIR_OVERRIDE;

	return spawnDetachedWithLog(cfg.runtime.nodeExecPath, [jitiCliPath, runner, cfgPath], cwd, asyncDir, deps.spawnImpl ?? spawn, env);
}

type NestedStartWriter = (...args: Parameters<typeof writeNestedEvent>) => void | boolean;

function publishAndSpawnRunner(
	cfg: { runtime: PiRuntimeIdentity; id: string; steps: RunnerStep[]; sessionId: string; sessionDir: string; resultMode: SubagentRunMode; [key: string]: unknown },
	suffix: string,
	cwd: string,
	asyncDir: string,
	origin: { route?: NestedRouteInfo; address?: ReturnType<typeof resolveNestedParentAddressFromEnv>; sessionFile?: string; sessionFiles?: string[]; sessionRoot?: string },
	writeStart: NestedStartWriter,
): { pid?: number; error?: string } {
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const steps: object[] = [];
	for (const [stepIndex, step] of cfg.steps.entries()) {
		const leaves = isParallelGroup(step) ? step.parallel : isDynamicRunnerGroup(step) ? [step.parallel] : [step];
		if (isParallelGroup(step) || isDynamicRunnerGroup(step)) parallelGroups.push({ start: steps.length, count: leaves.length, stepIndex });
		for (const leaf of leaves) {
			steps.push({
				agent: isDynamicRunnerGroup(step) ? `expand:${leaf.agent}` : leaf.agent,
				phase: isDynamicRunnerGroup(step) ? step.phase ?? leaf.phase : leaf.phase,
				label: isDynamicRunnerGroup(step) ? step.label ?? leaf.label ?? `Dynamic fanout (${step.collect.as})` : leaf.label,
				outputName: isDynamicRunnerGroup(step) ? step.collect.as : leaf.outputName,
				structured: isDynamicRunnerGroup(step) ? Boolean(step.collect.outputSchema) : leaf.structured,
				status: "pending",
				...(isDynamicRunnerGroup(step) ? {} : {
					sessionFile: leaf.sessionFile,
					skills: leaf.skills,
					model: leaf.model,
					thinking: leaf.thinking,
					attemptedModels: leaf.modelCandidates && leaf.modelCandidates.length > 0 ? leaf.modelCandidates : leaf.model ? [leaf.model] : undefined,
				}),
				recentTools: [],
				recentOutput: [],
			});
		}
	}
	let preparationError: unknown;
	try {
		fs.mkdirSync(cfg.sessionDir, { recursive: true });
		cfg.sessionDir = fs.realpathSync.native(cfg.sessionDir);
	} catch (error) {
		preparationError = error;
	}
	const statusPath = path.join(asyncDir, "status.json");
	const now = Date.now();
	const status = {
		runId: cfg.id, runtime: cfg.runtime, sessionId: cfg.sessionId,
		state: "queued", mode: cfg.resultMode, cwd, currentStep: 0, chainStepCount: cfg.steps.length,
		startedAt: now, lastUpdate: now, lastActivityAt: now, outputFile: path.join(asyncDir, "output-0.log"), steps, parallelGroups, workflowGraph: cfg.workflowGraph,
		artifactsDir: cfg.artifactsDir, sessionDir: cfg.sessionDir,
	};
	writeAtomicJson(statusPath, status);
	try {
		if (preparationError) throw preparationError;
		let sessionRoot = cfg.sessionDir;
		if (origin.sessionRoot !== undefined) {
			if (!origin.sessionFile && !origin.sessionFiles?.length) throw new Error("Origin session root requires a reused session file.");
			if (!path.isAbsolute(origin.sessionRoot)) throw new Error("Origin session root must be absolute.");
			let stat: fs.Stats;
			try {
				stat = fs.statSync(origin.sessionRoot);
			} catch {
				throw new Error("Origin session root must exist.");
			}
			if (!stat.isDirectory()) throw new Error("Origin session root must be a directory.");
			sessionRoot = fs.realpathSync.native(origin.sessionRoot);
			if (sessionRoot !== origin.sessionRoot) throw new Error("Origin session root must be canonical and cannot be retargeted.");
		}
		const effectiveFiles = origin.sessionFiles ?? (origin.sessionFile ? [origin.sessionFile] : []);
		if (origin.sessionRoot) {
			const contains = (candidate: string) => {
				const relative = path.relative(sessionRoot, candidate);
				return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
			};
			if (origin.sessionFiles && !contains(cfg.sessionDir)) throw new Error("Runner session directory is outside origin session root.");
			for (const file of effectiveFiles) {
				if (!fs.existsSync(file)) throw new Error("Reused session file must be an existing regular .jsonl file.");
				const stat = fs.lstatSync(file);
				if (!stat.isFile() || stat.isSymbolicLink() || path.extname(file) !== ".jsonl") throw new Error("Reused session file must be a regular .jsonl file.");
				if (!contains(fs.realpathSync.native(file))) throw new Error("Reused session file is outside origin session root.");
			}
		}
		if (origin.route && origin.address) {
			if (effectiveFiles.some(file => fs.existsSync(file)) && !origin.sessionRoot) throw new Error("Origin session root is required for a reused nested session.");
			const firstLeaf = isParallelGroup(cfg.steps[0]) ? cfg.steps[0].parallel[0] : isDynamicRunnerGroup(cfg.steps[0]) ? cfg.steps[0].parallel : cfg.steps[0];
			const agents = cfg.steps.flatMap(step => isParallelGroup(step) ? step.parallel.map(leaf => leaf.agent) : isDynamicRunnerGroup(step) ? [step.parallel.agent] : [step.agent]);
			try {
				if (writeStart(origin.route, {
					type: "subagent.nested.started", ts: now,
					parentRunId: origin.address.parentRunId, parentStepIndex: origin.address.parentStepIndex,
					child: {
						id: cfg.id, ...origin.address, asyncDir, sessionId: cfg.sessionId, capabilityToken: origin.route.capabilityToken,
						runtime: cfg.runtime, sessionRoot, mode: cfg.resultMode, state: "queued",
						agent: firstLeaf?.agent, agents, chainStepCount: cfg.steps.length, parallelGroups,
						startedAt: now, lastUpdate: now,
					},
				}) === false) throw new Error("Nested origin stamp was refused.");
			} catch (error) {
				throw new Error(`Failed to stamp nested origin: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		}
		const result = spawnRunner(cfg, suffix, cwd, asyncDir);
		if (result.error) throw new Error(result.error);
		return result;
	} catch (error) {
		writeAtomicJson(statusPath, { ...status, state: "failed", error: error instanceof Error ? error.message : String(error), lastUpdate: Date.now() });
		throw error;
	}
}

/**
 * Build the headline shown at the top of an async start message, e.g.
 * "Async single: my-agent [run-id]\nAsync dir: /tmp/...".
 */
export function asyncStartHeadline(prefix: string, id: string, asyncDir: string): string {
	return `${prefix} [${id}]\nAsync dir: ${asyncDir}`;
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-cohort";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
	writeStart: NestedStartWriter = writeNestedEvent,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeTeardownHook,
		worktreeTeardownHookTimeoutMs,
		controlConfig,
		nestedRoute,
		forwardedFlags,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: chain });

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
			: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return {
					content: [{ type: "text", text: `Unknown agent: ${agentName}` }],
					isError: true,
					details: { mode: resultMode, results: [] },
				};
			}
		}
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(path.dirname(asyncDir), { recursive: true });
		fs.mkdirSync(asyncDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior, isolatedLeaf?: { runDir: string; index: number }, groupCwd?: string) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const effectiveCwd = s.cwd ?? groupCwd;
		const templatedCwd = effectiveCwd?.includes("{outputs.");
		const stepCwd = templatedCwd ? effectiveCwd : resolveChildCwd(runnerCwd, effectiveCwd);
		const preparationCwd = templatedCwd ? runnerCwd : stepCwd;
		const instructionCwd = behaviorCwd ?? preparationCwd;
		const behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const skillNames = behavior.skills === false ? [] : behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, preparationCwd, ctx.cwd);
		if (missingSkills.includes("pi-cohort")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, runnerCwd, isFirstProgressAgent);
		const resolvedOutput = resolveParallelTaskOutputPath({
			output: behavior.output,
			ctxCwd: ctx.cwd,
			taskCwd: instructionCwd,
			isolated: Boolean(isolatedLeaf),
			runDir: isolatedLeaf?.runDir,
			index: isolatedLeaf?.index ?? 0,
		});
		if ("error" in resolvedOutput) throw new AsyncStartValidationError(resolvedOutput.error);
		const outputPath = resolvedOutput.path;
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const task = injectSingleOutputInstruction(`${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`, outputPath);

		const primaryRaw = behavior.model ?? a.model ?? ctx.parentModel;
		const thinking = a.thinking ?? ctx.parentThinking;
		const primaryModel = resolveModelCandidate(primaryRaw, availableModels, ctx.currentModelProvider);
		const model = applyThinkingSuffix(primaryModel, thinking);
		return {
			agent: s.agent,
			task,
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, thinking),
			modelCandidates: buildModelCandidates(primaryRaw, a.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
				applyThinkingSuffix(candidate, thinking),
			),
			tools: a.tools,
			extensions: a.extensions,
			completionGuard: a.completionGuard,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				task: s.task,
				mode: resultMode,
				async: true,
				dynamic: false,
			}),
			...(s.stopOn ? { stopOn: s.stopOn } : {}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextSessionFile = (): string | undefined => {
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return sessionFile;
	};

	let steps: RunnerStep[];
	try {
		steps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const groupCwd = s.cwd?.includes("{outputs.") ? runnerCwd : resolveChildCwd(runnerCwd, s.cwd);
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree) writeInitialProgressFile(groupCwd);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(groupCwd, `${id}-s${stepIndex}`, taskIndex);
							} catch {
								behaviorCwd = undefined;
							}
						}
						return buildSeqStep(
							t,
							nextSessionFile(),
							behaviorCwd,
							progressPrecreated,
							parallelBehaviors[taskIndex],
							s.worktree ? { runDir: path.join(asyncDir, `step-${stepIndex}`), index: taskIndex } : undefined,
							s.cwd,
						);
					}),
					cwd: s.cwd,
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
					stopOn: s.stopOn,
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(runnerCwd);
					progressInstructionCreated = true;
				}
				return {
					expand: s.expand,
					parallel: buildSeqStep(s.parallel as SequentialStep, undefined, undefined, progressPrecreated, behavior),
					collect: s.collect,
					concurrency: s.concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					stopOn: s.stopOn,
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.agent,
						task: s.parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
					}),
				};
			}
			return buildSeqStep(s as SequentialStep, nextSessionFile());
		});
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return formatAsyncStartError(resultMode, error.message);
		throw error;
	}

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = publishAndSpawnRunner(
			{
				id,
				steps,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: path.join(sessionRoot ?? path.join(RUN_STATE_ROOT_DIR, "sessions"), `async-${id}`),
				asyncDir,
				sessionId: ctx.currentSessionId,
				parentSessionLabel: ctx.parentSessionLabel,
				runtime: ctx.runtime,
				forwardedFlags,
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeTeardownHook,
				worktreeTeardownHookTimeoutMs,
				controlConfig,
				resultMode,
				executionBackends: detachedExecutionBackends(ctx.executionBackend),
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				workflowGraph,
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			asyncDir,
			{
				route: inheritedNestedRoute,
				address: nestedAddress,
				sessionFiles: steps
					.flatMap(step => isParallelGroup(step) ? step.parallel : isDynamicRunnerGroup(step) ? [step.parallel] : [step])
					.flatMap(step => step.sessionFile ? [step.sessionFile] : []),
				sessionRoot: params.originSessionRoot,
			},
			writeStart,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		const firstStep = chain[0];
		const firstAgents = isParallelStep(firstStep)
			? firstStep.parallel.map((t) => t.agent)
			: isDynamicParallelStep(firstStep)
				? [firstStep.parallel.agent]
			: [(firstStep as SequentialStep).agent];
		const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
		const flatAgents: string[] = [];
		let flatStepStart = 0;
		for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
			const step = chain[stepIndex]!;
			if (isParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
				flatAgents.push(...step.parallel.map((task) => task.agent));
				flatStepStart += step.parallel.length;
			} else if (isDynamicParallelStep(step)) {
				parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
				flatAgents.push(step.parallel.agent);
				flatStepStart++;
			} else {
				flatAgents.push((step as SequentialStep).agent);
				flatStepStart++;
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgents,
			task: isParallelStep(firstStep)
				? firstStep.parallel[0]?.task?.slice(0, 50)
				: isDynamicParallelStep(firstStep)
					? firstStep.parallel.task?.slice(0, 50)
				: (firstStep as SequentialStep).task?.slice(0, 50),
			chain: chain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			),
			chainStepCount: chain.length,
			parallelGroups,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			nestedRoute,
		});
	}

	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(asyncStartHeadline(`Async ${resultMode}: ${chainDesc}`, id, asyncDir)) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
	writeStart: NestedStartWriter = writeNestedEvent,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeTeardownHook,
		worktreeTeardownHookTimeoutMs,
		controlConfig,
		nestedRoute,
		forwardedFlags,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	if (missingSkills.includes("pi-cohort")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(RUN_STATE_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(path.dirname(asyncDir), { recursive: true });
		fs.mkdirSync(asyncDir);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	const primaryRaw = params.modelOverride ?? agentConfig.model ?? ctx.parentModel;
	const thinking = agentConfig.thinking ?? ctx.parentThinking;
	const model = applyThinkingSuffix(resolveModelCandidate(primaryRaw, availableModels, ctx.currentModelProvider), thinking);
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = publishAndSpawnRunner(
			{
				id,
				steps: [
					{
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model,
						thinking: resolveEffectiveThinking(model, thinking),
						modelCandidates: buildModelCandidates(primaryRaw, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider).map((candidate) =>
							applyThinkingSuffix(candidate, thinking),
						),
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						completionGuard: agentConfig.completionGuard,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						effectiveAcceptance: resolveEffectiveAcceptance({
							explicit: params.acceptance,
							agentName: agent,
							task,
							mode: "single",
							async: true,
						}),
					},
				],
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: path.join(sessionRoot ?? path.join(RUN_STATE_ROOT_DIR, "sessions"), `async-${id}`),
				asyncDir,
				sessionId: ctx.currentSessionId,
				parentSessionLabel: ctx.parentSessionLabel,
				runtime: ctx.runtime,
				forwardedFlags,
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeTeardownHook,
				worktreeTeardownHookTimeoutMs,
				controlConfig,
				resultMode: "single",
				executionBackends: detachedExecutionBackends(ctx.executionBackend),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			asyncDir,
			{ route: inheritedNestedRoute, address: nestedAddress, sessionFile, sessionRoot: params.originSessionRoot },
			writeStart,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
			nestedRoute,
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(asyncStartHeadline(`Async: ${agent}`, id, asyncDir)) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir },
	};
}
