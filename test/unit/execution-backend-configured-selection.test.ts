import assert from "node:assert/strict";
import { describe, it, after, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerExecutionBackend } from "../../src/execution-backend/registry.ts";
import { selectConfiguredExecutionBackend } from "../../src/execution-backend/configured-selection.ts";
import type { ExecutionBackend, ExecutionBackendDetection } from "../../src/execution-backend/types.ts";
import { EXECUTION_BACKEND_PROTOCOL_VERSION } from "../../src/execution-backend/types.ts";
import type { ExtensionConfig } from "../../src/shared/types.ts";

function createFakeBackend(
	name: string,
	detection: ExecutionBackendDetection,
): ExecutionBackend {
	return {
		name,
		protocolVersion: EXECUTION_BACKEND_PROTOCOL_VERSION,
		detect: async () => detection,
		launch: async () => {
			throw new Error("not implemented");
		},
		reattach: async () => {
			throw new Error("not implemented");
		},
		close: async () => {},
	};
}

describe("configured execution backend selection", () => {
	const disposers: Array<() => void> = [];
	let tempDirs: string[] = [];

	afterEach(() => {
		for (const dispose of disposers.splice(0).reverse()) dispose();
	});

	after(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function createTempRepo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-test-"));
		tempDirs.push(dir);
		fs.mkdirSync(path.join(dir, ".git"));
		return dir;
	}

	function writeProjectSettings(repoDir: string, level: string, settings: unknown): void {
		const settingsDir = path.join(repoDir, level, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: settings }));
	}

	it("uses auto when no config exists", async () => {
		const repoDir = createTempRepo();
		const userConfig: ExtensionConfig = {};

		const { selection } = await selectConfiguredExecutionBackend({ cwd: repoDir, userConfig });
		assert.equal(selection.kind, "native");
	});

	for (const projectValue of ["test-backend", "", 123]) {
		it(`uses supplied preference without parsing project backend ${JSON.stringify(projectValue)}`, async () => {
			const repoDir = createTempRepo();
			writeProjectSettings(repoDir, ".", { executionBackend: projectValue });
			const { selection } = await selectConfiguredExecutionBackend({ cwd: repoDir, userConfig: { executionBackend: "native" } });
			assert.equal(selection.kind, "native");
		});
	}

	it("user config wins when no project setting exists", async () => {
		const available = createFakeBackend("test-backend", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(available));

		const repoDir = createTempRepo();
		const userConfig: ExtensionConfig = { executionBackend: "test-backend" };

		const { selection } = await selectConfiguredExecutionBackend({ cwd: repoDir, userConfig });
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "test-backend");
		}
	});

	it("auto is default when neither project nor user config exists", async () => {
		const available = createFakeBackend("test-backend", { available: true, version: "1.0.0", capabilities: [] });
		disposers.push(registerExecutionBackend(available));

		const repoDir = createTempRepo();
		const userConfig: ExtensionConfig = {};

		const { selection } = await selectConfiguredExecutionBackend({ cwd: repoDir, userConfig });
		assert.equal(selection.kind, "external");
		if (selection.kind === "external") {
			assert.equal(selection.backend.name, "test-backend");
		}
	});

});
