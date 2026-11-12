import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { renderSubagentResult } from "../../src/tui/render.ts";

const { buildWidgetLines, clearLegacyResultAnimationTimer, renderWidget } = await import("../../src/tui/render.ts") as {
	buildWidgetLines: (jobs: Array<Record<string, unknown>>, theme: { fg(name: string, text: string): string; bold(text: string): string }, width?: number, expanded?: boolean) => string[];
	clearLegacyResultAnimationTimer: (context: { state: { subagentResultAnimationTimer?: ReturnType<typeof setInterval> } }) => void;
	renderWidget: (ctx: Record<string, unknown>, jobs: Array<Record<string, unknown>>) => void;
};

const theme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
};

for (const mode of ["single", "parallel", "chain"] as const) {
	it(`refreshes silent foreground nested snapshots in ${mode} mode and clears the poll on exit`, async (t) => {
		const { POLL_INTERVAL_MS } = await import("../../src/shared/types.ts");
		const realSetInterval = globalThis.setInterval;
		const polls: ReturnType<typeof setInterval>[] = [];
		t.mock.method(globalThis, "setInterval", (callback, delay, ...args) => {
			const timer = realSetInterval(callback, delay, ...args);
			if (delay === POLL_INTERVAL_MS) polls.push(timer);
			return timer;
		});
		const clears = t.mock.method(globalThis, "clearInterval");
		const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
		const { writeNestedEvent } = await import("../../src/runs/shared/nested-events.ts");
		const { createMockPi, createTempDir, removeTempDir, createEventBus, makeAgent, makeMinimalCtx, events } = await import("../support/helpers.ts");
		const temp = createTempDir();
		const mock = createMockPi();
		mock.install();
		mock.onCall({ taskIncludes: "Silent", steps: [{ jsonl: [events.assistantMessage("Ready"), events.messageStart()] }, { delay: 60_000, jsonl: [events.assistantMessage("Done")] }] });
		const state = { baseCwd: temp, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), lastForegroundControlId: null,
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() } };
		const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime, pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: temp, getSubagentSessionRoot: () => temp,
			expandTilde: (value: string) => value, discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }) });
		const controller = new AbortController();
		const updates: any[] = [];
		const task = { agent: "echo", task: "Silent", label: "parent work" };
		const pending = executor.execute("silent", { ...(mode === "parallel" ? { tasks: [task] } : mode === "chain" ? { chain: [task] } : task), async: false }, controller.signal, (update) => updates.push(update), makeMinimalCtx(temp));
		try {
			const deadline = Date.now() + 5_000;
			while (!updates.some((update) => update.details?.results?.[0]?.progress) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(updates.some((update) => update.details?.results?.[0]?.progress), "parent progress is available before the nested event");
			await new Promise((resolve) => setTimeout(resolve, 100));
			const [runId, control] = [...state.foregroundControls.entries()][0];
			const previousUpdate = updates.at(-1);
			const countBeforeNested = updates.length;
			assert.equal(polls.length, 1, "one shared-cadence projection poll per foreground run");
			const childId = previousUpdate.details.results[0].id;
			const nestedId = randomUUID();
			writeNestedEvent(control.nestedRoute, { type: "subagent.nested.started", ts: 1, parentRunId: runId,
				child: { id: nestedId, parentRunId: runId, depth: 1, path: [{ runId, childId }], state: "running", agent: "leaf", lastUpdate: 1 } });
			const nestedIds = [nestedId];
			for (let depth = 2; depth <= 4; depth++) {
				const parentId = nestedIds.at(-1)!;
				const id = randomUUID();
				nestedIds.push(id);
				writeNestedEvent(control.nestedRoute, { type: "subagent.nested.started", ts: depth, parentRunId: parentId,
					child: { id, parentRunId: parentId, depth, path: [{ runId, childId }, { runId: parentId }], state: "running", agent: `depth-${depth}` } });
			}
			const leafIds = Array.from({ length: 14 }, () => randomUUID());
			for (const [index, id] of leafIds.entries()) writeNestedEvent(control.nestedRoute, { type: "subagent.nested.child", ts: 10 + index,
				runId: nestedIds.at(-1)!, id, index, agent: "worker", label: `audit ${index}`, status: "running" });
			const refreshDeadline = Date.now() + 1_000;
			while (!updates.some((update) => update.details?.results?.[0]?.progress?.children?.some((child) => child.id === nestedId)) && Date.now() < refreshDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(updates.length > countBeforeNested, "the poll publishes a new snapshot");
			assert.ok(updates.at(-1)?.details?.results?.[0]?.progress?.children?.some((child) => child.id === nestedId), "nested progress must arrive without parent output");
			assert.equal(previousUpdate.details.results[0].progress.children?.length ?? 0, 0, "old snapshots remain immutable");
			const render = (value: any, expanded: boolean) => renderSubagentResult(value, { expanded }, theme as any).render(180).join("\n");
			for (const id of [...nestedIds, ...leafIds]) assert.match(render(updates.at(-1), true), new RegExp(`^\\s*${id.slice(0, 6)} `, "m"));
			assert.doesNotMatch(render(updates.at(-1), false), /↳/);
			writeNestedEvent(control.nestedRoute, { type: "subagent.nested.updated", ts: 100, parentRunId: runId,
				child: { id: nestedId, parentRunId: runId, depth: 1, path: [{ runId, childId }], state: "paused", agent: "leaf" } });
			const changedDeadline = Date.now() + 1_000;
			while (!render(updates.at(-1), true).includes("leaf · paused") && Date.now() < changedDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.match(render(updates.at(-1), true), /leaf · paused/);
			controller.abort();
			const final = await pending;
			for (const id of [...nestedIds, ...leafIds]) assert.match(render(final, true), new RegExp(`^\\s*${id.slice(0, 6)} `, "m"));
			assert.doesNotMatch(render(final, false), /↳/);
		} finally {
			controller.abort();
			await pending;
			const count = updates.length;
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(updates.length, count, "a completed run must not publish poll updates");
			assert.equal(state.foregroundControls.size, 0);
			assert.ok(polls.every((poll) => clears.mock.calls.some((call) => call.arguments[0] === poll)), "all projection polls are cleared");
			mock.uninstall();
			removeTempDir(temp);
		}
	});
}

for (const [shape, rootCount, concurrency = 1, failure] of [
	["single", 1],
	["single", 2],
	["tasks", 1],
	["tasks", 2],
	["sequential", 1],
	["sequential", 2],
	["static", 1],
	["dynamic", 1],
	["static", 1, 2],
	["dynamic", 1, 2],
	["dynamic", 1, 2, "validation"],
	["static", 1, 2, "fail-fast"],
] as const) {
	it(`renders live and final identities and labels from ${shape} dispatch with ${rootCount} foreground run${rootCount === 1 ? "" : "s"} and concurrency ${concurrency}${failure ? ` with ${failure}` : ""}`, async () => {
		const { createSubagentExecutor } = await import("../../src/runs/foreground/subagent-executor.ts");
		const { writeNestedEvent } = await import("../../src/runs/shared/nested-events.ts");
		const { createMockPi, createTempDir, removeTempDir, createEventBus, makeAgent, makeMinimalCtx, events } = await import("../support/helpers.ts");
		const temp = createTempDir();
		const mock = createMockPi();
		mock.install();
		const state = { baseCwd: temp, currentSessionId: null, asyncJobs: new Map(), foregroundControls: new Map(), retainedNestedRoutes: new Map(), lastForegroundControlId: null,
			grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() } };
		const executor = createSubagentExecutor({ captureRuntime: mock.captureRuntime, pi: { events: createEventBus(), getSessionName: () => undefined }, state,
			resolveConfig: () => ({ control: { enabled: false } }), tempArtifactsDir: temp, getSubagentSessionRoot: () => temp,
			expandTilde: (value: string) => value, discoverAgents: () => ({ agents: [makeAgent("echo", { completionGuard: false })] }) });
		const render = (value: any, expanded: boolean) => renderSubagentResult(value, { expanded }, theme as any).render(180).join("\n");
		try {
			const names = concurrency === 2 ? ["alpha", "beta", "gamma"] : ["alpha", "beta"];
			if (shape === "dynamic") mock.onCall({ taskIncludes: "Seed", output: "items", structuredOutput: {
				items: names.map((name, index) => ({ name, task: failure === "validation" && index === 0 ? "{outputs.missing}" : name })),
			} });
			const steps = [
				{ jsonl: [events.messageStart()] },
				...(concurrency === 2 ? [{ delay: 350, jsonl: [events.toolStart("read", { path: "audit.ts" })] }] : []),
				{ delay: 350, jsonl: [events.assistantMessage("done")] },
			];
			if (concurrency === 2) mock.onCall({ taskIncludes: shape === "static" ? "Work first" : "Work alpha", delay: 500, steps });
			if (failure === "fail-fast") mock.onCall({ taskIncludes: "Work second", steps, exitCode: 1 });
			mock.onCall({ taskIncludes: "Work", steps });
			const first = { agent: "echo", task: "Work first", label: "audit alpha" };
			const second = { agent: "echo", task: "Work second", label: "audit beta" };
			const third = { agent: "echo", task: "Work third", label: "audit gamma" };
			const params = shape === "single" ? first
				: shape === "tasks" ? { tasks: [first, second], concurrency: 1 }
				: shape === "sequential" ? { chain: [first, second] }
				: shape === "static" ? { chain: [{ parallel: concurrency === 2 ? [first, second, third] : [first, second], concurrency, failFast: failure === "fail-fast" }] }
				: { chain: [{ agent: "echo", task: "Seed", label: "seed items", as: "items", outputSchema: { type: "object" } },
					{ expand: { from: { output: "items", path: "/items" }, maxItems: names.length }, parallel: { agent: "echo", task: "Work {item.task}", label: "audit {item.name}" }, collect: { as: "reviews" }, label: "group audit", concurrency }] };
			const allUpdates: any[][] = [];
			const concurrentUpdates: Array<{ update: any; reportingId: string; children: Array<{ id: string; label?: string; index: number; state: string }> }> = [];
			const attachmentId = randomUUID();
			let attachedTo: string | undefined;
			let maxConcurrentRoots = 0;
			const finals = await Promise.all(Array.from({ length: rootCount }, async (_, rootIndex) => {
				const updates: any[] = [];
				allUpdates.push(updates);
				return executor.execute(`labels-${rootIndex}`, { ...params, async: false }, undefined, (update: any) => {
					updates.push(update);
					if (concurrency === 2) {
						const control = state.foregroundControls.get(update.details?.runId);
						const children = [...(control?.children.entries() ?? [])].filter(([, child]) => child.label?.startsWith("audit ")).map(([id, child]) => ({ id, ...child }));
						const reportingChild = children.find((child) => child.index === control.currentIndex && child.state === "running");
						if (children.length === 3 && reportingChild) concurrentUpdates.push({ update, reportingId: reportingChild.id, children });
					}
					if (update.details?.results.some((child) => child.progress?.status === "running")) {
						maxConcurrentRoots = Math.max(maxConcurrentRoots, state.foregroundControls.size);
					}
					const child = update.details?.results[0];
					if (shape === "tasks" && rootIndex === 0 && child?.id && !attachedTo) {
						const control = state.foregroundControls.get(update.details.runId);
						attachedTo = child.id;
						writeNestedEvent(control.nestedRoute, { type: "subagent.nested.started", ts: 1, parentRunId: control.runId, parentStepIndex: 1,
							child: { id: attachmentId, parentRunId: control.runId, parentStepIndex: 1, depth: 1, path: [{ runId: control.runId, childId: child.id }], state: "running", agent: "nested attachment" } });
					}
				}, makeMinimalCtx(temp));
			}));
			assert.equal(finals.length, rootCount, "every configured foreground root is dispatched");
			assert.equal(new Set(finals.map((value) => value.details.runId)).size, rootCount, "each root has its own id");
			assert.equal(maxConcurrentRoots, rootCount, "configured roots overlap while a child is running");
			if (concurrency === 2) {
				assert.equal(new Set(concurrentUpdates.map(({ reportingId }) => reportingId)).size, failure ? 2 : 3, "every launched sibling reports");
				if (!failure) {
					assert.ok(concurrentUpdates.some(({ update, reportingId, children }) => reportingId === children[1].id
						&& !update.details.results.find((entry) => entry.id === children[0].id)?.progress?.lastActivityAt), "second child reports before the delayed first child");
					assert.ok(concurrentUpdates.some(({ children }) => children[2].state === "pending"), "third child waits for a concurrency slot");
				}
				if (failure === "validation") assert.ok(concurrentUpdates.some(({ children }) => children[0].state === "failed"), "validation fails before a sibling reports");
				if (failure === "fail-fast") assert.ok(concurrentUpdates.some(({ children }) => children[2].state === "failed"), "fail-fast skips the queued child before a sibling reports");
				for (const { update, children } of concurrentUpdates) {
					for (const expanded of [false, true]) {
						const text = render(update, expanded);
						const rows = text.split("\n").filter((line) => children.some((child) => new RegExp(`^\\s*${child.id.slice(0, 6)} `).test(line)));
						assert.deepEqual(rows.map((line) => line.trim().slice(0, 6)), children.map((child) => child.id.slice(0, 6)), "each child has exactly one row in flat-index order, even before its first report");
						for (const [index, child] of children.entries()) assert.match(rows[index], new RegExp(`echo - ${child.label}`));
					}
					for (const child of children) {
						assert.equal(update.details.results[child.index]?.id, child.id, "result slots stay aligned with child indexes");
						assert.equal(update.details.results[child.index]?.progress?.status, child.state);
						assert.equal(update.details.progress.filter((entry) => entry.id === child.id).length, 1, "executor pending projection does not duplicate cached progress");
						const node = update.details.workflowGraph.nodes.flatMap((node) => node.children ?? [node]).find((node) => node.flatIndex === child.index);
						assert.equal(node?.status, child.state, "workflow graph uses the same child slot and lifecycle state");
					}
				}
			}
			for (const [rootIndex, final] of finals.entries()) {
				if (failure) assert.equal(final.isError, true, JSON.stringify(final.content));
				else assert.notEqual(final.isError, true, JSON.stringify(final.content));
				if (failure === "validation") assert.match(final.details.results[1].error, /Unknown chain output reference/);
				if (failure === "fail-fast") assert.equal(final.details.results[2].error, "Skipped due to fail-fast");
				// Failed chains show only their active group after settlement.
				const visibleResults = failure ? final.details.results.filter((child) => child.label?.startsWith("audit ")) : final.details.results;
				for (const child of visibleResults) {
					assert.ok(child.label);
					const live = allUpdates[rootIndex].find((update) => update.details.results.some((entry) => entry.id === child.id && entry.progress?.status === (child.exitCode !== 0 ? "failed" : "running")));
					assert.ok(live, `live snapshot for ${child.label}`);
					assert.equal(live.details.runId, final.details.runId, "live and settled rows belong to the same root");
					for (const value of [live, final]) for (const expanded of [false, true]) {
						const text = render(value, expanded);
						assert.match(text, new RegExp(`^\\s*${child.id.slice(0, 6)} .*echo - ${child.label}`, "m"));
						assert.ok(!text.includes(child.id));
						if (shape !== "single") assert.match(text, new RegExp(`^${value.details.runId.slice(0, 6)} `));
					}
				}
				if (shape === "tasks" || (shape === "static" && concurrency === 1)) {
					const pending = allUpdates[rootIndex].find((update) => update.details.progress?.some((entry) => entry.status === "pending"));
					assert.ok(pending, "queued child snapshot");
					for (const child of pending.details.progress.filter((entry) => entry.status === "pending")) for (const expanded of [false, true]) {
						assert.match(render(pending, expanded), new RegExp(`^\\s*${child.id.slice(0, 6)} .*pending`, "m"));
					}
				}
				if (shape === "dynamic") for (const expanded of [false, true]) {
					assert.match(render(final, expanded), /Parallel group .*group audit/);
					assert.doesNotMatch(render(final, expanded), /echo - group audit/);
				}
			}
			if (shape === "tasks") {
				assert.deepEqual(finals[0].details.results[0].progress?.children?.map((entry) => entry.id), [attachmentId]);
				assert.equal(finals[0].details.results[1].progress?.children?.length ?? 0, 0, "a conflicting index must not steal attachment");
			}
		} finally { mock.uninstall(); removeTempDir(temp); }
	});
}

const runningGlyphPattern = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]";

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function outputPathPattern(posixPath: string): RegExp {
	return new RegExp(`output: ${posixPath.split("/").map(escapeRegExp).join("[\\\\/]")}`);
}

function firstGrapheme(text: string): string {
	return Array.from(text.trimStart())[0] ?? "";
}

function firstRunningGlyph(text: string): string {
	return text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/)?.[0] ?? "";
}

function createUiContext(expanded = false) {
	const widgets: unknown[] = [];
	let renderRequests = 0;
	const ctx = {
		hasUI: true,
		ui: {
			theme,
			getToolsExpanded: () => expanded,
			setWidget: (_key: string, value: unknown) => {
				widgets.push(value);
			},
			requestRender: () => {
				renderRequests += 1;
			},
		},
	};
	return {
		ctx,
		widgets,
		get renderRequests() {
			return renderRequests;
		},
	};
}

describe("subagent async widget rendering", () => {
	it("orders running jobs before queued rows and completions", () => {
		const lines = buildWidgetLines([
			{ asyncId: "done-1", asyncDir: "/tmp/done", status: "complete", agents: ["reviewer"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "queued-1", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"], startedAt: 0, updatedAt: 1000 },
			{ asyncId: "run-1", asyncDir: "/tmp/run", status: "running", agents: ["scout"], currentStep: 0, stepsTotal: 2, startedAt: Date.now() - 1000, updatedAt: Date.now(), currentTool: "read", currentToolStartedAt: Date.now() - 500 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, new RegExp(`^${runningGlyphPattern} Async agents · background`));
		assert.ok(text.indexOf("scout") < text.indexOf("queued"), "running row should precede queued summary");
		assert.ok(text.indexOf("queued") < text.indexOf("reviewer"), "queued summary should precede completions");
		assert.match(text, /⎿  read/);
	});

	it("uses parallel running/done wording for async jobs with parallel groups", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["scout", "reviewer", "worker"], hasParallelGroups: true, activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running · 0\/3 done/);
		assert.match(text, /⎿  thinking…/);
		assert.doesNotMatch(text, /parallel · scout, reviewer, worker/);
		assert.doesNotMatch(text, /step 1\/3/);
	});

	it("collapses repeated async parallel agent names", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", mode: "parallel", agents: ["reviewer", "reviewer", "reviewer"], activeParallelGroup: true, runningSteps: 3, completedSteps: 0, stepsTotal: 3 },
		], theme, 120);

		const text = lines.join("\n");
		assert.match(text, /parallel · 3 agents running/);
		assert.doesNotMatch(text, /parallel · reviewer ×3/);
		assert.doesNotMatch(text, /reviewer → reviewer → reviewer/);
	});

	it("renders a compact component widget for three active parallel agents without core truncation", () => {
		const now = Date.now();
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer", "reviewer", "reviewer"],
			activeParallelGroup: true,
			runningSteps: 3,
			completedSteps: 0,
			stepsTotal: 3,
			updatedAt: now,
			steps: [
				{ index: 0, agent: "reviewer", status: "running", lastActivityAt: now, turnCount: 5, toolCount: 18, tokens: { input: 30_000, output: 10_000, cache: 4_000, total: 44_000 } },
				{ index: 1, agent: "reviewer", status: "running", lastActivityAt: now - 2000, turnCount: 4, toolCount: 13, tokens: { input: 16_000, output: 4_000, cache: 2_000, total: 22_000 } },
				{ index: 2, agent: "reviewer", status: "running", currentTool: "grep", currentToolStartedAt: now - 1000, turnCount: 3, toolCount: 11, tokens: { input: 14_000, output: 3_000, cache: 2_000, total: 19_000 } },
			],
		}]);
		const widget = ui.widgets.at(-1);
		assert.equal(typeof widget, "function", "renderWidget should install a component widget, not a capped string-array widget");
		const lines = (widget as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(180).map((line) => line.trimEnd());
		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /Agent 1\/3: reviewer · running · active now · 5 turns · 18 tool uses · 44k token/);
		assert.match(text, /Agent 2\/3: reviewer · running · active 2s ago · 4 turns · 13 tool uses · 22k token/);
		assert.match(text, /Agent 3\/3: reviewer · running · grep \| 1\.0s · 3 turns · 11 tool uses · 19k token/);
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.doesNotMatch(text, /widget truncated/);
		assert.ok(lines.length <= 10, "collapsed component should stay under Pi's string-widget cap even though it bypasses it");
	});

	it("shows per-agent detail for active async parallel widget rows", () => {
		const now = Date.now();
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "reviewer", "reviewer"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 1,
				stepsTotal: 3,
				updatedAt: now,
				steps: [
					{ agent: "reviewer", status: "running", lastActivityAt: now, toolCount: 2 },
					{ agent: "reviewer", status: "running", currentTool: "read", currentToolStartedAt: now - 2000 },
					{ agent: "reviewer", status: "complete", tokens: { input: 1000, output: 500, cache: 0, total: 1500 } },
				],
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /async subagent parallel \(3\) · background/);
		assert.match(text, /parallel · 2 agents running · 1\/3 done/);
		assert.match(text, /Agent 1\/3: reviewer · running · 2 tool uses/);
		assert.match(text, /⎿  active now/);
		assert.match(text, /Agent 2\/3: reviewer · running\n\s+⎿  read \| 2\.0s/);
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, /Agent 3\/3: reviewer · complete · 1\.5k token/);
	});

	it("shows model and thinking for active async widget rows", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer", "scout"],
				activeParallelGroup: true,
				runningSteps: 2,
				completedSteps: 0,
				stepsTotal: 2,
				steps: [
					{ agent: "reviewer", status: "running", model: "openai-codex/gpt-5.5:high" },
					{ agent: "scout", status: "running", model: "anthropic/claude-haiku-4-5", thinking: "low" },
				],
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /Agent 1\/2: reviewer · running \(gpt-5\.5 · thinking high\)/);
		assert.match(text, /Agent 2\/2: scout · running \(claude-haiku-4-5 · thinking low\)/);
		assert.doesNotMatch(text, /openai-codex\/gpt-5\.5/);
		assert.doesNotMatch(text, /gpt-5\.5:high/);
	});

	it("keeps async row status visible before long model badges on narrow widgets", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-1",
				asyncDir: "/tmp/1",
				status: "running",
				mode: "parallel",
				agents: ["reviewer"],
				activeParallelGroup: true,
				runningSteps: 1,
				completedSteps: 0,
				stepsTotal: 1,
				steps: [
					{ agent: "reviewer", status: "running", model: "anthropic/claude-opus-4-5-20260501-super-long-model-name:high" },
				],
			},
		], theme, 68);

		const row = lines.find((line) => line.includes("Agent 1/1")) ?? "";
		assert.match(row, /Agent 1\/1: reviewer · running/);
		assert.doesNotMatch(row, /Agent 1\/1: reviewer \(/);
	});

	it("shows inline live detail for expanded async parallel widget rows", () => {
		const now = Date.now();
		const job = {
			asyncId: "run-1",
			asyncDir: "/tmp/1",
			status: "running",
			mode: "parallel",
			agents: ["reviewer"],
			activeParallelGroup: true,
			runningSteps: 1,
			completedSteps: 0,
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "reviewer",
					status: "running",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentTools: [{ tool: "grep", args: "async widget", endMs: now - 3000 }],
					recentOutput: ["found renderWidget", "checking expanded state"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /Press Ctrl\+O for live detail/);
		assert.doesNotMatch(collapsedText, /found renderWidget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press Ctrl\+O for live detail/);
		assert.match(expandedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(expandedText, outputPathPattern("/tmp/1/output-0.log"));
		assert.match(expandedText, /grep: async widget/);
		assert.match(expandedText, /found renderWidget/);
		assert.match(expandedText, /checking expanded state/);
	});

	it("shows step detail and Ctrl+O hint for running single async jobs with steps", () => {
		const now = Date.now();
		const job = {
			asyncId: "single-run",
			asyncDir: "/tmp/single-run",
			status: "running",
			mode: "single",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: now,
			steps: [
				{
					index: 0,
					agent: "worker",
					status: "running",
					currentTool: "read",
					currentToolArgs: "src/tui/render.ts",
					currentToolStartedAt: now - 2000,
					recentOutput: ["reading render widget"],
				},
			],
		};

		const collapsedText = buildWidgetLines([job], theme, 180).join("\n");
		assert.match(collapsedText, /async subagent worker · background/);
		assert.match(collapsedText, /Step 1\/1: worker · running/);
		assert.match(collapsedText, /⎿  read: src\/tui\/render\.ts \| 2\.0s/);
		assert.match(collapsedText, /Press Ctrl\+O for live detail/);
		assert.match(collapsedText, outputPathPattern("/tmp/single-run/output-0.log"));
		assert.doesNotMatch(collapsedText, /reading render widget/);

		const expandedText = buildWidgetLines([job], theme, 180, true).join("\n");
		assert.doesNotMatch(expandedText, /Press Ctrl\+O for live detail/);
		assert.match(expandedText, /reading render widget/);
	});

	it("keeps generic activity fallback for single async jobs without steps", () => {
		const now = Date.now();
		const text = buildWidgetLines([
			{
				asyncId: "single-no-steps",
				asyncDir: "/tmp/single-no-steps",
				status: "running",
				mode: "single",
				agents: ["worker"],
				currentTool: "read",
				currentToolStartedAt: now - 1000,
				updatedAt: now,
			},
		], theme, 180).join("\n");

		assert.match(text, /⎿  read 1\.0s/);
		assert.doesNotMatch(text, /Step 1\/1/);
		assert.doesNotMatch(text, /Press Ctrl\+O for live detail/);
	});

	it("includes logical chain context for active async chain parallel groups", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-chain",
				asyncDir: "/tmp/chain",
				status: "running",
				mode: "chain",
				agents: ["reviewer", "auditor"],
				activeParallelGroup: true,
				currentStep: 1,
				chainStepCount: 3,
				parallelGroups: [{ start: 1, count: 2, stepIndex: 1 }],
				runningSteps: 1,
				completedSteps: 1,
				stepsTotal: 2,
			},
		], theme, 160);

		const text = lines.join("\n");
		assert.match(text, /step 2\/3 · parallel group: 1 agent running · 1\/2 done/);
	});

	it("keeps stop-id rows for pending steps outside the polled active parallel group", async (t) => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const { createAsyncJobTracker } = await import("../../src/runs/background/async-job-tracker.ts");
		const { createTempDir, removeTempDir, createEventBus } = await import("../support/helpers.ts");
		const root = createTempDir("pi-widget-pending-");
		const state = {
			asyncJobs: new Map(), cleanupTimers: new Map(), retainedNestedRoutes: new Map(), foregroundControls: new Map(),
			poller: null, resultFileCoalescer: { clear() {} },
		};
		const tracker = createAsyncJobTracker({ events: createEventBus() }, state as never, root);
		const intervals = t.mock.method(globalThis, "setInterval");
		try {
			const runDir = path.join(root, "run-chain");
			fs.mkdirSync(runDir);
			const steps = [
				{ id: "aaa000-scout", agent: "scout", status: "complete" },
				{ id: "bbb111-reviewer", agent: "reviewer", status: "running" },
				{ id: "ccc222-auditor", agent: "auditor", status: "complete" },
				{ id: "ddd333-writer", agent: "writer", status: "pending" },
				{ id: "eee444-editor", agent: "editor", status: "pending" },
			];
			tracker.handleStarted({ id: "run-chain", asyncDir: runDir, mode: "chain", agents: steps.map((step) => step.agent) });
			assert.equal(intervals.mock.calls.length, 1);
			for (const inactiveGroups of [false, true]) await t.test(inactiveGroups ? "completed and pending groups" : "pending sequential steps", () => {
				const chainStepCount = inactiveGroups ? 3 : 4;
				const parallelGroups = [
					...(inactiveGroups ? [{ start: 0, count: 1, stepIndex: 0 }] : []),
					{ start: 1, count: 2, stepIndex: 1 },
					...(inactiveGroups ? [{ start: 3, count: 2, stepIndex: 2 }] : []),
				];
				const nodes = steps.map((step, flatIndex) => ({
					id: step.id, kind: "agent", agent: step.agent, label: step.agent,
					status: step.status === "complete" ? "completed" : step.status, flatIndex,
				}));
				fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({
					runId: "run-chain", mode: "chain", state: "running", startedAt: Date.now(), lastUpdate: Date.now(),
					currentStep: inactiveGroups ? 2 : 1, chainStepCount, parallelGroups, steps,
					workflowGraph: { runId: "run-chain", mode: "chain", phases: [], nodes: [
						inactiveGroups ? { id: "before", kind: "parallel-group", label: "before", status: "completed", stepIndex: 0, children: nodes.slice(0, 1) }
							: { ...nodes[0], kind: "step", stepIndex: 0 },
						{ id: "review", kind: inactiveGroups ? "dynamic-parallel-group" : "parallel-group", label: "review", status: "running", stepIndex: 1, children: nodes.slice(1, 3) },
						...(inactiveGroups ? [{ id: "after", kind: "parallel-group", label: "after", status: "pending", stepIndex: 2, children: nodes.slice(3) }]
							: nodes.slice(3).map((node, index) => ({ ...node, kind: "step", stepIndex: index + 2 }))),
					] },
				}));
				intervals.mock.calls[0].arguments[0]();
				const job = state.asyncJobs.get("run-chain");
				assert.equal(job.activeParallelGroup, true);
				assert.deepEqual(job.agents, ["reviewer", "auditor"]);
				assert.equal(job.stepsTotal, 2);
				assert.equal(job.runningSteps, 1);
				assert.equal(job.completedSteps, 1);
				const positions = inactiveGroups
					? ["Agent 1/1", "Agent 1/2", "Agent 2/2", "Agent 1/2", "Agent 2/2"]
					: ["Step 1/4", "Agent 1/2", "Agent 2/2", "Step 3/4", "Step 4/4"];
				for (const expanded of [false, true]) for (const width of [32, 180]) for (const multiple of [false, true]) {
					const jobs = multiple ? [job, { asyncId: "other-run", asyncDir: root, status: "running", agents: ["other"] }] : [job];
					const ui = createUiContext(expanded);
					renderWidget(ui.ctx as never, jobs);
					const widget = ui.widgets.at(-1) as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] };
					for (const lines of [buildWidgetLines(jobs, theme, width, expanded), widget(undefined, theme).render(width)]) {
						const text = lines.join("\n");
						assert.deepEqual(lines.filter((line) => /Parallel group \d/.test(line)).map((line) => line.trim()), ["Parallel group 2: review"]);
						for (const [index, step] of steps.entries()) {
							const rows = lines.filter((line) => new RegExp(`^\\s*${step.id.slice(0, 6)} `).test(line));
							assert.equal(rows.length, 1, `one row for ${step.id} at width ${width}, expanded=${expanded}, multiple=${multiple}`);
							assert.ok(rows[0].includes(`${positions[index]}:`), rows[0]);
							if (width === 180) assert.ok(rows[0].includes(`${step.agent} · ${step.status}`), rows[0]);
						}
						if (width === 180) assert.match(text, new RegExp(`step 2/${chainStepCount} · parallel group: 1 agent running · 1/2 done`));
					}
				}
			});
		} finally {
			tracker.resetJobs();
			if (state.poller) clearInterval(state.poller);
			removeTempDir(root);
		}
	});

	it("uses logical chain steps after an async chain parallel group finishes", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "run-chain",
				asyncDir: "/tmp/chain",
				status: "running",
				mode: "chain",
				agents: ["scout", "reviewer", "auditor", "writer"],
				activeParallelGroup: false,
				currentStep: 3,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 3, stepIndex: 0 }],
				stepsTotal: 4,
				steps: [
					{ index: 0, agent: "scout", status: "complete" },
					{ index: 1, agent: "reviewer", status: "complete" },
					{ index: 2, agent: "auditor", status: "complete" },
					{ index: 3, agent: "writer", status: "running", toolCount: 1 },
				],
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /async subagent chain \(2\)/);
		assert.match(text, /chain · step 2\/2/);
		assert.match(text, /Parallel group 1\/2 · 3\/3 done/);
		assert.match(text, /Step 2\/2: writer · running · 1 tool use/);
		assert.match(text, /Press Ctrl\+O for live detail/);
		assert.match(text, outputPathPattern("/tmp/chain/output-3.log"));
		assert.doesNotMatch(text, /step 4\/4/);
		assert.doesNotMatch(text, /Step 4\/4/);
	});

	it("omits zero-running labels for pending active async parallel groups", () => {
		const lines = buildWidgetLines([
			{
				asyncId: "parallel-pending",
				asyncDir: "/tmp/parallel-pending",
				status: "running",
				mode: "parallel",
				agents: ["scout", "reviewer", "worker"],
				activeParallelGroup: true,
				runningSteps: 0,
				completedSteps: 0,
				stepsTotal: 3,
			},
			{
				asyncId: "chain-pending",
				asyncDir: "/tmp/chain-pending",
				status: "running",
				mode: "chain",
				agents: ["reviewer", "auditor"],
				activeParallelGroup: true,
				currentStep: 0,
				chainStepCount: 2,
				parallelGroups: [{ start: 0, count: 2, stepIndex: 0 }],
				runningSteps: 0,
				completedSteps: 0,
				stepsTotal: 2,
			},
		], theme, 180);

		const text = lines.join("\n");
		assert.match(text, /parallel · 0\/3 done/);
		assert.match(text, /chain · step 1\/2 · parallel group: 0\/2 done/);
		assert.doesNotMatch(text, /0 agents running/);
	});

	it("keeps running jobs beyond the job cap", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["a1"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "run-5", asyncDir: "/tmp/5", status: "running", agents: ["a5"] },
		], theme, 120);

		assert.match(lines.join("\n"), /^run-5 . a5/m);
	});

	it("keeps queued work beyond the job cap", () => {
		const lines = buildWidgetLines([
			{ asyncId: "run-1", asyncDir: "/tmp/1", status: "running", agents: ["queued-scanner"] },
			{ asyncId: "run-2", asyncDir: "/tmp/2", status: "running", agents: ["a2"] },
			{ asyncId: "run-3", asyncDir: "/tmp/3", status: "running", agents: ["a3"] },
			{ asyncId: "run-4", asyncDir: "/tmp/4", status: "running", agents: ["a4"] },
			{ asyncId: "queued-1", asyncDir: "/tmp/q", status: "queued", agents: ["planner"] },
		], theme, 120);

		assert.match(lines.join("\n"), /^queued ◦ planner/m);
	});

	it("advances running widget glyphs when progress seed changes", () => {
		const first = buildWidgetLines([
			{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 11 },
			{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
		], theme, 120);
		const second = buildWidgetLines([
			{ asyncId: "run-progress", asyncDir: "/tmp/run", status: "running", agents: ["worker"], updatedAt: 12 },
			{ asyncId: "run-other", asyncDir: "/tmp/other", status: "running", agents: ["scout"], updatedAt: 0 },
		], theme, 120);

		assert.notEqual(firstGrapheme(first[0] ?? ""), firstGrapheme(second[0] ?? ""), "header glyph should advance from changed progress");
		assert.notEqual(firstRunningGlyph(first[1] ?? ""), firstRunningGlyph(second[1] ?? ""), "job glyph should advance from changed progress");

		const firstStep = buildWidgetLines([{
			asyncId: "run-step-progress",
			asyncDir: "/tmp/run-step",
			status: "running",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: 20,
			steps: [{ agent: "worker", status: "running", currentToolStartedAt: 10 }],
		}], theme, 120);
		const secondStep = buildWidgetLines([{
			asyncId: "run-step-progress",
			asyncDir: "/tmp/run-step",
			status: "running",
			agents: ["worker"],
			stepsTotal: 1,
			updatedAt: 20,
			steps: [{ agent: "worker", status: "running", currentToolStartedAt: 11 }],
		}], theme, 120);
		assert.notEqual(
			firstRunningGlyph(firstStep.find((line) => line.includes("Step 1/1")) ?? ""),
			firstRunningGlyph(secondStep.find((line) => line.includes("Step 1/1")) ?? ""),
			"step glyph should advance from changed step progress",
		);
	});

	it("keeps running widget output stable when progress seed is unchanged", async () => {
		const job = {
			asyncId: "run-stable",
			asyncDir: "/tmp/run",
			status: "running",
			agents: ["worker"],
			startedAt: 1_000,
			updatedAt: 3_000,
			currentTool: "read",
			currentToolStartedAt: 2_000,
			lastActivityAt: 2_500,
		};
		const first = buildWidgetLines([job], theme, 120);
		await new Promise((resolve) => setTimeout(resolve, 120));
		const second = buildWidgetLines([job], theme, 120);

		assert.deepEqual(second, first);
		assert.equal(firstGrapheme(first[1] ?? ""), firstGrapheme(second[1] ?? ""));
	});

	it("does not animate queued-only widgets", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{ asyncId: "queued-only", asyncDir: "/tmp/queued", status: "queued", agents: ["planner"] }]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, initialWidgetCount, "static queued widget should not refresh at animation cadence");
		assert.equal(ui.renderRequests, 0);
	});

	it("clears legacy result row animation timers", async () => {
		let ticks = 0;
		const context = {
			state: { subagentResultAnimationTimer: setInterval(() => { ticks += 1; }, 10) },
		};
		try {
			clearLegacyResultAnimationTimer(context);
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.equal(context.state.subagentResultAnimationTimer, undefined);
			assert.equal(ticks, 0, "legacy timer should be cleared before it can tick");
		} finally {
			if (context.state.subagentResultAnimationTimer) clearInterval(context.state.subagentResultAnimationTimer);
		}
	});

	it("retains every live target through component height, width, and job budgets", () => {
		const ui = createUiContext(true);
		const children = Array.from({ length: 16 }, (_, index) => ({
			id: `c${String(index).padStart(5, "0")}-child`, agent: "worker", label: "audit", state: index % 2 ? "queued" : "running",
			parentRunId: "abcdef-root", depth: 1, path: [], lastUpdate: 1,
		}));
		const jobs = [
			{ asyncId: "settle-root", asyncDir: "/tmp/s", status: "complete", nestedChildren: children },
			...Array.from({ length: 5 }, (_, index) => ({ asyncId: `r${String(index).padStart(5, "0")}-root`, asyncDir: "/tmp/r", status: "running", agents: ["worker"] })),
		];
		renderWidget(ui.ctx as never, jobs);
		const widget = ui.widgets.at(-1) as (_tui: unknown, widgetTheme: typeof theme) => { render(width: number): string[] };
		const text = widget(undefined, theme).render(32).join("\n");
		for (const child of children) assert.match(text, new RegExp(`^\\s*${child.id.slice(0, 6)} `, "m"));
		for (const job of jobs) assert.match(text, new RegExp(`^\\s*${job.asyncId.slice(0, 6)} `, "m"));
		assert.doesNotMatch(text, /c00000-child|r00000-root/);
	});

	it("does not refresh running widgets at animation cadence", async () => {
		const ui = createUiContext();
		renderWidget(ui.ctx as never, [{ asyncId: "run-static", asyncDir: "/tmp/run", status: "running", agents: ["scout"] }]);
		const initialWidgetCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, initialWidgetCount, "running widget should wait for status updates instead of animation ticks");
		assert.equal(ui.renderRequests, 0);

		renderWidget(ui.ctx as never, []);
		const afterClearCount = ui.widgets.length;
		await new Promise((resolve) => setTimeout(resolve, 190));
		assert.equal(ui.widgets.length, afterClearCount, "cleared widget should stay quiet");
		assert.equal(ui.widgets.at(-1), undefined);
	});
});
