import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTROL_PROTOCOL_VERSION,
	encodeControlRequest,
	type ControlRequest,
	type ControlRequestIdentity,
} from "./control-protocol.ts";
import { EXECUTION_REPORT_PROTOCOL_VERSION } from "./reporting-protocol.ts";

interface ControlChannelFileSystem {
	mkdtempSync(prefix: string): string;
	chmodSync(path: fs.PathLike, mode: fs.Mode): void;
	openSync(path: fs.PathLike, flags: string, mode: fs.Mode): number;
	writeFileSync(file: number, data: string): void;
	closeSync(fd: number): void;
	rmSync(path: fs.PathLike, options: { recursive: true; force: true }): void;
}

export interface ExecutionControlChannel {
	readonly configPath: string;
	readonly connected: Promise<void>;
	request(action: "abort" | "shutdown"): Promise<string>;
	close(): Promise<void>;
}

interface ControlConnection {
	once(event: "error", listener: (error: Error) => void): this;
	once(event: "close", listener: () => void): this;
	write(data: Buffer, callback: (error?: Error | null) => void): boolean;
	destroy(): void;
}

interface ControlServer {
	readonly listening: boolean;
	once(event: "error", listener: (error: Error) => void): this;
	off(event: "error", listener: (error: Error) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	listen(path: string, callback: () => void): this;
	close(callback: () => void): this;
}

export interface ExecutionControlChannelDependencies {
	readonly fileSystem?: ControlChannelFileSystem;
	readonly platform?: NodeJS.Platform;
	readonly randomUUID?: () => string;
	readonly createServer?: (listener: (socket: ControlConnection) => void) => ControlServer;
}

interface PendingWrite {
	reject(error: Error): void;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

async function closeServer(server: ControlServer): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function createExecutionControlChannel(
	identity: ControlRequestIdentity,
	dependencies: ExecutionControlChannelDependencies = {},
): Promise<ExecutionControlChannel> {
	const platform = dependencies.platform ?? process.platform;
	if (platform === "win32") throw new Error("interactive execution control is unsupported on win32");
	const fileSystem = dependencies.fileSystem ?? fs;
	const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
	let directory: string | undefined;
	let server: ControlServer | undefined;
	let connection: ControlConnection | undefined;
	let disconnectCause: Error | undefined;
	let closePromise: Promise<void> | undefined;
	const pendingWrites = new Set<PendingWrite>();
	let resolveConnected: (() => void) | undefined;
	let rejectConnected: ((error: Error) => void) | undefined;
	const connected = new Promise<void>((resolve, reject) => {
		resolveConnected = resolve;
		rejectConnected = reject;
	});
	void connected.catch(() => {});

	const fail = (cause: Error): void => {
		disconnectCause ??= cause;
		rejectConnected?.(disconnectCause);
		rejectConnected = undefined;
		resolveConnected = undefined;
		for (const pending of pendingWrites) pending.reject(disconnectCause);
		pendingWrites.clear();
	};

	const cleanup = async (): Promise<void> => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			fail(disconnectCause ?? new Error("control channel closed"));
			connection?.destroy();
			connection = undefined;
			if (server) await closeServer(server);
			server = undefined;
			if (directory) fileSystem.rmSync(directory, { recursive: true, force: true });
		})();
		return closePromise;
	};

	try {
		directory = fileSystem.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-control-"));
		fileSystem.chmodSync(directory, 0o700);
		const socketPath = path.join(directory, "control.sock");
		if (Buffer.byteLength(socketPath) > 103) {
			throw new Error("control socket path exceeds the portable Unix limit");
		}
		const configPath = path.join(directory, "reporter-config.json");
		server = (dependencies.createServer ?? net.createServer)((socket) => {
			if (connection) {
				socket.once("error", () => {});
				socket.destroy();
				return;
			}
			connection = socket;
			socket.once("error", (error) => fail(asError(error)));
			socket.once("close", () => fail(new Error("control socket disconnected")));
			resolveConnected?.();
			resolveConnected = undefined;
			rejectConnected = undefined;
		});
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			server!.once("error", onError);
			server!.listen(socketPath, () => {
				server!.off("error", onError);
				resolve();
			});
		});
		server.on("error", (error) => fail(asError(error)));
		fileSystem.chmodSync(socketPath, 0o600);
		const config = {
			protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION,
			...identity,
			controlSocketPath: socketPath,
		};
		const descriptor = fileSystem.openSync(configPath, "wx", 0o600);
		try {
			fileSystem.writeFileSync(descriptor, JSON.stringify(config));
		} finally {
			fileSystem.closeSync(descriptor);
		}

		return {
			configPath,
			connected,
			async request(action) {
				if (closePromise) throw disconnectCause ?? new Error("control channel closed");
				await connected;
				if (disconnectCause || !connection) {
					throw disconnectCause ?? new Error("control socket disconnected");
				}
				const requestId = randomUUID();
				const request: ControlRequest = {
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					...identity,
					requestId,
					action,
				};
				await new Promise<void>((resolve, reject) => {
					let settled = false;
					const pending: PendingWrite = {
						reject(error) {
							if (settled) return;
							settled = true;
							reject(error);
						},
					};
					pendingWrites.add(pending);
					connection!.write(encodeControlRequest(request), (error) => {
						pendingWrites.delete(pending);
						if (settled) return;
						settled = true;
						if (error) {
							const cause = asError(error);
							fail(cause);
							reject(cause);
						} else resolve();
					});
				});
				return requestId;
			},
			close: cleanup,
		};
	} catch (error) {
		const cause = asError(error);
		fail(cause);
		await cleanup();
		throw cause;
	}
}
