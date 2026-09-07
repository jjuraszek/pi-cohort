export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_MAX_FRAME_BYTES = 64 * 1024;

export interface ControlRequestIdentity {
	readonly runId: string;
	readonly childId: string;
	readonly attemptId: string;
}

export interface ControlRequest extends ControlRequestIdentity {
	readonly protocolVersion: typeof CONTROL_PROTOCOL_VERSION;
	readonly requestId: string;
	readonly action: "abort" | "shutdown";
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function exactFields(input: Record<string, unknown>, fields: readonly string[]): void {
	const allowed = new Set(fields);
	if (Object.keys(input).some((key) => !allowed.has(key))) {
		throw new Error("invalid control request fields");
	}
}

export function validateControlRequest(value: unknown): ControlRequest {
	const input = object(value, "control request");
	if (input.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
		throw new Error("incompatible control protocol");
	}
	exactFields(input, ["protocolVersion", "runId", "childId", "attemptId", "requestId", "action"]);
	if (input.action !== "abort" && input.action !== "shutdown") {
		throw new Error("invalid control action");
	}
	return {
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		runId: text(input.runId, "runId"),
		childId: text(input.childId, "childId"),
		attemptId: text(input.attemptId, "attemptId"),
		requestId: text(input.requestId, "requestId"),
		action: input.action,
	};
}

export function encodeControlRequest(request: ControlRequest): Buffer {
	return Buffer.from(`${JSON.stringify(validateControlRequest(request))}\n`);
}

export class ControlFrameDecoder {
	#buffer = Buffer.alloc(0);
	readonly #maxBytes: number;

	constructor(maxBytes = CONTROL_MAX_FRAME_BYTES) {
		this.#maxBytes = maxBytes;
	}

	feed(chunk: Buffer | string): ControlRequest[] {
		this.#buffer = Buffer.concat([
			this.#buffer,
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
		]);
		const requests: ControlRequest[] = [];
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.#buffer.length > this.#maxBytes) {
					throw new Error("control frame size limit exceeded");
				}
				return requests;
			}
			if (newline === 0) throw new Error("empty control frame");
			if (newline > this.#maxBytes) throw new Error("control frame size limit exceeded");
			const frame = this.#buffer.subarray(0, newline);
			this.#buffer = this.#buffer.subarray(newline + 1);
			try {
				requests.push(validateControlRequest(JSON.parse(frame.toString("utf8"))));
			} catch (error) {
				if (error instanceof Error && error.message === "control frame size limit exceeded") throw error;
				throw new Error("invalid control frame");
			}
		}
	}

	get remainder(): Buffer {
		return this.#buffer;
	}
}
