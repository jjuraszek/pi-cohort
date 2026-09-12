import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXECUTION_REPORT_TYPE, createExclusiveSessionFile, loadReporterConfig, validateExecutionReport } from "../../src/execution-backend/reporting-protocol.ts";

const identity = { protocolVersion: 1, runId: "run", childId: "child", attemptId: "attempt" };
const config = { ...identity, controlSocketPath: "/private/control.sock" };
const ready = { ...identity, kind: "ready", sequence: 1, timestamp: "2026-09-06T00:00:00.000Z" };

function temporaryFile(name: string): string { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "report-protocol-")), name); }

describe("execution reporting protocol", () => {
	it("validates only exact fields for each report kind", () => {
		assert.equal(EXECUTION_REPORT_TYPE, "pi-cohort:execution-report:v1");
		assert.equal(validateExecutionReport(ready).kind, "ready");
		assert.deepEqual(validateExecutionReport({ ...ready, kind: "result", outcome: "success", finalOutput: "done", error: "", stopReason: "stopped" }).kind, "result");
		assert.equal(validateExecutionReport({ ...ready, kind: "control", action: "abort", state: "requested" }).kind, "control");
		for (const malformed of [
			{ ...ready, extra: true }, { ...ready, protocolVersion: 2 }, { ...ready, sequence: 0 }, { ...ready, timestamp: "not-a-timestamp" },
			{ ...ready, kind: "result", outcome: "unknown", finalOutput: "done" }, { ...ready, kind: "result", outcome: "success", finalOutput: 3 }, { ...ready, kind: "result", outcome: "success", finalOutput: "done", error: 3 }, { ...ready, kind: "result", outcome: "success", finalOutput: "done", stopReason: null },
			{ ...ready, kind: "result", outcome: "success", finalOutput: "done", action: "abort" }, { ...ready, kind: "control", action: "abort", state: "nope" },
			{ ...ready, kind: "control", action: "abort", state: "requested", finalOutput: "nope" },
		]) assert.throws(() => validateExecutionReport(malformed));
	});

	it("reads reporter configuration from the descriptor it inspected", () => {
		const descriptor = 42;
		const calls: Array<[string, number | string]> = [];
		const fileSystem = {
			constants: { O_RDONLY: 0, O_NOFOLLOW: 0o400000 },
			openSync(file: string, flags: number) { calls.push(["open", file]); assert.equal(flags, 0o400000); return descriptor; },
			fstatSync(openDescriptor: number) { calls.push(["fstat", openDescriptor]); return { isFile: () => true, mode: 0o100600 }; },
			lstatSync(file: string) { calls.push(["lstat", file]); return { isFile: () => true, isSymbolicLink: () => false }; },
			readFileSync(openDescriptor: number, encoding: string) { calls.push(["read", openDescriptor]); assert.equal(encoding, "utf8"); return JSON.stringify(config); },
			closeSync(openDescriptor: number) { calls.push(["close", openDescriptor]); },
		};

		assert.deepEqual(loadReporterConfig("/config-that-will-be-swapped.json", fileSystem, "darwin"), config);
		assert.deepEqual(calls, [["open", "/config-that-will-be-swapped.json"], ["fstat", descriptor], ["read", descriptor], ["close", descriptor]]);
	});

	it("closes the reporter configuration descriptor when validation fails", () => {
		const calls: string[] = [];
		const fileSystem = {
			constants: { O_RDONLY: 0, O_NOFOLLOW: 0o400000 },
			openSync() { return 42; },
			fstatSync() { return { isFile: () => true, mode: 0o100600 }; },
			lstatSync() { return { isFile: () => true, isSymbolicLink: () => false }; },
			readFileSync() { return "{}"; },
			closeSync() { calls.push("close"); },
		};

		assert.throws(() => loadReporterConfig("/invalid-config.json", fileSystem, "darwin"));
		assert.deepEqual(calls, ["close"]);
	});

	it("rejects symlink and non-regular reporter configuration targets", () => {
		const file = temporaryFile("config.json"); const link = `${file}.link`;
		fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
		fs.symlinkSync(file, link); assert.throws(() => loadReporterConfig(link), /regular non-symlink/);
		assert.throws(() => loadReporterConfig(path.dirname(file)), /regular non-symlink/);
	});

	it("rejects group or world readable reporter configuration", () => {
		const file = temporaryFile("config.json"); fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
		for (const mode of [0o640, 0o604, 0o644]) { fs.chmodSync(file, mode); assert.throws(() => loadReporterConfig(file, fs, "darwin"), /owner-only/); }
	});

	it("requires a strictly shaped reporter configuration", () => {
		const file = temporaryFile("config.json");
		for (const value of [{}, { ...config, extra: true }, { ...config, protocolVersion: "1" }, { ...config, runId: "" }, { ...config, childId: 1 }, { ...config, attemptId: null }, { ...config, controlSocketPath: "" }, { ...config, controlSocketPath: 1 }, Object.fromEntries(Object.entries(config).filter(([key]) => key !== "controlSocketPath"))]) {
			fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); assert.throws(() => loadReporterConfig(file));
		}
	});

	it("creates a zero-byte owner-only session file exclusively", () => {
		const file = temporaryFile("session.jsonl");
		createExclusiveSessionFile(file); assert.equal(fs.statSync(file).size, 0);
		if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
		assert.throws(() => createExclusiveSessionFile(file), /EEXIST/);
	});

	it("rejects a symlink at a fresh session-file target", () => {
		const file = temporaryFile("session.jsonl"); const target = temporaryFile("target.jsonl");
		fs.writeFileSync(target, "existing"); fs.symlinkSync(target, file);
		assert.throws(() => createExclusiveSessionFile(file), /symbolic link/); assert.equal(fs.readFileSync(target, "utf8"), "existing");
	});
});
