import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "./types.ts";
import type {
	DetachedExecutionBackendConfig,
	ExecutionBackend,
	ExecutionBackendRegistration,
	ExecutionBackendReloadDescriptor,
} from "./types.ts";

export type ExecutionBackendReloadErrorCode =
	| "metadata_missing"
	| "module_unavailable"
	| "export_not_public"
	| "factory_invalid"
	| "factory_failed"
	| "identity_mismatch";

export class ExecutionBackendReloadError extends Error {
	readonly code: ExecutionBackendReloadErrorCode;

	constructor(code: ExecutionBackendReloadErrorCode, backend?: unknown) {
		super(`Execution backend reload failed: ${code}${backend === undefined ? "" : ` (${safeBackendLabel(backend)})`}`);
		this.name = "ExecutionBackendReloadError";
		this.code = code;
	}
}

interface PackageMetadata {
	readonly name: string;
	readonly exports: unknown;
}

interface ValidatedDescriptor {
	readonly descriptor: ExecutionBackendReloadDescriptor;
	readonly packageName: string;
}

const detachedRegistrationFailures = Symbol("detached-execution-backend-registration-failures");
type DecodedDetachedExecutionBackendConfig = DetachedExecutionBackendConfig & {
	readonly [detachedRegistrationFailures]?: ReadonlyMap<string, ExecutionBackendReloadError>;
};

function safeBackendLabel(value: unknown): string {
	const label = typeof value === "string" ? value : "unknown";
	const safe = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
	return safe === "" ? "unknown" : safe;
}

function failure(code: ExecutionBackendReloadErrorCode, backend?: unknown): ExecutionBackendReloadError {
	return new ExecutionBackendReloadError(code, backend);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyDescriptorFields(value: Record<string, unknown>): boolean {
	const fields = Object.keys(value).sort();
	return fields.length === 4
		&& fields[0] === "factoryExport"
		&& fields[1] === "packageJsonUrl"
		&& fields[2] === "protocolVersion"
		&& fields[3] === "publicSubpath"
		&& Object.getOwnPropertySymbols(value).length === 0;
}

function isPublicSubpath(value: unknown): value is "." | `./${string}` {
	if (value === ".") return true;
	if (typeof value !== "string" || !value.startsWith("./") || value.includes("*") || value.includes("\\")) return false;
	const segments = value.slice(2).split("/");
	return segments.length > 0 && segments.every(segment => segment !== "" && segment !== "." && segment !== "..");
}

function isFactoryExport(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function hasExportTarget(value: unknown): boolean {
	if (typeof value === "string") return value.startsWith("./");
	if (Array.isArray(value)) return value.some(hasExportTarget);
	return isRecord(value) && Object.values(value).some(hasExportTarget);
}

function hasExplicitPublicExport(packageExports: unknown, publicSubpath: "." | `./${string}`): boolean {
	if (publicSubpath === ".") {
		if (typeof packageExports === "string" || Array.isArray(packageExports)) return hasExportTarget(packageExports);
		if (!isRecord(packageExports)) return false;
		if (Object.hasOwn(packageExports, ".")) return hasExportTarget(packageExports["."]);
		return !Object.keys(packageExports).some(key => key.startsWith(".")) && hasExportTarget(packageExports);
	}
	return isRecord(packageExports)
		&& Object.hasOwn(packageExports, publicSubpath)
		&& hasExportTarget(packageExports[publicSubpath]);
}

function packageJsonPath(value: unknown, backend?: unknown): string {
	if (typeof value !== "string") throw failure("module_unavailable", backend);
	try {
		const url = new URL(value);
		if (url.protocol !== "file:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.hostname !== "" && url.hostname !== "localhost")) {
			throw failure("module_unavailable", backend);
		}
		const candidate = fileURLToPath(url);
		if (!path.isAbsolute(candidate) || path.basename(candidate) !== "package.json") {
			throw failure("module_unavailable", backend);
		}
		const canonical = fs.realpathSync(candidate);
		if (!fs.statSync(canonical).isFile()) throw failure("module_unavailable", backend);
		return canonical;
	} catch (error) {
		if (error instanceof ExecutionBackendReloadError) throw error;
		throw failure("module_unavailable", backend);
	}
}

function readPackageMetadata(packagePath: string, backend?: unknown): PackageMetadata {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
		if (!isRecord(parsed) || typeof parsed.name !== "string" || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(parsed.name)) {
			throw failure("module_unavailable", backend);
		}
		return { name: parsed.name, exports: parsed.exports };
	} catch (error) {
		if (error instanceof ExecutionBackendReloadError) throw error;
		throw failure("module_unavailable", backend);
	}
}

function inspectDescriptor(value: unknown, backend?: unknown): ValidatedDescriptor {
	if (!isRecord(value) || !hasOnlyDescriptorFields(value)
		|| value.protocolVersion !== EXECUTION_BACKEND_PROTOCOL_VERSION
		|| !isPublicSubpath(value.publicSubpath)
		|| !isFactoryExport(value.factoryExport)) {
		throw failure("module_unavailable", backend);
	}
	const packagePath = packageJsonPath(value.packageJsonUrl, backend);
	const packageMetadata = readPackageMetadata(packagePath, backend);
	if (!hasExplicitPublicExport(packageMetadata.exports, value.publicSubpath)) {
		throw failure("export_not_public", backend);
	}
	return {
		packageName: packageMetadata.name,
		descriptor: Object.freeze({
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
			packageJsonUrl: pathToFileURL(packagePath).href,
			publicSubpath: value.publicSubpath,
			factoryExport: value.factoryExport,
		}),
	};
}

export function validateExecutionBackendReloadDescriptor(
	value: unknown,
	backend?: unknown,
): ExecutionBackendReloadDescriptor {
	return inspectDescriptor(value, backend).descriptor;
}

function assertFactoryBackend(value: unknown, expectedName: string): asserts value is ExecutionBackend {
	if (!isRecord(value)) throw failure("factory_invalid", expectedName);
	try {
		if (typeof value.name !== "string" || typeof value.protocolVersion !== "number") {
			throw failure("factory_invalid", expectedName);
		}
		if (value.name !== expectedName || value.protocolVersion !== EXECUTION_BACKEND_PROTOCOL_VERSION) {
			throw failure("identity_mismatch", expectedName);
		}
		for (const method of ["detect", "launch", "reattach", "close"] as const) {
			if (typeof value[method] !== "function") throw failure("factory_invalid", expectedName);
		}
	} catch (error) {
		if (error instanceof ExecutionBackendReloadError) throw error;
		throw failure("factory_invalid", expectedName);
	}
}

export async function reloadExecutionBackend(
	expectedName: string,
	descriptor: ExecutionBackendReloadDescriptor,
): Promise<ExecutionBackend> {
	const inspected = inspectDescriptor(descriptor, expectedName);
	const selfReference = inspected.packageName + (inspected.descriptor.publicSubpath === "." ? "" : inspected.descriptor.publicSubpath.slice(1));
	const jiti = createJiti(inspected.descriptor.packageJsonUrl);
	let resolved: string;
	try {
		resolved = jiti.esmResolve(selfReference, {
			parentURL: inspected.descriptor.packageJsonUrl,
			conditions: ["node", "import"],
		});
	} catch {
		throw failure("module_unavailable", expectedName);
	}
	let module: unknown;
	try {
		module = await jiti.import(resolved);
	} catch {
		throw failure("module_unavailable", expectedName);
	}
	let factory: unknown;
	try {
		factory = isRecord(module) ? module[inspected.descriptor.factoryExport] : undefined;
	} catch {
		throw failure("factory_invalid", expectedName);
	}
	if (typeof factory !== "function") throw failure("factory_invalid", expectedName);
	let backend: unknown;
	try {
		backend = await factory();
	} catch {
		throw failure("factory_failed", expectedName);
	}
	assertFactoryBackend(backend, expectedName);
	return backend;
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === fields.length
		&& actual.every((field, index) => field === fields[index])
		&& Object.getOwnPropertySymbols(value).length === 0;
}

/** Validates the allowlisted metadata transferred to a detached coordinator. */
export function decodeDetachedExecutionBackendConfig(value: unknown): DetachedExecutionBackendConfig {
	if (value === undefined) {
		return Object.freeze({
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
			registrations: Object.freeze([]),
		});
	}
	if (!isRecord(value)
		|| !hasOnlyFields(value, Object.hasOwn(value, "userPreference")
			? ["protocolVersion", "registrations", "userPreference"]
			: ["protocolVersion", "registrations"])
		|| value.protocolVersion !== EXECUTION_BACKEND_PROTOCOL_VERSION
		|| !Array.isArray(value.registrations)
		|| (value.userPreference !== undefined && typeof value.userPreference !== "string")) {
		throw failure("module_unavailable");
	}
	const names = new Set<string>();
	const failures = new Map<string, ExecutionBackendReloadError>();
	const registrations = value.registrations.map((entry): ExecutionBackendRegistration => {
		if (!isRecord(entry)
			|| !hasOnlyFields(entry, Object.hasOwn(entry, "reload") ? ["name", "reload"] : ["name"])
			|| typeof entry.name !== "string"
			|| entry.name.trim() === ""
			|| names.has(entry.name)) {
			throw failure("module_unavailable");
		}
		names.add(entry.name);
		if (entry.reload === undefined) return Object.freeze({ name: entry.name });
		try {
			return Object.freeze({ name: entry.name, reload: validateExecutionBackendReloadDescriptor(entry.reload, entry.name) });
		} catch (error) {
			if (error instanceof ExecutionBackendReloadError) {
				failures.set(entry.name, error);
				return Object.freeze({ name: entry.name });
			}
			throw error;
		}
	});
	const decoded: DecodedDetachedExecutionBackendConfig = {
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		...(value.userPreference === undefined ? {} : { userPreference: value.userPreference }),
		registrations: Object.freeze(registrations),
	};
	Object.defineProperty(decoded, detachedRegistrationFailures, { value: failures });
	return Object.freeze(decoded);
}

export interface DetachedExecutionBackendCoordinator {
	prepare(preference: string): Promise<void>;
}

interface ReloadOutcome {
	readonly backend?: ExecutionBackend;
	readonly error?: ExecutionBackendReloadError;
}

export function createDetachedExecutionBackendCoordinator(
	config: DetachedExecutionBackendConfig,
): DetachedExecutionBackendCoordinator {
	const outcomes = new Map<string, ReloadOutcome>();
	const decodedFailures = (config as DecodedDetachedExecutionBackendConfig)[detachedRegistrationFailures];
	let preparation: Promise<void> | undefined;
	const loadAll = (): Promise<void> => (preparation ??= (async () => {
		for (const registration of config.registrations) {
			let outcome: ReloadOutcome;
			const decodedFailure = decodedFailures?.get(registration.name);
			if (decodedFailure) {
				outcome = { error: decodedFailure };
			} else if (!registration.reload) {
				outcome = { error: failure("metadata_missing", registration.name) };
			} else {
				try {
					const backend = await reloadExecutionBackend(registration.name, registration.reload);
					const { registerExecutionBackend } = await import("./registry.ts");
					registerExecutionBackend(backend, { reload: registration.reload });
					outcome = { backend };
				} catch (error) {
					outcome = { error: error instanceof ExecutionBackendReloadError
						? error
						: failure("factory_invalid", registration.name) };
				}
			}
			outcomes.set(registration.name, outcome);
		}
	})());
	return {
		async prepare(preference: string): Promise<void> {
			await loadAll();
			if (preference === "auto") {
				const failed = config.registrations
					.map(registration => outcomes.get(registration.name)?.error)
					.find((error): error is ExecutionBackendReloadError => error !== undefined);
				if (failed) throw failed;
				return;
			}
			const outcome = outcomes.get(preference);
			if (outcome?.error) throw outcome.error;
		},
	};
}

export async function reconstructExecutionBackends(
	registrations: readonly ExecutionBackendRegistration[],
): Promise<readonly ExecutionBackend[]> {
	const reconstructed: ExecutionBackend[] = [];
	const disposers: Array<() => void> = [];
	try {
		for (const registration of registrations) {
			const name = isRecord(registration) && typeof registration.name === "string" ? registration.name : undefined;
			if (!name || !registration.reload) throw failure("metadata_missing", name);
			const backend = await reloadExecutionBackend(name, registration.reload);
			try {
				const { registerExecutionBackend } = await import("./registry.ts");
				disposers.push(registerExecutionBackend(backend, { reload: registration.reload }));
			} catch {
				throw failure("factory_invalid", name);
			}
			reconstructed.push(backend);
		}
		return Object.freeze(reconstructed);
	} catch (error) {
		for (const dispose of disposers.reverse()) dispose();
		throw error;
	}
}
