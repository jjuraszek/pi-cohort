/**
 * Bridges one external foreground attempt (an already-created
 * `ExternalExecution` owner) into the same `SingleResult` shape
 * native attempts produce, reusing the shared init/finalize helpers from
 * `execution.ts`.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "../../agents/agents.ts";
import type { RunSyncOptions, SingleResult, Usage } from "../../shared/types.ts";
import { getSubagentDepthEnv } from "../../shared/types.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { isMutatingTool } from "../shared/long-running-guard.ts";
import type { ExternalAttemptResult, ExternalExecution } from "../shared/external-execution.ts";
import { type AttemptSharedInit, finalizeSingleAttempt, initializeAttempt } from "./attempt-finalization.ts";

const REPORTING_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"execution-backend",
	"reporting-extension.ts",
);

export type ExternalSingleAttemptShared = AttemptSharedInit;

export interface RunExternalSingleAttemptInput {
	owner: ExternalExecution;
	attemptId: string;
	runtimeCwd: string;
	agent: AgentConfig;
	model: string | undefined;
	task: string;
	options: RunSyncOptions;
	shared: ExternalSingleAttemptShared;
}

function toolMutationFromAssistantMessages(messages: readonly Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if ((part as { type?: string }).type !== "toolCall") continue;
			const toolCall = part as { name?: string; arguments?: unknown };
			const toolArgs = toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)
				? toolCall.arguments as Record<string, unknown>
				: {};
			if (isMutatingTool(toolCall.name, toolArgs)) return true;
		}
	}
	return false;
}

function usageOf(usage: ExternalAttemptResult["usage"]): Usage {
	return { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost: usage.cost, turns: usage.turns };
}

function exitCodeOf(exit: ExternalAttemptResult["exit"]): number {
	if (exit.code !== null) return exit.code;
	return exit.signal ? 1 : 0;
}

/**
 * Run one attempt against an already-created external foreground execution
 * owner, mapping the owner's durable result into the same `SingleResult`
 * shape `runSync`'s native attempts produce.
 */
export async function runExternalSingleAttempt(input: RunExternalSingleAttemptInput): Promise<SingleResult> {
	const { owner, attemptId, runtimeCwd, agent, model, task, options, shared } = input;
	if (!options.sessionFile) throw new Error("external foreground attempts require options.sessionFile");

	const init = initializeAttempt(agent, task, model, options, shared);
	const { result, progress, startTime, allControlEvents, emitControlEvent } = init;

	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: [],
		task,
		sessionEnabled: shared.sessionEnabled,
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

	try {
		const taskArg = args.pop();
		args.push("--extension", REPORTING_EXTENSION_PATH);
		if (taskArg !== undefined) args.push(taskArg);

		const spawnSpec = getPiSpawnCommand(args);
		const mergedEnv: Record<string, string | undefined> = { ...process.env, ...sharedEnv, ...getSubagentDepthEnv(options.maxSubagentDepth) };
		const environment: Record<string, string> = {};
		for (const [key, value] of Object.entries(mergedEnv)) {
			if (value !== undefined) environment[key] = value;
		}

		const attemptResult = await owner.runAttempt({
			attemptId,
			command: spawnSpec.command,
			args: spawnSpec.args,
			cwd: options.cwd ?? runtimeCwd,
			environment,
			sessionFile: options.sessionFile,
			signal: options.signal,
			interruptSignal: options.interruptSignal,
		});

		result.messages = [...attemptResult.messages];
		result.usage = usageOf(attemptResult.usage);
		if (!result.model && attemptResult.model) result.model = attemptResult.model;
		result.finalOutput = attemptResult.finalOutput;
		if (attemptResult.error) result.error = attemptResult.error;
		result.exitCode = exitCodeOf(attemptResult.exit);

		const observedMutationAttempt = toolMutationFromAssistantMessages(attemptResult.messages);
		const interruptedByControl = attemptResult.outcome === "interrupted";

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
	} finally {
		cleanupTempDir(tempDir);
	}
}
