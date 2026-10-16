import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import type { SubagentState } from "../../src/shared/types.ts";

const FALLBACK_LOG = "fell back to polling because native fs.watch is unavailable";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: "session-1",
		asyncJobs: new Map(),
		grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() },
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		safetyRescanTimer: null,
		resultFileCoalescer: { schedule: () => false, clear: () => {} },
	};
}

type RecordedInterval = { handler: () => void; delayMs: number; handle: NodeJS.Timeout };

function createTimers() {
	const intervals: RecordedInterval[] = [];
	const cleared: NodeJS.Timeout[] = [];
	const timers = {
		setTimeout,
		clearTimeout() {},
		setInterval(handler: () => void, delayMs?: number) {
			const handle = { unref() {} } as NodeJS.Timeout;
			intervals.push({ handler, delayMs: delayMs ?? 0, handle });
			return handle;
		},
		clearInterval(handle?: NodeJS.Timeout) {
			if (handle) cleared.push(handle);
		},
	};
	return { timers, intervals, cleared };
}

function createHarness() {
	const emitted: Array<{ event: string; data: unknown }> = [];
	const pi = {
		events: {
			on: () => () => {},
			emit(event: string, data: unknown) { emitted.push({ event, data }); },
		},
	};
	const logged: string[] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-safety-rescan-"));
	return {
		pi, logged, resultsDir,
		completions: () => emitted.filter((entry) => entry.event === "subagent:async-complete").length,
		fellBack: () => logged.some((line) => line.includes(FALLBACK_LOG)),
		writeResult(name: string) {
			fs.writeFileSync(path.join(resultsDir, name), JSON.stringify({ sessionId: "session-1", summary: "done" }), "utf-8");
		},
		dispose() {
			console.error = originalError;
			fs.rmSync(resultsDir, { recursive: true, force: true });
		},
	};
}

const silentWatcher = {
	on() { return silentWatcher; },
	close() {},
	unref() {},
} as unknown as fs.FSWatcher;

async function waitFor(predicate: () => boolean, budgetMs = 1000): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

describe("result watcher safety rescan", () => {
	it("consumes a result the silent native watcher never reported, exactly once", async () => {
		const h = createHarness();
		try {
			const state = createState();
			const { timers, intervals } = createTimers();
			const watcher = createResultWatcher(h.pi, state, h.resultsDir, 60_000, { fs: { ...fs, watch: () => silentWatcher }, timers });
			try {
				watcher.startResultWatcher();
				watcher.primeExistingResults();
				assert.equal(intervals.length, 1);
				assert.equal(intervals[0].delayMs, 1000);
				assert.equal(state.safetyRescanTimer, intervals[0].handle);
				assert.equal(state.watcherRestartTimer, null);
				h.writeResult("done.json");
				intervals[0].handler();
				assert.ok(await waitFor(() => !fs.existsSync(path.join(h.resultsDir, "done.json"))), "result file not consumed");
			} finally {
				watcher.stopResultWatcher();
			}
			assert.equal(h.completions(), 1);
			assert.equal(h.fellBack(), false);
		} finally { h.dispose(); }
	});

	it("clears the safety interval on stop", () => {
		const h = createHarness();
		try {
			const state = createState();
			const { timers, intervals, cleared } = createTimers();
			const watcher = createResultWatcher(h.pi, state, h.resultsDir, 60_000, { fs: { ...fs, watch: () => silentWatcher }, timers });
			watcher.startResultWatcher();
			assert.equal(intervals.length, 1);
			const handle = state.safetyRescanTimer;
			assert.equal(handle, intervals[0].handle);
			watcher.stopResultWatcher();
			assert.equal(state.safetyRescanTimer, null);
			assert.ok(cleared.includes(handle as NodeJS.Timeout));
		} finally { h.dispose(); }
	});

	it("keeps the EMFILE polling fallback and never arms the safety interval", async () => {
		const h = createHarness();
		try {
			const state = createState();
			const { timers, intervals } = createTimers();
			const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });
			const watcher = createResultWatcher(h.pi, state, h.resultsDir, 60_000, {
				fs: { ...fs, watch: () => { throw emfile; } }, timers,
			});
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.equal(state.safetyRescanTimer, null);
				assert.equal(intervals.length, 1);
				assert.equal(intervals[0].delayMs, 3000);
				assert.equal(state.watcherRestartTimer, intervals[0].handle);
				assert.ok(h.logged.some((line) => line.includes(`${FALLBACK_LOG} (EMFILE)`)));
				h.writeResult("done.json");
				intervals[0].handler();
				assert.ok(await waitFor(() => !fs.existsSync(path.join(h.resultsDir, "done.json"))), "result file not consumed");
			} finally { watcher.stopResultWatcher(); }
			assert.equal(h.completions(), 1);
			assert.equal(state.safetyRescanTimer, null);
		} finally { h.dispose(); }
	});
});
