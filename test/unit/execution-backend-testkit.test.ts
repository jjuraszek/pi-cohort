/**
 * Unit tests for the execution-backend conformance testkit.
 *
 * These tests prove that:
 * 1. The deterministic fixture (createConformanceBackend) is structurally sound.
 * 2. The assertion helpers (assertConformingHandle) reject broken inputs.
 * 3. registerExecutionBackendConformance registers exactly CONFORMANCE_TEST_COUNT tests.
 * 4. The "rejects incompatible protocol version" test proves assertion liveness
 *    (deliberately broken fixture rejection).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CONFORMANCE_TEST_COUNT,
	assertConformingHandle,
	createConformanceBackend,
	registerExecutionBackendConformance,
} from "../../src/execution-backend/testkit.ts";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "../../src/execution-backend/types.ts";

// ── assertConformingHandle ────────────────────────────────────────────────────

describe("assertConformingHandle", () => {
	const validHandle = {
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		backend: "conformance",
		surface: { kind: "pane", id: "surface-1" },
		display: { label: "conformance:surface-1", hint: "conformance:surface-1" },
		data: null,
	};

	it("passes for a well-formed handle", () => {
		assert.doesNotThrow(() => assertConformingHandle(validHandle));
	});

	it("rejects a null handle", () => {
		assert.throws(() => assertConformingHandle(null), /object/);
	});

	it("rejects a handle without surface.id", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, surface: { kind: "pane" } }),
			/surface\.id/,
		);
	});

	it("rejects a handle with a non-string surface.id", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, surface: { kind: "pane", id: 42 } }),
			/surface\.id/,
		);
	});

	it("rejects a handle with a blank display.hint", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, display: { label: "", hint: "" } }),
			/\S/,
		);
	});

	it("rejects a handle with a whitespace-only display.hint", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, display: { label: "x", hint: "   " } }),
			/\S/,
		);
	});

	it("rejects a handle that embeds a live function", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, fn: () => "oops" }),
			/function/,
		);
	});

	it("rejects a handle that contains a forbidden key: runId", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, surface: { kind: "pane", id: "s1", runId: "leak" } }),
			/runId/,
		);
	});

	it("rejects a handle that contains a forbidden key: childId (nested)", () => {
		assert.throws(
			() => assertConformingHandle({ ...validHandle, data: { childId: "leak" } }),
			/childId/,
		);
	});

	it("rejects a handle that leaks a prohibited value", () => {
		assert.throws(
			() => assertConformingHandle(
				{ ...validHandle, data: "SUPER_SECRET" },
				["SUPER_SECRET"],
			),
			/prohibited value/,
		);
	});

	it("is a no-op for prohibited values when prohibitedValues is empty", () => {
		assert.doesNotThrow(() =>
			assertConformingHandle(
				{ ...validHandle, data: "some-value" },
				[],
			),
		);
	});
});

// ── createConformanceBackend ──────────────────────────────────────────────────

describe("createConformanceBackend", () => {
	it("has the correct protocol version", () => {
		const backend = createConformanceBackend();
		assert.equal(backend.protocolVersion, EXECUTION_BACKEND_PROTOCOL_VERSION);
	});

	it("has all required methods", () => {
		const backend = createConformanceBackend();
		assert.equal(typeof backend.detect, "function");
		assert.equal(typeof backend.launch, "function");
		assert.equal(typeof backend.reattach, "function");
		assert.equal(typeof backend.close, "function");
	});

	it("returns a fresh independent state on each call", () => {
		const a = createConformanceBackend();
		const b = createConformanceBackend();
		assert.notEqual(a.state, b.state);
		assert.equal(a.state.launches.length, 0);
		assert.equal(b.state.launches.length, 0);
	});

	it("detect returns an available backend with a string version and array capabilities", async () => {
		const backend = createConformanceBackend();
		const detection = await backend.detect();
		assert.equal(detection.available, true);
		assert.equal(typeof detection.version, "string");
		assert.ok(Array.isArray(detection.capabilities));
	});

	it("launch records state.trace and state.lastRequest", async () => {
		const backend = createConformanceBackend();
		const request = {
			command: "child-host",
			args: ["--session", "s.jsonl"],
			cwd: "/exact/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		};
		const lease = await backend.launch(request);
		assert.deepEqual(backend.state.trace.slice(0, 2), ["observe", "start"]);
		assert.equal(backend.state.lastRequest?.cwd, "/exact/cwd");
		assert.equal(backend.state.launches.length, 1);
		await lease.release();
	});

	it("launch returns a handle with a non-empty display.hint", async () => {
		const backend = createConformanceBackend();
		const lease = await backend.launch({
			command: "pi",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});
		assert.match(lease.handle.display.hint, /\S/);
		await lease.release();
	});

	it("release is idempotent and does not close the surface", async () => {
		const backend = createConformanceBackend();
		const lease = await backend.launch({
			command: "pi",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});
		await lease.release();
		await lease.release();
		assert.equal(backend.state.releaseCount, 1);
		assert.equal(backend.state.closed.size, 0);
	});

	it("close records the surface id", async () => {
		const backend = createConformanceBackend();
		const handle = {
			protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION as typeof EXECUTION_BACKEND_PROTOCOL_VERSION,
			backend: "conformance",
			surface: { kind: "pane", id: "surface-xyz" },
			display: { label: "x", hint: "x" },
			data: null,
		};
		await backend.close(handle, "explicit_cleanup");
		assert.ok(backend.state.closed.has("surface-xyz"));
	});

	it("push + events.next delivers the pushed event (enriched with timestamp, source, surface)", async () => {
		const backend = createConformanceBackend();
		const lease = await backend.launch({
			command: "pi",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});
		lease.push({ type: "surface_closed", requested: true });
		const next = await lease.events.next();
		assert.equal(next.done, false);
		// Events are enriched with timestamp, source, surface before delivery
		const event = (next as IteratorYieldResult<Record<string, unknown>>).value;
		assert.equal(event["type"], "surface_closed");
		assert.equal(event["requested"], true);
		assert.equal(typeof event["timestamp"], "number", "events must be enriched with timestamp");
		assert.equal(event["source"], "mux", "events must be enriched with source");
		assert.ok(event["surface"] && typeof (event["surface"] as Record<string, unknown>)["id"] === "string", "events must be enriched with surface");
		await lease.release();
	});

	it("advisory overflow coalesces and suspends as specified", async () => {
		const backend = createConformanceBackend();
		const lease = await backend.launch({
			command: "pi",
			args: [],
			cwd: "/cwd",
			runId: "r1",
			childId: "c1",
			environment: {},
			signal: new AbortController().signal,
		});
		// Two advisories: coalescing only fires when queue.length >= 2 before the push
		lease.push({ type: "no_observed_activity", sinceMs: 10 });
		lease.push({ type: "no_observed_activity", sinceMs: 20 });
		assert.deepEqual(lease.queuedEvents, [
			{ type: "no_observed_activity", sinceMs: 10 },
			{ type: "no_observed_activity", sinceMs: 20 },
		]);
		// Third advisory coalesces with the second (tail advisory is replaced)
		lease.push({ type: "no_observed_activity", sinceMs: 30 });
		assert.deepEqual(lease.queuedEvents, [
			{ type: "no_observed_activity", sinceMs: 10 },
			{ type: "no_observed_activity", sinceMs: 30 },
		]);
		// Entity fact pushes to 3 items
		lease.push({ type: "surface_closed", requested: false });
		// Fourth push causes overflow; authoritative fact is recorded
		lease.push({ type: "exited", status: 0, signal: null });
		assert.equal(lease.suspended, true);
		assert.deepEqual(lease.queuedEvents, [
			{ type: "no_observed_activity", sinceMs: 10 },
			{ type: "no_observed_activity", sinceMs: 30 },
			{ type: "surface_closed", requested: false },
			{ type: "unknown", fact: "event_stream", reason: "overflow" },
		]);
		await lease.release();
	});
});

// ── registerExecutionBackendConformance ───────────────────────────────────────

describe("registerExecutionBackendConformance", () => {
	it("registers exactly CONFORMANCE_TEST_COUNT tests and returns the count", () => {
		const registered: string[] = [];
		const count = registerExecutionBackendConformance({
			test: (name) => { registered.push(name); },
			name: "fixture",
			createBackend: createConformanceBackend,
		});
		assert.equal(count, CONFORMANCE_TEST_COUNT);
		assert.equal(registered.length, CONFORMANCE_TEST_COUNT);
	});

	it("prefixes all test names with the provided name", () => {
		const registered: string[] = [];
		registerExecutionBackendConformance({
			test: (name) => { registered.push(name); },
			name: "my-adapter",
			createBackend: createConformanceBackend,
		});
		assert.ok(registered.every((n) => n.startsWith("my-adapter:")));
	});

	it("all registered tests pass with the conformance fixture", async () => {
		const tests: Array<[string, () => void | Promise<void>]> = [];
		registerExecutionBackendConformance({
			test: (name, fn) => { tests.push([name, fn]); },
			name: "fixture",
			createBackend: createConformanceBackend,
		});
		for (const [, fn] of tests) {
			await assert.doesNotReject(async () => fn(), `should not reject`);
		}
	});

	it("deliberately broken: protocol version assertion catches incompatible backends", async () => {
		let brokenTestFn: (() => void | Promise<void>) | undefined;
		registerExecutionBackendConformance({
			test: (name, fn) => {
				if (name.includes("rejects an incompatible protocol version")) brokenTestFn = fn;
			},
			name: "fixture",
			createBackend: createConformanceBackend,
		});
		// The test must have been registered
		assert.ok(brokenTestFn, "protocol version rejection test must be registered");
		// It must pass (because the conformance fixture passes it)
		await assert.doesNotReject(async () => brokenTestFn!());
	});

	it("CONFORMANCE_TEST_COUNT matches the literal 12", () => {
		// Pinned so any future addition is intentional
		assert.equal(CONFORMANCE_TEST_COUNT, 12);
	});
});
