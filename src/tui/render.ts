/**
 * Rendering functions for subagent results
 */

import * as path from "node:path";
import { budgetLines, detailLine, formatWidgetAgents, nestedRunName, stopId, targetLine, type RenderLine } from "./render-helpers.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	type AgentProgress,
	type AsyncJobState,
	type AsyncStatus,
	type AsyncJobStep,
	type AsyncParallelGroupStatus,
	type Details,
	type NestedRunSummary,
	type NestedStepSummary,
	type WorkflowNodeStatus,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "../shared/types.ts";
import { formatTokens, formatUsage, formatDuration, formatModelThinking, formatToolCall, shortenPath } from "../shared/formatters.ts";
import { getDisplayItems, getSingleResultOutput } from "../shared/utils.ts";
import { flatToLogicalStepIndex } from "../runs/background/parallel-groups.ts";
import { hasLiveNestedDescendants, type NestedRegistry } from "../runs/shared/nested-events.ts";
import { formatNestedAggregate } from "../runs/shared/nested-render.ts";
import { aggregateStepStatus, formatActivityLabel, formatAgentRunningLabel, formatParallelOutcome } from "../shared/status-format.ts";

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 * 
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 * 
 * Uses Intl.Segmenter for proper Unicode/emoji handling (not char-by-char).
 */
function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATIC_RUNNING_GLYPH = "●";

type WidgetJob = AsyncJobState & Pick<AsyncStatus, "workflowGraph">;
type RetainedWidgetRoot = Pick<NestedRegistry, "rootRunId" | "children">;

type ProgressSeedSource = Partial<Pick<AgentProgress, "index" | "toolCount" | "tokens" | "durationMs" | "lastActivityAt" | "currentToolStartedAt" | "turnCount">>;

function runningSeed(...values: Array<number | undefined>): number | undefined {
	let seed: number | undefined;
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) continue;
		seed = (seed ?? 0) + Math.trunc(value);
	}
	return seed;
}

function runningGlyph(seed?: number): string {
	if (seed === undefined) return STATIC_RUNNING_GLYPH;
	return RUNNING_FRAMES[Math.abs(seed) % RUNNING_FRAMES.length]!;
}

function progressRunningSeed(progress: ProgressSeedSource | undefined): number | undefined {
	if (!progress) return undefined;
	return runningSeed(
		progress.index,
		progress.toolCount,
		progress.tokens,
		progress.durationMs,
		progress.lastActivityAt,
		progress.currentToolStartedAt,
		progress.turnCount,
	);
}

interface LegacyResultAnimationContext {
	state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> };
}

export function clearLegacyResultAnimationTimer(context: LegacyResultAnimationContext): void {
	const timer = context.state.subagentResultAnimationTimer;
	if (!timer) return;
	clearInterval(timer);
	context.state.subagentResultAnimationTimer = undefined;
}

function extractOutputTarget(task: string): string | undefined {
	const writeToMatch = task.match(/\[Write to:\s*([^\]\n]+)\]/i);
	if (writeToMatch?.[1]?.trim()) return writeToMatch[1].trim();
	const findingsMatch = task.match(/Write your findings to:\s*(\S+)/i);
	if (findingsMatch?.[1]?.trim()) return findingsMatch[1].trim();
	const outputMatch = task.match(/[Oo]utput(?:\s+to)?\s*:\s*(\S+)/i);
	if (outputMatch?.[1]?.trim()) return outputMatch[1].trim();
	return undefined;
}

function hasEmptyTextOutputWithoutOutputTarget(task: string, output: string): boolean {
	if (output.trim()) return false;
	return !extractOutputTarget(task);
}

function getToolCallLines(
	result: Pick<Details["results"][number], "messages" | "toolCalls">,
	expanded: boolean,
): string[] {
	if (result.messages) {
		return getDisplayItems(result.messages)
			.filter((item): item is { type: "tool"; name: string; args: Record<string, unknown> } => item.type === "tool")
			.map((item) => formatToolCall(item.name, item.args, expanded));
	}
	return result.toolCalls?.map((toolCall) => expanded ? toolCall.expandedText : toolCall.text) ?? [];
}


function snapshotNowForProgress(progress: Pick<AgentProgress, "currentToolStartedAt" | "durationMs" | "lastActivityAt">): number | undefined {
	if (progress.currentToolStartedAt !== undefined && progress.durationMs !== undefined) return progress.currentToolStartedAt + progress.durationMs;
	return progress.lastActivityAt;
}

function formatCurrentToolLine(
	progress: Pick<AgentProgress, "currentTool" | "currentToolArgs" | "currentToolStartedAt">,
	availableWidth: number,
	expanded: boolean,
	snapshotNow?: number,
): string | undefined {
	if (!progress.currentTool) return undefined;
	const maxToolArgsLen = Math.max(50, availableWidth - 20);
	const toolArgsPreview = progress.currentToolArgs
		? (expanded || progress.currentToolArgs.length <= maxToolArgsLen
			? progress.currentToolArgs
			: `${progress.currentToolArgs.slice(0, maxToolArgsLen)}...`)
		: "";
	const durationSuffix = progress.currentToolStartedAt !== undefined && snapshotNow !== undefined
		? ` | ${formatDuration(Math.max(0, snapshotNow - progress.currentToolStartedAt))}`
		: "";
	return toolArgsPreview
		? `${progress.currentTool}: ${toolArgsPreview}${durationSuffix}`
		: `${progress.currentTool}${durationSuffix}`;
}

function buildLiveStatusLine(progress: Pick<AgentProgress, "activityState" | "lastActivityAt">, snapshotNow?: number): string | undefined {
	if (progress.lastActivityAt !== undefined && snapshotNow !== undefined) return formatActivityLabel(progress.lastActivityAt, progress.activityState, snapshotNow);
	if (progress.activityState === "needs_attention") return "needs attention";
	if (progress.activityState === "active_long_running") return "active but long-running";
	if (progress.lastActivityAt !== undefined) return "active";
	return undefined;
}

function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function statJoin(theme: Theme, parts: string[]): string {
	return parts.filter(Boolean).map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `);
}

function formatTokenStat(tokens: number): string {
	return `${formatTokens(tokens)} token`;
}

function formatToolUseStat(count: number): string {
	return `${count} tool use${count === 1 ? "" : "s"}`;
}

function formatProgressStats(theme: Theme, progress: Pick<AgentProgress, "toolCount" | "tokens" | "durationMs"> | undefined, includeDuration = true): string {
	if (!progress) return "";
	const parts: string[] = [];
	if (progress.toolCount > 0) parts.push(formatToolUseStat(progress.toolCount));
	if (progress.tokens > 0) parts.push(formatTokenStat(progress.tokens));
	if (includeDuration && progress.durationMs > 0) parts.push(formatDuration(progress.durationMs));
	return statJoin(theme, parts);
}

function firstOutputLine(text: string): string {
	return text.split("\n").find((line) => line.trim())?.trim() ?? "";
}

function resultStatusLine(result: Details["results"][number], output: string): string {
	if (result.interrupted) return "Paused";
	if (result.exitCode !== 0) return `Error: ${result.error ?? (firstOutputLine(output) || `exit ${result.exitCode}`)}`;
	if (result.acceptance?.status && result.acceptance.status !== "not-required") return `Done · acceptance: ${result.acceptance.status}`;
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return "Done (no text output)";
	return "Done";
}

function resultGlyph(result: Details["results"][number], output: string, theme: Theme, running = result.progress?.status === "running", seed = progressRunningSeed(result.progress ?? result.progressSummary)): string {
	if (running) return theme.fg("accent", runningGlyph(seed));
	if (result.interrupted) return theme.fg("warning", "■");
	if (result.exitCode !== 0) return theme.fg("error", "✗");
	if (hasEmptyTextOutputWithoutOutputTarget(result.task, output)) return theme.fg("warning", "✓");
	return theme.fg("success", "✓");
}

function compactCurrentActivity(progress: AgentProgress): string {
	const snapshotNow = snapshotNowForProgress(progress);
	return formatCurrentToolLine(progress, getTermWidth() - 4, false, snapshotNow) ?? buildLiveStatusLine(progress, snapshotNow) ?? "thinking…";
}

export function widgetRenderKey(job: WidgetJob): string {
	return JSON.stringify({
		asyncDir: job.asyncDir,
		workflowGraph: job.workflowGraph,
		status: job.status,
		activityState: job.activityState,
		lastActivityAt: job.lastActivityAt,
		currentTool: job.currentTool,
		currentToolStartedAt: job.currentToolStartedAt,
		currentPath: job.currentPath,
		turnCount: job.turnCount,
		toolCount: job.toolCount,
		mode: job.mode,
		agents: job.agents,
		currentStep: job.currentStep,
		chainStepCount: job.chainStepCount,
		parallelGroups: job.parallelGroups,
		steps: job.steps,
		nestedChildren: job.nestedChildren,
		stepsTotal: job.stepsTotal,
		runningSteps: job.runningSteps,
		completedSteps: job.completedSteps,
		activeParallelGroup: job.activeParallelGroup,
		startedAt: job.startedAt,
		updatedAt: job.updatedAt,
		totalTokens: job.totalTokens,
	});
}

export function widgetJobName(job: AsyncJobState): string {
	if (job.mode === "parallel") return "parallel";
	if (job.mode === "chain") return "chain";
	if (job.mode === "single" && job.agents?.length === 1) return job.agents[0]!;
	if (job.agents?.length) return formatWidgetAgents(job.agents);
	return job.mode ?? "subagent";
}

function widgetActivity(job: AsyncJobState): string {
	const facts: string[] = [];
	if (job.currentTool && job.currentToolStartedAt !== undefined && job.updatedAt !== undefined) facts.push(`${job.currentTool} ${formatDuration(Math.max(0, job.updatedAt - job.currentToolStartedAt))}`);
	else if (job.currentTool) facts.push(job.currentTool);
	if (job.currentPath) facts.push(shortenPath(job.currentPath));
	if (job.turnCount !== undefined) facts.push(`${job.turnCount} turns`);
	if (job.toolCount !== undefined) facts.push(`${job.toolCount} tools`);
	const activity = buildLiveStatusLine(job, job.updatedAt);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (job.status === "running") return "thinking…";
	if (job.status === "queued") return "queued…";
	if (job.status === "paused") return "Paused";
	if (job.status === "failed") return "Failed";
	return "Done";
}

function widgetStepRunningSeed(step: NonNullable<AsyncJobState["steps"]>[number], fallbackIndex?: number): number | undefined {
	return runningSeed(
		fallbackIndex,
		step.index,
		step.toolCount,
		step.turnCount,
		step.tokens?.total,
		step.lastActivityAt,
		step.currentToolStartedAt,
		step.durationMs,
	);
}

function widgetStepsRunningSeed(steps: Array<NonNullable<AsyncJobState["steps"]>[number]> | undefined): number | undefined {
	let seed: number | undefined;
	for (const [index, step] of (steps ?? []).entries()) seed = runningSeed(seed, widgetStepRunningSeed(step, index));
	return seed;
}

function widgetJobRunningSeed(job: AsyncJobState): number | undefined {
	return runningSeed(
		job.updatedAt,
		job.lastActivityAt,
		job.toolCount,
		job.turnCount,
		job.totalTokens?.total,
		job.currentStep,
		job.runningSteps,
		job.completedSteps,
		widgetStepsRunningSeed(job.steps),
	);
}

function widgetJobsRunningSeed(jobs: AsyncJobState[]): number | undefined {
	let seed: number | undefined;
	for (const job of jobs) seed = runningSeed(seed, widgetJobRunningSeed(job));
	return seed;
}

function widgetStatusGlyph(job: AsyncJobState, theme: Theme): string {
	if (job.status === "running") return theme.fg("accent", runningGlyph(widgetJobRunningSeed(job)));
	if (job.status === "queued") return theme.fg("muted", "◦");
	if (job.status === "complete") return theme.fg("success", "✓");
	if (job.status === "paused") return theme.fg("warning", "■");
	return theme.fg("error", "✗");
}

function widgetStepGlyph(status: AsyncJobStep["status"], theme: Theme, seed?: number): string {
	if (status === "running") return theme.fg("accent", runningGlyph(seed));
	if (status === "complete" || status === "completed") return theme.fg("success", "✓");
	if (status === "failed") return theme.fg("error", "✗");
	if (status === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function widgetStepStatus(status: AsyncJobStep["status"], theme: Theme): string {
	if (status === "running") return theme.fg("accent", "running");
	if (status === "complete" || status === "completed") return theme.fg("success", "complete");
	if (status === "failed") return theme.fg("error", "failed");
	if (status === "paused") return theme.fg("warning", "paused");
	return theme.fg("dim", status);
}

function widgetChainDetails(job: WidgetJob, theme: Theme, expanded = false, width = getTermWidth()): RenderLine[] {
	if (!job.steps?.length) return [];
	const total = job.chainStepCount ?? job.steps.length;
	const lines: RenderLine[] = [];
	for (const span of buildAsyncChainStepSpans(total, job.steps.length, job.parallelGroups)) {
		const steps = job.steps.slice(span.start, span.start + span.count);
		if (span.isParallel) {
			const status = aggregateStepStatus(steps);
			const label = job.workflowGraph?.nodes.find((node) => node.stepIndex === span.stepIndex)?.label;
			lines.push(detailLine(`  ${widgetStepGlyph(status, theme, widgetStepsRunningSeed(steps))} Parallel group ${span.stepIndex + 1}/${total}${label ? `: ${label}` : ""} ${theme.fg("dim", "·")} ${theme.fg("dim", formatParallelOutcome(steps, span.count))}`));
			for (const [index, step] of steps.entries()) lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Agent", index + 1, span.count, expanded, width));
			continue;
		}
		const step = steps[0];
		if (!step) {
			lines.push(detailLine(`  ${theme.fg("dim", `Workflow step ${span.stepIndex + 1}/${total}: pending`)}`));
			continue;
		}
		lines.push(...foregroundStyleWidgetStepLines(job, theme, step, "Step", span.stepIndex + 1, total, expanded, width));
	}
	return lines;
}

function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
	status?: WorkflowNodeStatus;
	label?: string;
	error?: string;
}

function buildChainStepSpans(details: Pick<Details, "chainAgents" | "workflowGraph">): ChainStepSpan[] {
	if (details.workflowGraph?.nodes?.length) {
		const spans: ChainStepSpan[] = [];
		let flatCursor = 0;
		for (const node of details.workflowGraph.nodes) {
			if (node.stepIndex === undefined) continue;
			if (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") {
				const childFlatIndexes = (node.children ?? [])
					.map((child) => child.flatIndex)
					.filter((value): value is number => typeof value === "number");
				const start = childFlatIndexes.length ? Math.min(...childFlatIndexes) : flatCursor;
				const count = node.children?.length ?? 0;
				spans.push({ stepIndex: node.stepIndex, start, count, isParallel: true, status: node.status, label: node.label, error: node.error });
				flatCursor = Math.max(flatCursor, start + count);
				continue;
			}
			const start = node.flatIndex ?? flatCursor;
			spans.push({ stepIndex: node.stepIndex, start, count: 1, isParallel: false, status: node.status, label: node.label, error: node.error });
			flatCursor = Math.max(flatCursor, start + 1);
		}
		if (spans.length) return spans.sort((left, right) => left.stepIndex - right.stepIndex);
	}

	if (!details.chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < details.chainAgents.length; stepIndex++) {
		const label = details.chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

function isChainParallelGroupActive(details: Pick<Details, "mode" | "chainAgents" | "currentStepIndex" | "workflowGraph">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	return buildChainStepSpans(details).some((span) => span.stepIndex === details.currentStepIndex && span.isParallel);
}

function buildAsyncChainStepSpans(total: number, stepCount: number, parallelGroups: AsyncParallelGroupStatus[] = []): ChainStepSpan[] {
	const spans: ChainStepSpan[] = [];
	let flatIndex = 0;
	for (let stepIndex = 0; stepIndex < total; stepIndex++) {
		const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
		if (group) {
			spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
			flatIndex = Math.max(flatIndex, group.start + group.count);
			continue;
		}
		spans.push({ stepIndex, start: flatIndex, count: flatIndex < stepCount ? 1 : 0, isParallel: false });
		flatIndex++;
	}
	return spans;
}

function isDoneResult(result: Details["results"][number]): boolean {
	const status = result.progress?.status;
	if (status === "completed") return true;
	if (status === "running" || status === "pending") return false;
	if (result.interrupted) return false;
	return result.exitCode === 0;
}

function workflowGraphHasStatus(details: Pick<Details, "workflowGraph">, statuses: WorkflowNodeStatus[]): boolean {
	return details.workflowGraph?.nodes.some((node) => statuses.includes(node.status)) ?? false;
}

interface ChainRenderResultEntry {
	kind: "result";
	resultIndex: number;
	rowNumber: number;
	agentName: string;
}

interface ChainRenderPlaceholderEntry {
	kind: "placeholder";
	rowNumber: number;
	stepLabel: string;
	agentName: string;
	status: WorkflowNodeStatus;
	error?: string;
}

type ChainRenderEntry = ChainRenderResultEntry | ChainRenderPlaceholderEntry | { kind: "group"; stepIndex: number; label: string };

function pendingChildLine(progress: AgentProgress | undefined, label: string, agent: string): string {
	return progress
		? `${stopId(progress.id)} ◦ ${label}: ${progress.agent}${progress.label ? ` - ${progress.label}` : ""} · pending`
		: `Workflow ${label.toLowerCase()}: ${agent} · pending`;
}

function buildChainRenderEntries(details: Details, label: MultiProgressLabel, expanded = false): ChainRenderEntry[] | undefined {
	if (details.mode === "parallel") return Array.from({ length: Math.max(details.results.length, ...(details.progress ?? []).map((entry) => entry.index + 1)) }, (_, index) => ({
		kind: "result", resultIndex: index, rowNumber: index + 1, agentName: details.results[index]?.agent ?? details.progress?.find((entry) => entry.index === index)?.agent ?? "agent",
	}));
	if (details.mode !== "chain" || !label.hasParallelInChain) return undefined;
	const entries: ChainRenderEntry[] = [];
	for (const span of buildChainStepSpans(details)) {
		if (label.showActiveGroupOnly && (span.start < label.groupStartIndex || span.start >= label.groupEndIndex)) {
			const hasLiveChildren = expanded && (
				details.results.slice(span.start, span.start + span.count).some((result) => hasLiveNestedDescendants(result.progress?.children))
				|| details.progress?.some((progress) => progress.index >= span.start && progress.index < span.start + span.count && hasLiveNestedDescendants(progress.children))
			);
			if (!hasLiveChildren) continue;
		}
		if (span.isParallel && span.label && span.count > 0) entries.push({ kind: "group", stepIndex: span.stepIndex, label: span.label });
		if (span.isParallel && span.count === 0) {
			entries.push({
				kind: "placeholder",
				rowNumber: span.stepIndex + 1,
				stepLabel: `Parallel group ${span.stepIndex + 1}`,
				agentName: span.label ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
				status: span.status ?? "pending",
				error: span.error,
			});
			continue;
		}
		for (let index = span.start; index < span.start + span.count; index++) {
			entries.push({
				kind: "result",
				resultIndex: index,
				rowNumber: index + 1,
				agentName: details.results[index]?.agent ?? details.chainAgents?.[span.stepIndex] ?? `step-${span.stepIndex + 1}`,
			});
		}
	}
	return entries;
}

interface MultiProgressLabel {
	headerLabel: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	activeParallelGroup: boolean;
	groupStartIndex: number;
	groupEndIndex: number;
	showActiveGroupOnly: boolean;
}

function buildMultiProgressLabel(details: Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents" | "workflowGraph">, hasRunning: boolean): MultiProgressLabel {
	const stepSpans = buildChainStepSpans(details);
	const hasParallelInChain = details.mode === "chain" && stepSpans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed">;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray = details.progress?.find((progress) => progress.index === i)
				|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			const status = result.progress?.status
				?? (result.interrupted
					? "paused"
					: result.exitCode === 0
						? "completed"
						: "failed");
			statuses[index] = status;
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const headerLabel = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: totalCount, showActiveGroupOnly: false };
	}

	if (activeParallelGroup) {
		const currentStepIndex = details.currentStepIndex!;
		const span = stepSpans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let running = 0;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "running") {
				running++;
				continue;
			}
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
		const headerLabel = hasRunning
			? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
			: `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
		return { headerLabel, itemTitle, totalCount: groupSize, hasParallelInChain, activeParallelGroup, groupStartIndex: groupStart, groupEndIndex: groupEnd, showActiveGroupOnly: true };
	}

	if (details.mode === "chain" && details.chainAgents?.length) {
		const totalCount = details.totalSteps ?? details.chainAgents.length;
		const doneLogical = stepSpans.filter((span) => {
			if (span.status && span.status !== "completed") return false;
			if (span.count === 0) return span.status === "completed";
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending" || progressEntry?.status === "failed") return false;
				if (!resultEntry || !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
		const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
		return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const headerLabel = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { headerLabel, itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStartIndex: 0, groupEndIndex: details.results.length, showActiveGroupOnly: false };
}

function resultRowLabel(details: Pick<Details, "mode" | "chainAgents" | "workflowGraph">, label: MultiProgressLabel, resultIndex: number, stepNumber: number): string {
	if (details.mode === "chain" && label.hasParallelInChain) {
		const span = buildChainStepSpans(details).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
		if (span?.isParallel) return `Agent ${resultIndex - span.start + 1}/${span.count}`;
		if (span) return `Step ${span.stepIndex + 1}`;
	}
	if (label.itemTitle === "Agent") {
		const localStepNumber = label.activeParallelGroup
			? Math.max(1, stepNumber - label.groupStartIndex)
			: stepNumber;
		return `Agent ${localStepNumber}/${label.totalCount}`;
	}
	return `Step ${stepNumber}`;
}

function widgetStats(job: AsyncJobState, theme: Theme): string {
	const parts: string[] = [];
	const stepsTotal = job.stepsTotal ?? (job.agents?.length ?? 1);
	if (job.activeParallelGroup) {
		const running = job.runningSteps ?? (job.status === "running" ? 1 : 0);
		const done = job.completedSteps ?? (job.status === "complete" ? stepsTotal : 0);
		if (job.mode === "parallel") {
			if (job.status === "running" && running > 0) parts.push(formatAgentRunningLabel(running));
			if (stepsTotal > 0) parts.push(`${done}/${stepsTotal} done`);
		} else {
			const activeGroup = job.currentStep !== undefined
				? job.parallelGroups?.find((group) => job.currentStep! >= group.start && job.currentStep! < group.start + group.count)
				: job.parallelGroups?.find((group) => group.start === 0);
			const logicalStep = activeGroup?.stepIndex ?? job.currentStep ?? 0;
			const total = job.chainStepCount ?? stepsTotal;
			const groupParts = [`${done}/${stepsTotal} done`];
			if (job.status === "running" && running > 0) groupParts.unshift(formatAgentRunningLabel(running));
			parts.push(`step ${logicalStep + 1}/${total} · parallel group: ${groupParts.join(" · ")}`);
		}
	} else if (job.currentStep !== undefined) {
		if (job.mode === "chain" && job.parallelGroups?.length) {
			const total = job.chainStepCount ?? stepsTotal;
			parts.push(`step ${flatToLogicalStepIndex(job.currentStep, total, job.parallelGroups) + 1}/${total}`);
		} else {
			parts.push(`step ${job.currentStep + 1}/${stepsTotal}`);
		}
	} else if (stepsTotal > 1) {
		parts.push(`steps ${stepsTotal}`);
	}
	if (job.toolCount !== undefined) parts.push(formatToolUseStat(job.toolCount));
	if (job.totalTokens?.total) parts.push(formatTokenStat(job.totalTokens.total));
	if (job.startedAt !== undefined && job.updatedAt !== undefined) parts.push(formatDuration(Math.max(0, job.updatedAt - job.startedAt)));
	return statJoin(theme, parts);
}

function widgetStepStats(theme: Theme, step: NonNullable<AsyncJobState["steps"]>[number]): string {
	return statJoin(theme, [
		step.turnCount !== undefined ? `${step.turnCount} turns` : "",
		step.toolCount !== undefined ? formatToolUseStat(step.toolCount) : "",
		step.tokens?.total ? formatTokenStat(step.tokens.total) : "",
		step.durationMs !== undefined ? formatDuration(step.durationMs) : "",
	]);
}

function modelThinkingBadge(theme: Theme, model?: string, thinking?: string): string {
	const label = formatModelThinking(model, thinking);
	return label ? theme.fg("dim", ` (${label})`) : "";
}

function widgetStepActivityLine(step: NonNullable<AsyncJobState["steps"]>[number], width: number, expanded: boolean, snapshotNow?: number): string {
	const toolLine = formatCurrentToolLine(step, width, expanded, snapshotNow);
	if (toolLine) return toolLine;
	const activity = buildLiveStatusLine(step, snapshotNow);
	if (activity) return activity;
	if (step.status === "running") return "thinking…";
	return "";
}

function widgetOutputPath(job: AsyncJobState, step: NonNullable<AsyncJobState["steps"]>[number]): string | undefined {
	if (typeof step.index !== "number") return undefined;
	return path.join(job.asyncDir, `output-${step.index}.log`);
}

function nestedStatusGlyph(state: NestedRunSummary["state"] | NestedStepSummary["status"], theme: Theme, seed?: number): string {
	if (state === "running") return theme.fg("accent", runningGlyph(seed));
	if (state === "complete" || state === "completed") return theme.fg("success", "✓");
	if (state === "failed") return theme.fg("error", "✗");
	if (state === "paused") return theme.fg("warning", "■");
	return theme.fg("muted", "◦");
}

function nestedRunSeed(run: NestedRunSummary): number | undefined {
	return runningSeed(run.lastUpdate, run.lastActivityAt, run.currentStep, run.toolCount, run.turnCount, run.totalTokens?.total, run.currentToolStartedAt);
}

function nestedActivity(input: Pick<NestedRunSummary | NestedStepSummary, "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount">, state: NestedRunSummary["state"] | NestedStepSummary["status"], snapshotNow?: number): string {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined && snapshotNow !== undefined) facts.push(`${input.currentTool} ${formatDuration(Math.max(0, snapshotNow - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(input.currentTool);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	const activity = buildLiveStatusLine(input, snapshotNow);
	if (activity && facts.length) return `${activity} · ${facts.join(" · ")}`;
	if (activity) return activity;
	if (facts.length) return facts.join(" · ");
	if (state === "running") return "thinking…";
	if (state === "queued" || state === "pending") return "queued…";
	if (state === "paused") return "Paused";
	if (state === "failed") return "Failed";
	return "Done";
}

function formatNestedWidgetLines(children: NestedRunSummary[] | undefined, theme: Theme, width: number, expanded: boolean, snapshotNow?: number, lineBudget = expanded ? 12 : 1): RenderLine[] {
	if (!expanded) {
		const aggregate = formatNestedAggregate(children);
		return aggregate ? [detailLine(truncLine(theme.fg("dim", `    ↳ ${aggregate}`), width))] : [];
	}
	const lines: RenderLine[] = [];
	const append = (items: NestedRunSummary[] | undefined, depth: number): void => {
		const aggregate = formatNestedAggregate(depth > 2 ? items?.filter((child) => !hasLiveNestedDescendants([child])) : []);
		if (aggregate) lines.push(detailLine(theme.fg("dim", `        ↳ ${aggregate}`)));
		for (const child of items ?? []) {
			const prefix = `    ${"  ".repeat(Math.min(depth, 2))}`;
			const live = hasLiveNestedDescendants([child]);
			if (depth > 2 && !live) continue;
			const activity = nestedActivity(child, child.state, snapshotNow ?? child.lastUpdate) + (child.error ? ` · ${child.error}` : "");
			lines.push(targetLine(truncLine(`${prefix}${stopId(child.id)} ↳ ${nestedStatusGlyph(child.state, theme, nestedRunSeed(child))} ${nestedRunName(child)} · ${child.state}${activity ? ` · ${activity}` : ""}`, width), live));
			for (const step of child.steps ?? []) {
				if (depth > 2 && step.status !== "running" && step.status !== "pending" && !hasLiveNestedDescendants(step.children)) continue;
				lines.push(targetLine(truncLine(`${prefix}  ${stopId(step.id)} ↳ ${nestedStatusGlyph(step.status, theme)} ${step.agent}${step.label ? ` - ${step.label}` : ""} · ${step.status} · ${nestedActivity(step, step.status, snapshotNow ?? child.lastUpdate)}`, width), step.status === "running" || step.status === "pending" || hasLiveNestedDescendants(step.children)));
				append(step.children, depth + 1);
			}
			append(child.children, depth + 1);
		}
	};
	append(children, 0);
	return budgetLines(lines, lineBudget);
}

function foregroundStyleWidgetStepLines(
	job: AsyncJobState, theme: Theme, step: AsyncJobStep, itemTitle: "Agent" | "Step",
	index: number, total: number, expanded: boolean, width: number,
): RenderLine[] {
	const stats = widgetStepStats(theme, step);
	const model = modelThinkingBadge(theme, step.model, step.thinking);
	const name = step.label ? `${step.agent} - ${step.label}` : step.agent;
	const lines: RenderLine[] = [targetLine(truncLine(`  ${stopId(step.id)} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index - 1))} ${itemTitle} ${index}/${total}: ${themeBold(theme, name)} ${theme.fg("dim", "·")} ${widgetStepStatus(step.status, theme)}${model}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), step.status === "running" || step.status === "pending" || hasLiveNestedDescendants(step.children))];
	const activity = widgetStepActivityLine(step, width, expanded, job.updatedAt);
	if (activity) lines.push(detailLine(`    ${theme.fg("dim", `⎿  ${activity}`)}`));
	lines.push(...formatNestedWidgetLines(step.children, theme, width, expanded, job.updatedAt));
	if (step.status === "running") {
		if (!expanded) lines.push(detailLine(`    ${theme.fg("accent", "Press Ctrl+O for live detail")}`));
		const output = widgetOutputPath(job, step);
		if (output) lines.push(detailLine(`    ${theme.fg("dim", `output: ${shortenPath(output)}`)}`));
		if (expanded) {
			const liveStatus = buildLiveStatusLine(step, job.updatedAt);
			if (liveStatus && liveStatus !== activity) lines.push(detailLine(`    ${theme.fg("accent", liveStatus)}`));
			for (const tool of step.recentTools?.slice(-3) ?? []) {
				const maxArgsLen = Math.max(40, width - 30);
				const args = tool.args.length <= maxArgsLen ? tool.args : `${tool.args.slice(0, maxArgsLen)}...`;
				lines.push(detailLine(`      ${theme.fg("dim", `${tool.tool}${args ? `: ${args}` : ""}`)}`));
			}
			for (const line of step.recentOutput?.slice(-5) ?? []) lines.push(detailLine(`      ${theme.fg("dim", line)}`));
		}
	}
	return lines;
}

function activeWidgetGroupLines(job: WidgetJob): RenderLine[] {
	if (!job.activeParallelGroup) return [];
	return (job.workflowGraph?.nodes ?? []).filter((node) => node.label && (node.kind === "parallel-group" || node.kind === "dynamic-parallel-group") && node.children?.some((child) => job.steps?.some((step) => step.index === child.flatIndex)))
		.map((node) => detailLine(`  Parallel group ${(node.stepIndex ?? 0) + 1}: ${node.label}`));
}

function foregroundStyleWidgetDetails(job: AsyncJobState, theme: Theme, expanded: boolean, width: number): RenderLine[] {
	const lines: RenderLine[] = activeWidgetGroupLines(job);
	if (!job.steps?.length) lines.push(detailLine(`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`));
	const total = job.stepsTotal ?? job.steps?.length ?? 0;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	if (job.mode === "chain" && !job.activeParallelGroup && job.parallelGroups?.length) lines.push(...widgetChainDetails(job, theme, expanded, width));
	else for (const [index, step] of (job.steps ?? []).entries()) lines.push(...foregroundStyleWidgetStepLines(job, theme, step, itemTitle, index + 1, total, expanded, width));
	const attached = new Set(job.steps?.flatMap((step) => step.children?.map((child) => child.id) ?? []) ?? []);
	lines.push(...formatNestedWidgetLines(job.nestedChildren?.filter((child) => !attached.has(child.id)), theme, width, expanded, job.updatedAt));
	return lines;
}

function buildSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number, expanded: boolean): RenderLine[] {
	const stats = widgetStats(job, theme);
	const count = job.mode === "chain" ? job.chainStepCount : job.stepsTotal ?? job.agents?.length ?? job.steps?.length;
	const mode = widgetJobName(job);
	const title = `async subagent ${mode}${count && count > 1 ? ` (${count})` : ""}`;
	return [
		detailLine(`${theme.fg("toolTitle", themeBold(theme, title))} ${theme.fg("dim", "· background")}`),
		targetLine(`${stopId(job.asyncId)} ${widgetStatusGlyph(job, theme)} ${themeBold(theme, mode)}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, widgetHasLiveTargets(job)),
		...foregroundStyleWidgetDetails(job, theme, expanded, width),
	].map((line) => ({ ...line, text: truncLine(line.text, width) }));
}

function compactSingleWidgetLines(job: AsyncJobState, theme: Theme, width: number): RenderLine[] {
	const fullLines = buildSingleWidgetLines(job, theme, width, false);
	if (fullLines.length <= 10 || !job.steps?.length || (job.mode !== "parallel" && !job.activeParallelGroup)) return fullLines;
	const total = job.stepsTotal ?? job.steps.length;
	const itemTitle = job.mode === "parallel" || job.activeParallelGroup ? "Agent" : "Step";
	const lines = [...fullLines.slice(0, 2), ...activeWidgetGroupLines(job)];
	for (const [index, step] of job.steps.entries()) {
		const activity = widgetStepActivityLine(step, width, false, job.updatedAt);
		const stats = widgetStepStats(theme, step);
		const name = step.label ? `${step.agent} - ${step.label}` : step.agent;
		const model = modelThinkingBadge(theme, step.model, step.thinking);
		lines.push(targetLine(truncLine(`  ${stopId(step.id)} ${widgetStepGlyph(step.status, theme, widgetStepRunningSeed(step, index))} ${itemTitle} ${index + 1}/${total}: ${themeBold(theme, name)} ${theme.fg("dim", "·")} ${widgetStepStatus(step.status, theme)}${model}${activity ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", activity)}` : ""}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), step.status === "pending" || step.status === "running" || hasLiveNestedDescendants(step.children)));
		lines.push(...formatNestedWidgetLines(step.children, theme, width, false, job.updatedAt));
	}
	const attached = new Set(job.steps.flatMap((step) => step.children?.map((child) => child.id) ?? []));
	lines.push(...formatNestedWidgetLines(job.nestedChildren?.filter((child) => !attached.has(child.id)), theme, width, false, job.updatedAt));
	if (job.steps.some((step) => step.status === "running")) lines.push(detailLine(theme.fg("accent", "  Press Ctrl+O for live detail")));
	return lines;
}

function fitWidgetLineBudget(lines: RenderLine[], expanded: boolean): string[] {
	const rows = process.stdout.rows || 30;
	const budget = expanded ? Math.max(12, Math.min(24, Math.floor(rows * 0.55))) : Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
	return budgetLines(lines, budget).map((line) => line.text);
}

function buildWidgetComponent(jobs: AsyncJobState[], expanded: boolean, retainedRoots: RetainedWidgetRoot[]): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => {
		const container = new Container();
		const width = getTermWidth();
		const rows = !expanded && jobs.length === 1 ? compactSingleWidgetLines(jobs[0]!, theme, width) : buildWidgetRows(jobs, theme, width, expanded);
		rows.push(...retainedWidgetRows(retainedRoots, theme, width, expanded));
		for (const line of fitWidgetLineBudget(rows, expanded)) container.addChild(new Text(line, 1, 0));
		return container;
	};
}

function widgetHasLiveTargets(job: AsyncJobState): boolean {
	return job.status === "running" || job.status === "queued"
		|| !!job.steps?.some((step) => step.status === "pending" || step.status === "running" || hasLiveNestedDescendants(step.children))
		|| hasLiveNestedDescendants(job.nestedChildren);
}

function buildWidgetRows(jobs: AsyncJobState[], theme: Theme, width: number, expanded: boolean): RenderLine[] {
	if (jobs.length === 0) return [];
	if (jobs.length === 1) return buildSingleWidgetLines(jobs[0]!, theme, width, expanded);
	const active = [...jobs.filter((job) => job.status === "running"), ...jobs.filter((job) => job.status === "queued")];
	const finished = jobs.filter((job) => job.status !== "running" && job.status !== "queued");
	const visible = [...active, ...finished.filter((job, index) => index < Math.max(0, MAX_WIDGET_JOBS - active.length) || widgetHasLiveTargets(job))];
	const lines: RenderLine[] = [detailLine(`${theme.fg(active.length ? "accent" : "dim", active.length ? runningGlyph(widgetJobsRunningSeed(active)) : "○")} ${theme.fg(active.length ? "accent" : "dim", "Async agents")} ${theme.fg("dim", "· background")}`)];
	for (const job of visible) {
		const stats = widgetStats(job, theme);
		lines.push(targetLine(truncLine(`${stopId(job.asyncId)} ${widgetStatusGlyph(job, theme)} ${themeBold(theme, widgetJobName(job))}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), widgetHasLiveTargets(job)));
		lines.push(detailLine(`  ${theme.fg("dim", `⎿  ${widgetActivity(job)}`)}`));
		lines.push(...foregroundStyleWidgetDetails(job, theme, expanded, width));
	}
	if (visible.length < jobs.length) lines.push(detailLine(theme.fg("dim", `+${jobs.length - visible.length} more (${jobs.length - visible.length} finished)`)));
	return lines;
}

function retainedWidgetRows(roots: RetainedWidgetRoot[], theme: Theme, width: number, expanded: boolean): RenderLine[] {
	return roots.flatMap((root) => [
		targetLine(truncLine(`${stopId(root.rootRunId)} ${theme.fg("accent", STATIC_RUNNING_GLYPH)} subagent · nested work running`, width), true),
		...formatNestedWidgetLines(root.children, theme, width, expanded),
	]);
}

export function buildWidgetLines(jobs: AsyncJobState[], theme: Theme, width = getTermWidth(), expanded = false, retainedRoots: RetainedWidgetRoot[] = []): string[] {
	return [...buildWidgetRows(jobs, theme, width, expanded), ...retainedWidgetRows(retainedRoots, theme, width, expanded)].map((line) => line.text);
}

/**
 * Render the async jobs widget
 */
export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[], retainedRoots: RetainedWidgetRoot[] = []): void {
	if (jobs.length === 0 && retainedRoots.length === 0) {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, buildWidgetComponent(jobs, ctx.ui.getToolsExpanded?.() ?? false, retainedRoots));
}

function renderSingleCompact(d: Details, r: Details["results"][number], theme: Theme): Component {
	const output = r.truncation?.text || getSingleResultOutput(r);
	const progress = r.progress || r.progressSummary;
	const isRunning = r.progress?.status === "running";
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const stats = statJoin(theme, [
		r.usage?.turns ? `⟳ ${r.usage.turns}` : "",
		formatProgressStats(theme, progress),
	]);
	const c = new Container();
	const width = getTermWidth() - 4;
	const modelDisplay = modelThinkingBadge(theme, r.model);
	c.addChild(new Text(truncLine(`${stopId(r.id)} ${resultGlyph(r, output, theme, isRunning)} ${theme.fg("toolTitle", theme.bold(r.label ? `${r.agent} - ${r.label}` : r.agent))}${modelDisplay}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	if (isRunning && r.progress) {
		const progressSnapshotNow = snapshotNowForProgress(r.progress);
		const activity = compactCurrentActivity(r.progress);
		c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${activity}`), width), 0, 0));
		const liveStatus = buildLiveStatusLine(r.progress, progressSnapshotNow);
		if (liveStatus && liveStatus !== activity) c.addChild(new Text(truncLine(theme.fg("dim", `     ${liveStatus}`), width), 0, 0));
		c.addChild(new Text(truncLine(theme.fg("accent", "  Press Ctrl+O for live detail"), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
		return c;
	}

	c.addChild(new Text(truncLine(theme.fg("dim", `  ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
	const preview = firstOutputLine(output);
	if (preview && r.exitCode === 0 && !hasEmptyTextOutputWithoutOutputTarget(r.task, output)) {
		c.addChild(new Text(truncLine(theme.fg("dim", `     ${preview}`), width), 0, 0));
	}
	if (r.sessionFile) c.addChild(new Text(truncLine(theme.fg("dim", `  session: ${shortenPath(r.sessionFile)}`), width), 0, 0));
	if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `  output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	if (r.truncation?.artifactPath) c.addChild(new Text(truncLine(theme.fg("dim", `  full output: ${shortenPath(r.truncation.artifactPath)}`), width), 0, 0));
	return c;
}

function renderMultiCompact(d: Details, theme: Theme): Component {
	const hasRunning = d.progress?.some((p) => p.status === "running")
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const failed = d.results.some((r) => r.exitCode !== 0 && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["failed"]);
	const paused = d.results.some((r) => r.interrupted && r.progress?.status !== "running")
		|| workflowGraphHasStatus(d, ["paused"]);
	let totalSummary = d.progressSummary;
	if (!totalSummary) {
		let sawProgress = false;
		const summary = { toolCount: 0, tokens: 0, durationMs: 0 };
		for (const r of d.results) {
			const prog = r.progress || r.progressSummary;
			if (!prog) continue;
			sawProgress = true;
			summary.toolCount += prog.toolCount;
			summary.tokens += prog.tokens;
			summary.durationMs = d.mode === "chain" ? summary.durationMs + prog.durationMs : Math.max(summary.durationMs, prog.durationMs);
		}
		if (sawProgress) totalSummary = summary;
	}
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	const stats = statJoin(theme, [multiLabel.headerLabel, formatProgressStats(theme, totalSummary)]);
	const glyph = hasRunning
		? theme.fg("accent", runningGlyph(runningSeed(progressRunningSeed(totalSummary), d.currentStepIndex)))
		: failed
			? theme.fg("error", "✗")
			: paused
				? theme.fg("warning", "■")
				: theme.fg("success", "✓");
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const c = new Container();
	const width = getTermWidth() - 4;
	c.addChild(new Text(truncLine(`${stopId(d.runId)} ${glyph} ${theme.fg("toolTitle", theme.bold(d.mode))}${contextBadge}${stats ? ` ${theme.fg("dim", "·")} ${stats}` : ""}`, width), 0, 0));

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = 0;
	const displayEnd = useResultsDirectly ? d.results.length : d.chainAgents!.length;
	const chainEntries = buildChainRenderEntries(d, multiLabel);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const fallbackLabel = itemTitle.toLowerCase();
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `${fallbackLabel}-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `${fallbackLabel}-${rowNumber}`) };
	});
	for (const entry of renderEntries) {
		if (entry.kind === "group") {
			c.addChild(new Text(truncLine(`  Parallel group ${entry.stepIndex + 1}: ${entry.label}`, width), 0, 0));
			continue;
		}
		if (entry.kind === "placeholder") {
			const glyph = widgetStepGlyph(entry.status as AsyncJobStep["status"], theme);
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(truncLine(`  ${glyph} ${entry.stepLabel}: ${themeBold(theme, entry.agentName)} ${theme.fg("dim", "·")} ${statusLabel}`, width), 0, 0));
			if (entry.error) c.addChild(new Text(truncLine(theme.fg("error", `    ⎿  Error: ${entry.error}`), width), 0, 0));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;
		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(truncLine(theme.fg("dim", `  ${pendingChildLine(d.progress?.find((entry) => entry.index === i), pendingLabel, agentName)}`), width), 0, 0));
			continue;
		}
		const output = getSingleResultOutput(r);
		const progressFromArray = d.progress?.find((p) => p.index === i) || d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg && "status" in rProg && rProg.status === "running";
		const rPending = rProg && "status" in rProg && rProg.status === "pending";
		const stepNumber = r.progress?.index !== undefined ? r.progress.index + 1 : progressFromArray?.index !== undefined ? progressFromArray.index + 1 : i + 1;
		const stepStats = formatProgressStats(theme, rProg);
		const glyph = rPending ? theme.fg("dim", "◦") : resultGlyph(r, output, theme, rRunning, progressRunningSeed(rProg));
		const pendingLabel = rPending ? ` ${theme.fg("dim", "· pending")}` : "";
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const line = `${stopId(r.id)} ${glyph} ${stepLabel}: ${themeBold(theme, r.label ? `${agentName} - ${r.label}` : agentName)}${stepStats ? ` ${theme.fg("dim", "·")} ${stepStats}` : ""}${pendingLabel}`;
		c.addChild(new Text(truncLine(`  ${line}`, width), 0, 0));
		if (rRunning && rProg && "status" in rProg) {
			const activity = compactCurrentActivity(rProg);
			c.addChild(new Text(truncLine(theme.fg("dim", `    ⎿  ${activity}`), width), 0, 0));
			c.addChild(new Text(truncLine(theme.fg("accent", "    Press Ctrl+O for live detail"), width), 0, 0));
		} else if (!rPending && (r.exitCode !== 0 || r.interrupted || hasEmptyTextOutputWithoutOutputTarget(r.task, output))) {
			c.addChild(new Text(truncLine(theme.fg(r.exitCode !== 0 ? "error" : "dim", `    ⎿  ${resultStatusLine(r, output)}`), width), 0, 0));
		}
		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${outputTarget}`), width), 0, 0));
		if (r.artifactPaths) c.addChild(new Text(truncLine(theme.fg("dim", `    output: ${shortenPath(r.artifactPaths.outputPath)}`), width), 0, 0));
	}
	if (d.artifacts) c.addChild(new Text(truncLine(theme.fg("dim", `  artifacts: ${shortenPath(d.artifacts.dir)}`), width), 0, 0));
	return c;
}

/**
 * Render a subagent result
 */
export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
): Component {
	const d = result.details;
	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		const contextPrefix = d?.context === "fork" ? `${theme.fg("warning", "[fork]")} ` : "";
		return new Text(truncLine(`${contextPrefix}${text}`, getTermWidth() - 4), 0, 0);
	}

	const expanded = options.expanded;
	const mdTheme = getMarkdownTheme();

	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		if (!expanded) return renderSingleCompact(d, r, theme);
		const isRunning = r.progress?.status === "running";
		const icon = isRunning
			? theme.fg("warning", "running")
				: r.exitCode === 0
					? theme.fg("success", "ok")
					: theme.fg("error", "failed");
		const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
		const output = r.truncation?.text || getSingleResultOutput(r);

		const progressInfo = isRunning && r.progress
			? ` | ${r.progress.toolCount} tools, ${formatTokens(r.progress.tokens)} tok, ${formatDuration(r.progress.durationMs)}`
			: r.progressSummary
				? ` | ${r.progressSummary.toolCount} tools, ${formatTokens(r.progressSummary.tokens)} tok, ${formatDuration(r.progressSummary.durationMs)}`
				: "";

		const w = getTermWidth() - 4;
		const fit = (text: string) => expanded ? text : truncLine(text, w);
		const toolCallLines = getToolCallLines(r, expanded);
		const c = new Container();
		c.addChild(new Text(fit(`${stopId(r.id)} ${icon} ${theme.fg("toolTitle", theme.bold(r.label ? `${r.agent} - ${r.label}` : r.agent))}${contextBadge}${progressInfo}`), 0, 0));
		c.addChild(new Spacer(1));
		const taskMaxLen = Math.max(20, w - 8);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(
			new Text(fit(theme.fg("dim", `Task: ${taskPreview}`)), 0, 0),
		);
		c.addChild(new Spacer(1));

		if (isRunning && r.progress) {
			const progressSnapshotNow = snapshotNowForProgress(r.progress);
			const toolLine = formatCurrentToolLine(r.progress, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `> ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(r.progress, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", liveStatusLine)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", "Press Ctrl+O for live detail")), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (r.progress.recentTools?.length) {
				for (const t of r.progress.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 24);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			for (const line of (r.progress.recentOutput ?? []).slice(-5)) {
				c.addChild(new Text(fit(theme.fg("dim", `  ${line}`)), 0, 0));
			}
			if (toolLine || liveStatusLine || r.progress.recentTools?.length || r.progress.recentOutput?.length || r.artifactPaths) {
				c.addChild(new Spacer(1));
			}
		}

		if (expanded) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", line)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		if (output) c.addChild(new Markdown(output, 0, 0, mdTheme));
		c.addChild(new Spacer(1));
		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `Skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `Fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}
		c.addChild(new Text(fit(theme.fg("dim", formatUsage(r.usage, r.model))), 0, 0));
		if (r.sessionFile) {
			c.addChild(new Text(fit(theme.fg("dim", `Session: ${shortenPath(r.sessionFile)}`)), 0, 0));
		}

		if (!isRunning && r.artifactPaths) {
			c.addChild(new Spacer(1));
			c.addChild(new Text(fit(theme.fg("dim", `Artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}
		for (const line of formatNestedWidgetLines(r.progress?.children, theme, w, true)) c.addChild(new Text(line.text, 0, 0));
		return c;
	}

	if (!expanded) return renderMultiCompact(d, theme);

	const hasRunning = d.progress?.some((p) => p.status === "running") 
		|| d.results.some((r) => r.progress?.status === "running")
		|| workflowGraphHasStatus(d, ["running"]);
	const ok = d.results.filter((r) => r.progress?.status === "completed" || (r.exitCode === 0 && r.progress?.status !== "running")).length;
	const hasEmptyWithoutTarget = d.results.some((r) =>
		r.exitCode === 0
		&& r.progress?.status !== "running"
		&& hasEmptyTextOutputWithoutOutputTarget(r.task, getSingleResultOutput(r)),
	);
	const hasWorkflowFailure = workflowGraphHasStatus(d, ["failed"]);
	const hasWorkflowPause = workflowGraphHasStatus(d, ["paused"]);
	const icon = hasRunning
		? theme.fg("warning", "running")
		: hasEmptyWithoutTarget
			? theme.fg("warning", "warning")
			: hasWorkflowFailure
				? theme.fg("error", "failed")
				: hasWorkflowPause
					? theme.fg("warning", "paused")
					: ok === d.results.length
						? theme.fg("success", "ok")
						: theme.fg("error", "failed");

	const totalSummary =
		d.progressSummary ||
		d.results.reduce(
			(acc, r) => {
				const prog = r.progress || r.progressSummary;
				if (prog) {
					acc.toolCount += prog.toolCount;
					acc.tokens += prog.tokens;
					acc.durationMs =
						d.mode === "chain"
							? acc.durationMs + prog.durationMs
							: Math.max(acc.durationMs, prog.durationMs);
				}
				return acc;
			},
			{ toolCount: 0, tokens: 0, durationMs: 0 },
		);

	const summaryStr =
		totalSummary.toolCount || totalSummary.tokens
			? ` | ${totalSummary.toolCount} tools, ${formatTokens(totalSummary.tokens)} tok, ${formatDuration(totalSummary.durationMs)}`
			: "";

	const modeLabel = d.mode;
	const contextBadge = d.context === "fork" ? theme.fg("warning", " [fork]") : "";
	const multiLabel = buildMultiProgressLabel(d, hasRunning);
	const itemTitle = multiLabel.itemTitle;
	
	const chainVis = d.chainAgents?.length && !multiLabel.hasParallelInChain
		? d.chainAgents
				.map((agent, i) => {
					const result = d.results[i];
					const isFailed = result && result.exitCode !== 0 && result.progress?.status !== "running";
					const isComplete = result && result.exitCode === 0 && result.progress?.status !== "running";
					const isEmptyWithoutTarget = Boolean(result)
						&& Boolean(isComplete)
						&& hasEmptyTextOutputWithoutOutputTarget(result.task, getSingleResultOutput(result));
					const isCurrent = i === (d.currentStepIndex ?? d.results.length);
					const stepIcon = isFailed
						? theme.fg("error", "failed")
						: isEmptyWithoutTarget
							? theme.fg("warning", "warning")
							: isComplete
								? theme.fg("success", "done")
								: isCurrent && hasRunning
									? theme.fg("warning", "running")
									: theme.fg("dim", "pending");
					return `${stepIcon} ${agent}`;
				})
				.join(theme.fg("dim", " → "))
		: null;

	const w = getTermWidth() - 4;
	const fit = (text: string) => expanded ? text : truncLine(text, w);
	const c = new Container();
	c.addChild(
		new Text(
			fit(`${stopId(d.runId)} ${icon} ${theme.fg("toolTitle", theme.bold(modeLabel))}${contextBadge} · ${multiLabel.headerLabel}${summaryStr}`),
			0,
			0,
		),
	);
	if (chainVis) {
		c.addChild(new Text(fit(`  ${chainVis}`), 0, 0));
	}

	const useResultsDirectly = multiLabel.hasParallelInChain || !d.chainAgents?.length;
	const displayStart = 0;
	const displayEnd = useResultsDirectly ? d.results.length : d.chainAgents!.length;
	const chainEntries = buildChainRenderEntries(d, multiLabel, expanded);
	const renderEntries = chainEntries ?? Array.from({ length: displayEnd - displayStart }, (_, offset): ChainRenderEntry => {
		const i = displayStart + offset;
		const r = d.results[i];
		const rowNumber = multiLabel.showActiveGroupOnly ? (i - multiLabel.groupStartIndex + 1) : (i + 1);
		return { kind: "result", resultIndex: i, rowNumber, agentName: useResultsDirectly ? (r?.agent || `step-${rowNumber}`) : (d.chainAgents![i] || r?.agent || `step-${rowNumber}`) };
	});

	c.addChild(new Spacer(1));

	for (const entry of renderEntries) {
		if (entry.kind === "group") {
			c.addChild(new Text(fit(`  Parallel group ${entry.stepIndex + 1}: ${entry.label}`), 0, 0));
			continue;
		}
		if (entry.kind === "placeholder") {
			const statusLabel = widgetStepStatus(entry.status as AsyncJobStep["status"], theme);
			c.addChild(new Text(fit(`  ${statusLabel} ${entry.stepLabel}: ${theme.bold(entry.agentName)}`), 0, 0));
			c.addChild(new Text(theme.fg(entry.status === "failed" ? "error" : "dim", `    status: ${entry.status}`), 0, 0));
			if (entry.error) c.addChild(new Text(theme.fg("error", `    error: ${entry.error}`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}
		const i = entry.resultIndex;
		const r = d.results[i];
		const rowNumber = entry.rowNumber;
		const agentName = entry.agentName;

		if (!r) {
			const pendingLabel = chainEntries ? resultRowLabel(d, multiLabel, i, rowNumber) : `${itemTitle} ${rowNumber}`;
			c.addChild(new Text(fit(theme.fg("dim", `  ${pendingChildLine(d.progress?.find((entry) => entry.index === i), pendingLabel, agentName)}`)), 0, 0));
			c.addChild(new Text(theme.fg("dim", `    status: pending`), 0, 0));
			c.addChild(new Spacer(1));
			continue;
		}

		const progressFromArray = d.progress?.find((p) => p.index === i) 
			|| d.progress?.find((p) => p.agent === r.agent && p.status === "running");
		const rProg = r.progress || progressFromArray || r.progressSummary;
		const rRunning = rProg?.status === "running";
		const stepNumber = typeof rProg?.index === "number" ? rProg.index + 1 : i + 1;

		const resultOutput = getSingleResultOutput(r);
		const statusIcon = rRunning
			? theme.fg("warning", "running")
			: r.exitCode !== 0
				? theme.fg("error", "failed")
				: hasEmptyTextOutputWithoutOutputTarget(r.task, resultOutput)
					? theme.fg("warning", "warning")
					: theme.fg("success", "done");
		const stats = rProg ? ` | ${rProg.toolCount} tools, ${formatDuration(rProg.durationMs)}` : "";
		const modelDisplay = modelThinkingBadge(theme, r.model);
		const stepLabel = resultRowLabel(d, multiLabel, i, stepNumber);
		const stepHeader = rRunning
			? `${statusIcon} ${stepLabel}: ${theme.bold(theme.fg("warning", r.label ? `${r.agent} - ${r.label}` : r.agent))}${modelDisplay}${stats}`
			: `${statusIcon} ${stepLabel}: ${theme.bold(r.label ? `${r.agent} - ${r.label}` : r.agent)}${modelDisplay}${stats}`;
		const toolCallLines = getToolCallLines(r, expanded);
		c.addChild(new Text(fit(`${stopId(r.id)} ${stepHeader}`), 0, 0));

		const taskMaxLen = Math.max(20, w - 12);
		const taskPreview = expanded || r.task.length <= taskMaxLen
			? r.task
			: `${r.task.slice(0, taskMaxLen)}...`;
		c.addChild(new Text(fit(theme.fg("dim", `    task: ${taskPreview}`)), 0, 0));

		const outputTarget = extractOutputTarget(r.task);
		if (outputTarget) {
			c.addChild(new Text(fit(theme.fg("dim", `    output: ${outputTarget}`)), 0, 0));
		}

		if (r.skills?.length) {
			c.addChild(new Text(fit(theme.fg("dim", `    skills: ${r.skills.join(", ")}`)), 0, 0));
		}
		if (r.skillsWarning) {
			c.addChild(new Text(fit(theme.fg("warning", `    Warning: ${r.skillsWarning}`)), 0, 0));
		}
		if (r.attemptedModels && r.attemptedModels.length > 1) {
			c.addChild(new Text(fit(theme.fg("dim", `    fallbacks: ${r.attemptedModels.join(" → ")}`)), 0, 0));
		}

		if (rRunning && rProg) {
			if (rProg.skills?.length) {
				c.addChild(new Text(fit(theme.fg("accent", `    skills: ${rProg.skills.join(", ")}`)), 0, 0));
			}
			const progressSnapshotNow = snapshotNowForProgress(rProg);
			const toolLine = formatCurrentToolLine(rProg, w, expanded, progressSnapshotNow);
			if (toolLine) {
				c.addChild(new Text(fit(theme.fg("warning", `    > ${toolLine}`)), 0, 0));
			}
			const liveStatusLine = buildLiveStatusLine(rProg, progressSnapshotNow);
			if (liveStatusLine) {
				c.addChild(new Text(fit(theme.fg("accent", `    ${liveStatusLine}`)), 0, 0));
			}
			c.addChild(new Text(fit(theme.fg("accent", "    Press Ctrl+O for live detail")), 0, 0));
			if (r.artifactPaths) {
				c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
			}
			if (rProg.recentTools?.length) {
				for (const t of rProg.recentTools.slice(-3)) {
					const maxArgsLen = Math.max(40, w - 30);
					const argsPreview = expanded || t.args.length <= maxArgsLen
						? t.args
						: `${t.args.slice(0, maxArgsLen)}...`;
					c.addChild(new Text(fit(theme.fg("dim", `      ${t.tool}: ${argsPreview}`)), 0, 0));
				}
			}
			const recentLines = (rProg.recentOutput ?? []).slice(-5);
			for (const line of recentLines) {
				c.addChild(new Text(fit(theme.fg("dim", `      ${line}`)), 0, 0));
			}
		}

		if (!rRunning && r.artifactPaths) {
			c.addChild(new Text(fit(theme.fg("dim", `    artifacts: ${shortenPath(r.artifactPaths.outputPath)}`)), 0, 0));
		}

		if (expanded && !rRunning) {
			for (const line of toolCallLines) {
				c.addChild(new Text(fit(theme.fg("muted", `      ${line}`)), 0, 0));
			}
			if (toolCallLines.length) c.addChild(new Spacer(1));
		}

		for (const line of formatNestedWidgetLines(r.progress?.children, theme, w, true)) c.addChild(new Text(line.text, 0, 0));
		c.addChild(new Spacer(1));
	}

	if (d.artifacts) {
		c.addChild(new Spacer(1));
		c.addChild(new Text(fit(theme.fg("dim", `Artifacts dir: ${shortenPath(d.artifacts.dir)}`)), 0, 0));
	}
	return c;
}
