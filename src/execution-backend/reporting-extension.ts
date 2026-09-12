import * as net from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFinalOutput } from "../shared/utils.ts";
import { ControlFrameDecoder, type ControlRequest } from "./control-protocol.ts";
import { EXECUTION_REPORT_TYPE, validateExecutionReport, loadReporterConfig, type ExecutionReport, type ReporterConfig } from "./reporting-protocol.ts";
import { assertNoMalformedStandardMessage, isAssistantMessage, isStandardMessage } from "./session-replay.ts";

type ReporterContext = Pick<ExtensionContext, "sessionManager" | "abort" | "shutdown">;
type ReporterAPI = Pick<ExtensionAPI, "on" | "appendEntry">;

export interface ReportingControlSocket {
	on(event: "data", listener: (data: Buffer) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: () => void): this;
	destroy(): this;
}

export interface ExecutionReportingDependencies {
	createConnection(path: string): ReportingControlSocket;
}

const defaultDependencies: ExecutionReportingDependencies = {
	createConnection: (socketPath) => net.createConnection(socketPath),
};

function reports(context: ReporterContext, config: ReporterConfig): readonly ExecutionReport[] {
	return context.sessionManager.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === EXECUTION_REPORT_TYPE)
		.map((entry) => validateExecutionReport(entry.data))
		.filter((report) => report.runId === config.runId && report.childId === config.childId && report.attemptId === config.attemptId);
}

function append(
	pi: ReporterAPI,
	context: ReporterContext,
	config: ReporterConfig,
	report: Omit<ExecutionReport, "protocolVersion" | "runId" | "childId" | "attemptId" | "sequence" | "timestamp">,
): void {
	const identity = {
		protocolVersion: config.protocolVersion,
		runId: config.runId,
		childId: config.childId,
		attemptId: config.attemptId,
	};
	pi.appendEntry(EXECUTION_REPORT_TYPE, {
		...identity,
		...report,
		sequence: reports(context, config).length + 1,
		timestamp: new Date().toISOString(),
	} as ExecutionReport);
}

function result(messages: readonly AgentMessage[]): Omit<ExecutionReport, "protocolVersion" | "runId" | "childId" | "attemptId" | "sequence" | "timestamp"> {
	messages.forEach(assertNoMalformedStandardMessage);
	const standardMessages = messages.filter(isStandardMessage);
	const finalAssistant = [...standardMessages].reverse().find(isAssistantMessage);
	if (!finalAssistant) return { kind: "result", outcome: "failed", finalOutput: "", error: "result_missing" };
	const interrupted = finalAssistant.stopReason === "aborted";
	const failed = !interrupted && (finalAssistant.stopReason === "error" || typeof finalAssistant.errorMessage === "string");
	return {
		kind: "result",
		outcome: interrupted ? "interrupted" : failed ? "failed" : "success",
		finalOutput: getFinalOutput(standardMessages),
		...(failed && finalAssistant.errorMessage ? { error: finalAssistant.errorMessage } : {}),
		...(finalAssistant.stopReason ? { stopReason: finalAssistant.stopReason } : {}),
	};
}

function correlated(request: ControlRequest, config: ReporterConfig): boolean {
	return request.runId === config.runId &&
		request.childId === config.childId &&
		request.attemptId === config.attemptId;
}

function applyControl(
	pi: ReporterAPI,
	context: ReporterContext,
	config: ReporterConfig,
	request: ControlRequest,
	appliedRequestIds: Set<string>,
): void {
	if (!correlated(request, config)) throw new Error("cross-correlated control request");
	if (appliedRequestIds.has(request.requestId)) return;
	appliedRequestIds.add(request.requestId);
	append(pi, context, config, { kind: "control", action: request.action, state: "requested" });
	if (request.action === "abort") {
		context.abort();
		append(pi, context, config, { kind: "control", action: request.action, state: "applied" });
		return;
	}
	append(pi, context, config, { kind: "control", action: request.action, state: "applied" });
	queueMicrotask(() => context.shutdown());
}

export function createExecutionReportingExtension(
	config: ReporterConfig,
	dependencies: ExecutionReportingDependencies = defaultDependencies,
): (pi: ReporterAPI) => void {
	return (pi) => {
		let controlSocket: ReportingControlSocket | undefined;
		const appliedRequestIds = new Set<string>();

		pi.on("session_start", (_event, context) => {
			if (!context.sessionManager.getSessionFile()) throw new Error("Execution reporting requires a persisted session.");
			if (!reports(context, config).some((report) => report.kind === "ready")) {
				append(pi, context, config, { kind: "ready" });
			}
			if (controlSocket) return;
			try {
				const socket = dependencies.createConnection(config.controlSocketPath);
				controlSocket = socket;
				const decoder = new ControlFrameDecoder();
				socket.on("data", (data) => {
					try {
						for (const request of decoder.feed(data)) {
							applyControl(pi, context, config, request, appliedRequestIds);
						}
					} catch {
						socket.destroy();
					}
				});
				socket.on("error", () => {});
				socket.on("close", () => {
					if (controlSocket === socket) controlSocket = undefined;
				});
			} catch {
				controlSocket = undefined;
			}
		});

		pi.on("agent_settled", (_event, context) => {
			const existing = reports(context, config);
			if (existing.some((report) => report.kind === "result")) return;
			if (!existing.some((report) => report.kind === "settled")) append(pi, context, config, { kind: "settled" });
			const messages = context.sessionManager.getBranch().flatMap((entry) => entry.type === "message" ? [entry.message] : []);
			append(pi, context, config, result(messages));
		});
	};
}

export default function executionReportingExtension(pi: ReporterAPI): void {
	createExecutionReportingExtension(loadReporterConfig())(pi);
}
