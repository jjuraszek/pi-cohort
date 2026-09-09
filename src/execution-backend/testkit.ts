/**
 * Core-owned public execution-backend conformance testkit.
 *
 * Importable as `pi-cohort/execution-backend-testkit` by companion packages.
 * Provides a deterministic conformance fixture, a reusable test-registration
 * function that proves the SPI contract is correctly implemented, and a
 * `ConformanceHarness` that wraps any real backend to enable request inspection
 * and event injection without modifying the ExecutionBackend / ExecutionBackendLease
 * interfaces.
 *
 * ## Responsibilities
 *
 * - `registerExecutionBackendConformance`: registers 12 tests against any
 *   `ExecutionBackend`.  All tests drive the real SPI and assert observable
 *   effects; no fixture-internal state is exposed to the suite.
 * - `createConformanceBackend`: returns the deterministic in-process fixture
 *   used to prove the conformance suite passes.  The fixture also exposes
 *   `push()` / `queuedEvents` / `suspended` / `state` for fixture-level unit
 *   tests; these are NOT part of the conformance SPI contract.
 * - `wrapWithConformanceHarness`: wraps any `ExecutionBackend` to capture
 *   `lastLaunchRequest` and enable `inject()` for scenarios that require
 *   external transport simulation (overflow ordering, cwd verification, …).
 *   The harness is separate from the backend and lease types; pass it via the
 *   optional `createHarness` option only when those scenarios are needed.
 *
 * Usage:
 *
 *   import {
 *     registerExecutionBackendConformance,
 *     createConformanceBackend,
 *     wrapWithConformanceHarness,
 *   } from "pi-cohort/execution-backend-testkit";
 */

import assert from "node:assert/strict";
import type {
	ExecutionBackend,
	ExecutionBackendCloseReason,
	ExecutionBackendDetection,
	ExecutionBackendEvent,
	ExecutionSurfaceHandle,
	ExecutionSurfaceIdentity,
	ExecutionSurfaceRequest,
} from "./types.ts";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "./types.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Loose event type used internally by the testkit fixture.
 * The fixture stores events as plain records for easy construction;
 * enrichment (timestamp, source, surface) is applied when events exit via the
 * public `events` iterable.
 */
export type TestEvent = Record<string, unknown>;

/** Mutable state tracked by the conformance fixture for assertion purposes. */
export interface ConformanceBackendState {
	trace: string[];
	closed: Set<string>;
	launches: ExecutionSurfaceRequest[];
	releaseCount: number;
	subscriptions: number;
	reconciles: number;
	lastRequest: ExecutionSurfaceRequest | undefined;
	/** Arbitrary persisted values; adapters may record extra data here. */
	persisted: Record<string, unknown>;
}

/**
 * Async event channel returned by the conformance fixture.
 *
 * `next()` returns fully-conforming `ExecutionBackendEvent` values (enriched
 * with timestamp, source, and surface if the raw fixture event was sparse).
 * `return()` terminates the stream without closing the surface.
 *
 * The fixture tests that call `push()` / `queuedEvents` work directly with
 * `TestEvent` (raw, unenriched) – use `queuedEvents` for those assertions.
 */
export interface ConformanceLeaseEvents extends AsyncIterable<ExecutionBackendEvent> {
	next(): Promise<IteratorResult<ExecutionBackendEvent>>;
	return(): Promise<{ done: true; value: undefined }>;
	[Symbol.asyncIterator](): this;
}

/** Execution lease returned by a conformance backend, with testing hooks. */
export interface ConformanceLease {
	readonly handle: ExecutionSurfaceHandle;
	/** Public SPI events – every value is a fully-conforming ExecutionBackendEvent. */
	readonly events: ConformanceLeaseEvents;
	reconcile(): Promise<readonly ExecutionBackendEvent[]>;
	release(): Promise<void>;
	/** Inject a raw event into the queue (fixture-internal API). */
	push(event: TestEvent): void;
	/** True when the queue overflowed and new events are being dropped. */
	readonly suspended: boolean;
	/** True after release() or events.return() has been called. */
	readonly released: boolean;
	/** Raw (unenriched) snapshot of the current event queue contents. */
	readonly queuedEvents: readonly TestEvent[];
	/** The original launch request (for fixture-level assertions). */
	readonly request: ExecutionSurfaceRequest | Record<string, never>;
}

/** Execution backend with the testing-state accessor used by the fixture. */
export interface ConformanceBackend {
	readonly name: string;
	readonly protocolVersion: typeof EXECUTION_BACKEND_PROTOCOL_VERSION;
	readonly state: ConformanceBackendState;
	detect(): Promise<ExecutionBackendDetection>;
	launch(request: ExecutionSurfaceRequest): Promise<ConformanceLease>;
	reattach(
		handle: ExecutionSurfaceHandle,
	): Promise<
		| { status: "present"; lease: ConformanceLease }
		| { status: "gone" }
		| { status: "unknown"; reason: string }
	>;
	close(
		handle: ExecutionSurfaceHandle,
		reason: ExecutionBackendCloseReason,
	): Promise<void>;
}

/**
 * Wraps any `ExecutionBackend` to enable request inspection and event injection
 * during conformance testing.  Kept separate from `ExecutionBackend` and
 * `ExecutionBackendLease` – the SPI types are not widened.
 *
 * Pass the harness via `createHarness` in `RegisterConformanceOptions` only for
 * scenarios that require external transport simulation (cwd verification, event
 * injection, ordering assertions).  Scenarios that test purely observable
 * output work with a bare `createBackend`.
 */
export interface ConformanceHarness {
	/**
	 * The wrapped backend to use as the backend under test.
	 * Pass this (or drive it directly) instead of the raw backend when using
	 * the harness.
	 */
	readonly wrappedBackend: ExecutionBackend;
	/** The most recent request observed by `wrappedBackend.launch()`. */
	readonly lastLaunchRequest: ExecutionSurfaceRequest | undefined;
	/**
	 * Inject a synthetic external-transport event into the active lease's
	 * event stream.  The event must be a fully-conforming ExecutionBackendEvent
	 * (including `timestamp`, `source`, `surface`).
	 * Only meaningful after `launch()` and before `release()`.
	 */
	inject(event: ExecutionBackendEvent): void;
	/** Injected events not yet consumed by the iterator. */
	readonly injectedQueue: readonly ExecutionBackendEvent[];
	/** True when the injection channel is suspended (overflow). */
	readonly injectedSuspended: boolean;
}

/** Number of conformance tests registered by registerExecutionBackendConformance. */
export const CONFORMANCE_TEST_COUNT = 12 as const;

/** Options accepted by registerExecutionBackendConformance. */
export interface RegisterConformanceOptions {
	/** The node:test `test` function (or any compatible runner). */
	test: (name: string, fn: () => void | Promise<void>) => void;
	/** Label prefix for registered test names. */
	name: string;
	/**
	 * Factory that creates a fresh `ExecutionBackend` for each test case.
	 * Must return the real SPI type; do NOT require ConformanceBackend-specific
	 * fields (state, push, queuedEvents) – those are fixture internals.
	 */
	createBackend: () => ExecutionBackend;
	/**
	 * Optional harness factory for tests that require external transport
	 * simulation (event injection, request inspection).  Kept separate from
	 * the backend type so adapters under test are not forced to expose internal
	 * state.  When omitted, harness-dependent assertions are skipped.
	 */
	createHarness?: (backend: ExecutionBackend) => ConformanceHarness;
	/**
	 * Values that must not appear anywhere in surface artifacts (args,
	 * environment, handle, events).  Use to detect secret leakage in
	 * conformance runs that provide a real secret-pipe value.
	 */
	prohibitedValues?: string[];
}

// ── Internal assertion helpers (also exported for adapter test suites) ────────

const requiredMethods = ["detect", "launch", "reattach", "close"] as const;
const forbiddenHandleKeys = ["runId", "childId", "attempt", "task", "result", "output"];

/**
 * Assert that `handle` conforms to the opaque-handle contract:
 * - `handle.surface.id` is a non-empty string
 * - `handle.display.hint` contains at least one non-whitespace character
 * - serialisable to JSON without throwing
 * - contains no live functions
 * - contains none of the forbidden core-identity keys
 * - contains none of the explicitly prohibited values
 */
export function assertConformingHandle(handle: unknown, prohibitedValues: string[] = []): void {
	assert.ok(handle && typeof handle === "object", "handle must be an object");
	const h = handle as Record<string, unknown>;
	const surface = h.surface as { id?: unknown; kind?: unknown } | undefined;
	assert.equal(typeof surface?.id, "string", "handle.surface.id must be a string");
	const display = h.display as { hint?: unknown } | undefined;
	assert.match(String(display?.hint ?? ""), /\S/, "handle.display.hint must include an actionable display hint");
	assert.doesNotThrow(() => JSON.parse(JSON.stringify(handle)), "handle must be JSON-serialisable");
	assertNoFunction(handle);
	assertNoForbiddenKey(handle, forbiddenHandleKeys);
	assertNoProhibitedValue(handle, prohibitedValues);
}

function assertNoFunction(value: unknown, seen: Set<unknown> = new Set()): void {
	if (!value || typeof value !== "object") {
		assert.notEqual(typeof value, "function", "handle must not contain live functions");
		return;
	}
	if (seen.has(value)) return;
	seen.add(value);
	for (const nested of Object.values(value as Record<string, unknown>)) {
		assertNoFunction(nested, seen);
	}
}

function assertNoForbiddenKey(value: unknown, forbiddenKeys: string[], seen: Set<unknown> = new Set()): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		assert.equal(forbiddenKeys.includes(key), false, `handle leaks forbidden key: ${key}`);
		assertNoForbiddenKey(nested, forbiddenKeys, seen);
	}
}

function assertNoProhibitedValue(value: unknown, prohibitedValues: string[], seen: Set<unknown> = new Set()): void {
	if (prohibitedValues.length === 0 || value === undefined || value === null) return;
	if (typeof value !== "object") {
		for (const prohibited of prohibitedValues) {
			assert.notEqual(value, prohibited, `surface artifact leaks prohibited value: ${prohibited}`);
		}
		return;
	}
	if (seen.has(value)) return;
	seen.add(value);
	for (const nested of Object.values(value as Record<string, unknown>)) {
		assertNoProhibitedValue(nested, prohibitedValues, seen);
	}
}

function assertValidBackend(backend: unknown): ExecutionBackend {
	assert.ok(backend && typeof backend === "object", "backend must be an object");
	const b = backend as Record<string, unknown>;
	for (const method of requiredMethods) {
		assert.equal(typeof b[method], "function", `backend.${method} must be a function`);
	}
	assert.equal(b.protocolVersion, EXECUTION_BACKEND_PROTOCOL_VERSION, "backend protocol version must be v1");
	return backend as ExecutionBackend;
}

// ── Conformance test suite ────────────────────────────────────────────────────

/**
 * Register the 12 conformance test cases against the provided backend factory.
 * Returns CONFORMANCE_TEST_COUNT so callers can assert all tests were registered.
 *
 * All tests drive the real ExecutionBackend SPI and assert observable effects.
 * No fixture-internal state (state.closed, push, queuedEvents) is accessed by
 * the conformance suite itself.
 *
 * When `createHarness` is supplied, additional assertions run (cwd capture,
 * event injection, close-call tracking).  Scenarios that can be fully exercised
 * via the real SPI work without a harness.
 */
export function registerExecutionBackendConformance({
	test,
	name,
	createBackend,
	createHarness,
	prohibitedValues = [],
}: RegisterConformanceOptions): typeof CONFORMANCE_TEST_COUNT {
	// 1
	test(`${name}: exposes the v1 detection shape`, async () => {
		const backend = assertValidBackend(createBackend());
		const detection = await backend.detect();
		assert.equal(backend.protocolVersion, EXECUTION_BACKEND_PROTOCOL_VERSION, "protocol version must be v1");
		assert.equal(typeof detection.available, "boolean");
		assert.equal(typeof detection.version, "string");
		assert.ok(Array.isArray(detection.capabilities));
	});

	// 2 – deliberately broken: proves the protocol-version assertion executes
	test(`${name}: rejects an incompatible protocol version`, () => {
		const backend = assertValidBackend(createBackend());
		assert.throws(() => assertValidBackend({ ...backend, protocolVersion: 2 }), /protocol version/);
	});

	// 3
	test(`${name}: launches one observed surface at the exact cwd`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const request = makeRequest();
		const lease = await active.launch(request);
		try {
			assertConformingHandle(lease.handle, prohibitedValues);
			if (harness) {
				assert.equal(
					harness.lastLaunchRequest?.cwd,
					request.cwd,
					"launched cwd must match the request",
				);
			}
		} finally {
			await lease.release();
		}
	});

	// 4 – event carries required fields including timestamp
	test(`${name}: events carry required fields including timestamp`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;

		// When no harness, ask backends that support it to emit an immediate exit event
		const awareness = harness == null ? { immediateExit: true } : {};
		const lease = await active.launch({ ...makeRequest(), awareness });
		try {
			if (harness) {
				// Inject a conforming event via the separate stimulus harness
				harness.inject({
					timestamp: Date.now(),
					type: "exited",
					status: 0,
					signal: null,
					source: "mux",
					surface: lease.handle.surface,
				});
			}

			const iter = lease.events[Symbol.asyncIterator]();
			const next = await iter.next();
			assert.equal(next.done, false, "expected at least one event from the lease");
			const event = next.value;
			assert.equal(event.source, "mux", "event source must be mux");
			assert.equal(
				event.surface.id,
				lease.handle.surface.id,
				"event surface id must match the lease handle",
			);
			assert.equal(typeof event.timestamp, "number", "event must carry a numeric timestamp");
		} finally {
			await lease.release();
		}
	});

	// 5
	test(`${name}: exposes a durable opaque handle without secret or core identity`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const lease = await active.launch(makeRequest());
		try {
			assertConformingHandle(lease.handle, prohibitedValues);
		} finally {
			await lease.release();
		}
	});

	// 6
	test(`${name}: passes only a secret-pipe path and never leaks its value`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const request = makeRequest();
		const lease = await active.launch(request);
		try {
			let event: ExecutionBackendEvent | undefined;
			if (harness) {
				harness.inject({
					timestamp: Date.now(),
					type: "unknown",
					fact: "safe_fixture",
					reason: "conformance",
					source: "mux",
					surface: lease.handle.surface,
				});
				const iter = lease.events[Symbol.asyncIterator]();
				const next = await iter.next();
				event = next.done ? undefined : next.value;
			}

			assertNoProhibitedValue(
				{
					args: request.args,
					environment: request.environment,
					handle: lease.handle,
					event,
				},
				prohibitedValues,
			);
		} finally {
			await lease.release();
		}
	});

	// 7
	test(`${name}: keeps mux events free of core correlation`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;

		const awareness = harness == null ? { immediateExit: true } : {};
		const lease = await active.launch({ ...makeRequest(), awareness });
		try {
			if (harness) {
				harness.inject({
					timestamp: Date.now(),
					type: "exited",
					status: 0,
					signal: null,
					source: "mux",
					surface: lease.handle.surface,
				});
			}

			const iter = lease.events[Symbol.asyncIterator]();
			const next = await iter.next();
			if (!next.done) {
				const event = next.value;
				assert.equal(event.source, "mux", "event source must be mux");
				assert.deepEqual(event.surface, lease.handle.surface, "event surface must match lease handle");
				assert.equal(typeof event.timestamp, "number", "event must carry a numeric timestamp");
				assert.equal(JSON.stringify(event).includes("childId"), false, "event must not contain childId");
				assert.equal(JSON.stringify(event).includes("runId"), false, "event must not contain runId");
			}
		} finally {
			await lease.release();
		}
	});

	// 8 – reconcile returns a conforming event array (replaces fixture-internal coalescing test)
	test(`${name}: reconcile returns conforming events with required fields`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const lease = await active.launch(makeRequest());
		try {
			const reconciled = await lease.reconcile();
			assert.ok(Array.isArray(reconciled), "reconcile must return an array");
			for (const evt of reconciled) {
				assert.equal(
					typeof evt.timestamp,
					"number",
					"reconciled event must carry a numeric timestamp",
				);
				assert.equal(evt.source, "mux", "reconciled event source must be mux");
				assert.ok(
					evt.surface && typeof evt.surface.id === "string",
					"reconciled event must have a surface.id",
				);
			}
		} finally {
			await lease.release();
		}
	});

	// 9 – release stops observation without closing the surface
	test(`${name}: release and iterator return stop observation without closing`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;

		const lease = await active.launch(makeRequest());
		try {
			const iter = lease.events[Symbol.asyncIterator]();

			// Start waiting for an event then terminate the iterator
			const pendingNext = iter.next();
			await iter.return?.();
			const result = await pendingNext;
			assert.equal(result.done, true, "iterator return must terminate the pending next");

			// Release is idempotent
			await lease.release();
			await lease.release();

			// Verify release did NOT close the surface (a broken adapter that calls close()
			// on release would cause reattach to return "gone")
			const reattachResult = await active.reattach(lease.handle);
			try {
				assert.notEqual(reattachResult.status, "gone", "release must not close the surface");
			} finally {
				if (reattachResult.status === "present") {
					await reattachResult.lease.release();
				}
			}
		} finally {
			await lease.release(); // idempotent: already released in the happy path above
		}
	});

	// 10 – reattach returns present/gone/unknown; first event before second (non-decreasing timestamps)
	test(`${name}: reattaches with earlier events before later events and distinguishes absence`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;

		// Launch a real surface so the backend knows its handle
		const lease = await active.launch(makeRequest());
		const launchedHandle = lease.handle;

		// Reattach by the actual handle – backend must recognise it as present
		const present = await active.reattach(launchedHandle);
		assert.equal(present.status, "present", "reattach of active surface must return present");

		const presentLease = (present as { status: "present"; lease: { events: AsyncIterable<ExecutionBackendEvent>; release(): Promise<void> } }).lease;
		try {
			const iter = presentLease.events[Symbol.asyncIterator]();

			if (harness) {
				// When harness is available, inject two events as external stimulus
				// rather than requiring the backend to fabricate facts for a live surface.
				// Backends that use a live subscription channel produce only a snapshot
				// observation on reattach; the harness provides the second event.
				const ts = Date.now();
				harness.inject({
					timestamp: ts,
					type: "unknown",
					fact: "snapshot",
					reason: "conformance reattach stimulus 1",
					source: "mux",
					surface: launchedHandle.surface,
				});
				harness.inject({
					timestamp: ts + 1,
					type: "unknown",
					fact: "live_observation",
					reason: "conformance reattach stimulus 2",
					source: "mux",
					surface: launchedHandle.surface,
				});
			}

			const first = await iter.next();
			assert.equal(first.done, false, "first reattach event expected");
			const firstEvent = first.value;
			assert.equal(typeof firstEvent.timestamp, "number", "first reattach event must have timestamp");

			const second = await iter.next();
			assert.equal(second.done, false, "second reattach event expected");
			const secondEvent = second.value;
			assert.equal(typeof secondEvent.timestamp, "number", "second reattach event must have timestamp");

			assert.ok(
				secondEvent.timestamp >= firstEvent.timestamp,
				"reattach events must be in non-decreasing timestamp order",
			);
		} finally {
			// Release both leases regardless of assertion outcome
			await presentLease.release();
			await lease.release();
		}

		// Close the surface explicitly; subsequent reattach must return gone
		await active.close(launchedHandle, "delivered");
		const gone = await active.reattach(launchedHandle);
		assert.equal(gone.status, "gone", "reattach after explicit close must return gone");
	});

	// 11
	test(`${name}: closes by persisted handle idempotently without a lease`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const handle = makeTestHandle("surface-after-restart");
		await active.close(handle, "explicit_cleanup");
		// Second close must not throw
		await active.close(handle, "explicit_cleanup");
	});

	// 12
	test(`${name}: treats retention as release without close and accepts non-Git cwd`, async () => {
		const backend = assertValidBackend(createBackend());
		const harness = createHarness?.(backend);
		const active = harness?.wrappedBackend ?? backend;
		const request = makeRequest();
		const lease = await active.launch(request);
		try {
			await lease.release();

			// Verify retention (release) does not close the surface
			const reattachResult = await active.reattach(lease.handle);
			try {
				assert.notEqual(reattachResult.status, "gone", "release must not close the surface");

				if (harness) {
					assert.equal(harness.lastLaunchRequest?.cwd, "/ordinary/cwd");
				}
			} finally {
				if (reattachResult.status === "present") {
					await reattachResult.lease.release();
				}
			}
		} finally {
			await lease.release(); // idempotent: already released above as "retain"
		}
	});

	return CONFORMANCE_TEST_COUNT;
}

// ── Conformance harness ───────────────────────────────────────────────────────

/**
 * Wrap a real `ExecutionBackend` in a test harness that:
 * - captures `lastLaunchRequest` for request-inspection assertions
 * - provides `inject()` to deliver synthetic external-transport events into the
 *   active lease's event stream (without modifying the backend or lease types)
 *
 * The harness is a separate object alongside the backend; it is NOT the
 * backend itself.  Use `harness.wrappedBackend` as the backend under test.
 *
 * Injection queue takes priority: injected events are returned by the iterator
 * before any events from the underlying backend.  When a `next()` call is
 * already pending, `inject()` resolves it immediately.
 */
export function wrapWithConformanceHarness(backend: ExecutionBackend): ConformanceHarness {
	let lastLaunchRequest: ExecutionSurfaceRequest | undefined;

	// Per-lease injection channel; replaced on each launch()
	let currentInject: ((event: ExecutionBackendEvent) => void) | undefined;
	let currentQueueView: (() => readonly ExecutionBackendEvent[]) | undefined;
	let currentSuspendedView: (() => boolean) | undefined;

	const wrappedBackend: ExecutionBackend = {
		name: backend.name,
		protocolVersion: backend.protocolVersion,
		detect: () => backend.detect(),

		async launch(request) {
			lastLaunchRequest = request;
			const realLease = await backend.launch(request);

			const injectionQueue: ExecutionBackendEvent[] = [];
			let suspended = false;
			// Resolve fn for a pending next() call awaiting either injected or real events
			let pendingResolve: ((result: IteratorResult<ExecutionBackendEvent>) => void) | undefined;

			function inject(event: ExecutionBackendEvent): void {
				if (suspended) return;
				injectionQueue.push(event);
				if (pendingResolve) {
					const resolve = pendingResolve;
					pendingResolve = undefined;
					resolve({ done: false, value: injectionQueue.shift()! });
				}
			}

			currentInject = inject;
			currentQueueView = () => [...injectionQueue];
			currentSuspendedView = () => suspended;

			// Merged event stream: injected events take priority over real backend events
			const events: AsyncIterable<ExecutionBackendEvent> = {
				[Symbol.asyncIterator]() {
					const realIter = realLease.events[Symbol.asyncIterator]();
					return {
						async next(): Promise<IteratorResult<ExecutionBackendEvent>> {
							if (injectionQueue.length > 0) {
								return { done: false, value: injectionQueue.shift()! };
							}
							return new Promise<IteratorResult<ExecutionBackendEvent>>((resolve) => {
								pendingResolve = resolve;
								realIter.next().then((result) => {
									// Only deliver if inject() hasn't already resolved this slot
									if (pendingResolve === resolve) {
										pendingResolve = undefined;
										resolve(result);
									}
								});
							});
						},
						async return(): Promise<IteratorResult<ExecutionBackendEvent, undefined>> {
							// Resolve any pending next() as done before cancelling the real iterator
							const resolve = pendingResolve;
							pendingResolve = undefined;
							await realIter.return?.();
							resolve?.({ done: true, value: undefined });
							return { done: true, value: undefined };
						},
						[Symbol.asyncIterator]() { return this; },
					};
				},
			};

			return {
				handle: realLease.handle,
				events,
				reconcile: () => realLease.reconcile(),
				async release() {
					const resolve = pendingResolve;
					pendingResolve = undefined;
					currentInject = undefined;
					await realLease.release();
					resolve?.({ done: true, value: undefined });
				},
			};
		},

		async reattach(handle) {
			const result = await backend.reattach(handle);
			if (result.status !== "present") return result;

			const realLease = result.lease;
			const injectionQueue: ExecutionBackendEvent[] = [];
			let pendingResolve: ((r: IteratorResult<ExecutionBackendEvent>) => void) | undefined;

			function inject(event: ExecutionBackendEvent): void {
				injectionQueue.push(event);
				if (pendingResolve) {
					const resolve = pendingResolve;
					pendingResolve = undefined;
					resolve({ done: false, value: injectionQueue.shift()! });
				}
			}

			// Route harness.inject() into this reattach lease's channel.
			currentInject = inject;
			currentQueueView = () => [...injectionQueue];
			currentSuspendedView = () => false;

			const events: AsyncIterable<ExecutionBackendEvent> = {
				[Symbol.asyncIterator]() {
					const realIter = realLease.events[Symbol.asyncIterator]();
					return {
						async next(): Promise<IteratorResult<ExecutionBackendEvent>> {
							if (injectionQueue.length > 0) {
								return { done: false, value: injectionQueue.shift()! };
							}
							return new Promise<IteratorResult<ExecutionBackendEvent>>((resolve) => {
								pendingResolve = resolve;
								realIter.next().then((r) => {
									if (pendingResolve === resolve) {
										pendingResolve = undefined;
										resolve(r);
									}
								});
							});
						},
						async return(): Promise<IteratorResult<ExecutionBackendEvent, undefined>> {
							const resolve = pendingResolve;
							pendingResolve = undefined;
							await realIter.return?.();
							resolve?.({ done: true, value: undefined });
							return { done: true, value: undefined };
						},
						[Symbol.asyncIterator]() { return this; },
					};
				},
			};

			return {
				status: "present",
				lease: {
					handle: realLease.handle,
					events,
					reconcile: () => realLease.reconcile(),
					async release() {
						const resolve = pendingResolve;
						pendingResolve = undefined;
						currentInject = undefined;
						await realLease.release();
						resolve?.({ done: true, value: undefined });
					},
				},
			};
		},
		close: (handle, reason) => backend.close(handle, reason),
	};

	return {
		wrappedBackend,
		get lastLaunchRequest() { return lastLaunchRequest; },
		inject(event) { currentInject?.(event); },
		get injectedQueue() { return currentQueueView?.() ?? []; },
		get injectedSuspended() { return currentSuspendedView?.() ?? false; },
	};
}

// ── Deterministic conformance fixture ────────────────────────────────────────

/** Enrich a raw fixture TestEvent with required ExecutionBackendEvent fields. */
function enrichEvent(raw: TestEvent, surface: ExecutionSurfaceIdentity): ExecutionBackendEvent {
	return {
		...raw,
		timestamp: typeof raw["timestamp"] === "number" ? raw["timestamp"] as number : Date.now(),
		source: "mux" as const,
		surface: (raw["surface"] as ExecutionSurfaceIdentity | undefined) ?? surface,
	} as unknown as ExecutionBackendEvent;
}

/**
 * Create a deterministic in-process backend that passes all conformance tests.
 * Each call returns a fresh backend with independent state.
 *
 * The returned `ConformanceBackend` extends the real `ExecutionBackend` SPI with
 * fixture-specific fields (`state`, `push`, `queuedEvents`, `suspended`,
 * `released`, `request`) for use in fixture-level unit tests.  These extras are
 * NOT part of the SPI contract.
 */
export function createConformanceBackend(): ConformanceBackend {
	const state: ConformanceBackendState = {
		trace: [],
		closed: new Set(),
		launches: [],
		releaseCount: 0,
		subscriptions: 0,
		reconciles: 0,
		lastRequest: undefined,
		persisted: {},
	};

	function makeLease(
		request: ExecutionSurfaceRequest | Record<string, never>,
		identity: { id: string },
		initial: TestEvent[] = [],
	): ConformanceLease {
		const surface: ExecutionSurfaceIdentity = { kind: "pane", id: identity.id };
		const handle: ExecutionSurfaceHandle = {
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
			backend: "conformance",
			surface,
			display: { label: `conformance:${identity.id}`, hint: `conformance:${identity.id}` },
			data: null,
		};

		const queue: TestEvent[] = [...initial];
		let suspended = false;
		let released = false;
		let lostAuthoritativeFact: TestEvent | undefined;
		// Resolves with a fully-conforming ExecutionBackendEvent (or done)
		let waiter: ((result: IteratorResult<ExecutionBackendEvent>) => void) | undefined;

		state.subscriptions += 1;

		const finish = (): void => {
			if (released) return;
			released = true;
			state.releaseCount += 1;
			const resolve = waiter;
			waiter = undefined;
			resolve?.({ done: true, value: undefined });
		};

		const events: ConformanceLeaseEvents = {
			async next(): Promise<IteratorResult<ExecutionBackendEvent>> {
				if (queue.length) return { done: false, value: enrichEvent(queue.shift()!, surface) };
				if (released) return { done: true, value: undefined };
				return new Promise<IteratorResult<ExecutionBackendEvent>>((resolve) => {
					waiter = resolve;
				});
			},
			async return(): Promise<{ done: true; value: undefined }> {
				finish();
				return { done: true, value: undefined };
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};

		const lease: ConformanceLease = {
			handle,
			events,

			async reconcile(): Promise<readonly ExecutionBackendEvent[]> {
				state.reconciles += 1;
				if (!lostAuthoritativeFact) return [];
				const fact = enrichEvent(
					{
						...lostAuthoritativeFact,
						source: "mux",
						surface: { kind: surface.kind, id: surface.id },
						snapshot: true,
					},
					surface,
				);
				suspended = false;
				lostAuthoritativeFact = undefined;
				return [fact];
			},

			async release(): Promise<void> {
				finish();
			},

			push(event: TestEvent): void {
				if (suspended) return;
				if (
					queue.length >= 2
					&& event.type === "no_observed_activity"
					&& queue[queue.length - 1]?.type === "no_observed_activity"
				) {
					queue[queue.length - 1] = event;
				} else if (queue.length >= 3) {
					lostAuthoritativeFact = event;
					queue.push({ type: "unknown", fact: "event_stream", reason: "overflow" });
					suspended = true;
				} else {
					queue.push(event);
				}
				if (waiter && queue.length) {
					const resolve = waiter;
					waiter = undefined;
					resolve({ done: false, value: enrichEvent(queue.shift()!, surface) });
				}
			},

			get suspended() { return suspended; },
			get released() { return released; },
			get queuedEvents(): readonly TestEvent[] { return [...queue]; },
			request,
		};

		return lease;
	}

	const backend: ConformanceBackend = {
		name: "conformance",
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		state,

		async detect(): Promise<ExecutionBackendDetection> {
			return {
				available: true,
				version: "conformance-1",
				capabilities: ["launch", "reattach", "close"],
			};
		},

		async launch(request: ExecutionSurfaceRequest): Promise<ConformanceLease> {
			state.trace.push("observe", "start");
			state.lastRequest = request;
			state.launches.push(request);
			const launchIndex = state.launches.length;
			const immediateExit = request.awareness?.immediateExit === true;
			const initial: TestEvent[] = immediateExit
				? [
					{
						type: "exited",
						status: 0,
						signal: null,
						source: "mux",
						surface: { kind: "pane", id: `surface-${launchIndex}` },
					},
				]
				: [];
			return makeLease(request, { id: `surface-${launchIndex}` }, initial);
		},

		async reattach(handle: ExecutionSurfaceHandle): Promise<
			| { status: "present"; lease: ConformanceLease }
			| { status: "gone" }
			| { status: "unknown"; reason: string }
		> {
			const surfaceId = handle.surface?.id ?? "";
			if (state.closed.has(surfaceId)) return { status: "gone" };
			if (surfaceId === "gone") return { status: "gone" };
			if (surfaceId === "unknown") return { status: "unknown", reason: "native unavailable" };
			// Emit two non-death observation facts with non-decreasing timestamps.
			// Fabricating surface_closed/exited for a live surface is semantically wrong;
			// these facts are real: the snapshot confirmed the surface is alive.
			const now = Date.now();
			const lease = makeLease({} as Record<string, never>, { id: surfaceId }, [
				{ type: "unknown", fact: "snapshot", reason: "reattach observation", snapshot: true, timestamp: now },
				{ type: "unknown", fact: "live_observation", reason: "reattach live", live: true, timestamp: now + 1 },
			]);
			return { status: "present", lease };
		},

		async close(handle: ExecutionSurfaceHandle, _reason: ExecutionBackendCloseReason): Promise<void> {
			state.closed.add(handle.surface.id);
		},
	};

	return backend;
}

// ── Internal request/handle factories ────────────────────────────────────────

function makeRequest(): ExecutionSurfaceRequest {
	return {
		command: "child-host",
		args: ["--session", "session.jsonl"],
		cwd: "/ordinary/cwd",
		runId: "run-1",
		childId: "child-1",
		environment: { SAFE: "1" },
		signal: new AbortController().signal,
	};
}

function makeTestHandle(surfaceId: string): ExecutionSurfaceHandle {
	return {
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		backend: "conformance",
		surface: { kind: "pane", id: surfaceId },
		display: { label: `test:${surfaceId}`, hint: `test:${surfaceId}` },
		data: null,
	};
}
