import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { readProjectExecutionBackend } from "../../src/agents/agents.ts";

describe("execution backend project settings", () => {
	let tempDirs: string[] = [];

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

	it("returns undefined when no settings exist", () => {
		const repoDir = createTempRepo();
		const result = readProjectExecutionBackend(repoDir);
		assert.equal(result, undefined);
	});

	it("reads executionBackend from root level", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { executionBackend: "test-backend" });
		const result = readProjectExecutionBackend(repoDir);
		assert.equal(result, "test-backend");
	});

	it("nearest level wins over farther levels", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested", "sub");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });
		writeProjectSettings(repoDir, "nested", { executionBackend: "nested-backend" });

		const result = readProjectExecutionBackend(subdir);
		assert.equal(result, "nested-backend");
	});

	it("skips levels with no settings", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested", "sub");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });
		// nested level has no .pi/settings.json

		const result = readProjectExecutionBackend(subdir);
		assert.equal(result, "root-backend");
	});

	it("skips levels with malformed JSON", () => {
		const repoDir = createTempRepo();
		const subdir = path.join(repoDir, "nested");
		fs.mkdirSync(subdir, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root-backend" });

		const nestedDir = path.join(repoDir, "nested", ".pi");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "settings.json"), "{ invalid json");

		const result = readProjectExecutionBackend(subdir);
		assert.equal(result, "root-backend");
	});

	it("normalizes string value by trimming whitespace", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { executionBackend: "  spaced  " });
		const result = readProjectExecutionBackend(repoDir);
		assert.equal(result, "spaced");
	});

	it("returns undefined when executionBackend is not in subagents settings", () => {
		const repoDir = createTempRepo();
		writeProjectSettings(repoDir, ".", { disableBuiltins: true });
		const result = readProjectExecutionBackend(repoDir);
		assert.equal(result, undefined);
	});

	it("handles three-level nesting with middle level winning", () => {
		const repoDir = createTempRepo();
		const middle = path.join(repoDir, "middle");
		const deepest = path.join(middle, "deepest");
		fs.mkdirSync(deepest, { recursive: true });

		writeProjectSettings(repoDir, ".", { executionBackend: "root" });
		writeProjectSettings(repoDir, "middle", { executionBackend: "middle" });
		// deepest has no setting

		const result = readProjectExecutionBackend(deepest);
		assert.equal(result, "middle");
	});

	it("stops at git root and does not walk parent directories", () => {
		const repoDir = createTempRepo();
		const nested = path.join(repoDir, "nested");
		fs.mkdirSync(nested, { recursive: true });

		// Only nested has settings
		writeProjectSettings(repoDir, "nested", { executionBackend: "nested-backend" });

		// Create another temp dir that could theoretically be a parent
		// but is actually unrelated
		const unrelatedParent = createTempRepo();
		writeProjectSettings(unrelatedParent, ".", { executionBackend: "unrelated" });

		const result = readProjectExecutionBackend(nested);
		assert.equal(result, "nested-backend");
	});

	it("throws for blank executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: "" } }));

		assert.throws(
			() => readProjectExecutionBackend(repoDir),
			/must not be blank/i,
		);
	});

	it("throws for whitespace-only executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: "  \t  " } }));

		assert.throws(
			() => readProjectExecutionBackend(repoDir),
			/must not be blank/i,
		);
	});

	it("throws for non-string executionBackend", () => {
		const repoDir = createTempRepo();
		const settingsDir = path.join(repoDir, ".pi");
		fs.mkdirSync(settingsDir, { recursive: true });
		fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ subagents: { executionBackend: 123 } }));

		assert.throws(
			() => readProjectExecutionBackend(repoDir),
			/invalid.*executionBackend/i,
		);
	});
});
