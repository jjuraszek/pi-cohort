import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai";
import {
	createChildHostController,
	type ChildHostController,
	type ChildHostControllerOptions,
	type ChildHostExit,
} from "../../execution-backend/child-host-controller.ts";
import {
	createExecutionControlChannel,
	type ExecutionControlChannel,
} from "../../execution-backend/control-channel.ts";
import { PI_COHORT_REPORT_CONFIG, createExclusiveSessionFile, type ExecutionReportIdentity } from "../../execution-backend/reporting-protocol.ts";
import { replayExecutionSession, type ReplayedSession } from "../../execution-backend/session-replay.ts";
import { createSessionWatcher, type OnNewSessionMessage, type SessionWatcher } from "../../execution-backend/session-watcher.ts";
import type { ExecutionBackend, ExecutionSurfaceHandle } from "../../execution-backend/types.ts";

export interface ExternalExecutionOptions {
	readonly backend: ExecutionBackend;
	readonly runId: string;
	readonly childId: string;
	readonly cwd: string;
	readonly title: string;
	readonly signal: AbortSignal;
	readonly readyTimeoutMs?: number;
	readonly controlTimeoutMs?: number;
}

export interface ExternalAttemptRequest {
	readonly attemptId: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly sessionFile: string;
	readonly signal?: AbortSignal;
	readonly interruptSignal?: AbortSignal;
	/** Optional: called for each newly accepted session message as it arrives, before the terminal result. */
	readonly onNewSessionMessage?: OnNewSessionMessage;
}

export interface ExternalAttemptUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly turns: number;
}

export interface ExternalAttemptResult {
	readonly attemptId: string;
	readonly sessionFile: string;
	readonly messages: readonly Message[];
	readonly outcome: "success" | "failed" | "interrupted";
	readonly finalOutput: string;
	readonly error?: string;
	readonly usage: ExternalAttemptUsage;
	readonly model?: string;
	readonly turns: number;
	readonly exit: { readonly code: number | null; readonly signal: string | null };
	readonly interrupted: boolean;
}

export type ExternalExecutionDiagnosticCode = "result_missing";

class ExternalExecutionDiagnosticError extends Error {
	readonly code: ExternalExecutionDiagnosticCode;

	constructor(code: ExternalExecutionDiagnosticCode) {
		super(code);
		this.code = code;
	}
}

export function externalExecutionDiagnosticCode(error: unknown): ExternalExecutionDiagnosticCode | undefined {
	return error instanceof ExternalExecutionDiagnosticError ? error.code : undefined;
}

export type ExternalExecutionDisposition = "delivered" | "retained";
export interface ExternalExecutionFinishResult {
	readonly handle: ExecutionSurfaceHandle;
	readonly retained: boolean;
}

export interface ExternalExecution {
	readonly surface: ExecutionSurfaceHandle;
	readonly ready: Promise<void>;
	runAttempt(request: ExternalAttemptRequest): Promise<ExternalAttemptResult>;
	finish(disposition: ExternalExecutionDisposition): Promise<ExternalExecutionFinishResult>;
}

interface WatchDependencies {
	watch(sessionFile: string, listener: () => void, onError: (error: Error) => void): { close(): void };
	readFile(sessionFile: string): Promise<string>;
}

export interface ExternalExecutionDependencies {
	readonly createController?: (options: ChildHostControllerOptions) => Promise<ChildHostController>;
	readonly createControl?: (identity: ExecutionReportIdentity) => Promise<ExecutionControlChannel>;
	readonly createWatcher?: (sessionFile: string, identity: ExecutionReportIdentity, onNewMessage?: OnNewSessionMessage) => SessionWatcher;
	readonly readSession?: (sessionFile: string) => Promise<string>;
	readonly ensureSessionFile?: (sessionFile: string) => void;
	readonly readyDeadline?: (ready: Promise<void>, timeoutMs: number, safeLabel: string) => Promise<void>;
	readonly controlDeadline?: <T>(promise: Promise<T>, timeoutMs: number, label: string) => Promise<T>;
}

function defaultWatchDependencies(): WatchDependencies {
	return {
		watch(sessionFile, listener, onError) {
			const watcher = fs.watch(sessionFile, listener);
			watcher.on("error", onError);
			return { close: () => watcher.close() };
		},
		readFile: sessionFile => fs.promises.readFile(sessionFile, "utf8"),
	};
}

function ensureTrustedSessionFile(sessionFile: string): void {
	try {
		const details = fs.lstatSync(sessionFile);
		if (!details.isFile() || details.isSymbolicLink()) throw new Error("execution session path must be a regular non-symlink file");
		if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error("execution session file must be owner-only");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		createExclusiveSessionFile(sessionFile);
	}
}

function withReadyDeadline(ready: Promise<void>, timeoutMs: number, safeLabel: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`external execution surface '${safeLabel}' was not ready within ${timeoutMs}ms`)), timeoutMs);
		timer.unref?.();
		void ready.then(
			() => { clearTimeout(timer); resolve(); },
			(error) => { clearTimeout(timer); reject(error); },
		);
	});
}

function usageFrom(messages: readonly Message[]): { usage: ExternalAttemptUsage; model?: string } {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let turns = 0;
	let model: string | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		turns++;
		input += message.usage?.input ?? 0;
		output += message.usage?.output ?? 0;
		cacheRead += message.usage?.cacheRead ?? 0;
		cacheWrite += message.usage?.cacheWrite ?? 0;
		cost += message.usage?.cost?.total ?? 0;
		model ??= message.model;
	}
	return { usage: { input, output, cacheRead, cacheWrite, cost, turns }, model };
}

function proveControl(replayed: ReplayedSession, action: "abort" | "shutdown"): void {
	const states = replayed.controls.filter(report => report.action === action).map(report => report.state);
	const requested = states.indexOf("requested");
	const applied = states.indexOf("applied");
	if (requested < 0 || applied <= requested) throw new Error(`durable ${action} control evidence is missing`);
}

function mapResult(request: ExternalAttemptRequest, replayed: ReplayedSession, exit: ChildHostExit): ExternalAttemptResult {
	if (!replayed.result) throw new ExternalExecutionDiagnosticError("result_missing");
	if (replayed.result.outcome === "success" && (exit.status !== 0 || exit.signal !== null)) throw new Error("successful durable result conflicts with child exit");
	const messages = replayed.messages.filter((message): message is Message => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
	const aggregate = usageFrom(messages);
	return {
		attemptId: request.attemptId,
		sessionFile: request.sessionFile,
		messages,
		outcome: replayed.result.outcome,
		finalOutput: replayed.result.finalOutput,
		...(replayed.result.outcome === "failed"
			? { error: replayed.result.error ?? replayed.result.finalOutput }
			: replayed.result.error === undefined ? {} : { error: replayed.result.error }),
		usage: aggregate.usage,
		...(aggregate.model === undefined ? {} : { model: aggregate.model }),
		turns: aggregate.usage.turns,
		exit: { code: exit.status, signal: exit.signal },
		interrupted: replayed.result.outcome === "interrupted",
	};
}

function abortPromise(signals: readonly (AbortSignal | undefined)[]): { promise: Promise<void>; close(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>(settle => { resolve = settle; });
	const listener = () => resolve();
	for (const signal of signals) {
		if (!signal) continue;
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", listener, { once: true });
	}
	return {
		promise,
		close() { for (const signal of signals) { if (!signal) continue; signal.removeEventListener("abort", listener); } },
	};
}

function withControlDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timerId: NodeJS.Timeout | undefined;
	const timeout = new Promise<T>((_, reject) => {
		timerId = setTimeout(() => reject(new Error(`${label} wait exceeded ${timeoutMs}ms`)), timeoutMs);
		if (timerId.unref) timerId.unref();
	});
	return Promise.race([promise, timeout]).finally(() => { if (timerId) clearTimeout(timerId); });
}

async function finishWithCleanup(primary: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
	let primaryError: Error | undefined;
	try {
		await primary();
	} catch (error) {
		primaryError = error as Error;
	}
	try {
		await cleanup();
	} catch (cleanupError) {
		if (primaryError) {
			throw new AggregateError([primaryError, cleanupError as Error], "finish failed with cleanup error");
		}
		throw cleanupError;
	}
	if (primaryError) throw primaryError;
}

export async function createExternalExecution(
	options: ExternalExecutionOptions,
	dependencies: ExternalExecutionDependencies = {},
): Promise<ExternalExecution> {
	const controller = await (dependencies.createController ?? createChildHostController)(options);
	const deadline = dependencies.readyDeadline ?? withReadyDeadline;
	const controlTimeoutMs = options.controlTimeoutMs ?? 30_000;
	const controlDeadline = dependencies.controlDeadline ?? withControlDeadline;
	const ready = deadline(controller.ready, options.readyTimeoutMs ?? 30_000, controller.lease.handle.display.label);
	void ready.catch(() => {});
	const watchDependencies = defaultWatchDependencies();
	const createControl = dependencies.createControl ?? (identity => createExecutionControlChannel(identity));
	const createWatcher = dependencies.createWatcher ?? ((sessionFile, identity, onNewMessage) => createSessionWatcher(sessionFile, identity, watchDependencies, onNewMessage));
	const readSession = dependencies.readSession ?? (sessionFile => fs.promises.readFile(sessionFile, "utf8"));
	const ensureSessionFile = dependencies.ensureSessionFile ?? ensureTrustedSessionFile;
	const attemptedIds = new Set<string>();
	let active = false;
	let finishPromise: Promise<ExternalExecutionFinishResult> | undefined;
	let finishDisposition: ExternalExecutionDisposition | undefined;
	let releasePromise: Promise<void> | undefined;
	const releaseObserver = () => (releasePromise ??= controller.releaseObserver().catch(error => {
		releasePromise = undefined;
		throw error;
	}));

	const runAttempt = async (request: ExternalAttemptRequest): Promise<ExternalAttemptResult> => {
		if (active) throw new Error("external execution owner is busy");
		if (!request.attemptId || attemptedIds.has(request.attemptId)) throw new Error("external execution attemptId has already been used");
		active = true;
		attemptedIds.add(request.attemptId);
		let control: ExecutionControlChannel | undefined;
		let watcher: SessionWatcher | undefined;
		const abort = abortPromise([request.signal, request.interruptSignal]);
		try {
			await ready;
			ensureSessionFile(request.sessionFile);
			const identity = { runId: options.runId, childId: options.childId, attemptId: request.attemptId };
			control = await createControl(identity);
			watcher = createWatcher(request.sessionFile, identity, request.onNewSessionMessage);
			const environment = { ...request.environment, [PI_COHORT_REPORT_CONFIG]: control.configPath };
			const exitPromise = controller.startAttempt({ attemptId: request.attemptId, command: request.command, args: [...request.args], cwd: request.cwd, environment });
			const first = await Promise.race([
				watcher.terminal.then(replayed => ({ kind: "result" as const, replayed })),
				exitPromise.then(exit => ({ kind: "exit" as const, exit })),
				abort.promise.then(() => ({ kind: "abort" as const })),
			]);
			let replayed: ReplayedSession;
			let exit: ChildHostExit;
			if (first.kind === "abort") {
				await control.request("abort");
				replayed = await controlDeadline(watcher.terminal, controlTimeoutMs, "post-abort terminal");
				if (replayed.result.outcome !== "interrupted") throw new Error("abort did not produce an interrupted durable result");
				await control.request("shutdown");
				exit = await controlDeadline(exitPromise, controlTimeoutMs, "post-shutdown exit");
				replayed = replayExecutionSession(await readSession(request.sessionFile), identity);
				proveControl(replayed, "abort");
				proveControl(replayed, "shutdown");
			} else if (first.kind === "result") {
				replayed = first.replayed;
				await control.request("shutdown");
				exit = await controlDeadline(exitPromise, controlTimeoutMs, "post-shutdown exit");
				replayed = replayExecutionSession(await readSession(request.sessionFile), identity);
				proveControl(replayed, "shutdown");
			} else {
				exit = first.exit;
				replayed = replayExecutionSession(await readSession(request.sessionFile), identity);
				if (!replayed.result) throw new ExternalExecutionDiagnosticError("result_missing");
			}
			return mapResult(request, replayed, exit);
		} finally {
			abort.close();
			watcher?.close();
			await control?.close();
			active = false;
		}
	};

	return {
		surface: controller.lease.handle,
		ready,
		runAttempt,
		finish(disposition) {
			if (finishDisposition && finishDisposition !== disposition) {
				return Promise.reject(new Error(`external execution owner is already finishing as ${finishDisposition}`));
			}
			finishDisposition = disposition;
			return (finishPromise ??= (async () => {
				if (active) throw new Error("external execution owner is busy");
				if (disposition === "retained") {
					await finishWithCleanup(
						async () => { await controller.shutdown(); },
						releaseObserver,
					);
					return { handle: controller.lease.handle, retained: true };
				}
				await finishWithCleanup(
					async () => {
						await controller.shutdown();
						await options.backend.close(controller.lease.handle, "delivered");
					},
					releaseObserver,
				);
				return { handle: controller.lease.handle, retained: false };
			})().catch(error => {
				finishPromise = undefined;
				throw error;
			}));
		},
	};
}
