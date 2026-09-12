export { EXECUTION_BACKEND_PROTOCOL_VERSION } from "./types.ts";
export { registerExecutionBackend } from "./registry.ts";
export { selectExecutionBackend } from "./selection.ts";
export type {
	ExecutionBackend,
	ExecutionBackendCloseReason,
	ExecutionBackendDetection,
	ExecutionBackendEvent,
	ExecutionBackendLease,
	ExecutionBackendFactory,
	ExecutionBackendRegistrationOptions,
	ExecutionBackendReloadDescriptor,
	ExecutionSurfaceHandle,
	ExecutionSurfaceIdentity,
	ExecutionSurfaceRequest,
	JsonValue,
	ReattachResult,
} from "./types.ts";
export type {
	ExecutionBackendDiagnostic,
	ExecutionBackendSelection,
	ExecutionBackendSelectionResult,
} from "./selection.ts";
