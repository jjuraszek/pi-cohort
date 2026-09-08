export const EXECUTION_BACKEND_PROTOCOL_VERSION = 1;

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface ExecutionSurfaceIdentity {
	readonly kind: string;
	readonly id: string;
}

export interface ExecutionSurfaceHandle {
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly backend: string;
	readonly surface: ExecutionSurfaceIdentity;
	readonly display: {
		readonly label: string;
		readonly hint: string;
	};
	readonly data: JsonValue;
}

export interface ExecutionSurfaceRequest {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly runId: string;
	readonly childId: string;
	readonly signal: AbortSignal;
	readonly secretPipePath?: string;
	readonly awareness?: Readonly<Record<string, JsonValue>>;
}

export interface ExecutionBackendDetection {
	readonly available: boolean;
	readonly version: string;
	readonly capabilities: readonly string[];
	readonly reason?: string;
}

interface ExecutionBackendFactBase {
	readonly timestamp: number;
	readonly source: "mux";
	readonly surface: ExecutionSurfaceIdentity;
}

export type ExecutionBackendEvent =
	| (ExecutionBackendFactBase & {
		readonly type: "exited";
		readonly status: number | null;
		readonly signal: string | null;
	})
	| (ExecutionBackendFactBase & { readonly type: "surface_closed"; readonly requested: boolean })
	| (ExecutionBackendFactBase & { readonly type: "backend_disconnected"; readonly reason: string })
	| (ExecutionBackendFactBase & { readonly type: "no_observed_activity"; readonly sinceMs: number })
	| (ExecutionBackendFactBase & { readonly type: "unknown"; readonly fact: string; readonly reason: string });

export interface ExecutionBackendLease {
	readonly handle: ExecutionSurfaceHandle;
	readonly events: AsyncIterable<ExecutionBackendEvent>;
	reconcile(): Promise<readonly ExecutionBackendEvent[]>;
	release(): Promise<void>;
}

export type ReattachResult =
	| { readonly status: "present"; readonly lease: ExecutionBackendLease }
	| { readonly status: "gone" }
	| { readonly status: "unknown"; readonly reason: string };

export type ExecutionBackendCloseReason = "delivered" | "explicit_cleanup";

export interface ExecutionBackend {
	readonly name: string;
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	detect(): Promise<ExecutionBackendDetection>;
	launch(request: ExecutionSurfaceRequest): Promise<ExecutionBackendLease>;
	reattach(handle: ExecutionSurfaceHandle): Promise<ReattachResult>;
	close(handle: ExecutionSurfaceHandle, reason: ExecutionBackendCloseReason): Promise<void>;
}

/**
 * A serializable, package-anchored recipe for recreating a backend in a fresh
 * coordinator process. It intentionally carries module identity only.
 */
export interface ExecutionBackendReloadDescriptor {
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly packageJsonUrl: string;
	readonly publicSubpath: "." | `./${string}`;
	readonly factoryExport: string;
}

export type ExecutionBackendFactory =
	() => ExecutionBackend | Promise<ExecutionBackend>;

export interface ExecutionBackendRegistrationOptions {
	readonly reload?: ExecutionBackendReloadDescriptor;
}

/** @internal Serialized only by the detached-runner boundary. */
export interface ExecutionBackendRegistration {
	readonly name: string;
	readonly reload?: ExecutionBackendReloadDescriptor;
}

/** @internal Detached coordinator configuration transferred across the process boundary. */
export interface DetachedExecutionBackendConfig {
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly userPreference?: string;
	readonly registrations: readonly ExecutionBackendRegistration[];
}
