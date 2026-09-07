import * as fs from "node:fs";
import * as path from "node:path";

export const EXECUTION_REPORT_TYPE = "pi-cohort:execution-report:v1";
export const EXECUTION_REPORT_PROTOCOL_VERSION = 1;
export const PI_COHORT_REPORT_CONFIG = "PI_COHORT_REPORT_CONFIG";

export interface ExecutionReportIdentity {
	readonly runId: string;
	readonly childId: string;
	readonly attemptId: string;
}

interface ExecutionReportBase extends ExecutionReportIdentity {
	readonly protocolVersion: typeof EXECUTION_REPORT_PROTOCOL_VERSION;
	readonly kind: "ready" | "settled" | "result" | "control";
	readonly sequence: number;
	readonly timestamp: string;
}

export interface ReadyExecutionReport extends ExecutionReportBase { readonly kind: "ready" }
export interface SettledExecutionReport extends ExecutionReportBase { readonly kind: "settled" }
export interface ResultExecutionReport extends ExecutionReportBase {
	readonly kind: "result";
	readonly outcome: "success" | "failed" | "interrupted";
	readonly finalOutput: string;
	readonly error?: string;
	readonly stopReason?: string;
}
export interface ControlExecutionReport extends ExecutionReportBase {
	readonly kind: "control";
	readonly action: "abort" | "shutdown";
	readonly state: "requested" | "applied";
}
export type ExecutionReport = ReadyExecutionReport | SettledExecutionReport | ResultExecutionReport | ControlExecutionReport;

export interface ReporterConfig extends ExecutionReportIdentity {
	readonly protocolVersion: typeof EXECUTION_REPORT_PROTOCOL_VERSION;
	readonly controlSocketPath: string;
}

interface ReporterConfigFileSystem {
	readonly constants: { readonly O_RDONLY: number; readonly O_NOFOLLOW?: number };
	openSync(path: fs.PathOrFileDescriptor, flags: number): number;
	fstatSync(fd: number): fs.Stats;
	readFileSync(fd: number, encoding: "utf8"): string;
	closeSync(fd: number): void;
	lstatSync?(path: fs.PathLike): fs.Stats;
}

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
	return value;
}
function optionalString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be a string`);
	return value;
}
function sequence(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("sequence must be a positive integer");
	return value as number;
}
function timestamp(value: unknown): string {
	const valueAsString = string(value, "timestamp");
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(valueAsString) || Number.isNaN(Date.parse(valueAsString))) throw new Error("timestamp must be an ISO timestamp");
	return valueAsString;
}
function exactFields(input: Record<string, unknown>, fields: readonly string[], label: string): void {
	const allowed = new Set(fields);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`unexpected ${label} field '${key}'`);
}

export function validateExecutionReport(value: unknown): ExecutionReport {
	const input = object(value, "execution report");
	if (input.protocolVersion !== EXECUTION_REPORT_PROTOCOL_VERSION) throw new Error("incompatible execution report protocol");
	const base = { protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION, runId: string(input.runId, "runId"), childId: string(input.childId, "childId"), attemptId: string(input.attemptId, "attemptId"), sequence: sequence(input.sequence), timestamp: timestamp(input.timestamp) } as const;
	const baseFields = ["protocolVersion", "kind", "runId", "childId", "attemptId", "sequence", "timestamp"];
	switch (input.kind) {
		case "ready": exactFields(input, baseFields, "ready report"); return { ...base, kind: "ready" };
		case "settled": exactFields(input, baseFields, "settled report"); return { ...base, kind: "settled" };
		case "result": {
			exactFields(input, [...baseFields, "outcome", "finalOutput", "error", "stopReason"], "result report");
			if (input.outcome !== "success" && input.outcome !== "failed" && input.outcome !== "interrupted") throw new Error("invalid result outcome");
			return { ...base, kind: "result", outcome: input.outcome, finalOutput: optionalString(input.finalOutput, "finalOutput"), ...(Object.hasOwn(input, "error") ? { error: optionalString(input.error, "error") } : {}), ...(Object.hasOwn(input, "stopReason") ? { stopReason: optionalString(input.stopReason, "stopReason") } : {}) };
		}
		case "control":
			exactFields(input, [...baseFields, "action", "state"], "control report");
			if ((input.action !== "abort" && input.action !== "shutdown") || (input.state !== "requested" && input.state !== "applied")) throw new Error("invalid control report");
			return { ...base, kind: "control", action: input.action, state: input.state };
		default: throw new Error("invalid execution report kind");
	}
}

export function validateReporterConfig(value: unknown): ReporterConfig {
	const input = object(value, "reporter config");
	exactFields(input, ["protocolVersion", "runId", "childId", "attemptId", "controlSocketPath"], "reporter config");
	if (input.protocolVersion !== EXECUTION_REPORT_PROTOCOL_VERSION) throw new Error("incompatible reporter config protocol");
	return {
		protocolVersion: EXECUTION_REPORT_PROTOCOL_VERSION,
		runId: string(input.runId, "runId"),
		childId: string(input.childId, "childId"),
		attemptId: string(input.attemptId, "attemptId"),
		controlSocketPath: string(input.controlSocketPath, "controlSocketPath"),
	};
}

export function loadReporterConfig(configPath = process.env[PI_COHORT_REPORT_CONFIG], fileSystem: ReporterConfigFileSystem = fs, platform = process.platform): ReporterConfig {
	if (!configPath) throw new Error(`${PI_COHORT_REPORT_CONFIG} is required`);
	if (platform === "win32") {
		const link = fileSystem.lstatSync!(configPath);
		if (!link.isFile() || link.isSymbolicLink()) throw new Error("reporter config must be a regular non-symlink file");
	}
	let descriptor: number | undefined;
	try {
		try {
			descriptor = fileSystem.openSync(configPath, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW ?? 0));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error("reporter config must be a regular non-symlink file");
			throw error;
		}
		const details = fileSystem.fstatSync(descriptor);
		if (!details.isFile()) throw new Error("reporter config must be a regular non-symlink file");
		if (platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error("reporter config must be owner-only");
		return validateReporterConfig(JSON.parse(fileSystem.readFileSync(descriptor, "utf8")));
	} finally {
		if (descriptor !== undefined) fileSystem.closeSync(descriptor);
	}
}

export function createExclusiveSessionFile(sessionFile: string): void {
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
	try {
		if (fs.lstatSync(sessionFile).isSymbolicLink()) throw new Error("session file target must not be a symbolic link");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const descriptor = fs.openSync(sessionFile, "wx", 0o600);
	fs.closeSync(descriptor);
}
