import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { RunSyncOptions } from "../../src/shared/types.ts";
import { finalizeSingleAttempt, initializeAttempt } from "../../src/runs/foreground/attempt-finalization.ts";
import {
	captureSingleOutputSnapshot,
	finalizeSingleOutput,
	formatFileOnlyFailure,
	formatSavedOutputReference,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	normalizeTopLevelOutput,
	resolveParallelTaskOutputPath,
	resolveSingleOutput,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../../src/runs/shared/single-output.ts";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (!dir) continue;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("normalizeSingleOutputOverride", () => {
	it("treats boolean and string false as disabled output", () => {
		assert.equal(normalizeSingleOutputOverride(false, "default.md"), false);
		assert.equal(normalizeSingleOutputOverride("false", "default.md"), false);
	});

	it("treats boolean and string true as the configured default output", () => {
		assert.equal(normalizeSingleOutputOverride(true, "default.md"), "default.md");
		assert.equal(normalizeSingleOutputOverride("true", "default.md"), "default.md");
		assert.equal(normalizeSingleOutputOverride("true", undefined), undefined);
	});

	it("passes explicit non-empty output paths through", () => {
		assert.equal(normalizeSingleOutputOverride("reports/out.md", "default.md"), "reports/out.md");
		assert.equal(normalizeSingleOutputOverride("", "default.md"), undefined);
		assert.equal(normalizeSingleOutputOverride(undefined, "default.md"), undefined);
	});
});

describe("normalizeTopLevelOutput", () => {
	it("normalizes top-level output truth table", () => {
		const defaultOutput = "default.md";
		const cases: Array<{ output: string | boolean | undefined; defaultOutput: string | undefined; expected: string | false }> = [
			{ output: undefined, defaultOutput, expected: false },
			{ output: "", defaultOutput, expected: false },
			{ output: " \t\n", defaultOutput, expected: false },
			{ output: false, defaultOutput, expected: false },
			{ output: "false", defaultOutput, expected: false },
			{ output: true, defaultOutput, expected: "default.md" },
			{ output: "true", defaultOutput, expected: "default.md" },
			{ output: true, defaultOutput: undefined, expected: false },
			{ output: true, defaultOutput: "", expected: false },
			{ output: "reports/out.md", defaultOutput, expected: "reports/out.md" },
			{ output: " reports/out.md ", defaultOutput, expected: " reports/out.md " },
		];

		for (const { output, defaultOutput: configuredOutput, expected } of cases) {
			assert.equal(normalizeTopLevelOutput(output, configuredOutput), expected);
		}
	});
});

describe("resolveSingleOutputPath", () => {
	it("does not resolve disabled or boolean-like output values", () => {
		assert.equal(resolveSingleOutputPath(false, "/repo"), undefined);
		assert.equal(resolveSingleOutputPath("false", "/repo"), undefined);
		assert.equal(resolveSingleOutputPath(true, "/repo"), undefined);
		assert.equal(resolveSingleOutputPath("true", "/repo"), undefined);
	});

	it("keeps absolute paths unchanged", () => {
		const absolutePath = path.join(os.tmpdir(), "pi-cohort-abs", "report.md");
		const resolved = resolveSingleOutputPath(absolutePath, "/repo", "/override");
		assert.equal(resolved, absolutePath);
	});

	it("resolves relative paths against requested cwd", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "/requested");
		assert.equal(resolved, path.resolve("/requested", "reviews/report.md"));
	});

	it("resolves relative paths against runtime cwd when requested cwd is absent", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime");
		assert.equal(resolved, path.resolve("/runtime", "reviews/report.md"));
	});

	it("resolves relative requested cwd from runtime cwd before resolving output", () => {
		const resolved = resolveSingleOutputPath("reviews/report.md", "/runtime", "nested/work");
		assert.equal(resolved, path.resolve("/runtime", "nested/work", "reviews/report.md"));
	});
});

describe("injectSingleOutputInstruction", () => {
	it("appends output instruction with resolved path", () => {
		const output = injectSingleOutputInstruction("Analyze this", "/tmp/report.md");
		assert.match(output, /Write your findings to: \/tmp\/report.md/);
	});
});

describe("resolveSingleOutput", () => {
	it("keeps agent-written file content when the file changed during the run", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.writeFileSync(outputPath, "real file content", "utf-8");

		const result = resolveSingleOutput(outputPath, "receipt text", before);
		assert.equal(result.fullOutput, "real file content");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "real file content");
	});

	it("falls back to persisting the assistant output when the file was not changed", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");

		fs.writeFileSync(outputPath, "stale content", "utf-8");
		const before = captureSingleOutputSnapshot(outputPath);
		const result = resolveSingleOutput(outputPath, "fresh assistant output", before);

		assert.equal(result.fullOutput, "fresh assistant output");
		assert.equal(result.savedPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), "fresh assistant output");
	});

	it("preserves read errors from changed output paths", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-output-test-"));
		tempDirs.push(dir);
		const outputPath = path.join(dir, "review.md");
		const before = captureSingleOutputSnapshot(outputPath);

		fs.mkdirSync(outputPath);
		const result = resolveSingleOutput(outputPath, "fallback output", before);

		assert.equal(result.fullOutput, "fallback output");
		assert.equal(result.savedPath, undefined);
		assert.match(result.saveError ?? "", /Failed to read changed output file/);
	});
});

describe("finalizeSingleAttempt file output recovery", () => {
	const agent: AgentConfig = {
		name: "reporter",
		description: "Writes a report",
		systemPrompt: "Write a report.",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: "reporter.md",
	};
	const report = "# Findings\nThe report is complete.\n";
	const toolResults = [
		{ name: "recovered grep error", toolName: "grep", isError: true, text: "Path not found: missing-directory" },
		{ name: "successful bash printing an exit expression", toolName: "bash", isError: false, text: 'REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1' },
	];
	const outputs = [
		{ name: "created", existed: false, changed: true, enabled: true },
		{ name: "updated", existed: true, changed: true, enabled: true },
		{ name: "unchanged", existed: true, changed: false, enabled: true },
		{ name: "missing", existed: false, changed: false, enabled: true },
		{ name: "disabled", existed: false, changed: false, enabled: false },
		{ name: "changed with nonzero exit", existed: false, changed: true, enabled: true, exitCode: 7 },
		{ name: "changed with explicit error", existed: false, changed: true, enabled: true, error: "Provider failed" },
	];

	for (const tool of toolResults) {
		for (const output of outputs) {
			it(`${tool.name}, output ${output.name}`, () => {
				const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-output-test-"));
				tempDirs.push(dir);
				const outputPath = output.enabled ? path.join(dir, "report.md") : undefined;
				if (output.existed) fs.writeFileSync(outputPath!, "stale report", "utf-8");
				const outputSnapshot = captureSingleOutputSnapshot(outputPath);
				const options = { outputPath, outputMode: "file-only", runId: "report" } as RunSyncOptions;
				const attempt = initializeAttempt(agent, "Review the files and write a report", undefined, options, {
					sessionEnabled: false,
					systemPrompt: agent.systemPrompt,
					attemptNotes: [],
				});
				attempt.result.messages.push({
					role: "toolResult",
					toolCallId: "inspect",
					toolName: tool.toolName,
					isError: tool.isError,
					content: [{ type: "text", text: tool.text }],
					timestamp: 1,
				});
				if (output.changed) {
					fs.writeFileSync(outputPath!, report, "utf-8");
					attempt.result.messages.push({
						role: "toolResult",
						toolCallId: "save",
						toolName: "write",
						isError: false,
						content: [{ type: "text", text: "Report written" }],
						timestamp: 2,
					});
				}

				attempt.result.exitCode = output.exitCode ?? 0;
				attempt.result.error = output.error;
				const result = finalizeSingleAttempt(attempt.result, attempt.progress, {
					agent,
					options,
					outputSnapshot,
					observedMutationAttempt: output.changed,
					interruptedByControl: false,
					allControlEvents: attempt.allControlEvents,
					emitControlEvent: attempt.emitControlEvent,
					startTime: attempt.startTime,
				});

				if (output.changed && !output.exitCode && !output.error) {
					assert.equal(result.exitCode, 0, result.error);
					assert.equal(result.error, undefined);
					assert.equal(result.savedOutputPath, outputPath);
					assert.deepEqual(result.outputReference, formatSavedOutputReference(outputPath!, report));
					assert.equal(result.finalOutput, result.outputReference.message);
					assert.equal(fs.readFileSync(outputPath!, "utf-8"), report);
				} else {
					assert.equal(result.exitCode, output.exitCode ?? 1);
					if (output.error) assert.equal(result.error, output.error);
					else if (!output.exitCode) assert.ok(result.error?.startsWith(`${tool.toolName} failed (exit 1):`));
					assert.equal(result.savedOutputPath, undefined);
					assert.equal(result.outputReference, undefined);
					assert.equal(result.finalOutput, "");
					if (output.changed) assert.equal(fs.readFileSync(outputPath!, "utf-8"), report);
					else if (output.existed) assert.equal(fs.readFileSync(outputPath!, "utf-8"), "stale report");
					else if (outputPath) assert.equal(fs.existsSync(outputPath), false);
				}
			});
		}
	}
});

describe("formatSavedOutputReference", () => {
	it("includes absolute path, human-readable size, and line count", () => {
		const reportPath = path.join(os.tmpdir(), "report.md");
		const ref = formatSavedOutputReference(reportPath, "line 1\nline 2");
		assert.equal(ref.path, path.resolve(reportPath));
		assert.equal(ref.bytes, Buffer.byteLength("line 1\nline 2", "utf-8"));
		assert.equal(ref.lines, 2);
		assert.equal(ref.message, `Output saved to: ${ref.path} (13 B, 2 lines). Read this file if needed.`);
	});

	it("formats larger byte sizes in KB", () => {
		const ref = formatSavedOutputReference("/tmp/large.md", "a".repeat(49_357));
		assert.match(ref.message, /\(48\.2 KB, 1 line\)/);
	});
});

describe("formatFileOnlyFailure", () => {
	const cases: Array<{ name: string; params: Parameters<typeof formatFileOnlyFailure>[0]; expected: string }> = [
		{
			name: "preserved reply",
			params: { preservedAt: "/tmp/reply.md" },
			expected: "Full reply preserved at /tmp/reply.md",
		},
		{
			name: "artifact output disabled",
			params: { notPreservedReason: "artifact output disabled" },
			expected: "Full reply not preserved (artifact output disabled)",
		},
		{
			name: "save error with preserved reply",
			params: { outputPath: "/tmp/requested.md", saveError: "EACCES", preservedAt: "/tmp/reply.md" },
			expected: "Output file error: /tmp/requested.md\nEACCES\n\nFull reply preserved at /tmp/reply.md",
		},
		{
			name: "save error with artifact write failure",
			params: { outputPath: "/tmp/requested.md", saveError: "EISDIR", notPreservedReason: "artifact write failed: EACCES" },
			expected: "Output file error: /tmp/requested.md\nEISDIR\n\nFull reply not preserved (artifact write failed: EACCES)",
		},
	];

	for (const { name, params, expected } of cases) {
		it(name, () => {
			const output = formatFileOnlyFailure(params);
			assert.equal(output, expected);
		});
	}
});

describe("resolveParallelTaskOutputPath", () => {
	const base = { ctxCwd: "/ctx", taskCwd: "/wt/task", index: 0 };
	const runDir = path.resolve("/runs/abc");

	it("redirects a relative output into the per-task leaf when isolated", () => {
		const result = resolveParallelTaskOutputPath({ ...base, output: "report.md", isolated: true, runDir });
		assert.deepEqual(result, { path: path.join(runDir, "task-0", "report.md") });
	});

	it("appends exactly one task segment for a nested relative output", () => {
		const result = resolveParallelTaskOutputPath({ ...base, index: 2, output: "out/report.md", isolated: true, runDir });
		assert.deepEqual(result, { path: path.join(runDir, "task-2", "out", "report.md") });
	});

	it("passes an absolute output through untouched", () => {
		const result = resolveParallelTaskOutputPath({ ...base, output: "/tmp/fixed.md", isolated: true, runDir });
		assert.deepEqual(result, { path: "/tmp/fixed.md" });
	});

	it("matches resolveSingleOutputPath when not isolated", () => {
		const result = resolveParallelTaskOutputPath({ ...base, output: "report.md", isolated: false });
		assert.deepEqual(result, { path: resolveSingleOutputPath("report.md", "/ctx", "/wt/task") });
	});

	it("returns undefined path for disabled output", () => {
		assert.deepEqual(resolveParallelTaskOutputPath({ ...base, output: false, isolated: true, runDir }), { path: undefined });
		assert.deepEqual(resolveParallelTaskOutputPath({ ...base, output: "false", isolated: true, runDir }), { path: undefined });
	});

	it("rejects an output escaping the per-task leaf", () => {
		const result = resolveParallelTaskOutputPath({ ...base, index: 1, output: "../report.md", isolated: true, runDir });
		assert.ok("error" in result);
		assert.match(result.error, /^Parallel task 2 output '\.\.\/report\.md' resolves outside its per-task directory/);
	});

	it("rejects an output normalizing to the leaf itself", () => {
		for (const output of [".", "dir/.."]) {
			const result = resolveParallelTaskOutputPath({ ...base, output, isolated: true, runDir });
			assert.ok("error" in result, `expected ${output} to be rejected`);
		}
	});

	it("accepts in-leaf names that merely begin with two dots", () => {
		for (const output of ["..foo/report.md", "..hidden.md"]) {
			const result = resolveParallelTaskOutputPath({ ...base, output, isolated: true, runDir });
			assert.deepEqual(result, { path: path.join(runDir, "task-0", output) }, `expected ${output} to resolve inside the leaf`);
		}
	});

	it("still rejects real parent segments regardless of depth", () => {
		for (const output of ["../report.md", "../../report.md"]) {
			const result = resolveParallelTaskOutputPath({ ...base, output, isolated: true, runDir });
			assert.ok("error" in result, `expected ${output} to be rejected`);
		}
	});
});

describe("validateFileOnlyOutputMode", () => {
	it("requires an output path for file-only mode", () => {
		assert.match(validateFileOnlyOutputMode("file-only", undefined, "Single run") ?? "", /Single run sets outputMode: "file-only"/);
		assert.equal(validateFileOnlyOutputMode("file-only", "/tmp/report.md", "Single run"), undefined);
		assert.equal(validateFileOnlyOutputMode("inline", undefined, "Single run"), undefined);
	});
});

describe("finalizeSingleOutput", () => {
	it("formats saved-path messaging around the already-resolved output", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			truncatedOutput: "[TRUNCATED]\nline 1",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 0,
		});

		assert.match(result.displayOutput, /^\[TRUNCATED\]\nline 1/);
		assert.match(result.displayOutput, /Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("returns only the saved-output reference in file-only mode", () => {
		const result = finalizeSingleOutput({
			fullOutput: "line 1\nline 2\nline 3",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			outputMode: "file-only",
			exitCode: 0,
		});

		assert.doesNotMatch(result.displayOutput, /line 1/);
		assert.match(result.displayOutput, /^Output saved to:/);
		assert.match(result.displayOutput, /3 lines/);
	});

	it("does not add save messaging on failed runs", () => {
		const result = finalizeSingleOutput({
			fullOutput: "full output",
			truncatedOutput: "truncated output",
			outputPath: "/tmp/review.md",
			savedPath: "/tmp/review.md",
			exitCode: 1,
		});

		assert.equal(result.displayOutput, "truncated output");
	});
});
