/**
 * Per-attempt scaffolding and post-process finalization shared by every
 * single-attempt executor (native spawn loop, external foreground bridge).
 * Deliberately has no dependency on execution.ts or external-single-attempt.ts
 * so neither backend module needs to import the other.
 */
import { existsSync, unlinkSync } from "node:fs";
import type { AgentConfig } from "../../agents/agents.ts";
import { blockedLine, evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import { detectSubagentError, getFinalOutput } from "../../shared/utils.ts";
import { stripAcceptanceReport } from "../shared/acceptance.ts";
import type {
	AgentProgress,
	ArtifactPaths,
	ControlEvent,
	RunSyncOptions,
	SingleResult,
	Usage,
} from "../../shared/types.ts";

export const artifactOutputByResult = new WeakMap<SingleResult, string>();
export const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

export function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
		executionSurface: result.executionSurface
			? { handle: result.executionSurface.handle, retained: result.executionSurface.retained }
			: undefined,
	};
}

export interface AttemptSharedInit {
	sessionEnabled: boolean;
	systemPrompt: string;
	resolvedSkillNames?: string[];
	skillsWarning?: string;
	jsonlPath?: string;
	artifactPaths?: ArtifactPaths;
	attemptNotes: string[];
	outputSnapshot?: SingleOutputSnapshot;
	originalTask?: string;
}

export interface AttemptInit {
	result: SingleResult;
	progress: AgentProgress;
	startTime: number;
	controlConfig: ReturnType<typeof resolveControlConfig>;
	allControlEvents: ControlEvent[];
	pendingControlEvents: ControlEvent[];
	emittedControlEventKeys: Set<string>;
	emitControlEvent: (event: ControlEvent) => void;
}

function resolveControlConfig(options: RunSyncOptions) {
	return options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
}

/**
 * Build the shared per-attempt result/progress/control-event scaffolding used
 * by both the native spawn loop and the external single-attempt bridge,
 * before any process is started or any owner attempt is launched.
 */
export function initializeAttempt(
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: AttemptSharedInit,
): AttemptInit {
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	const controlConfig = resolveControlConfig(options);
	const allControlEvents: ControlEvent[] = [];
	const pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
		turnOpen: false,
		lastProductiveSignalAt: startTime,
	};
	result.progress = progress;
	return { result, progress, startTime, controlConfig, allControlEvents, pendingControlEvents, emittedControlEventKeys, emitControlEvent };
}

export interface FinalizeAttemptContext {
	agent: AgentConfig;
	options: RunSyncOptions;
	outputSnapshot?: SingleOutputSnapshot;
	observedMutationAttempt: boolean;
	interruptedByControl: boolean;
	allControlEvents: ControlEvent[];
	emitControlEvent: (event: ControlEvent) => void;
	startTime: number;
}

/**
 * Post-process an attempt once messages/usage/exit are known: hidden-error
 * detection, blocker/`BLOCKED:` classification, structured output, the
 * completion-mutation guard, output snapshot/file handling, and the final
 * progress-completion + onUpdate emission. Shared by native and external
 * single attempts.
 */
export function finalizeSingleAttempt(
	result: SingleResult,
	progress: AgentProgress,
	ctx: FinalizeAttemptContext,
): SingleResult {
	const { agent, options } = ctx;
	if (ctx.interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = ctx.allControlEvents.length ? ctx.allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - ctx.startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	const acceptanceOutput = getFinalOutput(result.messages);
	let fullOutput = stripAcceptanceReport(acceptanceOutput);
	if (result.exitCode === 0 && !result.error && blockedLine(fullOutput)) {
		result.exitCode = 1;
		result.error = fullOutput;
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput({
			schema: options.structuredOutput.schema,
			schemaPath: options.structuredOutput.schemaPath,
			outputPath: options.structuredOutput.outputPath,
		});
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - ctx.startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	const completionGuard = result.exitCode === 0 && !result.error && agent.completionGuard !== false
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: result.task,
			messages: result.messages,
			tools: agent.tools,
		})
		: undefined;
	if (completionGuard?.triggered && !ctx.observedMutationAttempt) {
		result.exitCode = 1;
		result.error = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
		progress.status = "failed";
		progress.error = result.error;
		ctx.emitControlEvent(buildControlEvent({
			from: progress.activityState,
			to: "needs_attention",
			runId: options.runId ?? agent.name,
			agent: agent.name,
			index: options.index,
			ts: Date.now(),
			message: `${agent.name} completed without making edits for an implementation task`,
			reason: "completion_guard",
		}));
	}
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, ctx.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	acceptanceOutputByResult.set(result, acceptanceOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = ctx.allControlEvents.length ? ctx.allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: ctx.allControlEvents.length ? ctx.allControlEvents : undefined,
			},
		});
	}
	return result;
}
