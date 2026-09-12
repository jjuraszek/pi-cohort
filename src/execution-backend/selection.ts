import { executionBackends } from "./registry.ts";
import type { ExecutionBackend, ExecutionBackendDetection } from "./types.ts";

export type ExecutionBackendSelection =
	| { readonly kind: "native" }
	| { readonly kind: "external"; readonly backend: ExecutionBackend; readonly detection: ExecutionBackendDetection };

export interface ExecutionBackendDiagnostic {
	readonly backend: string;
	readonly reason: "unavailable" | "detection_error";
}

export interface ExecutionBackendSelectionResult {
	readonly selection: ExecutionBackendSelection;
	readonly diagnostics: readonly ExecutionBackendDiagnostic[];
}

/** @internal Supplies detached-process registrations before backend detection. */
export interface ExecutionBackendPreparation {
	prepare(preference: string): Promise<void>;
}

export async function selectExecutionBackend(
	preference: unknown = "auto",
	preparation?: ExecutionBackendPreparation,
): Promise<ExecutionBackendSelectionResult> {
	if (typeof preference !== "string") {
		throw new Error("Execution backend preference must be a string");
	}

	const normalized = preference.trim();

	if (normalized === "") {
		throw new Error("Execution backend preference must not be blank; use 'auto', 'native', or a registered backend name");
	}

	if (normalized === "native") {
		return { selection: { kind: "native" }, diagnostics: [] };
	}

	await preparation?.prepare(normalized);
	const registered = executionBackends();
	const diagnostics: ExecutionBackendDiagnostic[] = [];

	if (normalized === "auto") {
		for (const backend of registered) {
			let detection: ExecutionBackendDetection;
			try {
				detection = await backend.detect();
			} catch {
				diagnostics.push({
					backend: backend.name,
					reason: "detection_error",
				});
				continue;
			}

			if (detection.available) {
				return { selection: { kind: "external", backend, detection }, diagnostics };
			}

			diagnostics.push({
				backend: backend.name,
				reason: "unavailable",
			});
		}
		return { selection: { kind: "native" }, diagnostics };
	}

	const backend = registered.find((b) => b.name === normalized);
	if (!backend) {
		throw new Error(`Execution backend '${normalized}' is not registered`);
	}

	let detection: ExecutionBackendDetection;
	try {
		detection = await backend.detect();
	} catch {
		throw new Error(`Execution backend '${normalized}' failed to detect`);
	}

	if (!detection.available) {
		throw new Error(`Execution backend '${normalized}' is unavailable`);
	}

	return { selection: { kind: "external", backend, detection }, diagnostics };
}
