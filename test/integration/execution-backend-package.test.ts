import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import test from "node:test";

import * as executionBackend from "pi-cohort/execution-backend";

test("the package exposes only the execution backend public SPI subpath", () => {
	assert.equal(executionBackend.EXECUTION_BACKEND_PROTOCOL_VERSION, 1);
	assert.equal(typeof executionBackend.registerExecutionBackend, "function");
});

test("Pi's TypeScript-aware loader imports the execution backend public subpath", () => {
	const args: string[] = [];
	if (process.allowedNodeEnvironmentFlags.has("--no-experimental-strip-types")) {
		args.push("--no-experimental-strip-types");
	}
	args.push(
		"--input-type=module",
		"--eval",
		'import { createJiti } from "jiti"; const jiti = createJiti(import.meta.url); const spi = await jiti.import("pi-cohort/execution-backend"); if (spi.EXECUTION_BACKEND_PROTOCOL_VERSION !== 1) process.exit(1);',
	);
	const result = spawnSync(execPath, args, { cwd: process.cwd(), encoding: "utf8" });

	assert.equal(result.status, 0, result.stderr || result.stdout);
});
