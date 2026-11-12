import * as fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, LEGACY_ASYNC_DIR, RESULTS_DIR, type SubagentState, type AsyncStatus, type NestedRunSummary } from "../../shared/types.ts";
import { findAsyncRunPrefixMatches, resolveAsyncRunLocation, winningAsyncRunEntries, type AsyncRunLocation } from "./async-resume.ts";
import { assertSafeNestedId, findNestedRunMatchesById, projectNestedEvents, resolveNestedAsyncDir, type NestedRoute, type NestedRunMatch, type NestedRunResolutionScope } from "../shared/nested-events.ts";
import { checkPidLiveness } from "./stale-run-reconciler.ts";
import { widgetJobName } from "../../tui/render.ts";
import { nestedRunName } from "../../tui/render-helpers.ts";

export type ResolvedSubagentRunId =
	| { kind: "foreground"; id: string }
	| { kind: "async"; id: string; location: AsyncRunLocation }
	| { kind: "nested"; id: string; match: NestedRunMatch };

export interface ResolveSubagentRunIdDeps {
	state?: SubagentState;
	asyncDirRoot?: string | readonly string[];
	resultsDir?: string;
	nested?: NestedRunResolutionScope;
	readOnlyLegacy?: boolean;
	target?: "interrupt";
	sessionOnly?: boolean;
}

export interface ResolvedStopTarget {
	kind: "run" | "child";
	id: string;
	runId: string;
	name: string;
	label?: string;
	state: string;
	owner: ResolvedSubagentRunId;
}

interface BackgroundStopEntry {
	mtime: number;
	status: AsyncStatus;
}
const backgroundStopInventory = new Map<string, BackgroundStopEntry>();
const nestedStopInventory = new WeakMap<NestedRoute, NestedRunSummary[]>();

export function updateNestedStopInventory(route: NestedRoute, children: NestedRunSummary[]): void {
	nestedStopInventory.set(route, children);
}

export function updateBackgroundStopInventory(asyncDir: string, status: AsyncStatus, mtime: number): void {
	backgroundStopInventory.set(asyncDir, { status, mtime });
}

function backgroundStatus(asyncDir: string, refresh: boolean): AsyncStatus | undefined {
	const cached = backgroundStopInventory.get(asyncDir);
	if (!refresh || (cached && ["complete", "failed", "paused"].includes(cached.status.state))) return cached?.status;
	try {
		const file = path.join(asyncDir, "status.json");
		const mtime = fs.statSync(file).mtimeMs;
		if (cached?.mtime === mtime) return cached.status;
		const status = JSON.parse(fs.readFileSync(file, "utf8")) as AsyncStatus;
		updateBackgroundStopInventory(asyncDir, status, mtime);
		return status;
	} catch { return cached?.status; }
}

function stepState(status: string): string {
	return status === "complete" ? "completed" : status === "paused" ? "interrupted" : status;
}

export function listStopTargets(deps: ResolveSubagentRunIdDeps = {}, refresh = false, ownerPrefix = ""): ResolvedStopTarget[] {
	const targets = new Map<string, { target: ResolvedStopTarget; priority: number }>();
	// Keep the full namespace for ambiguity checks, but probe only possible owners.
	const matchesOwner = (id: string, steps: readonly { id?: string }[] | undefined): boolean =>
		id.startsWith(ownerPrefix) || Boolean(steps?.some((step) => step.id?.startsWith(ownerPrefix)));
	const add = (target: ResolvedStopTarget, priority: number): void => {
		if (!targets.has(target.id) || targets.get(target.id)!.priority < priority) targets.set(target.id, { target, priority });
	};
	for (const control of deps.state?.foregroundControls.values() ?? []) {
		const owner = { kind: "foreground" as const, id: control.runId };
		add({ kind: "run", id: control.runId, runId: control.runId, name: control.mode, state: "running", owner }, 3);
		for (const [id, child] of control.children ?? []) add({ kind: "child", id, runId: control.runId, name: child.agent, label: child.label, state: child.state, owner }, 3);
	}
	const asyncEntries = new Map((refresh
		? winningAsyncRunEntries(deps.asyncDirRoot ?? [ASYNC_DIR, LEGACY_ASYNC_DIR])
		: deps.sessionOnly ? [] : [...backgroundStopInventory.keys()].map((asyncDir) => ({ id: path.basename(asyncDir), asyncDir })))
		.map((entry) => [entry.id, entry]));
	for (const job of deps.state?.asyncJobs.values() ?? []) {
		if (!asyncEntries.has(job.asyncId)) asyncEntries.set(job.asyncId, { id: job.asyncId, asyncDir: job.asyncDir });
	}
	for (const { id, asyncDir } of asyncEntries.values()) {
		const status = backgroundStatus(asyncDir, refresh);
		const owner = { kind: "async" as const, id, location: { asyncDir, resultPath: null, resolvedId: id } };
		const priority = status?.state === "running" && status.pid && (!refresh || (matchesOwner(id, status.steps) && checkPidLiveness(status.pid) === "alive")) ? 2 : 0;
		const name = widgetJobName(deps.state?.asyncJobs.get(id) ?? {
			asyncId: id, asyncDir, status: status?.state ?? "queued", mode: status?.mode, agents: status?.steps?.map((step) => step.agent),
		});
		add({ kind: "run", id, runId: id, name, state: status?.state ?? "unknown", owner }, priority);
		for (const child of status?.steps ?? []) if (child.id) add({ kind: "child", id: child.id, runId: id, name: child.agent, label: child.label, state: stepState(child.status), owner }, priority);
	}
	const scope = deps.nested ?? nestedScopeFromState(deps.state) ?? { routes: [] };
	for (const route of scope.routes) {
		let children: NestedRunSummary[] | undefined;
		if (refresh) {
			try {
				children = projectNestedEvents(route, { readOnlyLegacy: deps.readOnlyLegacy }).children;
				updateNestedStopInventory(route, children);
			} catch { continue; }
		} else {
			const controls = [...deps.state?.foregroundControls.values() ?? [], ...deps.state?.asyncJobs.values() ?? []];
			children = controls.find((entry) => entry.nestedRoute?.eventSink === route.eventSink)?.nestedChildren
				?? nestedStopInventory.get(route);
		}
		const seen = new Set<string>();
		const visit = (runs: NestedRunSummary[] | undefined, admitted = !scope.descendantOf): void => {
			for (const run of runs ?? []) {
				if (seen.has(run.id)) continue;
				seen.add(run.id);
				const allowed = admitted || (run.parentRunId === scope.descendantOf?.parentRunId && (scope.descendantOf.parentStepIndex === undefined || run.parentStepIndex === scope.descendantOf.parentStepIndex));
				if (allowed) {
					let owner: ResolvedSubagentRunId = { kind: "nested", id: run.id, match: { rootRunId: route.rootRunId, route, run } };
					let priority = 1;
					const asyncDir = refresh ? resolveNestedAsyncDir(route.rootRunId, run) : run.asyncDir;
					if (asyncDir) {
						const status = backgroundStatus(asyncDir, refresh);
						if (status?.state === "running" && status.pid && (!refresh || (matchesOwner(run.id, run.steps) && checkPidLiveness(status.pid) === "alive"))) {
							owner = { kind: "async", id: run.id, location: { asyncDir, resultPath: null, resolvedId: run.id } };
							priority = 2;
						}
					}
					add({ kind: "run", id: run.id, runId: run.id, name: nestedRunName(run), state: run.state, owner }, priority);
					for (const child of run.steps ?? []) add({ kind: "child", id: child.id, runId: run.id, name: child.agent, label: child.label, state: stepState(child.status), owner }, priority);
				}
				visit(run.children, allowed);
				for (const step of run.steps ?? []) visit(step.children, allowed);
			}
		};
		visit(children);
	}
	return [...targets.values()].map(({ target }) => target);
}

export function uniqueStopPrefix(id: string, targets: readonly { id: string }[], minimum = 6): string {
	let length = minimum;
	while (length < id.length && targets.some((other) => other.id !== id && other.id.startsWith(id.slice(0, length)))) length++;
	return id.slice(0, length);
}

function resolveStopTarget(id: string, deps: ResolveSubagentRunIdDeps): ResolvedStopTarget | undefined {
	if (id.trim().length < 4) throw new Error(`Stop id '${id}' is too short; type at least 4 characters of the id at the start of the row.`);
	assertSafeNestedId("id", id);
	const targets = listStopTargets(deps, true, id);
	const exact = targets.find((target) => target.id === id);
	if (exact) return exact;
	const matches = targets.filter((target) => target.id.startsWith(id));
	if (matches.length > 1) throw new Error(`Ambiguous stop id '${id}': ${matches.map((target) => `${target.kind}:${uniqueStopPrefix(target.id, targets)} ${target.name}`).join(", ")}. Provide a longer id.`);
	if (matches.length === 0) {
		const running = targets.filter((target) => target.state === "running");
		throw new Error(`No running subagent matches '${id}'.\n${running.length ? running.map((target) => `${target.id.slice(0, 6)} ${target.name}`).join("\n") : "No subagent is running."}`);
	}
	return matches[0];
}

function exactAsyncLocation(id: string, asyncDirRoot: string | readonly string[], resultsDir: string): AsyncRunLocation | undefined {
	const exact = winningAsyncRunEntries(asyncDirRoot, id).find((entry) => entry.id === id);
	const resultPath = path.join(resultsDir, `${id}.json`);
	if (!exact && !fs.existsSync(resultPath)) return undefined;
	return resolveAsyncRunLocation({ id }, asyncDirRoot, resultsDir);
}

function foregroundIds(state: SubagentState | undefined): string[] {
	return state ? [...state.foregroundControls.keys()] : [];
}

function nestedScopeFromState(state: SubagentState | undefined): NestedRunResolutionScope | undefined {
	if (!state) return undefined;
	const routes: NestedRoute[] = [];
	const seen = new Set<string>();
	const add = (route: NestedRoute | undefined) => {
		if (!route) return;
		const key = JSON.stringify([route.rootRunId, route.capabilityToken, route.eventSink, route.controlInbox]);
		if (seen.has(key)) return;
		seen.add(key);
		routes.push(route);
	};
	for (const control of state.foregroundControls.values()) add(control.nestedRoute as NestedRoute | undefined);
	for (const job of state.asyncJobs.values()) add(job.nestedRoute as NestedRoute | undefined);
	for (const retained of state.retainedNestedRoutes?.values() ?? []) add(retained);
	return { routes };
}

function asyncPrefixMatches(prefix: string, asyncDirRoot: string | readonly string[], resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir);
}

export function resolveSubagentRunId(id: string, deps: ResolveSubagentRunIdDeps & { target: "interrupt" }): ResolvedStopTarget | undefined;
export function resolveSubagentRunId(id: string, deps?: ResolveSubagentRunIdDeps): ResolvedSubagentRunId | undefined;
export function resolveSubagentRunId(id: string, deps: ResolveSubagentRunIdDeps = {}): ResolvedSubagentRunId | ResolvedStopTarget | undefined {
	if (deps.target === "interrupt") return resolveStopTarget(id, deps);
	assertSafeNestedId("id", id);
	const asyncDirRoot = deps.asyncDirRoot ?? [ASYNC_DIR, LEGACY_ASYNC_DIR];
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;

	const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
	if (deps.state?.foregroundControls.has(id)) return { kind: "foreground", id };
	const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
	if (exactAsync) return { kind: "async", id, location: exactAsync };
	const nestedOptions = { scope: nestedScope, readOnlyLegacy: deps.readOnlyLegacy };
	const exactNested = findNestedRunMatchesById(id, nestedOptions);
	if (exactNested.length > 1) throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
	if (exactNested[0]) return { kind: "nested", id, match: exactNested[0] };

	const matches: ResolvedSubagentRunId[] = [];
	for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
		matches.push({ kind: "foreground", id: foregroundId });
	}
	for (const match of asyncPrefixMatches(id, asyncDirRoot, resultsDir)) {
		matches.push({ kind: "async", id: match.id, location: match.location });
	}
	for (const match of findNestedRunMatchesById(id, { ...nestedOptions, prefix: true })) {
		matches.push({ kind: "nested", id: match.run.id, match });
	}
	const values = matches;
	if (values.length > 1) {
		throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
	}
	return values[0];
}
