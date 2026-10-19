import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChainStep } from "../../src/shared/settings.ts";
import type { ChainOutputMapEntry } from "../../src/shared/types.ts";
import { removeTrees } from "../../src/runs/shared/worktree.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ChainOutputValidationError,

	outputEntryFromAsyncResult,
	outputEntryFromResult,
	resolveOutputReferences,
	validateChainOutputBindings,
} from "../../src/runs/shared/chain-outputs.ts";

import * as chainOutputs from "../../src/runs/shared/chain-outputs.ts";

const schema = { type: "object" };

describe("validateChainOutputBindings - stopOn", () => {
	it("rejects a stopOn step without outputSchema through ChainOutputValidationError", () => {
		assert.throws(
			() => validateChainOutputBindings([{ agent: "a", stopOn: { path: "/v", in: ["FAIL"] } }]),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Chain step 1 has stopOn but no outputSchema.",
		);
	});
	it("accepts a valid stopOn step", () => {
		validateChainOutputBindings([{ parallel: [{ agent: "a", outputSchema: schema, as: "r1" }], stopOn: { path: "/v", in: ["FAIL"] } }]);
	});
});

describe("validateChainOutputBindings - patchPath references", () => {
	it("accepts {outputs.name.patchPath} when the producer is a worktree parallel step", () => {
		validateChainOutputBindings([
			{ parallel: [{ agent: "impl", as: "impl_1" }], worktree: true },
			{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
		]);
	});
	it("rejects {outputs.name.patchPath} when the producer is not a worktree step", () => {
		assert.throws(
			() => validateChainOutputBindings([
				{ parallel: [{ agent: "impl", as: "impl_1" }] },
				{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
			]),
			(error: unknown) => error instanceof ChainOutputValidationError
				&& error.message === "Chain step 2 references {outputs.impl_1.patchPath} but step 1 is not a worktree step.",
		);
		assert.throws(
			() => validateChainOutputBindings([
				{ agent: "impl", as: "impl_1" },
				{ agent: "reviewer", task: "Review {outputs.impl_1.patchPath}" },
			]),
			/step 1 is not a worktree step/,
		);
	});
	it("still rejects unknown sub-fields and unknown names", () => {
		assert.throws(
			() => validateChainOutputBindings([
				{ parallel: [{ agent: "impl", as: "impl_1" }], worktree: true },
				{ agent: "reviewer", task: "Review {outputs.impl_1.other}" },
			]),
			/Invalid chain output reference '\{outputs\.impl_1\.other\}'/,
		);
		assert.throws(
			() => validateChainOutputBindings([{ agent: "reviewer", task: "Review {outputs.nope.patchPath}" }]),
			/Unknown chain output reference '\{outputs\.nope\.patchPath\}'/,
		);
	});
});

describe("resolveOutputReferences - patchPath", () => {
	it("substitutes the bound patch path", () => {
		const text = resolveOutputReferences("Read {outputs.impl_1.patchPath} and {outputs.impl_1}", {
			impl_1: { text: "{\"status\":\"DONE\"}", agent: "impl", stepIndex: 0, patchPath: "/run/worktree-diffs/step-0/task-0-impl.patch" },
		});
		assert.equal(text, "Read /run/worktree-diffs/step-0/task-0-impl.patch and {\"status\":\"DONE\"}");
	});
	it("throws naming no changes when the entry has no patch", () => {
		assert.throws(
			() => resolveOutputReferences("{outputs.impl_1.patchPath}", { impl_1: { text: "x", agent: "impl", stepIndex: 0 } }),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Output 'impl_1' has no patch (no changes).",
		);
	});
	it("throws naming the capture failure", () => {
		assert.throws(
			() => resolveOutputReferences("{outputs.impl_1.patchPath}", { impl_1: { text: "x", agent: "impl", stepIndex: 0, patchError: "git diff failed" } }),
			(error: unknown) => error instanceof ChainOutputValidationError && error.message === "Output 'impl_1' has no patch (capture failed: git diff failed).",
		);
	});
});

describe("outputEntryFromResult / outputEntryFromAsyncResult - patch fields", () => {
	const result = { agent: "impl", exitCode: 0, finalOutput: "done", messages: [], structuredOutput: { status: "DONE" } };
	it("binds patchPath only when given, and never patchError at the same time", () => {
		assert.deepEqual(outputEntryFromResult(result as never, 0), { text: "{\"status\":\"DONE\"}", structured: { status: "DONE" }, agent: "impl", stepIndex: 0 });
		assert.equal(outputEntryFromResult(result as never, 0, { patchPath: "/p.patch" }).patchPath, "/p.patch");
		assert.equal(outputEntryFromResult(result as never, 0, { patchError: "boom" }).patchError, "boom");
		assert.equal(outputEntryFromAsyncResult({ agent: "impl", output: "done" }, 2, { patchPath: "/q.patch" }).patchPath, "/q.patch");
		assert.equal(outputEntryFromAsyncResult({ agent: "impl", output: "done" }, 2).patchPath, undefined);
	});
});


describe("tree output references", () => {
	const producer: ChainStep = { parallel: [{ agent: "impl", as: "x" }], worktree: true };
	for (const field of ["task", "label", "cwd"]) {
		for (const shape of ["sequential", "static", "dynamic"]) {
			it(`scans ${shape} ${field}`, () => {
				const leaf = { agent: "review", [field]: "{outputs.x.treePath}" };
				const step: ChainStep = shape === "static" ? { parallel: [leaf] } : shape === "dynamic"
					? { expand: { from: { output: "x", path: "/items" }, maxItems: 2 }, parallel: leaf, collect: { as: "reviews" } } : leaf;
				validateChainOutputBindings([producer, step]);
				assert.throws(() => validateChainOutputBindings([{ ...producer, worktree: false }, step]), /Chain step 2 references .* but step 1 is not a worktree step/);
			});
		}
	}
	it("scans group cwd and rejects cwd placement before availability", () => {
		validateChainOutputBindings([producer, { parallel: [{ agent: "review" }], cwd: "{outputs.x.treePath}" }]);
		for (const cwd of ["{outputs.missing}", "{outputs.missing.patchPath}"]) {
			assert.throws(() => validateChainOutputBindings([producer, { agent: "review", cwd }]), { message: "Chain step 2: only {outputs.<name>.treePath} may appear in cwd." });
		}
		for (const step of [
			{ parallel: [{ agent: "review" }], cwd: "{outputs.missing}", worktree: true },
			{ parallel: [{ agent: "review", cwd: "{outputs.x.treePath}" }], worktree: true },
		]) assert.throws(() => validateChainOutputBindings([producer, step]), { message: "Chain step 2: cwd output references cannot be combined with worktree: true." });
	});
	for (const ref of ["x.other", "x.treePath.more", "bad-name", "1bad"]) {
		it(`rejects invalid grammar ${ref}`, () => {
			assert.throws(() => resolveOutputReferences(`{outputs.${ref}}`, {}), /Invalid chain output reference/);
		});
	}
	it("rejects unknown, forward, and registry-less tree references", () => {
		assert.throws(() => validateChainOutputBindings([{ agent: "review", task: "{outputs.x.treePath}" }, producer]), /Unknown chain output reference/);
		assert.throws(() => resolveOutputReferences("{outputs.nope.treePath}", {}), /Unknown chain output reference/);
		assert.throws(() => resolveOutputReferences("{outputs.x.treePath}", { x: { agent: "impl", text: "x", stepIndex: 0 } }), /registry.*unavailable|unavailable.*registry/i);
	});
});

describe("TreeRegistry", () => {
	function git(cwd: string, args: string[]): string {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	}
	it("builds once per name, publishes paths, and registers failed builds for cleanup", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "chain-trees-"));
		const repoCwd = path.join(root, "repo");
		fs.mkdirSync(repoCwd);
		const trees = new chainOutputs.TreeRegistry(path.join(root, "run"));
		try {
			git(repoCwd, ["init"]);
			git(repoCwd, ["config", "user.email", "tests@example.com"]);
			git(repoCwd, ["config", "user.name", "Tests"]);
			fs.writeFileSync(path.join(repoCwd, "file"), "base\n");
			git(repoCwd, ["add", "."]);
			git(repoCwd, ["commit", "-m", "base"]);
			const baseCommit = git(repoCwd, ["rev-parse", "HEAD"]);
			fs.writeFileSync(path.join(repoCwd, "file"), "changed\n");
			const patchPath = path.join(root, "change.patch");
			fs.writeFileSync(patchPath, git(repoCwd, ["diff"]) + "\n");
			const x: ChainOutputMapEntry = { text: "done", agent: "impl", stepIndex: 0, taskIndex: 0, baseCommit, repoCwd, patchPath };
			const outputs = { x };
			const first = resolveOutputReferences("{outputs.x.treePath}", outputs, trees);
			assert.equal(first, path.join(root, "run", "worktree-trees", "step-0", "task-0-impl"));
			assert.equal(resolveOutputReferences("Read {outputs.x.treePath}", outputs, trees), `Read ${first}`);
			assert.equal(x.treePath, first);
			assert.equal(trees.created.length, 1);
			assert.equal(trees.built.size, 1);
			assert.equal(fs.readFileSync(path.join(first, "file"), "utf8"), "changed\n");
			assert.equal(git(first, ["diff", "--cached", "--name-only"]), "file");
			assert.notEqual(trees.resolve("y", { ...x, taskIndex: 1 }), first);
			const invalid = path.join(root, "invalid.patch");
			fs.writeFileSync(invalid, "invalid");
			assert.throws(() => trees.resolve("bad", { ...x, taskIndex: 2, patchPath: invalid }), { message: "Output 'bad' tree build failed: error: No valid patches in input (allow with \"--allow-empty\")" });
			assert.equal(trees.created.length, 3);
			assert.equal(trees.built.has("bad"), false);
		} finally {
			removeTrees(trees.created);
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
	for (const patchError of [undefined, "denied"]) {
		it(`does not register an absent patch (${patchError ?? "no changes"})`, () => {
			const trees = new chainOutputs.TreeRegistry("/unused");
			assert.throws(() => trees.resolve("x", { text: "", agent: "impl", stepIndex: 0, patchError }), { message: `Output 'x' has no patch (${patchError ? `capture failed: ${patchError}` : "no changes"}).` });
			assert.equal(trees.created.length, 0);
			assert.equal(trees.built.size, 0);
		});
	}
});

it("preserves producer metadata and compact structured text in both constructors", () => {
	const metadata = { taskIndex: 0, baseCommit: "base", repoCwd: "/repo", patchError: "denied" };
	const expected = { ...metadata, agent: "impl", stepIndex: 2, text: '{"ok":true}', structured: { ok: true } };
	assert.deepEqual(outputEntryFromResult({ agent: "impl", messages: [], structuredOutput: { ok: true } } as never, 2, metadata), expected);
	assert.deepEqual(outputEntryFromAsyncResult({ agent: "impl", output: "ignored", structuredOutput: { ok: true } }, 2, metadata), expected);
	assert.deepEqual(outputEntryFromAsyncResult({ agent: "impl", output: "done" }, 2), { agent: "impl", stepIndex: 2, text: "done" });
});
