import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveExtensionConfig, discoverAgents } from "../agents/agents.ts";
import { getArtifactsDir } from "../shared/artifacts.ts";
import { createSubagentExecutor, type SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { readNestedControlRequests, resolveNestedRouteFromEnv, writeNestedControlResult } from "../runs/shared/nested-events.ts";
import { SubagentParams } from "./schemas.ts";
import { RUN_STATE_ROOT_DIR, type Details, type SubagentState } from "../shared/types.ts";
import { emptyGrandTotal } from "./grand-total.ts";

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return path.join(RUN_STATE_ROOT_DIR, "sessions");
}

function expandTilde(p: string): string {
	return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		grandTotal: emptyGrandTotal(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		retainedNestedRoutes: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		safetyRescanTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

export function startNestedControlInboxListener(pi: ExtensionAPI, state: SubagentState): NodeJS.Timeout | undefined {
	let route;
	try {
		route = resolveNestedRouteFromEnv();
	} catch {
		return undefined;
	}
	if (!route) return undefined;
	const seen = new Set<string>();
	const inFlight = new Set<string>();
	const pendingResults = new Map<string, { result: Parameters<typeof writeNestedControlResult>[1]; filePath: string }>();
	const writePendingResult = (requestId: string): void => {
		const pending = pendingResults.get(requestId)!;
		try {
			writeNestedControlResult(route, pending.result);
		} catch (error) {
			console.error(`Failed to write nested control result for request '${requestId}' targeting '${pending.result.targetId}' via inbox '${route.controlInbox}'; keeping request for retry:`, error);
			return;
		}
		pendingResults.delete(requestId);
		seen.add(requestId);
		try { fs.unlinkSync(pending.filePath); } catch {}
	};
	const timer = setInterval(() => {
		try {
			// The caller may have removed its request after timing out; the accepted stop still gets its reply.
			for (const requestId of pendingResults.keys()) writePendingResult(requestId);
			for (const request of readNestedControlRequests(route)) {
				if (seen.has(request.requestId) || inFlight.has(request.requestId) || pendingResults.has(request.requestId)) continue;
				const control = [...state.foregroundControls.values()].find((entry) =>
					entry.runId === request.targetId || (request.action === "interrupt" && entry.children?.has(request.targetId)));
				if (!control) continue;
				inFlight.add(request.requestId);
				void (async () => {
					try {
						let ok = false;
						let message = "Control request failed.";
						try {
							if (request.action === "interrupt") {
								ok = control.interrupt?.(request.targetId) === true;
								message = ok
									? `Interrupt requested for nested run ${request.targetId}.`
									: `Nested run ${request.targetId} has no active child step to interrupt.`;
							} else if (!request.message?.trim()) {
								message = "Nested resume requires message.";
							} else {
								message = `Nested run ${request.targetId} is still active; wait for completion, then resume.`;
							}
						} catch (error) {
							message = error instanceof Error ? error.message : String(error);
						}
						pendingResults.set(request.requestId, {
							result: { ts: Date.now(), requestId: request.requestId, targetId: request.targetId, ok, message },
							filePath: request.filePath,
						});
						writePendingResult(request.requestId);
					} finally {
						inFlight.delete(request.requestId);
					}
				})();
			}
		} catch (error) {
			console.error(`Failed to poll nested control inbox '${route.controlInbox}' for root '${route.rootRunId}':`, error);
		}
	}, 200);
	timer.unref?.();
	return timer;
}

export default function registerFanoutChildSubagentExtension(pi: ExtensionAPI): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;

	const globalStore = globalThis as Record<string, unknown>;
	const registeredKey = "__piSubagentFanoutChildRegisteredApis";
	const registeredApis = globalStore[registeredKey] instanceof WeakSet
		? globalStore[registeredKey] as WeakSet<ExtensionAPI>
		: new WeakSet<ExtensionAPI>();
	globalStore[registeredKey] = registeredApis;
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	const state = createChildSafeState();
	const executor = createSubagentExecutor({
		pi,
		state,
		resolveConfig: resolveExtensionConfig,
		tempArtifactsDir: getArtifactsDir(null),
		getSubagentSessionRoot,
		expandTilde,
		discoverAgents,
		allowMutatingManagementActions: false,
	});

	const tool: ToolDefinition<typeof SubagentParams, Details> = {
		name: "subagent",
		exposure: "model-only",
		label: "Subagent",
		description: [
			"Delegate to subagents from child-safe fanout mode.",
			"Allowed management/control actions: list, get, status, interrupt, resume, doctor.",
			"Agent config mutation actions create, update, and delete are blocked in this mode.",
		].join("\n"),
		parameters: SubagentParams,
		execute(id, params, signal, onUpdate, ctx) {
			return executor.execute(id, params as SubagentParamsLike, signal, onUpdate, ctx);
		},
	};

	pi.registerTool(tool);
	startNestedControlInboxListener(pi, state);
}
