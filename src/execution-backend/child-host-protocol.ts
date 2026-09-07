export const CHILD_HOST_PROTOCOL_VERSION = 1;
export const CHILD_HOST_MAX_FRAME_BYTES = 64 * 1024;

export interface ChildHostConfig {
	readonly protocolVersion: typeof CHILD_HOST_PROTOCOL_VERSION;
	readonly socketPath: string;
	readonly runId: string;
	readonly childId: string;
}

type Correlation = { readonly protocolVersion: 1; readonly runId: string; readonly childId: string };
export type ChildHostMessage =
	| (Correlation & { readonly kind: "host_ready" })
	| (Correlation & { readonly kind: "start_attempt"; readonly attemptId: string; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly environment: Readonly<Record<string, string>> })
	| (Correlation & { readonly kind: "attempt_started"; readonly attemptId: string })
	| (Correlation & { readonly kind: "attempt_spawn_error"; readonly attemptId: string })
	| (Correlation & { readonly kind: "attempt_exited"; readonly attemptId: string; readonly status: number | null; readonly signal: string | null })
	| (Correlation & { readonly kind: "shutdown_host" })
	| (Correlation & { readonly kind: "shutdown_ack" });

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function exact(input: Record<string, unknown>, fields: readonly string[]): void {
	if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))) throw new Error("invalid child host message fields");
}
function correlation(input: Record<string, unknown>): Correlation {
	return { protocolVersion: CHILD_HOST_PROTOCOL_VERSION, runId: text(input.runId, "runId"), childId: text(input.childId, "childId") };
}

export function validateChildHostConfig(value: unknown): ChildHostConfig {
	const input = record(value, "child host config");
	exact(input, ["protocolVersion", "socketPath", "runId", "childId"]);
	if (input.protocolVersion !== CHILD_HOST_PROTOCOL_VERSION) throw new Error("incompatible child host protocol");
	return { ...correlation(input), socketPath: text(input.socketPath, "socketPath") };
}

export function validateChildHostMessage(value: unknown): ChildHostMessage {
	const input = record(value, "child host message");
	if (input.protocolVersion !== CHILD_HOST_PROTOCOL_VERSION) throw new Error("incompatible child host protocol");
	const base = correlation(input);
	switch (input.kind) {
		case "host_ready": exact(input, ["protocolVersion", "kind", "runId", "childId"]); return { ...base, kind: "host_ready" };
		case "shutdown_host": exact(input, ["protocolVersion", "kind", "runId", "childId"]); return { ...base, kind: "shutdown_host" };
		case "shutdown_ack": exact(input, ["protocolVersion", "kind", "runId", "childId"]); return { ...base, kind: "shutdown_ack" };
		case "attempt_started": exact(input, ["protocolVersion", "kind", "runId", "childId", "attemptId"]); return { ...base, kind: "attempt_started", attemptId: text(input.attemptId, "attemptId") };
		case "attempt_spawn_error": exact(input, ["protocolVersion", "kind", "runId", "childId", "attemptId"]); return { ...base, kind: "attempt_spawn_error", attemptId: text(input.attemptId, "attemptId") };
		case "attempt_exited": {
			exact(input, ["protocolVersion", "kind", "runId", "childId", "attemptId", "status", "signal"]);
			if (input.status !== null && (!Number.isSafeInteger(input.status) || input.status < 0)) throw new Error("status must be a non-negative integer or null");
			if (input.signal !== null && typeof input.signal !== "string") throw new Error("signal must be a string or null");
			return { ...base, kind: "attempt_exited", attemptId: text(input.attemptId, "attemptId"), status: input.status, signal: input.signal };
		}
		case "start_attempt": {
			exact(input, ["protocolVersion", "kind", "runId", "childId", "attemptId", "command", "args", "cwd", "environment"]);
			if (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== "string")) throw new Error("args must be strings");
			const environment = record(input.environment, "environment");
			if (Object.values(environment).some(entry => typeof entry !== "string")) throw new Error("environment values must be strings");
			return { ...base, kind: "start_attempt", attemptId: text(input.attemptId, "attemptId"), command: text(input.command, "command"), args: input.args, cwd: text(input.cwd, "cwd"), environment: environment as Record<string, string> };
		}
		default: throw new Error("invalid child host message kind");
	}
}

/** Incremental, bounded JSONL decoder. It intentionally never retains parsed frames. */
export class ChildHostFrameDecoder {
	#buffer = Buffer.alloc(0);
	push(chunk: Buffer | string): ChildHostMessage[] {
		this.#buffer = Buffer.concat([this.#buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		const messages: ChildHostMessage[] = [];
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.#buffer.length > CHILD_HOST_MAX_FRAME_BYTES) throw new Error("child host frame buffer exceeds maximum size");
				return messages;
			}
			if (newline === 0 || newline > CHILD_HOST_MAX_FRAME_BYTES) throw new Error("invalid child host frame");
			const frame = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			try { messages.push(validateChildHostMessage(JSON.parse(frame.toString("utf8")))); }
			catch { throw new Error("invalid child host frame"); }
		}
	}
	get remainder(): string { return this.#buffer.toString("utf8"); }
}

export function decodeChildHostFrames(chunk: string, maxBytes = CHILD_HOST_MAX_FRAME_BYTES): { messages: ChildHostMessage[]; remainder: string } {
	if (maxBytes !== CHILD_HOST_MAX_FRAME_BYTES) {
		if (Buffer.byteLength(chunk) > maxBytes) throw new Error("child host frame buffer exceeds maximum size");
		for (const frame of chunk.split("\n").slice(0, -1)) if (!frame || Buffer.byteLength(frame) > maxBytes) throw new Error("invalid child host frame");
	}
	const decoder = new ChildHostFrameDecoder();
	const messages = decoder.push(chunk);
	return { messages, remainder: decoder.remainder };
}
export function encodeChildHostMessage(message: ChildHostMessage): string { return `${JSON.stringify(message)}\n`; }
