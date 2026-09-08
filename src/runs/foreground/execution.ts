/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import { selectConfiguredExecutionBackend } from "../../execution-backend/configured-selection.ts";
import type { ConfiguredSelectionInput } from "../../execution-backend/configured-selection.ts";
import type { ExecutionBackendSelectionResult } from "../../execution-backend/selection.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	truncateOutput,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import {
	applyChildEventToLifecycle,
	buildControlEvent,
	deriveActivityState,
	shouldSilenceKill,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	extractToolArgsPreview,
	extractTextFromContent,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { blockedLine } from "../shared/completion-guard.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { captureSingleOutputSnapshot, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { acceptanceFailureMessage, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "../shared/acceptance.ts";
import {
	acceptanceOutputByResult,
	artifactOutputByResult,
	emptyUsage,
	finalizeSingleAttempt,
	initializeAttempt,
	snapshotProgress,
	snapshotResult,
	type AttemptSharedInit,
} from "./attempt-finalization.ts";
import {
	createExternalForegroundExecution,
	type ExternalForegroundExecution,
	type ExternalForegroundExecutionOptions,
} from "./external-execution.ts";
import {
	runExternalSingleAttempt,
	type RunExternalSingleAttemptInput,
} from "./external-single-attempt.ts";

export { acceptanceOutputByResult, artifactOutputByResult };

export interface RunSyncDependencies {
	selectBackend?: (input: ConfiguredSelectionInput) => Promise<ExecutionBackendSelectionResult>;
	createExternalOwner?: (options: ExternalForegroundExecutionOptions) => Promise<ExternalForegroundExecution>;
	runNativeAttempt?: typeof runSingleAttempt;
	runExternalAttempt?: (input: RunExternalSingleAttemptInput) => Promise<SingleResult>;
}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function failedResult(agent: string, task: string, error: string): SingleResult {
	return { agent, task, exitCode: 1, messages: [], usage: emptyUsage(), error };
}

function safeExternalFailure(phase: "startup" | "attempt" | "finish" | "cleanup"): string {
	return `External execution ${phase} failed`;
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: AttemptSharedInit,
): Promise<SingleResult> {
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		systemPrompt: shared.systemPrompt,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		structuredOutput: options.structuredOutput,
		forwardedFlags: options.forwardedFlags,
	});

	const init = initializeAttempt(agent, task, model, options, shared);
	const { result, progress, startTime, allControlEvents, emitControlEvent } = init;
	let interruptedByControl = false;
	let pendingControlEvents: ControlEvent[] = init.pendingControlEvents;
	const controlConfig = init.controlConfig;
	const spawnEnv = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
	let observedMutationAttempt = false;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: options.cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let assistantError: string | undefined;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;


		// If the child emits a terminal assistant stop but never exits,
		// give it a short grace period to flush naturally, then clean it up.
		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childExited || finalDrainTimer || settled || processClosed) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !assistantError) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		let silenceKillRequested = false;
		const requestSilenceKill = (silenceMs: number) => {
			if (silenceKillRequested || childExited || settled || processClosed) return;
			silenceKillRequested = true;
			const termSent = trySignalChild(proc, "SIGTERM");
			if (!termSent) return;
			forcedTerminationSignal = true;
			result.error = result.error ??
				`Subagent killed: in-flight turn produced no output for ${Math.round(silenceMs / 1000)}s ` +
				`(exceeded inFlightSilenceKillMs=${controlConfig.inFlightSilenceKillMs}ms). Likely wedged in a tool call.`;
			const hardKill = setTimeout(() => {
				if (settled || processClosed) return;
				forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
			}, HARD_KILL_MS);
			hardKill.unref?.();
		};


		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			removeAbortListener?.();
			removeInterruptListener?.();
			resolve(code);
		};

		const drainPendingControlEvents = (): ControlEvent[] | undefined => {
			if (pendingControlEvents.length === 0) return undefined;
			const events = pendingControlEvents;
			pendingControlEvents = [];
			return events;
		};

		let activeLongRunningNotified = false;
		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		const mutatingFailures = createMutatingFailureState();
		const mutatingFailureWindowMs = 5 * 60_000;
		const currentToolDurationMs = (now: number) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
		const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
			if (!controlConfig.enabled) return false;
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			const event = buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				message: input.message,
				reason: input.reason ?? "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: input.currentTool ?? progress.currentTool,
				currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
				currentPath: input.currentPath ?? progress.currentPath,
				recentFailureSummary: input.recentFailureSummary,
			});
			emitControlEvent(event);
			return previous !== "needs_attention";
		};
		const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
			if (!controlConfig.enabled || activeLongRunningNotified || progress.activityState === "needs_attention") return false;
			activeLongRunningNotified = true;
			const previous = progress.activityState;
			progress.activityState = "active_long_running";
			emitControlEvent(buildControlEvent({
				type: "active_long_running",
				from: previous,
				to: "active_long_running",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				message: `${agent.name} is still active but long-running`,
				reason,
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: progress.currentTool,
				currentToolDurationMs: currentToolDurationMs(now),
				currentPath: progress.currentPath,
				elapsedMs: now - startTime,
			}));
			return true;
		};
		const updateActivityState = (now: number): boolean => {
			if (!controlConfig.enabled) return false;
			const idleState = deriveActivityState({
				config: controlConfig,
				startedAt: startTime,
				lastActivityAt: progress.lastActivityAt,
				now,
				inFlightTurn: progress.turnOpen,
				lastProductiveSignalAt: progress.lastProductiveSignalAt,
			});
			if (idleState === "needs_attention") {
				const notified = progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
				if (shouldSilenceKill({
					turnOpen: progress.turnOpen,
					lastProductiveSignalAt: progress.lastProductiveSignalAt,
					startedAt: startTime,
					now,
					killMs: controlConfig.inFlightSilenceKillMs,
				})) {
					requestSilenceKill(now - (progress.lastProductiveSignalAt ?? startTime));
				}
				return notified;
			}
			const activeReason = nextLongRunningTrigger(controlConfig, {
				startedAt: startTime,
				now,
				turns: result.usage.turns,
				tokens: progress.tokens,
			});
			return activeReason ? emitActiveLongRunning(now, activeReason) : false;
		};


		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			const controlEvents = drainPendingControlEvents();
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents,
				},
			});
		};

		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			emitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
			} catch {
				// Non-JSON stdout lines are expected; only structured events are parsed.
				return;
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			const lifecycle = applyChildEventToLifecycle(
				{ turnOpen: progress.turnOpen, lastProductiveSignalAt: progress.lastProductiveSignalAt },
				{
					type: evt.type,
					hasToolCall: evt.type === "message_end" && Array.isArray(evt.message?.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall"),
				},
				now,
			);
			progress.turnOpen = lifecycle.turnOpen;
			progress.lastProductiveSignalAt = lifecycle.lastProductiveSignalAt;
			updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
					? evt.args as Record<string, unknown>
					: {};
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				const mutates = isMutatingTool(evt.toolName, toolArgs);
				observedMutationAttempt = observedMutationAttempt || mutates;
				pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates, startedAt: now };
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				if (progress.currentTool) {
					progress.recentTools.push({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (!result.model && evt.message.model) result.model = evt.message.model;
					if (evt.message.errorMessage) assistantError = evt.message.errorMessage;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					// Final assistant message: start the exit drain window.
					const stopReason = (evt.message as { stopReason?: string }).stopReason;
					const hasToolCall = Array.isArray(evt.message.content)
						&& evt.message.content.some((part) => (part as { type?: string }).type === "toolCall");
					if (stopReason === "stop" && !hasToolCall) {
						if (!evt.message.errorMessage && assistantText.trim()) assistantError = undefined;
						cleanTerminalAssistantStopReceived ||= !evt.message.errorMessage;
						startFinalDrain();
					}
				}
				updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages.push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
				appendRecentOutput(progress, resultText.split("\n").slice(-10));
				const toolSnapshot = pendingToolResult;
				pendingToolResult = undefined;
				if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
					recordMutatingFailure(mutatingFailures, {
						tool: toolSnapshot.tool,
						path: toolSnapshot.path,
						error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
						ts: now,
					}, mutatingFailureWindowMs);
					if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
						emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							currentTool: toolSnapshot.tool,
							currentPath: toolSnapshot.path,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					}
				} else if (toolSnapshot?.mutates) {
					resetMutatingFailureState(mutatingFailures);
				}
				fireUpdate();
			}
		};

		if (controlConfig.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled) return;
				const now = Date.now();
				if (updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		let stderrBuf = "";

		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			childExited = true;
			clearFinalDrainTimers();
		});
		proc.on("close", (code, signal) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (!result.error && assistantError) result.error = assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
				result.error = stderrBuf.trim();
			}
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			finish(finalCode);
		});
		proc.on("error", (error) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			void jsonlWriter.close().catch(() => {
				// JSONL artifact flush is best effort.
			});
			cleanupTempDir(tempDir);
			if (!result.error) {
				result.error = error instanceof Error ? error.message : String(error);
			}
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed) return;
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (processClosed || settled) return;
				interruptedByControl = true;
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				setTimeout(() => {
					if (settled || processClosed) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000).unref?.();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}
	});
	result.exitCode = exitCode;
	return finalizeSingleAttempt(result, progress, {
		agent,
		options,
		outputSnapshot: shared.outputSnapshot,
		observedMutationAttempt,
		interruptedByControl,
		allControlEvents,
		emitControlEvent,
		startTime,
	});
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
	dependencies: RunSyncDependencies = {},
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const childCwd = options.cwd ?? runtimeCwd;
	let backendSelection: ExecutionBackendSelectionResult;
	try {
		backendSelection = await (dependencies.selectBackend ?? selectConfiguredExecutionBackend)({
			cwd: childCwd,
			userConfig: { executionBackend: options.executionBackend },
		});
	} catch (error) {
		return failedResult(agentName, task, error instanceof Error ? error.message : String(error));
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
		dynamic: options.acceptanceContext?.dynamic,
		dynamicGroup: options.acceptanceContext?.dynamicGroup,
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance);
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	if (skillNames.some((skill) => skill.trim() === "pi-cohort") && missingSkills.includes("pi-cohort")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-cohort",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
				writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	let lastResult: SingleResult | undefined;
	let externalOwner: ExternalForegroundExecution | undefined;
	const childId = `child-${options.index ?? 0}`;
	if (backendSelection.selection.kind === "external") {
		try {
			externalOwner = await (dependencies.createExternalOwner ?? createExternalForegroundExecution)({
				backend: backendSelection.selection.backend,
				runId: options.runId,
				childId,
				cwd: childCwd,
				title: agentName,
				signal: options.signal ?? NEVER_ABORTED_SIGNAL,
			});
			await externalOwner.ready;
		} catch {
			lastResult = failedResult(agentName, task, safeExternalFailure("startup"));
		}
	}

	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	if (!lastResult) for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const shared = {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		};
		let result: SingleResult;
		if (externalOwner) {
			try {
				result = await (dependencies.runExternalAttempt ?? runExternalSingleAttempt)({
					owner: externalOwner,
					attemptId: `${childId}-attempt-${i}`,
					runtimeCwd,
					agent,
					model: candidate,
					task: taskWithAcceptance,
					options,
					shared,
				});
			} catch {
				result = failedResult(agentName, task, safeExternalFailure("attempt"));
			}
		} else {
			result = await (dependencies.runNativeAttempt ?? runSingleAttempt)(
				runtimeCwd, agent, taskWithAcceptance, candidate, options, shared,
			);
		}
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: candidate ?? result.model ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (attemptSucceeded) {
			break;
		}
		if (blockedLine(result.error ?? "") || !isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	result.acceptance = await evaluateAcceptance({
		acceptance: effectiveAcceptance,
		output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
		cwd: options.cwd ?? runtimeCwd,
	});
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.interrupted) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}

	if (externalOwner) {
		const delivered = result.exitCode === 0 && !result.error && !result.interrupted;
		try {
			const surface = await externalOwner.finish(delivered ? "delivered" : "retained");
			result.executionSurface = surface;
		} catch {
			result.exitCode = 1;
			result.error = result.error
				? `${result.error}\n${safeExternalFailure("finish")}`
				: safeExternalFailure("finish");
			result.executionSurface = { handle: externalOwner.surface, retained: true };
		}
	}

	return result;
}
