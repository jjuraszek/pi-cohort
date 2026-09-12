/**
 * External-package consumption proof for the execution-backend conformance testkit.
 *
 * This file intentionally imports only from the public package export
 * (`pi-cohort/execution-backend-testkit`) to prove a companion package can
 * consume the testkit without touching internal src/ paths.
 *
 * It also exercises the full conformance suite against the bundled deterministic
 * fixture, proving all 12 assertions execute and pass.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { execPath } from "node:process";
import test from "node:test";

/**
 * Resolve the npm CLI script path for shell-free cross-platform spawning.
 *
 * Windows npm is a .cmd batch script; spawnSync("npm.cmd", ...) without
 * shell:true fails because .cmd files require cmd.exe to interpret them.
 * Spawning node directly with the JS CLI script works on all platforms.
 *
 * Resolution order:
 *  1. npm_execpath env var — set by npm when invoking this as an npm script
 *  2. Node-bundled npm — always present alongside the Node binary:
 *     Unix:    <nodeDir>/../lib/node_modules/npm/bin/npm-cli.js
 *     Windows: <nodeDir>/node_modules/npm/bin/npm-cli.js  (no lib/ level)
 */
function resolveNpmCliScript(opts: {
	npmExecPath: string | undefined;
	platform: NodeJS.Platform;
	execPath: string;
}): string {
	if (opts.npmExecPath) return opts.npmExecPath;
	return opts.platform === "win32"
		? join(opts.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")
		: join(opts.execPath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
}

// ── npm CLI resolution (seam tests for cross-platform shell-free spawn) ─────────
// These tests live here because resolveNpmCliScript owns the boundary used by
// the npm pack integration test below.

test("resolveNpmCliScript: returns npm_execpath when set (shell-free, any platform)", () => {
	const explicit = "/path/to/custom/npm-cli.js";
	assert.equal(
		resolveNpmCliScript({ npmExecPath: explicit, platform: "win32", execPath: "C:\\nodejs\\node.exe" }),
		explicit,
	);
});

test("resolveNpmCliScript: Unix layout from execPath when npm_execpath unset", () => {
	const result = resolveNpmCliScript({ npmExecPath: undefined, platform: "linux", execPath: "/usr/local/bin/node" });
	assert.ok(result.endsWith(join("lib", "node_modules", "npm", "bin", "npm-cli.js")));
	assert.ok(!result.endsWith(".cmd"), "must not produce a .cmd path requiring shell");
});

test("resolveNpmCliScript: Windows layout from execPath when npm_execpath unset — no .cmd, no shell required", () => {
	const result = resolveNpmCliScript({ npmExecPath: undefined, platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe" });
	assert.ok(result.endsWith("npm-cli.js"), "must resolve to npm JS script, not .cmd");
	assert.ok(!result.includes(".cmd"), "must not produce a .cmd path requiring shell");
	// Windows Node layout: <nodeDir>/node_modules/npm/... (no lib/ level)
	assert.ok(!result.includes(join("lib", "node_modules")), "Windows layout has no lib/ level");
});

// ── Public-subpath import only ────────────────────────────────────────────────
import {
	CONFORMANCE_TEST_COUNT,
	assertConformingHandle,
	type ConformanceHarness,
	createConformanceBackend,
	registerExecutionBackendConformance,
	wrapWithConformanceHarness,
} from "pi-cohort/execution-backend-testkit";

// ── Package export shape ──────────────────────────────────────────────────────

test("pi-cohort/execution-backend-testkit exposes the required public API", () => {
	assert.equal(typeof registerExecutionBackendConformance, "function");
	assert.equal(typeof createConformanceBackend, "function");
	assert.equal(typeof assertConformingHandle, "function");
	assert.equal(typeof wrapWithConformanceHarness, "function");
	// ConformanceHarness is a type-only export; verify it doesn't cause runtime errors
	const _typeOnly: ConformanceHarness | undefined = undefined;
	assert.equal(_typeOnly, undefined);
	assert.equal(CONFORMANCE_TEST_COUNT, 12);
});

// ── Full conformance suite against the built-in fixture ───────────────────────

test("registerExecutionBackendConformance + createConformanceBackend: all tests pass", async (t) => {
	const subtests: Array<[string, () => void | Promise<void>]> = [];

	const registered = registerExecutionBackendConformance({
		test: (name, fn) => { subtests.push([name, fn]); },
		name: "conformance-fixture",
		createBackend: createConformanceBackend,
	});

	assert.equal(registered, CONFORMANCE_TEST_COUNT, "must register exactly CONFORMANCE_TEST_COUNT tests");
	assert.equal(subtests.length, CONFORMANCE_TEST_COUNT);

	for (const [name, fn] of subtests) {
		await t.test(name, fn);
	}
});

// ── Deliberately broken fixture rejection ─────────────────────────────────────
// Proves the assertions are non-trivial: a broken backend would cause failures.

test("assertConformingHandle rejects a handle missing surface.id (assertion liveness proof)", () => {
	assert.throws(
		() => assertConformingHandle({
			protocolVersion: 1,
			backend: "broken",
			surface: { kind: "pane" }, // id missing
			display: { label: "x", hint: "x" },
			data: null,
		}),
		/surface\.id/,
	);
});

test("assertConformingHandle rejects a handle with a blank display hint (assertion liveness proof)", () => {
	assert.throws(
		() => assertConformingHandle({
			protocolVersion: 1,
			backend: "broken",
			surface: { kind: "pane", id: "s1" },
			display: { label: "", hint: "" },
			data: null,
		}),
		/\S/,
	);
});

test("assertConformingHandle rejects a handle leaking a prohibited value (secret guard proof)", () => {
	assert.throws(
		() => assertConformingHandle(
			{
				protocolVersion: 1,
				backend: "broken",
				surface: { kind: "pane", id: "s1" },
				display: { label: "x", hint: "LEAKED_SECRET" },
				data: null,
			},
			["LEAKED_SECRET"],
		),
		/prohibited value/,
	);
});

// ── jiti loader compatibility ─────────────────────────────────────────────────

test("Pi's TypeScript-aware loader (jiti) imports the testkit subpath", () => {
	const args: string[] = [];
	if (process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types")) {
		args.push("--no-experimental-strip-types");
	}
	args.push(
		"--input-type=module",
		"--eval",
		[
			'import { createJiti } from "jiti";',
			'const jiti = createJiti(import.meta.url);',
			'const kit = await jiti.import("pi-cohort/execution-backend-testkit");',
			'if (typeof kit.registerExecutionBackendConformance !== "function") process.exit(1);',
			'if (typeof kit.createConformanceBackend !== "function") process.exit(2);',
			'if (typeof kit.wrapWithConformanceHarness !== "function") process.exit(3);',
			'if (kit.CONFORMANCE_TEST_COUNT !== 12) process.exit(4);',
		].join(" "),
	);
	const result = spawnSync(execPath, args, { cwd: process.cwd(), encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
});

// ── External-package consumption via npm pack ─────────────────────────────────
// Proves that the published tarball (files-limited) contains everything needed
// for a consumer outside this repo to import only via public subpaths.

test("npm pack: external package can import testkit via public subpath only", async () => {
	const { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { fileURLToPath } = await import("node:url");

	const pkgRoot = join(fileURLToPath(import.meta.url), "../../..");

	// Pack the package using node + npm-cli.js directly (cross-platform, no shell).
	// spawnSync("npm") fails on Windows (not a native exe), and spawnSync("npm.cmd")
	// also fails without shell:true because .cmd files require cmd.exe.
	const npmCliScript = resolveNpmCliScript({
		npmExecPath: process.env.npm_execpath,
		platform: process.platform,
		execPath,
	});
	const packResult = spawnSync(execPath, [npmCliScript, "pack", "--ignore-scripts", "--json"], {
		cwd: pkgRoot,
		encoding: "utf8",
	});
	assert.equal(packResult.status, 0, `npm pack failed: ${packResult.error?.message ?? packResult.stderr}`);
	// npm pack --json outputs either an array (older npm) or an object keyed by package name
	const packJson = JSON.parse(packResult.stdout) as Record<string, { filename: string }> | [{ filename: string }];
	const filename = Array.isArray(packJson)
		? packJson[0]!.filename
		: Object.values(packJson)[0]!.filename;
	const tarball = join(pkgRoot, filename);

	const tmpDir = mkdtempSync(join(tmpdir(), "pi-cohort-ext-test-"));
	try {
		// Write minimal consumer package.json
		writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
			name: "external-consumer",
			type: "module",
			private: true,
		}));

		// Set up node_modules with pi-cohort extracted from the tarball
		const nodeModules = join(tmpDir, "node_modules");
		mkdirSync(nodeModules, { recursive: true });

		const piCohortDest = join(nodeModules, "pi-cohort");
		mkdirSync(piCohortDest, { recursive: true });
		const extractResult = spawnSync("tar", [
			"-xf", tarball, "-C", piCohortDest, "--strip-components=1",
		], { encoding: "utf8" });
		assert.equal(extractResult.status, 0, `tar extract failed: ${extractResult.stderr}`);

		// Symlink dependencies the testkit consumer needs (jiti for the eval test)
		for (const dep of ["jiti"]) {
			const src = join(pkgRoot, "node_modules", dep);
			try {
				symlinkSync(src, join(nodeModules, dep), "junction");
			} catch {
				// dep may not exist; skip
			}
		}

		// Write a consumer script that imports ONLY from the public subpath
		const testScript = [
			'import { createJiti } from "jiti";',
			// createJiti expects a string URL, not a URL object
			'const jiti = createJiti(import.meta.url);',
			'const kit = await jiti.import("pi-cohort/execution-backend-testkit");',
			'if (typeof kit.registerExecutionBackendConformance !== "function") { process.stderr.write("missing registerExecutionBackendConformance\\n"); process.exit(1); }',
			'if (typeof kit.createConformanceBackend !== "function") { process.stderr.write("missing createConformanceBackend\\n"); process.exit(2); }',
			'if (typeof kit.wrapWithConformanceHarness !== "function") { process.stderr.write("missing wrapWithConformanceHarness\\n"); process.exit(3); }',
			'if (kit.CONFORMANCE_TEST_COUNT !== 12) { process.stderr.write("wrong CONFORMANCE_TEST_COUNT\\n"); process.exit(4); }',
			'process.stdout.write("PASS: external package import OK\\n");',
		].join("\n");
		const scriptPath = join(tmpDir, "consumer.mjs");
		writeFileSync(scriptPath, testScript);

		// Run from tmpDir so Node resolves pi-cohort from tmpDir/node_modules
		const runResult = spawnSync(execPath, [scriptPath], {
			cwd: tmpDir,
			encoding: "utf8",
		});
		assert.equal(
			runResult.status,
			0,
			`External import test failed:\nstdout: ${runResult.stdout}\nstderr: ${runResult.stderr}`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(tarball, { force: true });
	}
});
