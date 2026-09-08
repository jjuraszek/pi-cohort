import { validateExecutionBackendReloadDescriptor } from "./reload.ts";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "./types.ts";
import type {
	ExecutionBackend,
	ExecutionBackendRegistration,
	ExecutionBackendRegistrationOptions,
	ExecutionBackendReloadDescriptor,
} from "./types.ts";

const hubSymbol = Symbol.for("pi-cohort.execution-backends.v1");

interface ExecutionBackendHub {
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly backends: Map<string, ExecutionBackend>;
	reloadDescriptors?: Map<string, ExecutionBackendReloadDescriptor>;
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
		&& (value as { backends?: unknown }).backends instanceof Map
		&& ((value as { reloadDescriptors?: unknown }).reloadDescriptors === undefined
			|| (value as { reloadDescriptors?: unknown }).reloadDescriptors instanceof Map);
}

function reloadDescriptors(registrationHub: ExecutionBackendHub): Map<string, ExecutionBackendReloadDescriptor> {
	return (registrationHub.reloadDescriptors ??= new Map());
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

export function registerExecutionBackend(
	backend: ExecutionBackend,
	options?: ExecutionBackendRegistrationOptions,
): () => void {
	assertBackend(backend);
	const reload = options?.reload === undefined
		? undefined
		: validateExecutionBackendReloadDescriptor(options.reload, backend.name);
	const registrationHub = hub();
	if (registrationHub.backends.has(backend.name)) {
		throw new Error(`Execution backend '${backend.name}' is already registered`);
	}
	registrationHub.backends.set(backend.name, backend);
	if (reload) reloadDescriptors(registrationHub).set(backend.name, reload);
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		if (registrationHub.backends.get(backend.name) === backend) {
			registrationHub.backends.delete(backend.name);
			registrationHub.reloadDescriptors?.delete(backend.name);
		}
	};
}

export function executionBackends(): readonly ExecutionBackend[] {
	return [...hub().backends.values()];
}

/** @internal The detached runner serializes this order-preserving manifest. */
export function executionBackendRegistrations(): readonly ExecutionBackendRegistration[] {
	const registrationHub = hub();
	const descriptors = registrationHub.reloadDescriptors;
	return Object.freeze([...registrationHub.backends.entries()].map(([name]) => Object.freeze({
		name,
		reload: descriptors?.get(name),
	})));
}
