import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ChildHostFrameDecoder, encodeChildHostMessage, type ChildHostMessage } from "./child-host-protocol.ts";
import { PI_COHORT_CHILD_HOST_CONFIG } from "./child-host-runtime.ts";
import { ensureJitiCliPath } from "../runs/shared/jiti-cli.ts";
import type { ExecutionBackend, ExecutionBackendLease } from "./types.ts";

export interface ChildHostAttempt { readonly attemptId: string; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly environment: Readonly<Record<string, string>>; }
export interface ChildHostExit { readonly status: number | null; readonly signal: string | null; }
export interface ChildHostController { readonly lease: ExecutionBackendLease; readonly ready: Promise<void>; startAttempt(attempt: ChildHostAttempt): Promise<ChildHostExit>; shutdown(): Promise<void>; releaseObserver(): Promise<void>; }
export interface ChildHostControllerOptions { readonly backend: ExecutionBackend; readonly runId: string; readonly childId: string; readonly cwd: string; readonly title?: string; readonly signal: AbortSignal; }
export interface ChildHostControllerDependencies { readonly fs?: typeof fs; readonly ensureJiti?: () => string | undefined; readonly childHostCommand?: () => { command: string; args: readonly string[] }; readonly platform?: NodeJS.Platform; readonly createServer?: typeof net.createServer; }

const HOST_ENVIRONMENT_KEYS = ["PATH", "HOME", "TMPDIR", "SystemRoot"] as const;
function childHostCommand(ensureJiti: () => string | undefined): { command: string; args: readonly string[] } {
	const jiti = ensureJiti();
	if (!jiti) throw new Error("upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed");
	return { command: process.execPath, args: [jiti, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "child-host-runtime.ts")] };
}
function disconnected(phase: string): Error { return new Error(`child host disconnected ${phase}`); }
function aborted(): Error { return new Error("child host launch aborted"); }

export async function createChildHostController(options: ChildHostControllerOptions, dependencies: ChildHostControllerDependencies = {}): Promise<ChildHostController> {
	const platform = dependencies.platform ?? process.platform;
	if (platform === "win32") throw new Error("external terminal mux child host is unsupported on win32");
	if (options.signal.aborted) throw aborted();
	const fileSystem = dependencies.fs ?? fs;
	let directory: string | undefined;
	let socketPath: string | undefined;
	let configPath: string | undefined;
	let server: net.Server | undefined;
	let socket: net.Socket | undefined;
	let closed = false;
	let abortListener: (() => void) | undefined;
	const cleanup = () => {
		if (abortListener) options.signal.removeEventListener("abort", abortListener);
		abortListener = undefined;
		try { socket?.destroy(); } catch {}
		try { server?.close(); } catch {}
		if (socketPath) try { fileSystem.unlinkSync(socketPath); } catch {}
		if (configPath) try { fileSystem.unlinkSync(configPath); } catch {}
		if (directory) try { fileSystem.rmdirSync(directory); } catch {}
	};
	try {
		directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-host-"));
		socketPath = path.join(directory, "host.sock");
		configPath = path.join(directory, "host.json");
		if (Buffer.byteLength(socketPath) >= 100) throw new Error("child host socket path exceeds platform limit");
		fileSystem.chmodSync(directory, 0o700);
		let descriptor: number | undefined;
		try {
			descriptor = fileSystem.openSync(configPath, "wx", 0o600);
			fileSystem.writeFileSync(descriptor, JSON.stringify({ protocolVersion: 1, socketPath, runId: options.runId, childId: options.childId }));
		} finally { if (descriptor !== undefined) fileSystem.closeSync(descriptor); }

		let lease: ExecutionBackendLease | undefined;
		let ready = false;
		let releasePromise: Promise<void> | undefined;
		let active: { readonly attemptId: string; started: boolean; resolve: (exit: ChildHostExit) => void; reject: (error: Error) => void } | undefined;
		let pendingShutdown: { resolve: () => void; reject: (error: Error) => void } | undefined;
		let resolveReady: (() => void) | undefined;
		let rejectReady: ((error: Error) => void) | undefined;
		const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
		void readyPromise.catch(() => {});
		let disconnectCause: Error | undefined;
		const attemptedIds = new Set<string>();
		const fail = (cause: Error) => {
			if (closed) return;
			closed = true;
			rejectReady?.(cause); rejectReady = undefined;
			if (active) { active.reject(cause); active = undefined; }
			if (pendingShutdown) { pendingShutdown.reject(cause); pendingShutdown = undefined; }
			cleanup();
		};
		server = (dependencies.createServer ?? net.createServer)(connection => {
			if (socket || closed) { connection.destroy(); return; }
			socket = connection;
			const decoder = new ChildHostFrameDecoder();
			connection.on("data", data => {
				let messages: ChildHostMessage[];
				try { messages = decoder.push(data); } catch { connection.destroy(); return; }
				for (const message of messages) {
					if (message.runId !== options.runId || message.childId !== options.childId) { connection.destroy(); return; }
					if (!ready) {
						if (message.kind !== "host_ready") { connection.destroy(); return; }
						ready = true; resolveReady?.(); resolveReady = undefined; rejectReady = undefined; continue;
					}
					if (message.kind === "attempt_started" && active?.attemptId === message.attemptId && !active.started) { active.started = true; continue; }
					if (message.kind === "attempt_spawn_error" && active?.attemptId === message.attemptId) {
						const pending = active; active = undefined; pending.reject(new Error("child host attempt spawn error")); continue;
					}
					if (message.kind === "attempt_exited" && active?.attemptId === message.attemptId && active.started) {
						const pending = active; active = undefined; pending.resolve({ status: message.status, signal: message.signal }); continue;
					}
					if (message.kind === "shutdown_ack" && pendingShutdown && !active) {
						const pending = pendingShutdown; pendingShutdown = undefined; closed = true; connection.end(); cleanup(); pending.resolve(); continue;
					}
					connection.destroy(); return;
				}
			});
			connection.once("close", () => {
				if (!closed) {
					const cause = disconnected(!ready ? "before ready" : active ? "during attempt" : pendingShutdown ? "before shutdown acknowledgement" : "after ready");
					disconnectCause = cause;
					fail(cause);
				}
			});
		});
		server.once("error", cause => fail(cause instanceof Error ? cause : new Error("child host server error")));
		abortListener = () => fail(aborted());
		options.signal.addEventListener("abort", abortListener, { once: true });
		await new Promise<void>((resolve, reject) => server!.listen(socketPath!, () => resolve()).once("error", reject));
		fileSystem.chmodSync(socketPath, 0o600);
		if (options.signal.aborted) throw aborted();
		const host = dependencies.childHostCommand?.() ?? childHostCommand(dependencies.ensureJiti ?? ensureJitiCliPath);
		const environment: Record<string, string> = { [PI_COHORT_CHILD_HOST_CONFIG]: configPath };
		for (const key of HOST_ENVIRONMENT_KEYS) if (process.env[key]) environment[key] = process.env[key]!;
		lease = await options.backend.launch({
			command: host.command,
			args: host.args,
			cwd: options.cwd,
			environment,
			runId: options.runId,
			childId: options.childId,
			signal: options.signal,
			...(options.title === undefined ? {} : { awareness: { title: options.title } }),
		});
		return {
			get lease() { return lease!; },
			ready: readyPromise,
			startAttempt(attempt) {
				if (closed || !socket || !ready) return Promise.reject(disconnectCause ?? disconnected("before ready"));
				if (pendingShutdown) return Promise.reject(new Error("child host is shutting down"));
				if (active) return Promise.reject(new Error("child host is busy"));
				if (!attempt.attemptId) return Promise.reject(new Error("attemptId is required"));
				if (attemptedIds.has(attempt.attemptId)) return Promise.reject(new Error("child host attemptId has already been used"));
				attemptedIds.add(attempt.attemptId);
				return new Promise<ChildHostExit>((resolve, reject) => {
					active = { attemptId: attempt.attemptId, started: false, resolve, reject };
					socket!.write(encodeChildHostMessage({ protocolVersion: 1, kind: "start_attempt", runId: options.runId, childId: options.childId, ...attempt }), error => { if (error && active?.attemptId === attempt.attemptId) fail(disconnected("during attempt")); });
				});
			},
			shutdown() {
				if (closed) return disconnectCause ? Promise.reject(disconnectCause) : Promise.resolve();
				if (!socket || !ready) return Promise.reject(disconnectCause ?? disconnected("before ready"));
				if (active || pendingShutdown) return Promise.reject(new Error("child host is busy"));
				return new Promise<void>((resolve, reject) => {
					pendingShutdown = { resolve, reject };
					socket!.write(encodeChildHostMessage({ protocolVersion: 1, kind: "shutdown_host", runId: options.runId, childId: options.childId }), error => { if (error) fail(disconnected("before shutdown acknowledgement")); });
				});
			},
			releaseObserver() {
				return (releasePromise ??= lease!.release().catch(error => {
					releasePromise = undefined;
					throw error;
				}));
			},
		};
	} catch (cause) {
		closed = true;
		cleanup();
		throw cause;
	}
}
