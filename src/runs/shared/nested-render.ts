import { hasLiveNestedDescendants } from "./nested-events.ts";
import { budgetLines, detailLine, nestedRunName, stopId, targetLine, type RenderLine } from "../../tui/render-helpers.ts";
import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import type { ActivityState, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";

export interface NestedRunCounts {
	total: number;
	running: number;
	paused: number;
	complete: number;
	failed: number;
	queued: number;
}

export function countNestedRuns(children: NestedRunSummary[] | undefined): NestedRunCounts {
	const counts: NestedRunCounts = { total: 0, running: 0, paused: 0, complete: 0, failed: 0, queued: 0 };
	for (const child of children ?? []) {
		counts.total++;
		counts[child.state]++;
		const nested = countNestedRuns([...(child.children ?? []), ...(child.steps?.flatMap((step) => step.children ?? []) ?? [])]);
		counts.total += nested.total;
		counts.running += nested.running;
		counts.paused += nested.paused;
		counts.complete += nested.complete;
		counts.failed += nested.failed;
		counts.queued += nested.queued;
	}
	return counts;
}

export function formatNestedAggregate(children: NestedRunSummary[] | undefined): string | undefined {
	const counts = countNestedRuns(children);
	if (counts.total === 0) return undefined;
	const parts = [
		counts.running > 0 ? `${counts.running} running` : "",
		counts.paused > 0 ? `${counts.paused} paused` : "",
		counts.failed > 0 ? `${counts.failed} failed` : "",
		counts.complete > 0 ? `${counts.complete} complete` : "",
		counts.queued > 0 ? `${counts.queued} queued` : "",
	].filter(Boolean);
	return `+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function formatNestedActivity(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: NestedRunSummary["totalTokens"];
}): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.totalTokens) facts.push(`${formatTokens(input.totalTokens.total)} tok`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState as ActivityState | undefined);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

function formatNestedRunLines(children: NestedRunSummary[] | undefined, options: { indent: string; maxDepth: number; maxLines: number; commandHints?: boolean }): string[] {
	const lines: RenderLine[] = [];
	const append = (items: NestedRunSummary[] | undefined, depth: number, indent: string): void => {
		if (!items?.length) return;
		const aggregate = formatNestedAggregate(depth > options.maxDepth ? items.filter((child) => !hasLiveNestedDescendants([child])) : []);
		if (aggregate) lines.push(detailLine(`${indent}↳ ${aggregate}`));
		for (const child of items) {
			if (depth > options.maxDepth && !hasLiveNestedDescendants([child])) continue;
			const activity = child.state === "running" ? formatNestedActivity(child) : undefined;
			const error = child.error ? ` | error: ${child.error}` : "";
			lines.push(targetLine(`${indent}${stopId(child.id)} ↳ ${nestedRunName(child)} ${child.state}${activity ? ` | ${activity}` : ""}${error}`, hasLiveNestedDescendants([child])));
			if (options.commandHints) lines.push(detailLine(`${indent}  Status: subagent({ action: "status", id: "${child.id}" })`));
			for (const [stepIndex, step] of (child.steps ?? []).entries()) {
				if (depth > options.maxDepth && step.status !== "running" && step.status !== "pending" && !hasLiveNestedDescendants(step.children)) continue;
				const stepActivity = step.status === "running" ? formatNestedActivity(step) : undefined;
				lines.push(targetLine(`${indent}  ${stopId(step.id)} ↳ ${stepIndex + 1}. ${step.agent}${step.label ? ` - ${step.label}` : ""} ${step.status}${stepActivity ? ` | ${stepActivity}` : ""}${step.error ? ` | error: ${step.error}` : ""}`, step.status === "running" || step.status === "pending" || hasLiveNestedDescendants(step.children)));
				append(step.children, depth + 1, `${options.indent}${"  ".repeat(Math.min(depth + 2, 3))}`);
			}
			append(child.children, depth + 1, `${options.indent}${"  ".repeat(Math.min(depth + 1, 3))}`);
		}
	};
	append(children, 0, options.indent);
	return budgetLines(lines, options.maxLines).map((line) => line.text);
}

export function formatNestedRunStatusLines(children: NestedRunSummary[] | undefined, options: { indent?: string; maxDepth?: number; maxLines?: number; commandHints?: boolean } = {}): string[] {
	return formatNestedRunLines(children, {
		indent: options.indent ?? "  ",
		maxDepth: options.maxDepth ?? 2,
		maxLines: options.maxLines ?? 40,
		commandHints: options.commandHints ?? false,
	});
}
