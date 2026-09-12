import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, test } from "node:test";
import type { RunnerStep } from "../../src/runs/shared/parallel-utils.ts";

interface PersistedResult {
	id: string;
	mode: string;
	success: boolean;
	state?: string;
	exitCode?: number;
	results: Array<{
		agent: string;
		output: string;
		success: boolean;
		exitCode?: number | null;
		model?: string;
		attemptedModels?: string[];
		modelAttempts?: Array<{ model?: string; success?: boolean; error?: string }>;
		structuredOutput?: unknown;
		acceptance?: { status?: string; childReport?: unknown; reviewResult?: { status?: string } };
		executionSurface?: { retained?: boolean; handle?: { id?: string; metadata?: Record<string, unknown> } };
	}>;
	outputs?: Record<string, { text?: string; structured?: unknown }>;
}

interface PersistedStatus {
	state: string;
	steps: Array<{
		agent: string;
		status: string;
		acceptance?: { status?: string };
		attemptedModels?: string[];
	}>;
}

interface TraceEvent {
	type: "launch" | "attempt-start" | "attempt-end" | "close" | "release" | "ready" | "abort";
	runId: string;
	childId: string;
	attemptId?: string;
	cwd?: string;
	task?: string;
	model?: string;
	pid?: number;
	ts: number;
}

interface RunFixture {
	root: string;
	asyncDir: string;
	resultPath: string;
	tracePath: string;
	logPath: string;
	barrierDir?: string;
	child: ChildProcess;
	result(): PersistedResult;
	status(): PersistedStatus;
	trace(): TraceEvent[];
}

const roots: string[] = [];
const require = createRequire(import.meta.url);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, "../fixtures/detached-execution-backend");
const fixturePackageJson = path.join(packageRoot, "package.json");
const fixturePi = path.join(packageRoot, "scripted-pi.mjs");
const runner = path.resolve(testDir, "../../src/runs/background/subagent-runner.ts");
const jitiPackageJson = require.resolve("jiti/package.json");
const jitiCli = path.join(path.dirname(jitiPackageJson), "lib/jiti-cli.mjs");
const unixTransport = process.platform === "win32"
	? "external child-host transport uses Unix domain sockets"
	: undefined;

function step(agent: string, task: string, overrides: Partial<RunnerStep & Record<string, unknown>> = {}): RunnerStep {
	return {
		agent,
		task,
		completionGuard: false,
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	} as RunnerStep;
}

function backendConfig() {
	return {
		protocolVersion: 1,
		userPreference: "fixture-detached",
		registrations: [{
			name: "fixture-detached",
			reload: {
				protocolVersion: 1,
				packageJsonUrl: pathToFileURL(fixturePackageJson).href,
				publicSubpath: "./backend",
				factoryExport: "createFixtureExecutionBackend",
			},
		}],
	};
}

function launchRun(
	name: string,
	steps: RunnerStep[],
	options: {
		mode?: string;
		dynamicFanoutMaxItems?: number;
		barrier?: { participants: number; taskPrefix: string };
	} = {},
): RunFixture {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-cohort-detached-${name}-`));
	roots.push(root);
	const home = path.join(root, "home");
	const bin = path.join(root, "bin");
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(root, "result.json");
	const tracePath = path.join(root, "trace.jsonl");
	const logPath = path.join(root, "runner.log");
	const barrierDir = options.barrier ? path.join(root, "barrier") : undefined;
	fs.mkdirSync(home);
	fs.mkdirSync(bin);
	fs.mkdirSync(asyncDir);
	if (barrierDir) fs.mkdirSync(barrierDir);
	fs.writeFileSync(path.join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${fixturePi}" "$@"\n`, { mode: 0o755 });
	const configPath = path.join(root, "config.json");
	fs.writeFileSync(configPath, JSON.stringify({
		id: name,
		steps,
		resultPath,
		cwd: root,
		placeholder: "{previous}",
		asyncDir,
		resultMode: options.mode ?? (steps.length === 1 ? "single" : "chain"),
		dynamicFanoutMaxItems: options.dynamicFanoutMaxItems,
		executionBackends: backendConfig(),
	}));
	const log = fs.openSync(logPath, "w");
	const child = spawn(process.execPath, [jitiCli, runner, configPath], {
		cwd: root,
		detached: true,
		stdio: ["ignore", log, log],
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
			PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
			PI_COHORT_FIXTURE_TRACE: tracePath,
			PI_COHORT_FIXTURE_BARRIER_DIR: barrierDir,
			PI_COHORT_FIXTURE_BARRIER_PARTICIPANTS: options.barrier?.participants.toString(),
			PI_COHORT_FIXTURE_BARRIER_TASK_PREFIX: options.barrier?.taskPrefix,
		},
	});
	fs.closeSync(log);
	child.unref();
	return {
		root,
		asyncDir,
		resultPath,
		tracePath,
		logPath,
		barrierDir,
		child,
		result: () => JSON.parse(fs.readFileSync(resultPath, "utf8")) as PersistedResult,
		status: () => JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as PersistedStatus,
		trace: () => readTrace(tracePath),
	};
}

function readTrace(tracePath: string): TraceEvent[] {
	if (!fs.existsSync(tracePath)) return [];
	return fs.readFileSync(tracePath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as TraceEvent);
}

async function waitFor(predicate: () => boolean, fixture: RunFixture, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			const log = fs.existsSync(fixture.logPath) ? fs.readFileSync(fixture.logPath, "utf8") : "<missing>";
			throw new Error(`Timed out waiting for ${label}. Runner log:\n${log}`);
		}
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

async function waitForResult(fixture: RunFixture): Promise<PersistedResult> {
	await waitFor(() => fs.existsSync(fixture.resultPath), fixture, "persisted result");
	return fixture.result();
}

function assertOwnerLifecycle(trace: TraceEvent[], launches: number, closes: number, releases: number): void {
	assert.equal(trace.filter(event => event.type === "launch").length, launches);
	assert.equal(trace.filter(event => event.type === "close").length, closes);
	assert.equal(trace.filter(event => event.type === "release").length, releases);
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("detached external orchestration through serialized runner config", () => {
	test("single and sequential chain runs reload the public backend and persist output artifacts", { skip: unixTransport }, async t => {
		await t.test("single", async () => {
			const fixture = launchRun("single", [step("worker", "SINGLE")]);
			const result = await waitForResult(fixture);
			assert.equal(result.success, true);
			assert.match(result.results[0]?.output ?? "", /reply:SINGLE/);
			assert.equal(fs.readFileSync(path.join(fixture.asyncDir, "output-0.log"), "utf8"), result.results[0]?.output);
			assert.equal(result.results[0]?.executionSurface?.handle?.metadata?.fixture, "detached-package");
			assertOwnerLifecycle(fixture.trace(), 1, 1, 1);
			assert.equal(fixture.trace().filter(event => event.type === "attempt-start").length, 1);
		});

		await t.test("sequential chain", async () => {
			const fixture = launchRun("chain", [
				step("first", "CHAIN-FIRST"),
				step("second", "CHAIN-SECOND sees {previous}"),
			], { mode: "chain" });
			const result = await waitForResult(fixture);
			assert.equal(result.success, true);
			assert.equal(result.results.length, 2);
			assert.match(result.results[1]?.output ?? "", /CHAIN-SECOND sees reply:CHAIN-FIRST/);
			assertOwnerLifecycle(fixture.trace(), 2, 2, 2);
			assert.equal(fixture.trace().filter(event => event.type === "attempt-start").length, 2);
		});
	});

	test("static parallel honors each leaf cwd when selecting native and external backends", { skip: unixTransport }, async () => {
		const cwdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cohort-detached-leaf-settings-"));
		roots.push(cwdRoot);
		const leftCwd = path.join(cwdRoot, "left");
		const rightCwd = path.join(cwdRoot, "right");
		for (const [cwd, executionBackend] of [[leftCwd, "native"], [rightCwd, "fixture-detached"]]) {
			fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
			fs.writeFileSync(
				path.join(cwd, ".pi/settings.json"),
				JSON.stringify({ subagents: { executionBackend } }),
			);
		}
		const fixture = launchRun("static-parallel", [{
			parallel: [
				step("left", "PARALLEL left", { cwd: leftCwd }),
				step("right", "PARALLEL right", { cwd: rightCwd }),
			],
			concurrency: 2,
		}], { mode: "chain" });
		const result = await waitForResult(fixture);
		assert.equal(result.success, true);
		assert.equal(result.results.length, 2);
		assert.match(result.results[0]?.output ?? "", /reply:PARALLEL left/);
		assert.match(result.results[1]?.output ?? "", /reply:PARALLEL right/);
		const trace = fixture.trace();
		assertOwnerLifecycle(trace, 1, 1, 1);
		const externalStart = trace.find(event => event.type === "attempt-start");
		assert.equal(externalStart?.cwd, fs.realpathSync(rightCwd));
		for (const entry of result.results) assert.ok(fs.existsSync(path.join(fixture.asyncDir, `output-${result.results.indexOf(entry)}.log`)));
	});

	test("dynamic parallel materializes leaves through independent backend owners", { skip: unixTransport }, async () => {
		const producerSchema = { type: "object", properties: { items: { type: "array" } }, required: ["items"] };
		const reviewSchema = { type: "object", properties: { reviewed: { type: "string" } }, required: ["reviewed"] };
		const fixture = launchRun("dynamic-parallel", [
			step("producer", "DYNAMIC-PRODUCER", {
				outputName: "targets",
				structured: true,
				structuredOutputSchema: producerSchema,
				structuredOutput: {
					schema: producerSchema,
					schemaPath: path.join(os.tmpdir(), `dynamic-schema-${process.pid}.json`),
					outputPath: path.join(os.tmpdir(), `dynamic-output-${process.pid}.json`),
				},
			}),
			{
				expand: { from: { output: "targets", path: "/items" }, item: "target", key: "/path", maxItems: 2 },
				parallel: step("reviewer", "DYNAMIC-REVIEW {target.path}", { structuredOutputSchema: reviewSchema }) as Extract<RunnerStep, { agent: string }>,
				collect: { as: "reviews" },
				concurrency: 2,
			},
		], {
			mode: "chain",
			dynamicFanoutMaxItems: 2,
			barrier: { participants: 2, taskPrefix: "DYNAMIC-REVIEW " },
		});
		fs.writeFileSync(path.join(os.tmpdir(), `dynamic-schema-${process.pid}.json`), JSON.stringify(producerSchema));
		const result = await waitForResult(fixture);
		assert.equal(result.success, true);
		assert.equal(result.results.length, 3);
		// The runner serializes each leaf with the fuller DynamicLeafResult shape.
		const reviews = result.outputs?.reviews?.structured as Array<Record<string, unknown>>;
		assert.deepEqual(reviews?.map(r => ({ item: r["item"], key: r["key"], structured: r["structured"] })), [
			{ item: { path: "src/a.ts" }, key: "src/a.ts", structured: { reviewed: "src/a.ts" } },
			{ item: { path: "src/b.ts" }, key: "src/b.ts", structured: { reviewed: "src/b.ts" } },
		]);
		const trace = fixture.trace();
		assertOwnerLifecycle(trace, 3, 3, 3);
		assert.equal(trace.filter(event => event.type === "attempt-start").length, 3);
		const reviewStartIndexes = trace
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.type === "attempt-start" && event.task?.startsWith("DYNAMIC-REVIEW "))
			.map(({ index }) => index);
		const firstReviewEndIndex = trace.findIndex(event => event.type === "attempt-end" && event.task?.startsWith("DYNAMIC-REVIEW "));
		assert.equal(reviewStartIndexes.length, 2);
		assert.ok(firstReviewEndIndex >= 0);
		assert.ok(
			reviewStartIndexes.every(index => index < firstReviewEndIndex),
			"barrier must record both dynamic leaf starts before either leaf ends",
		);
		assert.equal(fs.readdirSync(fixture.barrierDir!).filter(file => file.endsWith(".ready")).length, 2);
		for (const file of [`dynamic-schema-${process.pid}.json`, `dynamic-output-${process.pid}.json`]) {
			fs.rmSync(path.join(os.tmpdir(), file), { force: true });
		}
	});

	test("same-owner model fallback launches once, records distinct attempts, and finishes once", { skip: unixTransport }, async () => {
		const fixture = launchRun("fallback", [step("worker", "FALLBACK", {
			model: "bad/model",
			modelCandidates: ["bad/model", "good/model"],
		})]);
		const result = await waitForResult(fixture);
		assert.equal(result.success, true);
		assert.equal(result.results[0]?.model, "good/model");
		assert.deepEqual(result.results[0]?.attemptedModels, ["bad/model", "good/model"]);
		assert.equal(result.results[0]?.modelAttempts?.length, 2);
		const trace = fixture.trace();
		assertOwnerLifecycle(trace, 1, 1, 1);
		assert.deepEqual(trace.filter(event => event.type === "attempt-start").map(event => event.model), ["bad/model", "good/model"]);
		assert.equal(new Set(trace.filter(event => event.type === "attempt-start").map(event => event.attemptId)).size, 2);
	});

	test("interrupt retains the surface and persists interrupted result and status", { skip: unixTransport }, async () => {
		const fixture = launchRun("interrupt", [step("worker", "WAIT-FOR-INTERRUPT")]);
		await waitFor(() => fixture.trace().some(event => event.type === "ready"), fixture, "scripted Pi ready marker");
		await new Promise(resolve => setTimeout(resolve, 100));
		process.kill(fixture.child.pid!, "SIGUSR2");
		const result = await waitForResult(fixture);
		assert.equal(result.success, false);
		assert.equal(result.state, "paused");
		assert.equal(result.results[0]?.executionSurface?.retained, true);
		assert.equal(result.results[0]?.executionSurface?.handle?.metadata?.fixture, "detached-package");
		assert.equal(fixture.status().state, "paused");
		assertOwnerLifecycle(fixture.trace(), 1, 0, 1);
		assert.equal(fixture.trace().filter(event => event.type === "abort").length, 1);
	});

	test("acceptance rejection retains surface metadata in result and rejection in status", { skip: unixTransport }, async () => {
		const fixture = launchRun("acceptance-rejection", [step("worker", "ACCEPTANCE-REJECT", {
			effectiveAcceptance: {
				level: "reviewed",
				explicit: true,
				inferredReason: [],
				criteria: [{ id: "criterion-1", must: "Implement the requested change", evidence: ["changed-files"], severity: "required" }],
				evidence: ["changed-files"],
				verify: [],
				review: false,
				stopRules: [],
			},
		})]);
		const result = await waitForResult(fixture);
		assert.equal(result.success, false);
		assert.equal(result.results[0]?.acceptance?.status, "rejected");
		assert.ok(result.results[0]?.acceptance?.childReport);
		assert.equal(result.results[0]?.acceptance?.reviewResult?.status, "needs-parent-decision");
		assert.equal(result.results[0]?.executionSurface?.retained, true);
		assert.equal(result.results[0]?.executionSurface?.handle?.metadata?.fixture, "detached-package");
		assert.equal(fixture.status().steps[0]?.acceptance?.status, "rejected");
		assertOwnerLifecycle(fixture.trace(), 1, 0, 1);
	});
});
