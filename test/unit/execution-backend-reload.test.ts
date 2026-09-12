import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EXECUTION_BACKEND_PROTOCOL_VERSION,
	registerExecutionBackend,
} from "../../src/execution-backend/index.ts";
import { executionBackendRegistrations } from "../../src/execution-backend/registry.ts";
import { createDetachedExecutionBackendCoordinator, decodeDetachedExecutionBackendConfig, ExecutionBackendReloadError, reconstructExecutionBackends } from "../../src/execution-backend/reload.ts";
import { selectExecutionBackend } from "../../src/execution-backend/selection.ts";
import type { ExecutionBackend, ExecutionBackendReloadDescriptor } from "../../src/execution-backend/types.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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

function descriptor(overrides: Partial<ExecutionBackendReloadDescriptor> = {}): ExecutionBackendReloadDescriptor {
	return {
		protocolVersion: 1,
		packageJsonUrl: new URL("../../package.json", import.meta.url).href,
		publicSubpath: "./execution-backend",
		factoryExport: "createBackend",
		...overrides,
	};
}

describe("execution backend reload registrations", () => {
	it("snapshots ordered registrations while preserving absent reload metadata", async () => {
		await withFreshHub(() => {
			const original = descriptor();
			const disposeFirst = registerExecutionBackend(backend("first"));
			const disposeSecond = registerExecutionBackend(backend("second"), { reload: original });
			(original as { factoryExport: string }).factoryExport = "mutated";

			const snapshot = executionBackendRegistrations();
			assert.deepEqual(snapshot.map(registration => registration.name), ["first", "second"]);
			assert.equal(snapshot[0]?.reload, undefined);
			assert.equal(snapshot[1]?.reload?.factoryExport, "createBackend");
			assert.equal(Object.isFrozen(snapshot[1]?.reload), true);
			assert.throws(() => { (snapshot[1]!.reload as { factoryExport: string }).factoryExport = "changed"; }, TypeError);

			disposeFirst();
			disposeSecond();
		});
	});

	it("accepts a legacy hub without reload metadata and removes metadata only with its backend", async () => {
		await withFreshHub(() => {
			const legacyBackends = new Map<string, ExecutionBackend>();
			Object.defineProperty(globalThis, hubSymbol, {
				configurable: true,
				value: { protocolVersion: 1, backends: legacyBackends },
			});
			const first = backend("first");
			const disposeFirst = registerExecutionBackend(first, { reload: descriptor() });
			disposeFirst();
			const replacement = backend("first");
			const disposeReplacement = registerExecutionBackend(replacement);
			assert.deepEqual(executionBackendRegistrations(), [{ name: "first", reload: undefined }]);
			disposeReplacement();
		});
	});

	it("rejects descriptors with payloads, non-local URLs, and private exports without exposing their values", async () => {
		await withFreshHub(() => {
			for (const malformed of [
				{ ...descriptor(), environment: { TOKEN: "secret-sentinel" } },
				{ ...descriptor(), packageJsonUrl: "https://example.test/package.json" },
				{ ...descriptor(), publicSubpath: "./not-exported" },
			]) {
				assert.throws(
					() => registerExecutionBackend(backend(`bad-${Math.random()}`), { reload: malformed as ExecutionBackendReloadDescriptor }),
					(error: Error) => {
						assert.doesNotMatch(error.message, /secret-sentinel|example\.test|not-exported/);
						return true;
					},
				);
			}
		});
	});

	it("fails with metadata_missing before reconstructing registrations without metadata", async () => {
		await withFreshHub(async () => {
			await assert.rejects(
				reconstructExecutionBackends([{ name: "legacy" }]),
				(error: unknown) => error instanceof ExecutionBackendReloadError
					&& error.code === "metadata_missing",
			);
		});
	});

	it("reconstructs only named factories and verifies their backend identity", async () => {
		await withFreshHub(async () => {
			await assert.rejects(
				reconstructExecutionBackends([{ name: "expected", reload: descriptor() }]),
				(error: unknown) => error instanceof ExecutionBackendReloadError
					&& error.code === "factory_invalid"
					&& !/package\.json|createBackend/.test(error.message),
			);
		});
	});

	it("prepares each detached registration once in manifest order before explicit and auto selection", async () => {
		await withFreshHub(async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-reload-"));
			try {
				const registrations = ["first", "second"].map((name) => {
					const packageDir = path.join(root, name);
					fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
					fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
						name: `fixture-${name}`,
						type: "module",
						exports: { "./execution-backend": "./src/backend.mjs" },
					}), "utf8");
					fs.writeFileSync(path.join(packageDir, "src", "backend.mjs"), `
						export function createBackend() {
							globalThis.fixtureFactories = [...(globalThis.fixtureFactories ?? []), ${JSON.stringify(name)}];
							return {
								name: ${JSON.stringify(name)}, protocolVersion: 1,
								async detect() { globalThis.fixtureDetections = [...(globalThis.fixtureDetections ?? []), ${JSON.stringify(name)}]; return { available: true, version: "v1", capabilities: [] }; },
								async launch() { throw new Error("not used"); }, async reattach() { return { status: "gone" }; }, async close() {},
							};
						}
						export default function defaultExtension() { throw new Error("default extension must not run"); }
					`, "utf8");
					return {
						name,
						reload: {
							protocolVersion: 1 as const,
							packageJsonUrl: pathToFileURL(path.join(packageDir, "package.json")).href,
							publicSubpath: "./execution-backend" as const,
							factoryExport: "createBackend",
						},
					};
				});
				(globalThis as { fixtureFactories?: string[] }).fixtureFactories = [];
				(globalThis as { fixtureDetections?: string[] }).fixtureDetections = [];
				const config = decodeDetachedExecutionBackendConfig(JSON.parse(JSON.stringify({
					protocolVersion: 1,
					userPreference: "first",
					registrations,
				})));
				const coordinator = createDetachedExecutionBackendCoordinator(config);

				await selectExecutionBackend("native", coordinator);
				assert.deepEqual((globalThis as { fixtureFactories?: string[] }).fixtureFactories, []);
				await Promise.all([coordinator.prepare("first"), coordinator.prepare("auto")]);
				await selectExecutionBackend("first", coordinator);
				const automatic = await selectExecutionBackend("auto", coordinator);
				assert.equal(automatic.selection.kind, "external");
				assert.deepEqual((globalThis as { fixtureFactories?: string[] }).fixtureFactories, ["first", "second"]);
				assert.deepEqual((globalThis as { fixtureDetections?: string[] }).fixtureDetections, ["first", "first"]);
			} finally {
				Reflect.deleteProperty(globalThis, "fixtureFactories");
				Reflect.deleteProperty(globalThis, "fixtureDetections");
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});

	it("does not silently drop missing detached metadata for auto or explicit selection", async () => {
		await withFreshHub(async () => {
			const coordinator = createDetachedExecutionBackendCoordinator(decodeDetachedExecutionBackendConfig({
				protocolVersion: 1,
				registrations: [{ name: "legacy" }],
			}));
			await assert.rejects(
				selectExecutionBackend("legacy", coordinator),
				(error: unknown) => error instanceof ExecutionBackendReloadError && error.code === "metadata_missing",
			);
			await assert.rejects(
				selectExecutionBackend("auto", coordinator),
				(error: unknown) => error instanceof ExecutionBackendReloadError && error.code === "metadata_missing",
			);
			await assert.rejects(selectExecutionBackend("unknown", coordinator), /not registered/);
		});
	});
});
