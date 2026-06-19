import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GRAND_TOTAL_STATUS_KEY } from "../shared/types.ts";
import type { NestedRunSummary, SubagentState } from "../shared/types.ts";

export type GrandTotal = SubagentState["grandTotal"];

function safe(n: number): number {
	return Number.isFinite(n) ? n : 0;
}

export function emptyGrandTotal(): GrandTotal {
	return {
		mainCost: 0,
		syncCostByRun: new Map(),
		asyncCostByJob: new Map(),
	};
}

export function recordMainCost(gt: GrandTotal, delta: number): void {
	gt.mainCost += safe(delta);
}

export function recordSyncCost(gt: GrandTotal, runId: string, cost: number): void {
	gt.syncCostByRun.set(runId, Math.max(gt.syncCostByRun.get(runId) ?? 0, safe(cost)));
}

export function recordAsyncCost(gt: GrandTotal, jobId: string, cost: number): void {
	gt.asyncCostByJob.set(jobId, Math.max(gt.asyncCostByJob.get(jobId) ?? 0, safe(cost)));
}

export function recompute(gt: GrandTotal): number {
	let total = safe(gt.mainCost);
	for (const v of gt.syncCostByRun.values()) total += safe(v);
	for (const v of gt.asyncCostByJob.values()) total += safe(v);
	return total;
}

export function formatGrandTotal(total: number): string {
	// Leading divider separates this from the preceding extension status on the
	// shared footer line (statuses are space-joined, so a bare `Σ$` reads as the
	// neighbour's figure).
	return `│ Σ$${total.toFixed(3)}`;
}

export function renderGrandTotal(state: SubagentState): void {
	const ctx = state.lastUiContext;
	if (!ctx?.hasUI) return;
	try {
		ctx.ui.setStatus(GRAND_TOTAL_STATUS_KEY, formatGrandTotal(recompute(state.grandTotal)));
	} catch {
		// stale UI context — ignore
	}
}

export function sumNestedCost(children: NestedRunSummary[] | undefined): number {
	if (!children) return 0;
	let total = 0;
	for (const child of children) {
		total += safe(child.totalCost ?? 0);
		total += sumNestedCost(child.children);
	}
	return total;
}

export function seedMainCostFromSession(state: SubagentState, ctx: ExtensionContext): void {
	try {
		const entries = ctx.sessionManager.getBranch();
		let total = 0;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant") continue;
			const cost = (msg as { usage?: { cost?: { total?: number } } }).usage?.cost?.total;
			total += safe(cost ?? 0);
		}
		state.grandTotal.mainCost = total;
	} catch {
		state.grandTotal.mainCost = 0;
	}
}
