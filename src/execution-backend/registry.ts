import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "./types.ts";
import type { ExecutionBackend } from "./types.ts";

const hubSymbol = Symbol.for("pi-cohort.execution-backends.v1");

interface ExecutionBackendHub {
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly backends: Map<string, ExecutionBackend>;
}

function hub(): ExecutionBackendHub {
	const globalStore = globalThis as Record<symbol, unknown>;
	const existing = globalStore[hubSymbol];
	if (existing === undefined) {
		const created: ExecutionBackendHub = {
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
			backends: new Map(),
		};
		globalStore[hubSymbol] = created;
		return created;
	}
	if (!isHub(existing)) throw new Error("Incompatible execution backend registration hub");
	return existing;
}

function isHub(value: unknown): value is ExecutionBackendHub {
	return typeof value === "object"
		&& value !== null
		&& (value as { protocolVersion?: unknown }).protocolVersion === EXECUTION_BACKEND_PROTOCOL_VERSION
		&& (value as { backends?: unknown }).backends instanceof Map;
}

function assertBackend(backend: ExecutionBackend): void {
	if (!backend || typeof backend !== "object") throw new Error("Execution backend must be an object");
	if (typeof backend.name !== "string" || backend.name.trim() === "") {
		throw new Error("Execution backend name must be nonblank");
	}
	if (backend.protocolVersion !== EXECUTION_BACKEND_PROTOCOL_VERSION) {
		throw new Error("Execution backend protocol version is incompatible");
	}
	for (const method of ["detect", "launch", "reattach", "close"] as const) {
		if (typeof backend[method] !== "function") throw new Error(`Execution backend ${method} must be a function`);
	}
}

export function registerExecutionBackend(backend: ExecutionBackend): () => void {
	assertBackend(backend);
	const registrationHub = hub();
	if (registrationHub.backends.has(backend.name)) {
		throw new Error(`Execution backend '${backend.name}' is already registered`);
	}
	registrationHub.backends.set(backend.name, backend);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		if (registrationHub.backends.get(backend.name) === backend) {
			registrationHub.backends.delete(backend.name);
		}
	};
}

export function executionBackends(): readonly ExecutionBackend[] {
	return [...hub().backends.values()];
}
