import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { EXECUTION_REPORT_TYPE, type ExecutionReport, type ExecutionReportIdentity, validateExecutionReport } from "./reporting-protocol.ts";

export interface ReplayedSession {
	readonly reports: readonly ExecutionReport[];
	readonly controls: readonly (ExecutionReport & { readonly kind: "control" })[];
	/** Messages reconstructed from the terminal branch (only present when `result` is set). */
	readonly messages: readonly SessionMessageEntry["message"][];
	/**
	 * All parsed message entries observed so far, in document order.
	 * Available even before the terminal result arrives.
	 * Used for incremental observation/forwarding of session activity.
	 */
	readonly pendingMessages: readonly SessionMessageEntry["message"][];
	readonly result?: ExecutionReport & { readonly kind: "result" };
	readonly pendingResult: boolean;
	readonly incompleteTrailingLine: boolean;
}
interface SessionEntry { readonly type: string; readonly id?: string; readonly parentId?: string | null; readonly message?: AgentMessage; readonly customType?: string; readonly data?: unknown }
interface ReportedEntry { readonly entry: SessionEntry; readonly report: ExecutionReport }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isContent(value: unknown): boolean {
	return Array.isArray(value) && value.every((part) => isRecord(part) && typeof part.type === "string");
}
function isUsage(value: unknown): boolean {
	return isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => typeof value[key] === "number")
		&& isRecord(value.cost) && ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => typeof value.cost[key] === "number");
}
export function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isRecord(value) && value.role === "assistant" && isContent(value.content)
		&& typeof value.api === "string" && typeof value.provider === "string" && typeof value.model === "string"
		&& isUsage(value.usage) && ["stop", "length", "toolUse", "error", "aborted"].includes(value.stopReason as string)
		&& typeof value.timestamp === "number" && (value.errorMessage === undefined || typeof value.errorMessage === "string");
}
export function isStandardMessage(value: unknown): value is Message {
	if (!isRecord(value) || typeof value.timestamp !== "number") return false;
	if (value.role === "assistant") return isAssistantMessage(value);
	if (value.role === "user") return typeof value.content === "string" || isContent(value.content);
	return value.role === "toolResult" && typeof value.toolCallId === "string" && typeof value.toolName === "string"
		&& isContent(value.content) && typeof value.isError === "boolean";
}
export function assertNoMalformedStandardMessage(value: unknown): void {
	if (isRecord(value) && ["assistant", "user", "toolResult"].includes(value.role as string) && !isStandardMessage(value)) throw new Error("malformed standard session message");
}
function isAgentMessage(value: unknown): value is AgentMessage {
	if (isStandardMessage(value)) return true;
	assertNoMalformedStandardMessage(value);
	if (!isRecord(value) || typeof value.role !== "string") return false;
	if (value.role === "bashExecution") return typeof value.command === "string" && typeof value.output === "string"
		&& (typeof value.exitCode === "number" || value.exitCode === undefined) && typeof value.cancelled === "boolean"
		&& typeof value.truncated === "boolean" && typeof value.timestamp === "number";
	if (value.role === "custom") return typeof value.customType === "string" && (typeof value.content === "string" || isContent(value.content))
		&& typeof value.display === "boolean" && typeof value.timestamp === "number";
	return typeof value.timestamp === "number";
}

function isIdentityMatch(report: ExecutionReport, identity: ExecutionReportIdentity): boolean {
	return report.runId === identity.runId && report.childId === identity.childId && report.attemptId === identity.attemptId;
}
function hasClaimedStream(report: ExecutionReport, identity: ExecutionReportIdentity): boolean {
	return report.attemptId === identity.attemptId && (report.runId === identity.runId || report.childId === identity.childId);
}
function parseEntry(line: string): SessionEntry {
	try {
		const entry: unknown = JSON.parse(line);
		if (!isRecord(entry)) throw new Error();
		if (entry.type === "message" && (typeof entry.id !== "string" || (typeof entry.parentId !== "string" && entry.parentId !== null) || !isAgentMessage(entry.message))) throw new Error("malformed session message entry");
		return entry as SessionEntry;
	} catch (error) {
		if (error instanceof Error && ["malformed session message entry", "malformed standard session message"].includes(error.message)) throw error;
		throw new Error("malformed complete session JSONL line");
	}
}
function entryDataHasOtherAttempt(entry: SessionEntry, identity: ExecutionReportIdentity): boolean {
	return typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data) && "attemptId" in entry.data && (entry.data as { attemptId?: unknown }).attemptId !== identity.attemptId;
}

export function replayExecutionSession(content: string, identity: ExecutionReportIdentity): ReplayedSession {
	const complete = content.endsWith("\n");
	const lines = content.split("\n");
	const trailing = complete ? "" : lines.pop() ?? "";
	const completeLines = content.length === 0 ? [] : complete ? lines.slice(0, -1) : lines;
	const entries = completeLines.map((line) => {
		if (line.length === 0) throw new Error("blank complete session JSONL line");
		return parseEntry(line);
	});
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id !== "string") continue;
		if (byId.has(entry.id)) throw new Error("duplicate session entry identifier");
		byId.set(entry.id, entry);
	}
	const reportedEntries: ReportedEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== EXECUTION_REPORT_TYPE || entryDataHasOtherAttempt(entry, identity)) continue;
		const report = validateExecutionReport(entry.data);
		if (!isIdentityMatch(report, identity)) {
			if (hasClaimedStream(report, identity)) throw new Error("execution report correlation mismatch");
			continue;
		}
		reportedEntries.push({ entry, report });
	}
	let expected = 1;
	let ready = false;
	let settled = false;
	let result: (ExecutionReport & { kind: "result" }) | undefined;
	let resultEntry: SessionEntry | undefined;
	for (const { entry, report } of reportedEntries) {
		if (report.sequence !== expected++) throw new Error("execution report sequence gap or duplicate");
		if (report.kind === "control") continue;
		if (report.kind === "ready") {
			if (ready || settled || result) throw new Error("ready report out of order");
			ready = true;
			continue;
		}
		if (report.kind === "settled") {
			if (!ready || settled || result) throw new Error("settled report out of order");
			settled = true;
			continue;
		}
		if (!ready || !settled || result) throw new Error("result report out of order");
		result = report;
		resultEntry = entry;
	}
	const messages = result && resultEntry ? reconstructBranch(byId, resultEntry) : [];
	const pendingMessages = entries
		.filter((e): e is SessionEntry & { message: NonNullable<SessionEntry["message"]> } => e.type === "message" && e.message !== undefined)
		.map((e) => e.message);
	const reports = reportedEntries.map(({ report }) => report);
	const controls = reports.filter((report): report is ExecutionReport & { kind: "control" } => report.kind === "control");
	return { reports, controls, messages, pendingMessages, result, pendingResult: settled && !result, incompleteTrailingLine: trailing.length > 0 };
}

function reconstructBranch(byId: ReadonlyMap<string, SessionEntry>, result: SessionEntry): readonly SessionMessageEntry["message"][] {
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let entry = result;
	while (true) {
		const parentId = entry.parentId;
		if (parentId === null) break;
		if (typeof parentId !== "string") throw new Error("missing or non-string parent link for terminal branch reconstruction");
		if (seen.has(parentId)) throw new Error("parent cycle in terminal branch reconstruction");
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) throw new Error("missing parent link for terminal branch reconstruction");
		path.push(parent);
		entry = parent;
	}
	path.reverse();
	return path.filter((entry): entry is SessionEntry & { message: AgentMessage } => entry.type === "message" && entry.message !== undefined).map((entry) => entry.message);
}
