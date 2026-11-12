import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fileSystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../src/agents/agents.ts";
import type { ExecutionBackendSelectionResult } from "../../src/execution-backend/selection.ts";
import type { ExecutionBackend, ExecutionSurfaceHandle } from "../../src/execution-backend/types.ts";
import { runSync as execute, type RunSyncDependencies } from "../../src/runs/foreground/execution.ts";
import { createMockPi } from "../support/mock-pi.ts";
import { after } from "node:test";
import type { RunSyncOptions } from "../../src/shared/types.ts";
import { PiRuntimeLaunchError } from "../../src/runs/shared/pi-spawn.ts";
import { resolveControlConfig } from "../../src/runs/shared/subagent-control.ts";

const mock = createMockPi();
mock.install();
after(() => mock.uninstall());
const runtime = mock.runtime;
function runSync(cwd: string, agents: AgentConfig[], name: string, task: string, options: RunSyncOptions, deps: RunSyncDependencies = {}) {
	return execute(cwd, agents, name, task, { runtime, ...options }, deps);
}
import { ExternalExecutionDiagnosticError, type ExternalAttemptResult, type ExternalExecution, type ExternalExecutionOptions } from "../../src/runs/shared/external-execution.ts";
import type { RunExternalSingleAttemptInput } from "../../src/runs/foreground/external-single-attempt.ts";
import { snapshotResult } from "../../src/runs/foreground/attempt-finalization.ts";
import type { SingleResult } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

const handle: ExecutionSurfaceHandle = {
	protocolVersion: 1,
	backend: "fake",
	surface: { kind: "test", id: "surface-1" },
	display: { label: "safe surface", hint: "safe hint" },
	data: null,
};

const backend: ExecutionBackend = {
	name: "fake",
	protocolVersion: 1,
	async detect() { return { available: true, version: "1", capabilities: [] }; },
	async launch() { throw new Error("unused"); },
	async reattach() { return { status: "gone" }; },
	async close() {},
};

function result(agent: AgentConfig, task: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		finalOutput: "done",
		...overrides,
	};
}

function dependencies(selection: ExecutionBackendSelectionResult) {
	const selected: Array<{ cwd: string; userConfig: { executionBackend?: string } }> = [];
	const ownerOptions: ExternalExecutionOptions[] = [];
	const attempts: RunExternalSingleAttemptInput[] = [];
	const finishes: string[] = [];
	let nativeCalls = 0;
	const owner: ExternalExecution = {
		surface: handle,
		ready: Promise.resolve(),
		async runAttempt() { throw new Error("unused"); },
		async finish(disposition) {
			finishes.push(disposition);
			return { handle, retained: disposition === "retained" };
		},
	};
	const deps: RunSyncDependencies = {
		async selectBackend(input) { selected.push(input); return selection; },
		async createExternalOwner(options) { ownerOptions.push(options); return owner; },
		async runNativeAttempt(_runtimeCwd, agent, task) { nativeCalls++; return result(agent, task); },
		async runExternalAttempt(input) { attempts.push(input); return result(input.agent, input.task); },
	};
	return { deps, selected, ownerOptions, attempts, finishes, nativeCalls: () => nativeCalls, owner };
}

const nativeSelection: ExecutionBackendSelectionResult = { selection: { kind: "native" }, diagnostics: [] };
const externalSelection: ExecutionBackendSelectionResult = {
	selection: { kind: "external", backend, detection: { available: true, version: "1", capabilities: [] } },
	diagnostics: [],
};
const noAcceptance = { level: "none" as const, reason: "routing test" };

describe("runSync maxRuntimeMs deadline", () => {
	const cases = [
		{ name: "no controlConfig", controlConfig: undefined },
		{ name: "neither settings nor call-time cap", controlConfig: resolveControlConfig() },
		{ name: "controlConfig without the field", controlConfig: { enabled: false } as RunSyncOptions["controlConfig"] },
	];
	for (const scenario of cases) it(`aborts at the default maxRuntimeMs and not before: ${scenario.name}`, async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 123_456;
		let calls = 0;
		const h = dependencies(nativeSelection);
		h.deps.monotonicNow = () => now;
		h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
			calls++;
			assert.equal(options.signal?.aborted, false);
			now += 14_399_999;
			t.mock.timers.tick(14_399_999);
			assert.equal(options.signal?.aborted, false, "the child survives until one ms before four hours");
			now++;
			t.mock.timers.tick(1);
			assert.equal(options.signal?.aborted, true, "the child is aborted at exactly four hours");
			return result(agent, task, { exitCode: 1 });
		};
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
			runId: "default-cap", acceptance: noAcceptance, controlConfig: scenario.controlConfig,
		}, h.deps);
		assert.equal(calls, 1);
		assert.equal(output.exitCode, 1);
		assert.equal(output.error, "Subagent killed: ran for 14400s (exceeded maxRuntimeMs=14400000ms).");
		assert.equal(output.interrupted, undefined);
		assert.equal(output.modelAttempts?.length, 1);
		assert.equal(output.modelAttempts[0].success, false);
	});
});

describe("runSync maxRuntimeMs cleanup", () => {
	for (const scenario of ["early clean success", "thrown native attempt"] as const) {
		it(`cleans up after ${scenario}`, async t => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			let now = 0;
			let derivedSignal: AbortSignal | undefined;
			const caller = new AbortController();
			const originalError = new Error("native attempt failed");
			const h = dependencies(nativeSelection);
			h.deps.monotonicNow = () => now;
			h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
				derivedSignal = options.signal;
				assert.ok(derivedSignal);
				assert.notStrictEqual(derivedSignal, caller.signal);
				now = 250;
				t.mock.timers.tick(250);
				assert.equal(derivedSignal.aborted, false);
				if (scenario === "thrown native attempt") throw originalError;
				return result(agent, task);
			};
			const pending = runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: "cleanup-cap", acceptance: noAcceptance, signal: caller.signal,
				controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
			}, h.deps);
			if (scenario === "thrown native attempt") {
				await assert.rejects(pending, error => {
					assert.strictEqual(error, originalError);
					return true;
				});
			} else {
				const output = await pending;
				assert.equal(output.exitCode, 0);
				assert.equal(output.error, undefined);
				assert.equal(output.interrupted, undefined);
				assert.equal(output.finalOutput, "done");
			}
			assert.ok(derivedSignal);
			assert.equal(derivedSignal.aborted, false);
			now = 1001;
			t.mock.timers.tick(751);
			assert.equal(derivedSignal.aborted, false, "the cleared cap timer cannot abort a settled attempt");
			caller.abort();
			assert.equal(caller.signal.aborted, true);
			assert.equal(derivedSignal.aborted, false, "the removed listener cannot forward a later caller abort");
		});
	}
});

describe("runSync deadline continuity", () => {
	it("keeps the original deadline across a fallback attempt", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 0;
		let calls = 0;
		const h = dependencies(nativeSelection);
		h.deps.monotonicNow = () => now;
		h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
			calls++;
			if (calls === 1) {
				now = 600;
				t.mock.timers.tick(600);
				assert.equal(options.signal?.aborted, false);
				return result(agent, task, { exitCode: 1, error: "rate limit exceeded" });
			}
			now = 999;
			t.mock.timers.tick(399);
			assert.equal(options.signal?.aborted, false, "fallback survives until the original deadline minus one ms");
			now = 1000;
			t.mock.timers.tick(1);
			assert.equal(options.signal?.aborted, true, "fallback is aborted at the original deadline");
			return result(agent, task, { exitCode: 1 });
		};
		const output = await runSync("/runtime", [makeAgent("worker", {
			model: "one/model", fallbackModels: ["two/model"],
		})], "worker", "Task", {
			runId: "fallback-cap", acceptance: noAcceptance,
			controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
		}, h.deps);
		assert.equal(calls, 2);
		assert.deepEqual(output.attemptedModels, ["one/model", "two/model"]);
		assert.deepEqual(output.modelAttempts?.map(attempt => attempt.success), [false, false]);
		assert.equal(output.error, "Subagent killed: ran for 1s (exceeded maxRuntimeMs=1000ms).");
	});

	it("a wall-clock change does not move the cap deadline", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let wallNow = 7_200_000;
		t.mock.method(Date, "now", () => wallNow);
		let now = 0;
		const h = dependencies(nativeSelection);
		h.deps.monotonicNow = () => now;
		h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
			now = 500;
			t.mock.timers.tick(500);
			const beforeJump = Date.now();
			wallNow = beforeJump - 3_600_000;
			assert.equal(Date.now(), beforeJump - 3_600_000);
			now = 999;
			t.mock.timers.tick(499);
			assert.equal(options.signal?.aborted, false);
			now = 1000;
			t.mock.timers.tick(1);
			assert.equal(options.signal?.aborted, true, "a backwards Date jump cannot postpone the monotonic deadline");
			return result(agent, task, { exitCode: 1 });
		};
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
			runId: "wall-clock-cap", acceptance: noAcceptance,
			controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
		}, h.deps);
		assert.equal(output.error, "Subagent killed: ran for 1s (exceeded maxRuntimeMs=1000ms).");
	});

	for (const scenario of ["caller abort", "interrupt"] as const) {
		it(`leaves ${scenario === "interrupt" ? "an interrupt" : "a caller abort"} before the cap unchanged`, async t => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			let now = 0;
			const stop = new AbortController();
			const h = dependencies(nativeSelection);
			h.deps.monotonicNow = () => now;
			h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
				now = 500;
				t.mock.timers.tick(500);
				stop.abort();
				assert.equal(options.signal?.aborted, scenario === "caller abort");
				assert.equal(options.interruptSignal?.aborted, scenario === "interrupt" ? true : undefined);
				now = 1500;
				t.mock.timers.tick(1000);
				assert.equal(options.signal?.aborted, scenario === "caller abort", "the cap must not signal a previously interrupted child");
				return result(agent, task, scenario === "caller abort"
					? { exitCode: 1, error: "caller cancelled", finalOutput: "partial work" }
					: { interrupted: true, finalOutput: "interrupted work" });
			};
			const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: "cancel-before-cap", acceptance: noAcceptance,
				...(scenario === "caller abort" ? { signal: stop.signal } : { interruptSignal: stop.signal }),
				controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
			}, h.deps);
			assert.equal(output.exitCode, scenario === "caller abort" ? 1 : 0);
			assert.equal(output.error, scenario === "caller abort" ? "caller cancelled" : undefined);
			assert.equal(output.interrupted, scenario === "interrupt" ? true : undefined);
			assert.equal(output.finalOutput, scenario === "caller abort" ? "partial work" : "interrupted work");
			assert.equal(output.modelAttempts?.[0].success, scenario === "interrupt");
		});
	}
});

describe("runSync extended maxRuntimeMs deadline", () => {
	for (const maxRuntimeMs of [14_400_001, 3_000_000_000, 4_294_967_300]) {
		it(`runs past four hours and aborts at the call-time cap ${maxRuntimeMs}`, async t => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			const timeouts = t.mock.method(globalThis, "setTimeout");
			let now = 123_456;
			const startedAt = now;
			let calls = 0;
			const h = dependencies(nativeSelection);
			h.deps.monotonicNow = () => now;
			h.deps.runNativeAttempt = async (_cwd, agent, task, _model, options) => {
				calls++;
				assert.equal(options.signal?.aborted, false);
				const checkpoints = [...new Set([
					14_400_000, 14_400_001, 2_147_483_647, 4_294_967_294, maxRuntimeMs - 1, maxRuntimeMs,
				])].filter(elapsed => elapsed <= maxRuntimeMs).sort((a, b) => a - b);
				for (const elapsed of checkpoints) {
					const advance = startedAt + elapsed - now;
					now += advance;
					t.mock.timers.tick(advance);
					assert.equal(options.signal?.aborted, elapsed === maxRuntimeMs, `abort state at ${elapsed} ms`);
				}
				return result(agent, task, { exitCode: 1 });
			};
			const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: "extended-cap", acceptance: noAcceptance,
				controlConfig: resolveControlConfig(undefined, { maxRuntimeMs }),
			}, h.deps);
			assert.equal(calls, 1);
			assert.equal(output.exitCode, 1);
			assert.equal(output.error, `Subagent killed: ran for ${Math.round(maxRuntimeMs / 1000)}s (exceeded maxRuntimeMs=${maxRuntimeMs}ms).`);
			assert.equal(output.interrupted, undefined);
			assert.equal(output.modelAttempts?.length, 1);
			assert.equal(output.modelAttempts[0].success, false);
			const delays = timeouts.mock.calls.map(call => call.arguments[1]);
			const chunks = Math.floor(maxRuntimeMs / 2_147_483_647);
			assert.deepEqual(delays, [
				...Array(chunks).fill(2_147_483_647), maxRuntimeMs % 2_147_483_647,
			]);
		});
	}
});

describe("runSync external maxRuntimeMs", () => {
	const capError = "Subagent killed: ran for 1s (exceeded maxRuntimeMs=1000ms).";
	const diagnostic = "Process termination could not be confirmed; manual cleanup may be required.";
	const cases = ["interrupted", "partial output", "thrown interruption", "retryable failure", "clean success"] as const;
	for (const scenario of cases) it(`settles an external attempt at the cap: ${scenario}`, async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 123_456;
		let calls = 0;
		const caller = new AbortController();
		const removeListener = t.mock.method(caller.signal, "removeEventListener");
		const h = dependencies(externalSelection);
		h.deps.monotonicNow = () => now;
		delete h.deps.runExternalAttempt;
		h.owner.runAttempt = async input => {
			calls++;
			assert.strictEqual(input.signal, h.ownerOptions[0].signal);
			assert.notStrictEqual(input.signal, caller.signal);
			now += 999;
			t.mock.timers.tick(999);
			assert.equal(input.signal?.aborted, false);
			now++;
			t.mock.timers.tick(1);
			assert.equal(input.signal?.aborted, true);
			assert.equal(caller.signal.aborted, false, "the cap belongs to the child, not its caller");
			if (scenario === "thrown interruption") throw Object.assign(new Error(diagnostic), { interrupted: true });
			if (scenario === "clean success") return successAttemptResult();
			if (scenario === "retryable failure") return {
				...successAttemptResult(), outcome: "failed", exit: { code: 1, signal: null }, error: "rate limit exceeded",
			};
			return {
				...successAttemptResult(), outcome: "interrupted", interrupted: true,
				finalOutput: scenario === "partial output" ? "partial work" : "", error: diagnostic,
			};
		};
		const output = await runSync("/runtime", [makeAgent("worker", {
			model: "one/model", fallbackModels: ["two/model"], completionGuard: false,
		})], "worker", "Task", {
			runId: "external-cap", sessionFile: path.join(mock.dir, "external-cap.jsonl"), signal: caller.signal,
			acceptance: noAcceptance, controlConfig: resolveControlConfig(undefined, { enabled: false, maxRuntimeMs: 1000 }),
		}, h.deps);
		const succeeded = scenario === "clean success";
		assert.equal(calls, 1, "a capped failure must not start a fallback model");
		assert.equal(h.nativeCalls(), 0);
		assert.equal(output.exitCode, succeeded ? 0 : 1);
		assert.equal(output.interrupted, undefined);
		assert.equal(output.error, succeeded ? undefined : `${capError}\n${scenario === "retryable failure" ? "rate limit exceeded" : diagnostic}`);
		if (scenario === "interrupted" || scenario === "thrown interruption") assert.equal(output.finalOutput, undefined);
		if (scenario === "partial output") assert.equal(output.finalOutput, "partial work");
		if (scenario !== "thrown interruption") {
			assert.equal(output.progress?.status, succeeded ? "completed" : "failed");
			assert.equal(output.progress?.error, output.error);
		}
		assert.deepEqual(output.attemptedModels, ["one/model"]);
		assert.equal(output.modelAttempts?.length, 1);
		assert.equal(output.modelAttempts[0].success, succeeded);
		assert.equal(output.modelAttempts[0].error, output.error);
		assert.deepEqual(h.finishes, [succeeded ? "delivered" : "retained"]);
		assert.equal(output.executionSurface?.retained, !succeeded);
		assert.equal(removeListener.mock.calls.length, 2, "remove admission and runtime-cap abort listeners");
		assert.ok(removeListener.mock.calls.every(call => call.arguments[0] === "abort"));
	});

	for (const scenario of [
		{ phase: "creation", stop: "cap" },
		{ phase: "ready", stop: "cap" },
		{ phase: "ready", stop: "caller" },
	] as const) {
		it(`normalizes admission refusal after external ${scenario.phase} fulfills following ${scenario.stop}`, async t => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			let now = 0;
			const caller = new AbortController();
			const h = dependencies(externalSelection);
			h.deps.monotonicNow = () => now;
			h.deps.createExternalOwner = async options => {
				h.ownerOptions.push(options);
				const stopDuringStartup = async () => {
					if (scenario.stop === "caller") caller.abort();
					now = 1000;
					t.mock.timers.tick(1000);
					assert.equal(options.signal.aborted, true);
				};
				if (scenario.phase === "creation") await stopDuringStartup();
				else Object.defineProperty(h.owner, "ready", { get: stopDuringStartup });
				return h.owner;
			};
			const output = await runSync("/runtime", [makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"] })], "worker", "Task", {
				runId: "external-startup-refusal", acceptance: noAcceptance, signal: caller.signal,
				controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
			}, h.deps);
			assert.equal(output.exitCode, scenario.stop === "cap" ? 1 : 0);
			assert.equal(output.error, scenario.stop === "cap" ? capError : undefined);
			assert.equal(output.interrupted, scenario.stop === "cap" ? undefined : true);
			assert.equal(output.modelAttempts, undefined);
			assert.equal(h.ownerOptions.length, 1);
			assert.equal(h.attempts.length, 0);
			assert.equal(h.nativeCalls(), 0);
			assert.deepEqual(h.finishes, ["retained"]);
			assert.deepEqual(output.executionSurface, { handle, retained: true });
		});
	}

	for (const phase of ["startup", "ready"] as const) it(`rewrites external ${phase} failure after the cap`, async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let now = 0;
		const h = dependencies(externalSelection);
		h.deps.monotonicNow = () => now;
		h.deps.createExternalOwner = async options => {
			h.ownerOptions.push(options);
			const failAtCap = () => {
				now = 1000;
				t.mock.timers.tick(1000);
				assert.equal(options.signal.aborted, true);
				throw new Error("private startup details");
			};
			if (phase === "startup") failAtCap();
			Object.defineProperty(h.owner, "ready", { get: failAtCap });
			return h.owner;
		};
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
			runId: "startup-cap", acceptance: noAcceptance,
			controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
		}, h.deps);
		assert.equal(output.exitCode, 1);
		assert.equal(output.error, `${capError}\nExternal execution startup failed`);
		assert.equal(output.interrupted, undefined);
		assert.equal(output.modelAttempts, undefined);
		assert.equal(h.attempts.length, 0);
		assert.equal(h.nativeCalls(), 0);
		assert.deepEqual(h.finishes, phase === "ready" ? ["retained"] : []);
	});

	for (const settlement of ["pending", "late rejection", "same-turn rejection"] as const) {
		it(`caps backend selection with ${settlement}`, async t => {
			t.mock.timers.enable({ apis: ["setTimeout"] });
			let now = 0;
			let rejectSelection!: (error: Error) => void;
			const h = dependencies(externalSelection);
			h.deps.monotonicNow = () => now;
			h.deps.selectBackend = () => new Promise((_resolve, reject) => { rejectSelection = reject; });
			const pending = runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: "selection-cap", acceptance: noAcceptance,
				controlConfig: resolveControlConfig(undefined, { maxRuntimeMs: 1000 }),
			}, h.deps);
			now = 1000;
			t.mock.timers.tick(1000);
			if (settlement === "same-turn rejection") rejectSelection(new Error("selection failed"));
			const output = await pending;
			assert.equal(output.exitCode, 1);
			assert.equal(output.error, capError);
			assert.equal(h.ownerOptions.length, 0);
			assert.equal(h.attempts.length, 0);
			assert.equal(h.nativeCalls(), 0);
			if (settlement === "late rejection") {
				rejectSelection(new Error("late selection failure"));
				await new Promise(resolve => setImmediate(resolve));
			}
		});
	}
});

describe("runSync execution backend routing", () => {
	it("launches selected A through the actual native path despite process and PATH B", async t => {
		for (const scenario of ["success", "spawn error", "entry disappeared"] as const) await t.test(scenario, async () => {
			const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-")));
			const selected = { nodeExecPath: path.join(dir, `node A${path.extname(process.execPath)}`), piEntryPath: path.join(dir, "A", "cli.mjs"), piPackageRoot: path.join(dir, "A") };
			const otherEntry = path.join(dir, "B", "cli.mjs");
			fs.copyFileSync(process.execPath, selected.nodeExecPath);
			fs.chmodSync(selected.nodeExecPath, 0o755);
			for (const entry of [selected.piEntryPath, otherEntry]) {
				fs.mkdirSync(path.dirname(entry), { recursive: true });
				fs.writeFileSync(entry, "");
				fs.writeFileSync(path.join(path.dirname(entry), "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.mjs" } }));
			}
			fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${otherEntry}" "$@"\n`);
			fs.chmodSync(path.join(dir, "pi"), 0o755);
			const originalSpawn = childProcess.spawn;
			const originalMkdtemp = fileSystem.mkdtempSync;
			const originalPath = process.env.PATH;
			const originalEntry = process.argv[1];
			const promptDirs: string[] = [];
			const launches: Array<{ command: string; args: string[] }> = [];
			try {
				process.env.PATH = dir;
				process.argv[1] = otherEntry;
				assert.notEqual(selected.nodeExecPath, fs.realpathSync.native(process.execPath));
				assert.notEqual(selected.piEntryPath, fs.realpathSync.native(process.argv[1]));
				fileSystem.mkdtempSync = ((prefix, options) => {
					const created = originalMkdtemp(prefix, options);
					if (String(prefix).includes("pi-subagent-")) promptDirs.push(String(created));
					return created;
				}) as typeof fileSystem.mkdtempSync;
				childProcess.spawn = ((command, args, options) => {
					launches.push({ command, args: [...args] });
					const proc = originalSpawn(command, args, scenario === "spawn error" ? { ...options, cwd: path.join(dir, "missing") } : options);
					if (scenario === "spawn error") proc.prependListener("error", error => { error.message = `rate limit: ${error.message}`; });
					return proc;
				}) as typeof childProcess.spawn;
				// Native execution imports named builtins; synchronize both installation and restoration.
				syncBuiltinESMExports();
				const output = await runSync(dir, [makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"], completionGuard: false })], "worker", "Task", {
					runtime: selected, runId: "native-real", id: "abcdef12-1234-4234-8234-123456789abc", parentSessionLabel: "routing parent", acceptance: noAcceptance,
				}, { selectBackend: async () => {
					if (scenario === "entry disappeared") fs.unlinkSync(selected.piEntryPath);
					return nativeSelection;
				} });
				assert.equal(promptDirs.length, 1);
				assert.ok(promptDirs.every(promptDir => !fs.existsSync(promptDir)), "native finally removes the prompt directory");
				assert.equal(output.modelAttempts?.length, 1, "launch failures do not fall back");
				assert.deepEqual(output.attemptedModels, ["one/model"]);
				assert.equal(launches.length, scenario === "entry disappeared" ? 0 : 1);
				if (launches.length) assert.deepEqual(launches[0], {
					command: selected.nodeExecPath,
					args: [selected.piEntryPath, "--mode", "json", "-p", "--no-session", "--name", "worker abcdef from routing parent", "--model", "one/model", "--extension",
						fileURLToPath(new URL("../../src/runs/shared/subagent-prompt-runtime.ts", import.meta.url)),
						"--no-skills", "--system-prompt", path.join(promptDirs[0], "worker.md"), "Task: Task"],
				});
				assert.equal(output.exitCode, scenario === "success" ? 0 : 1, JSON.stringify(output));
				if (scenario !== "success") assert.ok(output.error?.includes(selected.piEntryPath));
				if (scenario === "spawn error") {
					assert.ok(output.error?.includes(selected.nodeExecPath));
					assert.ok(output.error?.includes("rate limit:"));
					assert.deepEqual(output.messages, []);
				}
			} finally {
				childProcess.spawn = originalSpawn;
				fileSystem.mkdtempSync = originalMkdtemp;
				syncBuiltinESMExports();
				if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
				process.argv[1] = originalEntry;
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});
	});

	it("preserves typed external startup and ready failures without attempts", async t => {
		for (const phase of ["startup", "ready"] as const) await t.test(phase, async () => {
			const h = dependencies(externalSelection);
			const error = new PiRuntimeLaunchError(`rate limit: selected runtime ${phase}`);
			if (phase === "startup") h.deps.createExternalOwner = async options => { h.ownerOptions.push(options); throw error; };
			else h.deps.createExternalOwner = async options => {
				h.ownerOptions.push(options);
				Object.defineProperty(h.owner, "ready", { value: Promise.reject(error) });
				return h.owner;
			};
			const output = await runSync("/runtime", [makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"] })], "worker", "Task", { runId: phase, acceptance: noAcceptance }, h.deps);
			assert.equal(output.exitCode, 1);
			assert.equal(output.error, error.message);
			assert.equal(h.ownerOptions.length, 1);
			assert.equal(h.attempts.length, 0);
			assert.equal(h.nativeCalls(), 0);
			assert.equal(output.modelAttempts, undefined);
			assert.deepEqual(h.finishes, phase === "ready" ? ["retained"] : []);
		});
	});

	it("does not retry native runtime failures", async () => {
		const h = dependencies(nativeSelection);
		let calls = 0;
		h.deps.runNativeAttempt = async (_cwd, _agent, _task, _model, options) => {
			assert.strictEqual(options.runtime, runtime);
			calls++;
			throw new PiRuntimeLaunchError("rate limit: selected Node disappeared");
		};
		const output = await runSync("/runtime", [makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"] })], "worker", "Task", { runId: "native-runtime", acceptance: noAcceptance }, h.deps);
		assert.equal(calls, 1);
		assert.equal(output.error, "rate limit: selected Node disappeared");
	});

	it("does not retry typed runtime failures and disposes an acquired owner", async () => {
		const h = dependencies(externalSelection);
		let calls = 0;
		h.deps.runExternalAttempt = async () => { calls++; throw new PiRuntimeLaunchError("rate limit: selected runtime disappeared"); };
		const output = await runSync("/runtime", [makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"] })], "worker", "Task", { runId: "runtime-failure", acceptance: noAcceptance }, h.deps);
		assert.equal(calls, 1);
		assert.equal(output.error, "rate limit: selected runtime disappeared");
		assert.deepEqual(h.finishes, ["retained"]);
	});

	it("preflights a disappeared entry before external acquisition", async () => {
		const h = dependencies(externalSelection);
		const missing = { ...runtime, piEntryPath: path.join(os.tmpdir(), "missing-pi-entry") };
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", { runtime: missing, runId: "missing", acceptance: noAcceptance }, h.deps);
		assert.equal(h.ownerOptions.length, 0);
		assert.ok(output.error?.includes(missing.piEntryPath));
	});
	it("keeps explicit native and auto/no-adapter on the native attempt path without an owner", async () => {
		for (const executionBackend of ["native", "auto"]) {
			const h = dependencies(nativeSelection);
			const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
				runId: `run-${executionBackend}`, cwd: "/exact", executionBackend, acceptance: noAcceptance,
			}, h.deps);
			assert.equal(output.exitCode, 0);
			assert.equal(h.nativeCalls(), 1);
			assert.equal(h.ownerOptions.length, 0);
			assert.deepEqual(h.selected, [{ cwd: "/exact", userConfig: { executionBackend } }]);
		}
	});

	it("returns the safe selector error before spawning", async () => {
		let nativeCalls = 0;
		const output = await runSync("/runtime", [makeAgent("worker")], "worker", "Task", {
			runId: "run", executionBackend: "missing", acceptance: noAcceptance,
		}, {
			async selectBackend() { throw new Error("Execution backend 'missing' is not registered"); },
			async runNativeAttempt() { nativeCalls++; throw new Error("must not spawn"); },
		});
		assert.equal(nativeCalls, 0);
		assert.equal(output.exitCode, 1);
		assert.equal(output.error, "Execution backend 'missing' is not registered");
	});

	it("creates one owner and reuses it across uniquely identified fallback attempts", async () => {
		const h = dependencies(externalSelection);
		h.deps.runExternalAttempt = async input => {
			h.attempts.push(input);
			return result(input.agent, input.task, h.attempts.length === 1
				? { exitCode: 1, error: "rate limit exceeded" }
				: {});
		};
		const agent = makeAgent("worker", { model: "one/model", fallbackModels: ["two/model"], completionGuard: false });
		const output = await runSync("/runtime", [agent], "worker", "Task", {
			runId: "run-7", index: 3, cwd: "/exact", sessionFile: "/tmp/external-session", acceptance: noAcceptance,
		}, h.deps);
		assert.equal(output.exitCode, 0);
		assert.equal(h.ownerOptions.length, 1);
		assert.equal(h.ownerOptions[0].childId, "child-3");
		assert.equal(h.ownerOptions[0].cwd, "/exact");
		assert.equal(h.ownerOptions[0].title, "worker");
		assert.strictEqual(h.ownerOptions[0].runtime, runtime);
		assert.ok(h.attempts.every(call => call.options.runtime === runtime));
		assert.deepEqual(h.attempts.map(call => call.attemptId), ["child-3-attempt-0", "child-3-attempt-1"]);
		assert.ok(h.attempts.every(call => call.owner === h.owner));
		assert.deepEqual(h.finishes, ["delivered"]);
		assert.deepEqual(output.executionSurface, { handle, retained: false });
	});

	it("retains failed, blocked, interrupted, and acceptance-rejected surfaces", async t => {
		const cases: Array<{ name: string; overrides: Partial<SingleResult>; acceptance?: typeof noAcceptance }> = [
			{ name: "failed", overrides: { exitCode: 1, error: "failed" } },
			{ name: "blocked", overrides: { exitCode: 1, error: "BLOCKED: approval required" } },
			{ name: "interrupted", overrides: { interrupted: true, finalOutput: "partial" } },
		];
		for (const scenario of cases) await t.test(scenario.name, async () => {
			const h = dependencies(externalSelection);
			h.deps.runExternalAttempt = async input => result(input.agent, input.task, scenario.overrides);
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId: scenario.name, sessionFile: `/tmp/${scenario.name}`, acceptance: noAcceptance,
			}, h.deps);
			assert.deepEqual(h.finishes, ["retained"]);
			assert.equal(output.executionSurface?.retained, true);
		});

		const h = dependencies(externalSelection);
		h.deps.runExternalAttempt = async input => result(input.agent, input.task);
		const rejected = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
			runId: "rejected", sessionFile: "/tmp/rejected", acceptance: { level: "checked", criteria: ["must report"] },
		}, h.deps);
		assert.equal(rejected.exitCode, 1);
		assert.deepEqual(h.finishes, ["retained"]);
	});

	it("retains the safe handle and safe phase errors for startup, attempt, and finish failures", async t => {
		for (const phase of ["startup", "attempt", "finish"] as const) await t.test(phase, async () => {
			const h = dependencies(externalSelection);
			if (phase === "startup") Object.defineProperty(h.owner, "ready", { value: Promise.reject(new Error("secret startup details")) });
			if (phase === "attempt") h.deps.runExternalAttempt = async () => { throw new Error("secret attempt details"); };
			if (phase === "finish") h.owner.finish = async () => { throw new Error("secret finish details"); };
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId: phase, sessionFile: `/tmp/${phase}`, acceptance: noAcceptance,
			}, h.deps);
			assert.equal(output.exitCode, 1);
			assert.equal(output.executionSurface?.retained, true);
			assert.ok(output.error?.includes(`External execution ${phase} failed`));
			assert.ok(!output.error?.includes("secret"));
		});
	});

	it("appends the diagnostic code when the attempt rejects the session file", async () => {
		const h = dependencies(externalSelection);
		h.deps.runExternalAttempt = async () => { throw new ExternalExecutionDiagnosticError("session_file_untrusted", "execution session file must be owner-only"); };
		const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
			runId: "untrusted", sessionFile: "/tmp/untrusted", acceptance: noAcceptance,
		}, h.deps);
		assert.equal(output.exitCode, 1);
		assert.equal(output.error, "External execution attempt failed (session_file_untrusted)");
		assert.equal(output.executionSurface?.retained, true);
	});

	it("preserves executionSurface through snapshots and JSON serialization", () => {
		const value = result(makeAgent("worker"), "Task", { executionSurface: { handle, retained: true } });
		const progress = { status: "completed" as const, startTime: 1, durationMs: 1, toolCount: 0, turnCount: 1, tokens: 2, recentTools: [], recentOutput: [] };
		const snapshot = snapshotResult(value, progress);
		assert.deepEqual(snapshot.executionSurface, { handle, retained: true });
		assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).executionSurface, { handle, retained: true });
	});
});

function successAttemptResult(): ExternalAttemptResult {
	return {
		attemptId: "child-0-attempt-0",
		sessionFile: "",
		messages: [],
		outcome: "success",
		finalOutput: "done",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		model: "mock",
		turns: 1,
		exit: { code: 0, signal: null },
		interrupted: false,
	};
}

describe("runSync external path exceptional lifecycle", () => {
	/**
	 * Exercises the ACTUAL runExternalSingleAttempt allocating path:
	 * - owner.runAttempt throws (proves tempDir finally cleanup)
	 * - post-loop output artifact write also fails (EISDIR)
	 * Both together: finish("retained") must be called (requires the fix).
	 * Pre-fix: post-loop EISDIR propagates out of runSync without calling finish.
	 */
	it("actual runExternalSingleAttempt: thrown attempt + post-loop artifact failure both handled - finish retained", async () => {
		const finishes: string[] = [];
		const attemptCalls: number[] = [];
		const owner: ExternalExecution = {
			surface: handle,
			ready: Promise.resolve(),
			async runAttempt() {
				attemptCalls.push(1);
				throw new Error("secret infra error - must not appear in result");
			},
			async finish(disposition) {
				finishes.push(disposition);
				return { handle, retained: disposition === "retained" };
			},
		};

		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-routing-"));
		const runId = "run-actual";
		// Pre-create the output artifact path as a directory so writeArtifact throws EISDIR.
		fs.mkdirSync(path.join(artifactsDir, `${runId}_worker_output.md`));

		try {
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId,
				sessionFile: path.join(artifactsDir, "session.jsonl"),
				artifactsDir,
				acceptance: noAcceptance,
			}, {
				selectBackend: async () => externalSelection,
				createExternalOwner: async () => owner,
				// No runExternalAttempt injection: uses real runExternalSingleAttempt
			});

			assert.equal(attemptCalls.length, 1, "real runExternalSingleAttempt must have run");
			assert.deepEqual(finishes, ["retained"], "owner.finish must be called retained even after both failures");
			assert.equal(output.exitCode, 1);
			assert.ok(output.error, "must have an error");
			// attempt failure preserved (safe message)
			assert.ok(output.error.includes("External execution attempt failed"), `attempt error must be in result, got: ${output.error}`);
			// cleanup failure appended (safe message)
			assert.ok(output.error.includes("External execution cleanup failed"), `cleanup error must be in result, got: ${output.error}`);
			// no raw infrastructure details leaked
			assert.ok(!output.error.includes("secret"), `must not leak raw errors, got: ${output.error}`);
			assert.ok(!output.error.includes("EISDIR"), `must not leak FS error details, got: ${output.error}`);
			assert.equal(output.executionSurface?.retained, true);
		} finally {
			fs.rmSync(artifactsDir, { recursive: true, force: true });
		}
	});

	/**
	 * Simpler variant: attempt succeeds (real runExternalSingleAttempt, tempDir cleaned by finally),
	 * but post-loop artifact write fails. finish("retained") must still be called.
	 * Pre-fix: EISDIR propagates out of runSync without calling finish.
	 */
	it("actual runExternalSingleAttempt: succeeding attempt + post-loop artifact failure: finish retained", async () => {
		const finishes: string[] = [];
		const attemptCalls: number[] = [];
		const owner: ExternalExecution = {
			surface: handle,
			ready: Promise.resolve(),
			async runAttempt() {
				attemptCalls.push(1);
				return successAttemptResult();
			},
			async finish(disposition) {
				finishes.push(disposition);
				return { handle, retained: disposition === "retained" };
			},
		};

		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-routing-"));
		const runId = "run-success-postloop";
		fs.mkdirSync(path.join(artifactsDir, `${runId}_worker_output.md`));

		try {
			const output = await runSync("/runtime", [makeAgent("worker", { completionGuard: false })], "worker", "Task", {
				runId,
				sessionFile: path.join(artifactsDir, "session.jsonl"),
				artifactsDir,
				acceptance: noAcceptance,
			}, {
				selectBackend: async () => externalSelection,
				createExternalOwner: async () => owner,
				// No runExternalAttempt injection: uses real runExternalSingleAttempt
			});

			assert.equal(attemptCalls.length, 1, "real runExternalSingleAttempt must have run");
			assert.deepEqual(finishes, ["retained"], "owner.finish must be called retained on post-loop failure");
			assert.equal(output.exitCode, 1);
			assert.ok(output.error, "must have an error");
			assert.ok(!output.error.includes("EISDIR"), `must not leak FS error details, got: ${output.error}`);
			assert.equal(output.executionSurface?.retained, true);
		} finally {
			fs.rmSync(artifactsDir, { recursive: true, force: true });
		}
	});
});
