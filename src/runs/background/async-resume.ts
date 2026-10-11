import fs from "node:fs";
import * as path from "node:path";
import { ASYNC_DIR, LEGACY_ASYNC_DIR, RESULTS_DIR, type AsyncStatus } from "../../shared/types.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";
import { parsePiRuntime, type PiRuntimeIdentity } from "../shared/pi-spawn.ts";

export function isLegacyAsyncDir(asyncDir: string): boolean {
	try { assertInsideRoot(LEGACY_ASYNC_DIR, asyncDir, "Async run directory"); return true; } catch { return false; }
}

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string | readonly string[];
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
}

export type AsyncResumeTarget = {
	kind: "revive";
	runtime: PiRuntimeIdentity;
	runId: string;
	asyncDir?: string;
	state: AsyncStatus["state"];
	agent: string;
	index: number;
	cwd?: string;
	sessionFile?: string;
};

interface AsyncResultFile {
	runtime?: unknown;
	id?: string;
	runId?: string;
	agent?: string;
	mode?: string;
	state?: string;
	success?: boolean;
	cwd?: string;
	sessionFile?: string;
	results?: Array<{ agent?: string; success?: boolean; sessionFile?: string }>;
}

export interface AsyncRunLocation {
	asyncDir: string | null;
	resultPath: string | null;
	resolvedId?: string;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ensureObject(value: unknown, source: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Async result file '${source}' must contain a JSON object.`);
	}
	return value as Record<string, unknown>;
}

function validateOptionalString(value: Record<string, unknown>, field: string, source: string, displayField = field): string | undefined {
	const fieldValue = value[field];
	if (fieldValue === undefined) return undefined;
	if (typeof fieldValue !== "string") throw new Error(`Invalid async result file '${source}': ${displayField} must be a string.`);
	return fieldValue;
}

function validateResultFile(value: unknown, resultPath: string): AsyncResultFile {
	const data = ensureObject(value, resultPath);
	const resultsValue = data.results;
	let results: AsyncResultFile["results"];
	if (resultsValue !== undefined) {
		if (!Array.isArray(resultsValue)) throw new Error(`Invalid async result file '${resultPath}': results must be an array.`);
		results = resultsValue.map((entry, index) => {
			const child = ensureObject(entry, `${resultPath} results[${index}]`);
			const agent = validateOptionalString(child, "agent", resultPath, `results[${index}].agent`);
			const sessionFile = validateOptionalString(child, "sessionFile", resultPath, `results[${index}].sessionFile`);
			const success = child.success;
			if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': results[${index}].success must be a boolean.`);
			return { agent, sessionFile, ...(typeof success === "boolean" ? { success } : {}) };
		});
	}
	const success = data.success;
	if (success !== undefined && typeof success !== "boolean") throw new Error(`Invalid async result file '${resultPath}': success must be a boolean.`);
	return {
		runtime: data.runtime,
		id: validateOptionalString(data, "id", resultPath),
		runId: validateOptionalString(data, "runId", resultPath),
		agent: validateOptionalString(data, "agent", resultPath),
		mode: validateOptionalString(data, "mode", resultPath),
		state: validateOptionalString(data, "state", resultPath),
		cwd: validateOptionalString(data, "cwd", resultPath),
		sessionFile: validateOptionalString(data, "sessionFile", resultPath),
		...(typeof success === "boolean" ? { success } : {}),
		...(results ? { results } : {}),
	};
}

function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = fs.readFileSync(resultPath, "utf-8");
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return validateResultFile(JSON.parse(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new Error(`${field} must not be empty.`);
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
		throw new Error(`${field} must be an async run id or prefix, not a path.`);
	}
	return value;
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
	const parent = path.dirname(resolved);
	return parent === resolved ? resolved : path.join(canonicalPath(parent), path.basename(resolved));
}

function assertInsideRoot(root: string, target: string, label: string): void {
	const rootPath = canonicalPath(root);
	const targetPath = canonicalPath(target);
	const relative = path.relative(rootPath, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error(`${label} must be inside ${rootPath}.`);
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((entry) => entry.startsWith(prefix) && (!suffix || entry.endsWith(suffix)))
		.map((entry) => suffix ? entry.slice(0, -suffix.length) : entry)
		.sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	assertInsideRoot(resultsDir, resultPath, "Async result file");
	return fs.existsSync(resultPath) ? resultPath : null;
}

export function winningAsyncRunEntries(asyncDirRoot: string | readonly string[], prefix = ""): Array<{ id: string; root: string; asyncDir: string }> {
	const winners = new Map<string, { id: string; root: string; asyncDir: string }>();
	for (const root of typeof asyncDirRoot === "string" ? [asyncDirRoot] : asyncDirRoot) {
		for (const id of prefixedRunIds(root, prefix)) {
			if (!winners.has(id)) winners.set(id, { id, root, asyncDir: path.join(path.resolve(root), id) });
		}
	}
	return [...winners.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function findAsyncRunPrefixMatches(prefix: string, asyncDirRoot: string | readonly string[], resultsDir: string): Array<{ id: string; location: AsyncRunLocation }> {
	const requestedId = assertRunId(prefix, "id");
	if (!requestedId) return [];
	const entries = winningAsyncRunEntries(asyncDirRoot, requestedId);
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const resultRoot = path.resolve(resultsDir);
	const matchingIds = [...new Set([
		...byId.keys(),
		...prefixedRunIds(resultRoot, requestedId, ".json"),
	])].sort();
	return matchingIds.map((id) => {
		const entry = byId.get(id);
		const asyncDir = entry?.asyncDir;
		if (entry) assertInsideRoot(entry.root, entry.asyncDir, "Async run directory");
		return {
			id,
			location: {
				asyncDir: asyncDir && fs.existsSync(asyncDir) ? asyncDir : null,
				resultPath: exactResultPath(resultRoot, id),
				resolvedId: id,
			},
		};
	});
}

export function resolveAsyncRunLocation(params: AsyncResumeParams, asyncDirRoot: string | readonly string[], resultsDir: string): AsyncRunLocation {
	if (typeof asyncDirRoot !== "string") {
		if (params.dir) {
			for (const root of asyncDirRoot) {
				try { assertInsideRoot(root, params.dir, "Async run directory"); } catch { continue; }
				return resolveAsyncRunLocation(params, root, resultsDir);
			}
			throw new Error("Async run directory must be inside an authorized async root.");
		}
		const id = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
		if (!id) return { asyncDir: null, resultPath: null };
		const exact = winningAsyncRunEntries(asyncDirRoot, id).find((entry) => entry.id === id);
		if (exact) {
			assertInsideRoot(exact.root, exact.asyncDir, "Async run directory");
			return { asyncDir: exact.asyncDir, resultPath: exactResultPath(resultsDir, id), resolvedId: id };
		}
		const resultPath = exactResultPath(resultsDir, id);
		if (resultPath) return { asyncDir: null, resultPath, resolvedId: id };
		const matches = findAsyncRunPrefixMatches(id, asyncDirRoot, resultsDir);
		if (matches.length > 1) throw new Error(`Ambiguous async run id prefix '${id}' matched: ${matches.map((match) => match.id).join(", ")}. Provide a longer id.`);
		return matches[0]?.location ?? { asyncDir: null, resultPath: null, resolvedId: id };
	}
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		const resolvedId = requestedId ?? path.basename(asyncDir);
		if (requestedId && requestedId !== path.basename(asyncDir)) {
			throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
		}
		return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
	}
	if (!requestedId) return { asyncDir: null, resultPath: null };

	const directAsyncDir = path.join(asyncRoot, requestedId);
	assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
	const directResultPath = exactResultPath(resultRoot, requestedId);
	if (fs.existsSync(directAsyncDir) || directResultPath) {
		return {
			asyncDir: fs.existsSync(directAsyncDir) ? directAsyncDir : null,
			resultPath: directResultPath,
			resolvedId: requestedId,
		};
	}

	const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
	if (matching.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	if (matching.length > 1) {
		throw new Error(`Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`);
	}
	return matching[0]!.location;
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (result.state === "complete" || result.state === "failed" || result.state === "paused" || result.state === "running" || result.state === "queued") {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (typeof status.runId !== "string") throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && typeof status.sessionId !== "string") throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && typeof status.cwd !== "string") throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && typeof status.sessionFile !== "string") throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		status.steps.forEach((step, index) => {
			if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			if (typeof step.agent !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
			if (step.sessionFile !== undefined && typeof step.sessionFile !== "string") throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
		});
	}
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl") throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	const resolved = path.resolve(sessionFile);
	if (!fs.existsSync(resolved)) throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`);
	return resolved;
}

export function resolveAsyncResumeTarget(params: AsyncResumeParams, deps: AsyncResumeDeps = {}): AsyncResumeTarget {
	const asyncDirRoot = deps.asyncDirRoot ?? [ASYNC_DIR, LEGACY_ASYNC_DIR];
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	const statusPath = location.asyncDir ? path.join(location.asyncDir, "status.json") : undefined;
	let status: AsyncStatus | null = null;
	if (statusPath) {
		let present = false;
		try {
			fs.lstatSync(statusPath);
			present = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, { cause: error });
			}
		}
		if (present) {
			let value: unknown;
			try {
				value = JSON.parse(fs.readFileSync(statusPath, "utf-8"));
			} catch (error) {
				throw new Error(`Failed to read or parse async status file '${statusPath}': ${getErrorMessage(error)}`, { cause: error });
			}
			status = ensureObject(value, statusPath) as unknown as AsyncStatus;
		}
	}
	if (status && (status.state === "queued" || status.state === "running") && location.asyncDir && !isLegacyAsyncDir(location.asyncDir)) {
		status = reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now }).status ?? status;
	}
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	const runtime = parsePiRuntime(status ? status.runtime : result?.runtime, statusPath ?? location.resultPath ?? "Async run");
	if (status && result?.runtime !== undefined) {
		const other = parsePiRuntime(result.runtime, location.resultPath!);
		if (runtime.nodeExecPath !== other.nodeExecPath || runtime.piEntryPath !== other.piEntryPath || runtime.piPackageRoot !== other.piPackageRoot) throw new Error("Async status and result runtime identities conflict; a new run is required.");
	}
	const runId = status?.runId ?? result?.runId ?? result?.id ?? location.resolvedId ?? (location.asyncDir ? path.basename(location.asyncDir) : "unknown");
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);

	if (state === "queued") throw new Error(`Async run '${runId}' is queued and cannot be revived before startup.`);
	const statusSteps = status?.steps ?? [];
	const resultSteps = result?.results ?? [];
	const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
	const requestedIndex = params.index;
	if (requestedIndex !== undefined && !Number.isInteger(requestedIndex)) throw new Error(`Async run '${runId}' index must be an integer.`);
	const terminalStepStatuses = new Set(["complete", "completed", "failed", "paused"]);

	if (state === "running") {
		if (requestedIndex !== undefined) {
			if (requestedIndex < 0 || requestedIndex >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
			const selectedStep = statusSteps[requestedIndex];
			if (selectedStep?.status === "pending") throw new Error(`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`);
			if (selectedStep?.status === "running") throw new Error("Selected child is still active; wait for completion, then resume.");
			if (selectedStep && !terminalStepStatuses.has(selectedStep.status)) throw new Error(`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`);
		} else {
			const running = statusSteps.filter((step) => step.status === "running");
			if (running.length === 1) throw new Error("Selected child is still active; wait for completion, then resume.");
			if (running.length > 1) throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
		}
	}

	if (stepCount > 1 && requestedIndex === undefined) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
	}
	const index = requestedIndex ?? 0;
	if (!Number.isInteger(index)) throw new Error(`Async run '${runId}' index must be an integer.`);
	if (index < 0 || index >= stepCount) throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
	const agent = statusSteps[index]?.agent ?? resultSteps[index]?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	const sessionFile = statusSteps[index]?.sessionFile
		?? resultSteps[index]?.sessionFile
		?? (stepCount === 1 ? status?.sessionFile ?? result?.sessionFile : undefined);
	if (!sessionFile) throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
	const resolvedSessionFile = validateResumeSessionFile(runId, sessionFile);

	return {
		kind: "revive",
		runtime,
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		index,
		cwd: status?.cwd ?? result?.cwd,
		sessionFile: resolvedSessionFile,
	};
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		`Original run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	].filter((line): line is string => line !== undefined).join("\n");
}
