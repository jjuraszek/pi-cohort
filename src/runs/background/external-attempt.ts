/**
 * Thin adapter that drives one background attempt against an already-created
 * `ExternalExecution` owner, mapping the durable result into the same shape
 * that `runPiStreaming` produces so `runSingleStep` can consume it uniformly.
 *
 * Interactive args (no -p / --mode json) are the caller's responsibility via
 * `buildPiArgs({ baseArgs: [] })`. This helper injects the reporting extension
 * before the task arg and forwards all other args unchanged.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import type { Usage } from "../../shared/types.ts";
import { getPiSpawnCommand } from "../shared/pi-spawn.ts";
import { isMutatingTool } from "../shared/long-running-guard.ts";
import type { ExternalAttemptResult, ExternalExecution } from "../shared/external-execution.ts";
import type { OnNewSessionMessage } from "../../execution-backend/session-watcher.ts";

const REPORTING_EXTENSION_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"execution-backend",
	"reporting-extension.ts",
);

/** Minimal ChildEvent shape used by updateStepFromChildEvent in subagent-runner.ts. */
interface SynthesizedChildEvent {
	type?: string;
	message?: unknown;
	toolName?: string;
	args?: Record<string, unknown>;
}

/** Callback for ChildEvents synthesized from session messages. */
export type OnSynthesizedChildEvent = (event: SynthesizedChildEvent) => void;

export interface RunExternalBackgroundAttemptInput {
	readonly owner: ExternalExecution;
	readonly attemptId: string;
	/**
	 * Args built by `buildPiArgs({ baseArgs: [] })` — MUST NOT include `-p` or
	 * `--mode json`; the task arg MUST be the last element. The reporting
	 * extension is injected here before the task arg.
	 */
	readonly args: readonly string[];
	/** Merged environment (process.env + buildPiArgs env + depth env). */
	readonly environment: Readonly<Record<string, string>>;
	readonly cwd: string;
	/** Trusted session file, already verified or created by the caller. */
	readonly sessionFile: string;
	readonly signal?: AbortSignal;
	readonly interruptSignal?: AbortSignal;
	/**
	 * Optional: forwarded to the session watcher, then converted to ChildEvents.
	 * Covers assistant tool calls/tool results so activity and mutation guards work.
	 * No fake token deltas, duplicate replay, or screen parsing.
	 */
	readonly onChildEvent?: OnSynthesizedChildEvent;
}

/** Compatible with the private `RunPiStreamingResult` shape in `subagent-runner.ts`. */
export interface ExternalBackgroundAttemptResult {
	readonly stderr: string;
	readonly exitCode: number | null;
	// Mutable array to match RunPiStreamingResult structural contract.
	messages: Message[];
	readonly usage: Usage;
	readonly model?: string;
	readonly error?: string;
	readonly finalOutput: string;
	readonly interrupted: boolean;
	readonly observedMutationAttempt: boolean;
}

function mapExitCode(result: ExternalAttemptResult): number | null {
	if (result.outcome === "success") return 0;
	// A failed or interrupted durable outcome must not become success from zero exit.
	const code = result.exit.code;
	return code !== null && code !== 0 ? code : 1;
}

function observedMutationFromMessages(messages: readonly Message[]): boolean {
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if ((part as { type?: string }).type !== "toolCall") continue;
			const toolCall = part as { name?: string; arguments?: unknown };
			const toolArgs =
				toolCall.arguments && typeof toolCall.arguments === "object" && !Array.isArray(toolCall.arguments)
					? (toolCall.arguments as Record<string, unknown>)
					: {};
			if (isMutatingTool(toolCall.name, toolArgs)) return true;
		}
	}
	return false;
}

function usageOf(usage: ExternalAttemptResult["usage"]): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost,
		turns: usage.turns,
	};
}

/**
 * Run one background attempt against `input.owner`, returning a result shape
 * compatible with `RunPiStreamingResult` from `subagent-runner.ts`.
 *
 * Does not evaluate acceptance, persist artifacts, or run any fallback loop.
 */
function synthesizeChildEvents(message: unknown, emit: (event: SynthesizedChildEvent) => void): void {
	if (!message || typeof message !== "object") return;
	const msg = message as { role?: string; content?: unknown[] };
	if (msg.role === "toolResult") {
		// A tool result ends the prior tool execution, then delivers the result.
		emit({ type: "tool_execution_end" });
		emit({ type: "tool_result_end", message });
	} else if (msg.role === "assistant") {
		// Emit tool_execution_start for each tool call in the assistant content.
		if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const p = part as { type?: string; name?: string; arguments?: unknown };
				if (p.type !== "toolCall" || typeof p.name !== "string") continue;
				const toolArgs = p.arguments && typeof p.arguments === "object" && !Array.isArray(p.arguments)
					? (p.arguments as Record<string, unknown>)
					: {};
				emit({ type: "tool_execution_start", toolName: p.name, args: toolArgs });
			}
		}
		emit({ type: "message_end", message });
	}
}

export async function runExternalBackgroundAttempt(
	input: RunExternalBackgroundAttemptInput,
): Promise<ExternalBackgroundAttemptResult> {
	const { owner, attemptId, args: inputArgs, environment, cwd, sessionFile, signal, interruptSignal, onChildEvent } = input;

	// Inject the reporting extension before the task arg.
	const args = [...inputArgs];
	const taskArg = args.pop();
	args.push("--extension", REPORTING_EXTENSION_PATH);
	if (taskArg !== undefined) args.push(taskArg);

	const spawnSpec = getPiSpawnCommand(args);

	const mergedEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(environment)) {
		if (value !== undefined) mergedEnv[key] = value;
	}

	const onNewSessionMessage: OnNewSessionMessage | undefined = onChildEvent
		? (message) => synthesizeChildEvents(message, onChildEvent)
		: undefined;

	const attemptResult = await owner.runAttempt({
		attemptId,
		command: spawnSpec.command,
		args: spawnSpec.args,
		cwd,
		environment: mergedEnv,
		sessionFile,
		signal,
		interruptSignal,
		onNewSessionMessage,
	});

	return {
		stderr: "",
		exitCode: mapExitCode(attemptResult),
		messages: [...attemptResult.messages],
		usage: usageOf(attemptResult.usage),
		model: attemptResult.model,
		error: attemptResult.error,
		finalOutput: attemptResult.finalOutput,
		interrupted: attemptResult.outcome === "interrupted",
		observedMutationAttempt: observedMutationFromMessages(attemptResult.messages),
	};
}
