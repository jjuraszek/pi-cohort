import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, it } from "node:test";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createSubagentExecutor } from "../../src/runs/foreground/subagent-executor.ts";
import { capturePiRuntime } from "../../src/runs/shared/pi-spawn.ts";
import { createEventBus, makeMinimalCtx } from "../support/helpers.ts";

const savedPackageDir = process.env.PI_PACKAGE_DIR;
let tempDir = "";

beforeEach(() => {
	delete process.env.PI_PACKAGE_DIR;
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-runtime-default-"));
});

afterEach(() => {
	if (savedPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = savedPackageDir;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

function createExecutor() {
	return createSubagentExecutor({
		pi: { events: createEventBus(), getSessionName: () => undefined } as any,
		state: { baseCwd: tempDir, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null } as any,
		config: {} as any,
		asyncByDefault: false,
		tempArtifactsDir: tempDir,
		getSubagentSessionRoot: () => tempDir,
		expandTilde: (value: string) => value,
		discoverAgents: () => ({ agents: [] }),
	});
}

it("captures the runtime from the loaded pi installation when argv[1] is not Pi's CLI", async () => {
	assert.notEqual(path.basename(process.argv[1] ?? ""), "cli.js", "the unit test process is not launched through Pi's CLI");
	const result = await createExecutor().execute("doctor", { action: "doctor" }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
	const text = result.content[0]?.text ?? "";
	assert.match(text, /^Subagents doctor report/);
	assert.doesNotMatch(text, /runtime capture: failed/);
});

it("the value the executor passes resolves to the loaded installation's declared CLI", () => {
	const installRoot = getPackageDir();
	const runtime = capturePiRuntime({ argv1: fileURLToPath(import.meta.url), installRoot });
	assert.equal(runtime.piPackageRoot, fs.realpathSync.native(installRoot));
	assert.equal(runtime.piEntryPath, fs.realpathSync.native(path.join(installRoot, "dist", "bundle", "cli.js")));
});
