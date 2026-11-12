import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NestedRunSummary } from "../shared/types.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function fuzzyScore(query: string, text: string): number {
	const lq = query.toLowerCase();
	const lt = text.toLowerCase();
	if (lt.includes(lq)) return 100 + (lq.length / lt.length) * 50;
	let score = 0;
	let qi = 0;
	let consecutive = 0;
	for (let i = 0; i < lt.length && qi < lq.length; i++) {
		if (lt[i] === lq[qi]) {
			score += 10 + consecutive;
			consecutive += 5;
			qi++;
		} else {
			consecutive = 0;
		}
	}
	return qi === lq.length ? score : 0;
}

export function fuzzyFilter<T extends { name: string; description: string; model?: string }>(items: T[], query: string): T[] {
	const q = query.trim();
	if (!q) return items;
	return items
		.map((item) => ({ item, score: Math.max(fuzzyScore(q, item.name), fuzzyScore(q, item.description) * 0.8, fuzzyScore(q, item.model ?? "") * 0.6) }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.item);
}

export function pad(s: string, len: number): string {
	const vis = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - vis));
}

export type RenderLine = { text: string; kind: "detail" | "settled" | "live" };

export function detailLine(text: string): RenderLine {
	return { text, kind: "detail" };
}

export function targetLine(text: string, live: boolean): RenderLine {
	return { text, kind: live ? "live" : "settled" };
}

export function budgetLines(lines: RenderLine[], budget: number): RenderLine[] {
	let excess = Math.max(0, lines.length - budget);
	const removed = new Set<number>();
	for (const kind of ["detail", "settled"] as const) {
		for (let index = lines.length - 1; index >= 0 && excess > 0; index--) {
			if (lines[index]!.kind !== kind) continue;
			removed.add(index);
			excess--;
		}
	}
	return lines.filter((_, index) => !removed.has(index));
}

export function stopId(id: string | undefined): string {
	return id?.slice(0, 6) ?? "";
}

export function formatWidgetAgents(agents: string[]): string {
	const distinct = [...new Set(agents)];
	if (distinct.length === 1 && agents.length > 1) return `${distinct[0]} ×${agents.length}`;
	if (agents.length > 3) return `${agents.slice(0, 2).join(", ")} +${agents.length - 2} more`;
	return agents.join(", ");
}

export function nestedRunName(run: NestedRunSummary): string {
	if (run.agent) return run.label ? `${run.agent} - ${run.label}` : run.agent;
	if (run.agents?.length) return formatWidgetAgents(run.agents);
	return run.mode ?? "nested run";
}

export function row(content: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const singleLine = content.replace(/[\r\n]+/g, " ").replace(/\t/g, "  ");
	const clipped = truncateToWidth(singleLine, innerW);
	return theme.fg("border", "│") + pad(clipped, innerW) + theme.fg("border", "│");
}

export function renderHeader(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╭" + "─".repeat(padLeft)) +
		theme.fg("accent", text) +
		theme.fg("border", "─".repeat(padRight) + "╮")
	);
}

export function formatPath(filePath: string): string {
	const home = process.env.HOME;
	if (home && filePath.startsWith(home)) return `~${filePath.slice(home.length)}`;
	return filePath;
}

export function formatScrollInfo(above: number, below: number): string {
	let info = "";
	if (above > 0) info += `↑ ${above} more`;
	if (below > 0) info += `${info ? "  " : ""}↓ ${below} more`;
	return info;
}

export function renderFooter(text: string, width: number, theme: Theme): string {
	const innerW = width - 2;
	const padLen = Math.max(0, innerW - visibleWidth(text));
	const padLeft = Math.floor(padLen / 2);
	const padRight = padLen - padLeft;
	return (
		theme.fg("border", "╰" + "─".repeat(padLeft)) +
		theme.fg("dim", text) +
		theme.fg("border", "─".repeat(padRight) + "╯")
	);
}
