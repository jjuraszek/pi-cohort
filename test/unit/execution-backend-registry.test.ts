import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
	EXECUTION_BACKEND_PROTOCOL_VERSION,
	registerExecutionBackend,
} from "../../src/execution-backend/index.ts";
import { executionBackends } from "../../src/execution-backend/registry.ts";
import type {
	ExecutionBackend,
	ExecutionBackendDetection,
	ExecutionSurfaceRequest,
} from "../../src/execution-backend/types.ts";

const hubSymbol = Symbol.for("pi-cohort.execution-backends.v1");

function backend(name: string): ExecutionBackend {
	return {
		name,
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		async detect() { return { available: true, version: "v1", capabilities: [] }; },
		async launch() { throw new Error("not used"); },
		async reattach() { return { status: "gone" }; },
		async close() {},
	};
}

function withFreshHub(fn: () => void | Promise<void>): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, hubSymbol);
	Reflect.deleteProperty(globalThis, hubSymbol);
	return Promise.resolve(fn()).finally(() => {
		Reflect.deleteProperty(globalThis, hubSymbol);
		if (descriptor) Object.defineProperty(globalThis, hubSymbol, descriptor);
	});
}

test("registrations are shared by separate query-string module instances and preserve insertion order", async () => {
	const registryUrl = pathToFileURL("src/execution-backend/registry.ts").href;
	for (const [firstName, secondName] of [["first", "second"], ["second", "first"]] as const) {
		await withFreshHub(async () => {
			const first = await import(`${registryUrl}?first=${firstName}-${Date.now()}`);
			const second = await import(`${registryUrl}?second=${secondName}-${Date.now()}`);
			const disposeFirst = first.registerExecutionBackend(backend(firstName));
			const disposeSecond = second.registerExecutionBackend(backend(secondName));
			assert.deepEqual(first.executionBackends().map((item: ExecutionBackend) => item.name), [firstName, secondName]);
			disposeFirst();
			disposeSecond();
		});
	}
});

test("rejects active duplicates and stale disposers cannot remove a newer registration", async () => {
	await withFreshHub(() => {
		const original = backend("mux");
		const disposeOriginal = registerExecutionBackend(original);
		assert.throws(() => registerExecutionBackend(backend("mux")), /already registered/);
		disposeOriginal();
		const replacement = backend("mux");
		const disposeReplacement = registerExecutionBackend(replacement);
		disposeOriginal();
		assert.deepEqual(executionBackends(), [replacement]);
		disposeReplacement();
	});
});

test("disposal is idempotent and enumeration preserves registration order", async () => {
	await withFreshHub(() => {
		const disposeZ = registerExecutionBackend(backend("zeta"));
		const disposeA = registerExecutionBackend(backend("alpha"));
		assert.deepEqual(executionBackends().map((item) => item.name), ["zeta", "alpha"]);
		disposeA();
		disposeA();
		assert.deepEqual(executionBackends().map((item) => item.name), ["zeta"]);
		disposeZ();
	});
});

test("rejects malformed, blank-name, and incompatible-protocol backends", async () => {
	await withFreshHub(() => {
		assert.throws(() => registerExecutionBackend({} as ExecutionBackend), /name/);
		assert.throws(() => registerExecutionBackend(backend("  ")), /name/);
		assert.throws(() => registerExecutionBackend({ ...backend("old"), protocolVersion: 2 } as ExecutionBackend), /protocol/);
		assert.throws(() => registerExecutionBackend({ ...backend("broken"), detect: undefined } as unknown as ExecutionBackend), /detect/);
	});
});

test("fails loudly for malformed pre-existing hubs and restores them after test", async () => {
	for (const value of [{ protocolVersion: 2 }, { protocolVersion: 1, backends: {} }]) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, hubSymbol);
		Object.defineProperty(globalThis, hubSymbol, { configurable: true, value });
		try {
			assert.throws(() => registerExecutionBackend(backend("mux")), /incompatible/i);
		} finally {
			Reflect.deleteProperty(globalThis, hubSymbol);
			if (descriptor) Object.defineProperty(globalThis, hubSymbol, descriptor);
		}
	}
});

test("contract fixtures use flat launch correlation and complete detection metadata", async () => {
	const request: ExecutionSurfaceRequest = {
		command: "pi",
		args: ["--version"],
		cwd: "/workspace",
		environment: {},
		runId: "run-1",
		childId: "child-1",
		signal: new AbortController().signal,
	};
	const detection: ExecutionBackendDetection = await backend("mux").detect();

	assert.deepEqual({ runId: request.runId, childId: request.childId }, { runId: "run-1", childId: "child-1" });
	assert.equal(typeof detection.version, "string");
	assert.ok(Array.isArray(detection.capabilities));
});
