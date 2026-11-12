import * as fs from "node:fs";
import * as path from "node:path";
import type { NestedRouteInfo, NestedRunSummary, SubagentState } from "../../shared/types.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { readStatus } from "../../shared/utils.ts";
import { checkPidLiveness } from "../background/stale-run-reconciler.ts";
import { assertSafeNestedId, projectNestedEvents, resolveNestedAsyncDir } from "./nested-events.ts";
import { parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { SUBAGENT_PARENT_PATH_ENV } from "./pi-args.ts";

export type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
export const ASYNC_INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";

function stopPath(route: NestedRouteInfo, targetId: string): string {
	assertSafeNestedId("targetId", targetId);
	return path.join(path.dirname(route.eventSink), "stops", targetId);
}

export function recordStop(route: NestedRouteInfo | undefined, targetId: string): boolean {
	if (!route) return false;
	const file = stopPath(route, targetId);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		fs.closeSync(fs.openSync(file, "wx", 0o600));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

export function stoppingAncestor(route: NestedRouteInfo | undefined, runId: string, childId?: string, ancestry: readonly NestedPathEntry[] = parseNestedPathEnv(process.env[SUBAGENT_PARENT_PATH_ENV])): string | undefined {
	if (!route) return undefined;
	return [runId, childId, ...ancestry.flatMap((entry) => [entry.runId, entry.childId])]
		.find((id): id is string => Boolean(id && fs.existsSync(stopPath(route, id))));
}

export function requestAsyncStop(asyncDir: string, targetId: string): void {
	assertSafeNestedId("targetId", targetId);
	const status = readStatus(asyncDir);
	if (!status || status.state !== "running" || !status.pid || checkPidLiveness(status.pid) !== "alive") {
		throw new Error("No running async run with an interrupt-capable pid was found.");
	}
	writeAtomicJson(path.join(asyncDir, `interrupt-request-${targetId}.json`), { targetId, requestedAt: Date.now() });
	process.kill(status.pid, ASYNC_INTERRUPT_SIGNAL);
}

export function sweepBackgroundDescendants(route: NestedRouteInfo | undefined, targetId: string): void {
	if (!route) return;
	const seen = new Set<string>();
	const failures: string[] = [];
	const visit = (runs: NestedRunSummary[] | undefined): void => {
		for (const run of runs ?? []) {
			if (seen.has(run.id)) continue;
			seen.add(run.id);
			if ((run.state === "queued" || run.state === "running") && run.path?.some((part) => part.runId === targetId || part.childId === targetId)) {
				const dir = resolveNestedAsyncDir(route.rootRunId, run);
				if (dir && run.state === "running") {
					const status = readStatus(dir);
					if (status?.state === "running" && status.pid && checkPidLiveness(status.pid) !== "dead") {
						try {
							requestAsyncStop(dir, run.id);
						} catch (error) {
							// The runner can exit between the status read, liveness probe and signal.
							if ((error as NodeJS.ErrnoException).code !== "ESRCH" && checkPidLiveness(status.pid) !== "dead") {
								failures.push(`Failed to stop background descendant '${run.id}': ${error instanceof Error ? error.message : String(error)}`);
							}
						}
					}
				}
			}
			visit(run.children);
			for (const step of run.steps ?? []) visit(step.children);
		}
	};
	visit(projectNestedEvents(route).children);
	if (failures.length) throw new Error(`Stop of ${targetId.slice(0, 6)} is incomplete. ${failures.join(" ")}`);
}

export function stopForegroundTarget(control: ForegroundControl, targetId = control.runId): boolean {
	const child = targetId === control.runId ? undefined : control.children.get(targetId);
	if (targetId !== control.runId && (!child || child.state !== "running")) return false;
	if (control.stopping || child?.stopRequested) return true;
	if (control.nestedRoute) recordStop(control.nestedRoute, targetId);
	if (child) {
		child.stopRequested = true;
		child.interrupt?.();
	} else {
		control.stopping = true;
		for (const entry of control.children.values()) if (entry.state === "running") entry.interrupt?.();
	}
	control.updatedAt = Date.now();
	control.currentActivityState = undefined;
	sweepBackgroundDescendants(control.nestedRoute, targetId);
	return true;
}

export function registerForegroundInterrupt(control: ForegroundControl | undefined, id: string, interrupt: () => boolean): () => void {
	const child = control?.children.get(id);
	if (!child) return () => {};
	child.interrupt = interrupt;
	if (control.stopping || child.stopRequested) interrupt();
	return () => { delete child.interrupt; };
}

export function stoppedChildrenOnly(control: ForegroundControl | undefined, results: readonly { id?: string; interrupted?: boolean }[]): boolean {
	return !control?.stopping && results.every((result) => !result.interrupted || Boolean(result.id && control?.children.get(result.id)?.stopRequested));
}
