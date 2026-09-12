/**
 * Red-phase tests pinning the Task 22 contract requirements:
 *
 * 1. wrapWithConformanceHarness exists and is exported.
 * 2. registerExecutionBackendConformance accepts () => ExecutionBackend (real SPI),
 *    not () => ConformanceBackend.
 * 3. Broken adapter liveness proofs – the redesigned conformance tests catch:
 *    a. release-closes-surface via test #9
 *    b. reconcile-without-timestamp via test #8
 *    c. wrong-observed-cwd via harness in test #3
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CONFORMANCE_TEST_COUNT,
	type ConformanceHarness,
	createConformanceBackend,
	registerExecutionBackendConformance,
	wrapWithConformanceHarness,
} from "../../src/execution-backend/testkit.ts";
import {
	EXECUTION_BACKEND_PROTOCOL_VERSION,
	type ExecutionBackend,
	type ExecutionBackendCloseReason,
	type ExecutionBackendEvent,
	type ExecutionSurfaceHandle,
	type ExecutionSurfaceRequest,
} from "../../src/execution-backend/types.ts";

// ── wrapWithConformanceHarness ────────────────────────────────────────────────

describe("wrapWithConformanceHarness", () => {
	it("is exported from the testkit", () => {
		assert.equal(typeof wrapWithConformanceHarness, "function");
	});

	it("wraps a backend and captures lastLaunchRequest", async () => {
		const backend = createConformanceBackend();
		const harness = wrapWithConformanceHarness(backend);
		assert.equal(typeof harness.wrappedBackend, "object");
		assert.equal(harness.lastLaunchRequest, undefined);

		const request: ExecutionSurfaceRequest = {
			command: "test",
			args: [],
			cwd: "/test/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		};
		const lease = await harness.wrappedBackend.launch(request);
		assert.equal(harness.lastLaunchRequest?.cwd, "/test/cwd");
		await lease.release();
	});

	it("inject delivers an event through the wrapped lease's events", async () => {
		const backend = createConformanceBackend();
		const harness = wrapWithConformanceHarness(backend);
		const lease = await harness.wrappedBackend.launch({
			command: "test",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});

		const injectedEvent: ExecutionBackendEvent = {
			timestamp: 12345,
			type: "exited",
			status: 0,
			signal: null,
			source: "mux",
			surface: lease.handle.surface,
		};
		harness.inject(injectedEvent);

		const iter = lease.events[Symbol.asyncIterator]();
		const next = await iter.next();
		assert.equal(next.done, false);
		assert.equal(next.value.type, "exited");
		assert.equal(next.value.timestamp, 12345);
		await lease.release();
	});

	it("injectedQueue reflects unread injected events", async () => {
		const backend = createConformanceBackend();
		const harness = wrapWithConformanceHarness(backend);
		const lease = await harness.wrappedBackend.launch({
			command: "test",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});

		assert.equal(harness.injectedQueue.length, 0);
		harness.inject({
			timestamp: Date.now(),
			type: "exited",
			status: 0,
			signal: null,
			source: "mux",
			surface: lease.handle.surface,
		});
		assert.equal(harness.injectedQueue.length, 1);
		await lease.release();
	});
});

// ── Real ExecutionBackend accepted by registerExecutionBackendConformance ─────

describe("registerExecutionBackendConformance accepts () => ExecutionBackend", () => {
	it("accepts a plain ExecutionBackend (not ConformanceBackend)", () => {
		// A backend that implements ExecutionBackend but has no .state or .push
		const minimalBackend: ExecutionBackend = {
			name: "minimal",
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
			detect: async () => ({ available: true, version: "1", capabilities: [] }),
			launch: async () => ({
				handle: {
					protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
					backend: "minimal",
					surface: { kind: "pane", id: "s1" },
					display: { label: "minimal:s1", hint: "minimal:s1" },
					data: null,
				},
				events: (async function* () {})(),
				reconcile: async () => [],
				release: async () => {},
			}),
			reattach: async () => ({ status: "gone" }),
			close: async () => {},
		};

		const registered: string[] = [];
		// This must NOT throw even though minimalBackend has no .state property
		const count = registerExecutionBackendConformance({
			test: (name) => { registered.push(name); },
			name: "minimal",
			createBackend: () => minimalBackend,
		});
		assert.equal(count, CONFORMANCE_TEST_COUNT);
		assert.equal(registered.length, CONFORMANCE_TEST_COUNT);
	});
});

// ── Broken adapter liveness proofs ───────────────────────────────────────────

/** A backend whose release() closes the surface (bug: reattach returns "gone"). */
function createBrokenReleaseBackend(): ExecutionBackend {
	const closedSurfaces = new Set<string>();
	return {
		name: "broken-release",
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		detect: async () => ({ available: true, version: "1", capabilities: [] }),
		launch: async () => {
			const handle: ExecutionSurfaceHandle = {
				protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
				backend: "broken-release",
				surface: { kind: "pane", id: "s-broken-rel" },
				display: { label: "broken-rel", hint: "broken-rel" },
				data: null,
			};
			return {
				handle,
				events: (async function* () {})(),
				reconcile: async () => [],
				release: async () => {
					// BUG: marks as closed on release (should not do this)
					closedSurfaces.add(handle.surface.id);
				},
			};
		},
		reattach: async (handle) => {
			if (closedSurfaces.has(handle.surface.id)) return { status: "gone" };
			return { status: "unknown", reason: "not tracked" };
		},
		close: async (handle) => {
			closedSurfaces.add(handle.surface.id);
		},
	};
}

/** A backend whose reconcile() returns events without a timestamp field. */
function createNoTimestampBackend(): ExecutionBackend {
	return {
		name: "no-timestamp",
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		detect: async () => ({ available: true, version: "1", capabilities: [] }),
		launch: async () => {
			const handle: ExecutionSurfaceHandle = {
				protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
				backend: "no-timestamp",
				surface: { kind: "pane", id: "s-no-ts" },
				display: { label: "no-ts", hint: "no-ts" },
				data: null,
			};
			return {
				handle,
				events: (async function* () {})(),
				// BUG: reconcile returns events missing required timestamp field
				reconcile: async () => ([
					{
						type: "unknown",
						fact: "snapshot",
						reason: "native",
						source: "mux",
						surface: handle.surface,
						// NO timestamp field – violates ExecutionBackendFactBase
					} as unknown as ExecutionBackendEvent,
				]),
				release: async () => {},
			};
		},
		reattach: async () => ({ status: "unknown", reason: "not supported" }),
		close: async () => {},
	};
}

/**
 * A harness whose lastLaunchRequest.cwd is wrong (simulates a buggy adapter
 * integration that corrupts the observed cwd).
 */
function createBrokenCwdHarness(backend: ExecutionBackend): ConformanceHarness {
	const harness = wrapWithConformanceHarness(backend);
	let wrongLastRequest: ExecutionSurfaceRequest | undefined;

	const origLaunch = harness.wrappedBackend.launch.bind(harness.wrappedBackend);
	const brokenWrapped: ExecutionBackend = {
		...harness.wrappedBackend,
		launch: async (req) => {
			// BUG: records wrong cwd (simulates adapter that corrupts the observed path)
			wrongLastRequest = { ...req, cwd: "/wrong/cwd" };
			return origLaunch(req);
		},
	};

	return {
		wrappedBackend: brokenWrapped,
		get lastLaunchRequest() { return wrongLastRequest; },
		inject: (event) => harness.inject(event),
		get injectedQueue() { return harness.injectedQueue; },
		get injectedSuspended() { return harness.injectedSuspended; },
	};
}

describe("broken adapter liveness proofs", () => {
	it("broken release: conformance test #9 catches release-closes-surface", async () => {
		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => tests.push([name, fn]),
			name: "broken-release",
			createBackend: createBrokenReleaseBackend,
		});
		const [, fn] = tests.find(([n]) => n.includes("release and iterator return stop observation")) ?? [];
		assert.ok(fn, "release conformance test must be registered");
		await assert.rejects(
			() => fn!(),
			"broken adapter should cause the release conformance test to fail",
		);
	});

	it("no-timestamp reconcile: conformance test #8 catches missing timestamp", async () => {
		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => tests.push([name, fn]),
			name: "no-timestamp",
			createBackend: createNoTimestampBackend,
		});
		const [, fn] = tests.find(([n]) => n.includes("reconcile returns conforming events")) ?? [];
		assert.ok(fn, "reconcile conformance test must be registered");
		await assert.rejects(
			() => fn!(),
			"broken adapter should cause the reconcile conformance test to fail",
		);
	});

	it("wrong-cwd harness: conformance test #3 catches wrong observed cwd via harness", async () => {
		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => tests.push([name, fn]),
			name: "broken-cwd",
			createBackend: () => createConformanceBackend() as ExecutionBackend,
			createHarness: (backend) => createBrokenCwdHarness(backend),
		});
		const [, fn] = tests.find(([n]) => n.includes("exact cwd")) ?? [];
		assert.ok(fn, "cwd conformance test must be registered");
		await assert.rejects(
			() => fn!(),
			"broken harness should cause the cwd conformance test to fail",
		);
	});

	it("reattach lease lifecycle: tests 9 and 12 release the reattached lease via finally", async () => {
		// Instrument a conformance backend to count how many times
		// a reattach lease's release() is invoked. Tests 9 and 12 each
		// acquire a reattached lease and must release it via the try/finally
		// block even when subsequent assertions fail.
		let reattachReleaseCount = 0;
		const base = createConformanceBackend();
		const instrumentedBackend: ExecutionBackend = {
			...base,
			async reattach(handle) {
				const result = await base.reattach(handle);
				if (result.status !== "present") return result;
				const orig = result.lease;
				return {
					status: "present" as const,
					lease: {
						...orig,
						async release() {
							reattachReleaseCount++;
							return orig.release();
						},
					},
				};
			},
		};

		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => tests.push([name, fn]),
			name: "reattach-lifecycle",
			createBackend: () => instrumentedBackend,
		});

		const fn9 = tests.find(([n]) => n.includes("release and iterator return stop observation"))?.[1];
		const fn12 = tests.find(([n]) => n.includes("treats retention as release"))?.[1];
		assert.ok(fn9, "test 9 must be registered");
		assert.ok(fn12, "test 12 must be registered");

		const before9 = reattachReleaseCount;
		await fn9!();
		assert.equal(reattachReleaseCount, before9 + 1, "test 9 must release the reattached lease exactly once");

		const before12 = reattachReleaseCount;
		await fn12!();
		assert.equal(reattachReleaseCount, before12 + 1, "test 12 must release the reattached lease exactly once");
	});
});

// ── Minimal real ExecutionBackend for full-suite regression ─────────────────────────

/**
 * A minimal but fully-conformant ExecutionBackend that tracks launched and
 * closed surfaces with real state. Rejects any synthetic handle it never
 * launched by returning "gone". Used to prove the conformance suite executes
 * end-to-end against a real (non-fixture) backend.
 */
function createMinimalRealBackend(): ExecutionBackend {
	const launched = new Set<string>();
	const closed = new Set<string>();

	return {
		name: "minimal-real",
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		detect: async () => ({ available: true, version: "1.0.0", capabilities: [] }),
		launch: async () => {
			const id = `surf-${Math.random().toString(36).slice(2, 9)}`;
			launched.add(id);
			const surface = { kind: "pane" as const, id };
			const handle: ExecutionSurfaceHandle = {
				protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
				backend: "minimal-real",
				surface,
				display: { label: `minimal-real:${id}`, hint: `minimal-real:${id}` },
				data: null,
			};
			return {
				handle,
				events: (async function* () {})(),
				reconcile: async () => [],
				release: async () => {},
			};
		},
		reattach: async (handle) => {
			const id = handle.surface.id;
			if (closed.has(id) || !launched.has(id)) return { status: "gone" as const };
			const ts = Date.now();
			const surface = handle.surface;
			return {
				status: "present" as const,
				lease: {
					handle,
					events: (async function* (): AsyncGenerator<ExecutionBackendEvent> {
						yield { timestamp: ts, type: "unknown", fact: "snapshot", reason: "native", source: "mux", surface };
						yield { timestamp: ts, type: "exited", status: 0, signal: null, source: "mux", surface };
					})(),
					reconcile: async () => [],
					release: async () => {},
				},
			};
		},
		close: async (handle: ExecutionSurfaceHandle, _reason: ExecutionBackendCloseReason) => {
			closed.add(handle.surface.id);
		},
	};
}

describe("minimal real ExecutionBackend: full conformance suite execution", () => {
	it("all 12 conformance tests pass against a real backend that rejects unknown synthetic handles", async () => {
		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => tests.push([name, fn]),
			name: "minimal-real",
			createBackend: createMinimalRealBackend,
			createHarness: wrapWithConformanceHarness,
		});
		assert.equal(tests.length, CONFORMANCE_TEST_COUNT);
		for (const [, fn] of tests) {
			await fn();
		}
	});
});
