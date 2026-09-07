import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { selectExecutionBackend } from "../../src/execution-backend/selection.ts";
import type { ExecutionBackend, ExecutionBackendDetection } from "../../src/execution-backend/types.ts";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "../../src/execution-backend/types.ts";

function createFakeBackend(
	name: string,
	detection: ExecutionBackendDetection | (() => Promise<ExecutionBackendDetection>),
): ExecutionBackend {
	return {
		name,
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		detect: typeof detection === "function" ? detection : async () => detection,
		launch: async () => {
			throw new Error("not implemented");
		},
		reattach: async () => {
			throw new Error("not implemented");
		},
		close: async () => {},
	};
}

describe("execution backend selection", () => {
	const disposers: Array<() => void> = [];

	afterEach(() => {
		for (const dispose of disposers.splice(0).reverse()) dispose();
	});

	it("selects native when auto with no registrations", async () => {
		const { selection } = await selectExecutionBackend("auto");
		assert.equal(selection.kind, "native");
	});

	it("selects native when undefined defaults to auto", async () => {
		const { selection } = await selectExecutionBackend(undefined);
		assert.equal(selection.kind, "native");
	});

	it("selects native when explicitly requested", async () => {
		const available = createFakeBackend("test-backend", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(available));

		const { selection } = await selectExecutionBackend("native");
		assert.equal(selection.kind, "native");
	});

	it("native invokes zero detectors", async () => {
		let detectCount = 0;
		const backend = createFakeBackend("test-backend", async () => {
			detectCount++;
			return { available: true, version: "1.0.0", capabilities: [] };
		});
		disposers.push(registerExecutionBackend(backend));

		await selectExecutionBackend("native");
		assert.equal(detectCount, 0);
	});

	it("selects first available backend in insertion order with auto", async () => {
		const zebra = createFakeBackend("zebra", { available: true, version: "1.0.0", capabilities: [] });
		const alpha = createFakeBackend("alpha", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(zebra));
		disposers.push(registerExecutionBackend(alpha));

		const { selection } = await selectExecutionBackend("auto");
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "zebra");
		}
	});

	it("reversed registration order changes winner under auto", async () => {
		const alpha = createFakeBackend("alpha", { available: true, version: "1.0.0", capabilities: [] });
		const zebra = createFakeBackend("zebra", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(alpha));
		disposers.push(registerExecutionBackend(zebra));

		const { selection } = await selectExecutionBackend("auto");
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "alpha");
		}
	});

	it("skips unavailable backends under auto and reports diagnostics", async () => {
		const unavailable = createFakeBackend("alpha", { available: false, version: "1.0.0", capabilities: [], reason: "not installed" });
		const available = createFakeBackend("beta", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(unavailable));
		disposers.push(registerExecutionBackend(available));

		const { selection, diagnostics } = await selectExecutionBackend("auto");
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "beta");
		}
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.backend, "alpha");
		assert.equal(diagnostics[0]?.reason, "unavailable");
	});

	it("skips throwing backends under auto without crashing and reports detection_error", async () => {
		const throwing = createFakeBackend("alpha", async () => {
			throw new Error("deliberate test error");
		});
		const available = createFakeBackend("beta", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(throwing));
		disposers.push(registerExecutionBackend(available));

		const { selection, diagnostics } = await selectExecutionBackend("auto");
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "beta");
		}
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.backend, "alpha");
		assert.equal(diagnostics[0]?.reason, "detection_error");
	});

	it("diagnostics contain backend name but never thrown error text", async () => {
		const throwing = createFakeBackend("alpha", async () => {
			throw new Error("secret credential exposed");
		});
		disposers.push(registerExecutionBackend(throwing));

		const { diagnostics } = await selectExecutionBackend("auto");
		assert.equal(diagnostics.length, 1);
		assert.equal(diagnostics[0]?.backend, "alpha");
		assert.equal(diagnostics[0]?.reason, "detection_error");
		const serialized = JSON.stringify(diagnostics);
		assert.doesNotMatch(serialized, /secret/);
		assert.doesNotMatch(serialized, /credential/);
	});

	it("fails loudly when explicit backend is unavailable without echoing detection.reason", async () => {
		const unavailable = createFakeBackend("test-backend", { available: false, version: "1.0.0", capabilities: [], reason: "secret path leaked" });
		disposers.push(registerExecutionBackend(unavailable));

		await assert.rejects(
			async () => selectExecutionBackend("test-backend"),
			(err: Error) => {
				assert.match(err.message, /unavailable/i);
				assert.doesNotMatch(err.message, /secret/i);
				assert.doesNotMatch(err.message, /path/i);
				assert.doesNotMatch(err.message, /leaked/i);
				return true;
			},
		);
	});

	it("fails loudly when explicit backend throws without echoing error text", async () => {
		const throwing = createFakeBackend("test-backend", async () => {
			throw new Error("secret credential exposed");
		});
		disposers.push(registerExecutionBackend(throwing));

		await assert.rejects(
			async () => selectExecutionBackend("test-backend"),
			(err: Error) => {
				assert.match(err.message, /failed to detect/i);
				assert.doesNotMatch(err.message, /secret/i);
				assert.doesNotMatch(err.message, /credential/i);
				assert.doesNotMatch(err.message, /exposed/i);
				return true;
			},
		);
	});

	it("fails loudly when explicit backend is unknown", async () => {
		await assert.rejects(
			async () => selectExecutionBackend("unknown-backend"),
			/not registered/i,
		);
	});

	it("sees late-registered backends in later selection", async () => {
		let result = await selectExecutionBackend("auto");
		assert.equal(result.selection.kind, "native");

		const available = createFakeBackend("late-backend", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(available));

		result = await selectExecutionBackend("auto");
		assert.equal(result.selection.kind, "external");
		if (result.selection.kind === "external") {
			assert.equal(result.selection.backend.name, "late-backend");
		}
	});

	it("runs detect once per candidate per selection", async () => {
		let detectCount = 0;
		const backend = createFakeBackend("test-backend", async () => {
			detectCount++;
			return { available: true, version: "1.0.0", capabilities: [] };
		});
		disposers.push(registerExecutionBackend(backend));

		await selectExecutionBackend("auto");
		assert.equal(detectCount, 1);

		await selectExecutionBackend("auto");
		assert.equal(detectCount, 2);

		await selectExecutionBackend("test-backend");
		assert.equal(detectCount, 3);
	});

	it("preserves exact detection object identity", async () => {
		const testCapabilities = ["test-cap-1", "test-cap-2"];
		const originalDetection = { available: true, version: "1.0.0", capabilities: testCapabilities };
		const backend = createFakeBackend("test-backend", async () => originalDetection);
		disposers.push(registerExecutionBackend(backend));

		const result = await selectExecutionBackend("auto");
		assert.equal(result.selection.kind, "external");
		if (result.selection.kind === "external") {
			assert.strictEqual(result.selection.detection, originalDetection);
		}
	});

	it("rejects blank backend name", async () => {
		await assert.rejects(
			async () => selectExecutionBackend(""),
			/blank/i,
		);
	});

	it("rejects whitespace-only backend name", async () => {
		await assert.rejects(
			async () => selectExecutionBackend("  \t  "),
			/blank/i,
		);
	});

	it("rejects invalid backend name type", async () => {
		await assert.rejects(
			async () => selectExecutionBackend(123 as any),
			/must be.*string/i,
		);
	});

	it("normalizes preference with trim", async () => {
		const available = createFakeBackend("test-backend", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(available));

		const { selection } = await selectExecutionBackend("  test-backend  ");
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "test-backend");
		}
	});
});
