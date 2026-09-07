import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import type { SubagentState } from "../../src/shared/types.ts";

function createState(): SubagentState {
	return {
		baseCwd: "/repo",
		currentSessionId: null,
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
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

describe("result watcher", () => {
	it("processes deferred session-scoped results after session identity is restored", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			const resultPath = path.join(resultsDir, "session-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "session-run",
				sessionId: "session-current",
				success: true,
				summary: "done",
			}), "utf-8");

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(emitted.length, 0);
				assert.equal(fs.existsSync(resultPath), true);

				state.currentSessionId = "session-current";
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs malformed result files instead of swallowing them silently", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0);
			assert.ok(
				logged.some((entry) => /Failed to process subagent result file/.test(String(entry[0] ?? ""))),
				"expected watcher error to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when an active fs.watch emits ENOSPC", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
			const fakeWatcher = {
				on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
					if (event === "error") emitWatcherError = handler;
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as fs.FSWatcher;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => fakeWatcher,
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, fakeWatcher);
				const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
				enospc.code = "ENOSPC";
				emitWatcherError?.(enospc);
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(path.join(resultsDir, "done.json"), JSON.stringify({ sessionId: "session-1", summary: "done" }), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 75));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("enriches async completion with nested registry children before deletion", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
		const route = createNestedRoute("async-nested-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: Date.now(),
				parentRunId: "async-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-child",
					parentRunId: "async-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-root", stepIndex: 0 }],
					state: "complete",
					agent: "nested-reviewer",
					sessionFile: path.join(resultsDir, "nested-child.jsonl"),
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-root.json");
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-root",
					runId: "async-nested-root",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{ agent: "owner", output: "owner done", success: true }],
					sessionId: "session-1",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }>; results?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
			assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("filters malformed explicit nested children in result files before compacting", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, handler: (payload: unknown) => void) {
						const eventListeners = listeners.get(event) ?? new Set();
						eventListeners.add(handler);
						listeners.set(event, eventListeners);
						return () => eventListeners.delete(handler);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const handler of listeners.get(event) ?? []) handler(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-explicit-nested.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-explicit-nested",
					runId: "async-explicit-nested",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{
						agent: "owner",
						output: "owner done",
						success: true,
						children: [
							{ id: "child-explicit-good", parentRunId: "async-explicit-nested", depth: 1, path: [{ runId: "async-explicit-nested" }], state: "complete", agent: "child-good" },
							{ id: "child-explicit-bad", path: "not-an-array" },
						],
					}],
					nestedChildren: [
						{ id: "top-explicit-good", parentRunId: "async-explicit-nested", parentStepIndex: 0, depth: 1, path: [{ runId: "async-explicit-nested", stepIndex: 0 }], state: "complete", agent: "top-good" },
						{ id: "top-explicit-bad", path: "not-an-array" },
					],
					sessionId: "session-1",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			assert.ok(logged.some((entry) => String(entry[0] ?? "").includes(resultPath) && /invalid nested child record/.test(String(entry[0] ?? ""))));
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ children?: Array<{ id?: string }> }>; nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["top-explicit-good"]);
			assert.deepEqual(completion?.results?.[0]?.children?.map((child) => child.id)?.sort(), ["child-explicit-good", "top-explicit-good"].sort());
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retries and delivers result files after nested registry enrichment recovers", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
		const route = createNestedRoute("async-nested-retry");
		try {
			const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
			fs.writeFileSync(registryPath, "{", "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: 100,
				parentRunId: "async-nested-retry",
				parentStepIndex: 0,
				child: {
					id: "nested-retry-child",
					parentRunId: "async-nested-retry",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-retry", stepIndex: 0 }],
					state: "complete",
					agent: "child",
				},
			});
			const emitted: Array<{ event: string; data: unknown }> = [];
			const listeners = new Map<string, Set<(payload: unknown) => void>>();
			const pi = {
				events: {
					on(event: string, listener: (payload: unknown) => void) {
						const set = listeners.get(event) ?? new Set();
						set.add(listener);
						listeners.set(event, set);
						return () => set.delete(listener);
					},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
						for (const listener of listeners.get(event) ?? []) listener(data);
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-retry.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-retry",
					runId: "async-nested-retry",
					agent: "owner",
					success: true,
					state: "complete",
					summary: "owner done",
					sessionId: "session-1",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(emitted.length, 0);
				assert.ok(
					logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
					"expected nested enrichment retry warning to be logged",
				);

				fs.rmSync(registryPath, { force: true });
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 650));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["nested-retry-child"]);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

});
