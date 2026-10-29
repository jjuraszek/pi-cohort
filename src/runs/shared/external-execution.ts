import * as fs from "node:fs";
import type { PiRuntimeIdentity } from "./pi-spawn.ts";
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
	readonly runtime: PiRuntimeIdentity;
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

export function isInterruptedExternalAttemptError(error: unknown): error is Error & { interrupted: true } {
	return error instanceof Error && (error as Error & { interrupted?: boolean }).interrupted === true;
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
	readonly monotonicNow?: () => number;
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

function mapResult(request: ExternalAttemptRequest, replayed: ReplayedSession, exit: ChildHostExit, validateExit = true): ExternalAttemptResult {
	if (!replayed.result) throw new ExternalExecutionDiagnosticError("result_missing");
	if (validateExit && replayed.result.outcome === "success" && (exit.status !== 0 || exit.signal !== null)) throw new Error("successful durable result conflicts with child exit");
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
	const now = dependencies.monotonicNow ?? (() => performance.now());
	let interruptedFinish: ExternalExecutionFinishResult | undefined;
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
		if (interruptedFinish) throw new Error("external execution owner has been interruption-cleaned");
		active = true;
		attemptedIds.add(request.attemptId);
		let control: ExecutionControlChannel | undefined;
		let watcher: SessionWatcher | undefined;
		const abort = abortPromise([request.signal, request.interruptSignal]);
		let interruptedAt: number | undefined;
		let disposed = false;
		const acceptInterruption = () => { interruptedAt ??= now(); };
		const signals = [request.signal, request.interruptSignal];
		for (const signal of signals) {
			if (signal?.aborted) acceptInterruption();
			else signal?.addEventListener("abort", acceptInterruption, { once: true });
		}
		try {
			await ready;
			ensureSessionFile(request.sessionFile);
			const identity = { runId: options.runId, childId: options.childId, attemptId: request.attemptId };
			control = await createControl(identity);
			watcher = createWatcher(request.sessionFile, identity, request.onNewSessionMessage);
			const environment = { ...request.environment, [PI_COHORT_REPORT_CONFIG]: control.configPath };
			const exitPromise = controller.startAttempt({ attemptId: request.attemptId, command: request.command, args: [...request.args], cwd: request.cwd, environment });
			let observedExit: ChildHostExit | undefined;
			let hostExited = false;
			void exitPromise.then(exit => { observedExit = exit; }, () => {});
			void controller.hostExit.then(() => { hostExited = true; }, () => {});
			const finalizeInterrupted = async (initial?: ReplayedSession, initialError?: unknown, shutdownRequest?: Promise<string>): Promise<ExternalAttemptResult> => {
				acceptInterruption();
				let endpoint = interruptedAt! + controlTimeoutMs;
				let fallback = false;
				let closed = false;
				let closeAttempted = false;
				const diagnostics: string[] = [];
				const note = (error: unknown) => { diagnostics.push(error instanceof Error ? error.message : String(error)); };
				const wait = <T>(promise: Promise<T>, label: string) => {
					void promise.catch(() => {});
					const remaining = Math.max(0, endpoint - now());
					return remaining > 0 ? controlDeadline(promise, remaining, label) : Promise.reject(new Error(`${label} deadline exhausted`));
				};
				const forceCleanup = async () => {
					if (closeAttempted) return;
					closeAttempted = true;
					endpoint = interruptedAt! + 2 * controlTimeoutMs;
					try { await wait(options.backend.close(controller.lease.handle, "explicit_cleanup"), "explicit cleanup"); closed = true; } catch (error) { note(error); }
				};
				let replayed = initial;
				let primary = initialError;
				if (!initial) {
					try { await wait(control!.request("abort"), "abort request"); } catch (error) { note(error); }
					if (!initialError) {
						try { replayed = await wait(watcher!.terminal, "post-abort terminal"); } catch (error) { primary = error; fallback = true; }
					}
				}
				try { await wait(shutdownRequest ?? control!.request("shutdown"), "child shutdown"); } catch (error) { note(error); fallback = true; }
				if (fallback) endpoint = interruptedAt! + 2 * controlTimeoutMs;
				try {
					replayed = replayExecutionSession(await wait(readSession(request.sessionFile), "final replay"), identity);
					if (!replayed.result && !initialError) primary = new ExternalExecutionDiagnosticError("result_missing");
					else if (!primary) {
						if (!initial) proveControl(replayed, "abort");
						proveControl(replayed, "shutdown");
					}
				} catch (error) { primary ??= error; }
				if (fallback) await forceCleanup();
				try { await wait(exitPromise, "post-shutdown exit"); } catch (error) { note(error); fallback = true; }
				if (observedExit) {
					try { await wait(controller.shutdown(), "host shutdown"); } catch (error) { note(error); fallback = true; }
				}
				if (fallback) await forceCleanup();
				if (!observedExit) {
					// A failed observation is not exit evidence; keep resources until the remaining budget expires.
					const remainingExit = exitPromise.catch(() => new Promise<ChildHostExit>(() => {}));
					try { await wait(remainingExit, "child exit observation"); } catch (error) { note(error); }
					if (observedExit) {
						try { await wait(controller.shutdown(), "host shutdown"); } catch (error) { note(error); }
					}
				}
				if (!hostExited) {
					try { await wait(controller.hostExit, "host exit observation"); } catch (error) { note(error); }
				}
				try { watcher!.close(); } catch (error) { note(error); }
				finally {
					try { controller.dispose(); } catch (error) { note(error); }
					finally {
						disposed = true;
						try { await wait(control!.close(), "control disposal"); } catch (error) { note(error); }
						finally {
							try { await wait(releaseObserver(), "observer release"); } catch (error) { note(error); }
						}
					}
				}
				interruptedFinish = { handle: controller.lease.handle, retained: !closed };
				if (!observedExit || !hostExited || (fallback && !closed)) diagnostics.push("Process termination could not be confirmed; manual cleanup may be required.");
				if (primary) {
					const error = primary instanceof Error ? primary : new Error(String(primary));
					Object.assign(error, { interrupted: true });
					if (diagnostics.length) error.message += `; ${diagnostics.join("; ")}`;
					throw error;
				}
				const result = mapResult(request, replayed!, observedExit ?? { status: null, signal: null }, false);
				return { ...result, interrupted: true, ...(diagnostics.length ? { error: [result.error, ...diagnostics].filter(Boolean).join("; ") } : {}) };
			};
			let first;
			try { first = await Promise.race([
				watcher.terminal.then(replayed => ({ kind: "result" as const, replayed })),
				exitPromise.then(exit => ({ kind: "exit" as const, exit })),
				abort.promise.then(() => ({ kind: "abort" as const })),
			]); } catch (error) {
				if (interruptedAt !== undefined) return await finalizeInterrupted(undefined, error);
				throw error;
			}
			if (first.kind === "abort") return await finalizeInterrupted();
			if (first.kind === "result" && (interruptedAt !== undefined || first.replayed.result?.outcome === "interrupted")) return await finalizeInterrupted(first.replayed);
			const finalReplay = () => Promise.race([
				readSession(request.sessionFile).then(content => replayExecutionSession(content, identity)),
				abort.promise.then(() => undefined),
			]);
			let replayed: ReplayedSession;
			let exit: ChildHostExit;
			if (first.kind === "result") {
				replayed = first.replayed;
				const shutdownRequest = control.request("shutdown");
				try {
					const shutdown = await Promise.race([shutdownRequest.then(() => "shutdown" as const), abort.promise.then(() => "abort" as const)]);
					if (shutdown === "abort") return await finalizeInterrupted(replayed, undefined, shutdownRequest);
					const stopped = await Promise.race([
						controlDeadline(exitPromise, controlTimeoutMs, "post-shutdown exit").then(exit => ({ exit })),
						abort.promise.then(() => ({ exit: undefined })),
					]);
					if (!stopped.exit || interruptedAt !== undefined) return await finalizeInterrupted(replayed, undefined, shutdownRequest);
					exit = stopped.exit;
				} catch (error) {
					if (interruptedAt !== undefined && !disposed) return await finalizeInterrupted(replayed, error, shutdownRequest);
					throw error;
				}
				let final: ReplayedSession | undefined;
				try { final = await finalReplay(); } catch (error) {
					if (interruptedAt !== undefined) return await finalizeInterrupted(replayed, error, shutdownRequest);
					throw error;
				}
				if (!final || interruptedAt !== undefined) return await finalizeInterrupted(replayed, undefined, shutdownRequest);
				replayed = final;
				proveControl(replayed, "shutdown");
			} else {
				exit = first.exit;
				let final: ReplayedSession | undefined;
				try {
					final = await finalReplay();
					if (final && !final.result) throw new ExternalExecutionDiagnosticError("result_missing");
				} catch (error) {
					if (interruptedAt !== undefined) return await finalizeInterrupted(undefined, error);
					throw error;
				}
				if (!final) return await finalizeInterrupted();
				replayed = final;
				if (interruptedAt !== undefined || replayed.result!.outcome === "interrupted") return await finalizeInterrupted(replayed);
			}
			return mapResult(request, replayed, exit);
		} finally {
			abort.close();
			for (const signal of signals) signal?.removeEventListener("abort", acceptInterruption);
			try {
				if (!disposed) { watcher?.close(); await control?.close(); }
			} finally { active = false; }
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
			if (interruptedFinish && disposition === "delivered") {
				return Promise.reject(new Error("interruption-cleaned external execution owner accepts only retained finish"));
			}
			finishDisposition = disposition;
			return (finishPromise ??= (async () => {
				if (active) throw new Error("external execution owner is busy");
				if (interruptedFinish) return interruptedFinish;
				if (disposition === "retained") {
					await finishWithCleanup(
						async () => { await controller.shutdown(); },
						async () => { try { await releaseObserver(); } finally { controller.dispose(); } },
					);
					return { handle: controller.lease.handle, retained: true };
				}
				await finishWithCleanup(
					async () => {
						await controller.shutdown();
						await options.backend.close(controller.lease.handle, "delivered");
					},
					async () => { try { await releaseObserver(); } finally { controller.dispose(); } },
				);
				return { handle: controller.lease.handle, retained: false };
			})().catch(error => {
				finishPromise = undefined;
				throw error;
			}));
		},
	};
}
