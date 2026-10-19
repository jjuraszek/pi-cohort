import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import { createMockPi } from "../support/mock-pi.ts";

const ordering = "Write a fenced JSON block tagged `acceptance-report` in your final text message, then call `structured_output` as your final action. Shape:";
let mock: ReturnType<typeof createMockPi>;
let cwd: string;
beforeEach(() => {
	mock = createMockPi();
	mock.install();
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mock-pi-test-"));
});
afterEach(() => {
	mock.uninstall();
	fs.rmSync(cwd, { recursive: true, force: true });
});

function launch(task: string, capture = path.join(cwd, "capture.json")) {
	return spawnSync(mock.runtime.nodeExecPath, [mock.runtime.piEntryPath, "--mode", "json", "--no-session", task], {
		cwd, env: { ...process.env, PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: capture }, encoding: "utf8",
	});
}

function events(stdout: string) {
	return stdout.trim().split("\n").map(line => JSON.parse(line));
}

test("mock observes files and cwd inside the child", () => {
	fs.mkdirSync(path.join(cwd, "nested"));
	fs.writeFileSync(path.join(cwd, "nested", "value.txt"), "snapshot\n");
	fs.writeFileSync(path.join(cwd, "empty.txt"), "");
	const response = { output: "observed", echoCwd: true, echoFiles: ["nested/value.txt", "empty.txt"] };
	mock.onCall(response);
	const result = launch("Observe snapshot");
	assert.equal(result.status, 0, result.stderr);
	const text = events(result.stdout)[0].message.content[0].text;
	assert.equal(text.split("\n")[0], "observed");
	assert.deepEqual(JSON.parse(text.slice("observed\n".length)), {
		cwd: fs.realpathSync(cwd), files: { "nested/value.txt": "snapshot\n", "empty.txt": "" },
	});
});

for (const source of ["direct", "file"]) {
	for (const valid of [false, true]) {
		test(`ordering guard ${valid ? "accepts" : "rejects"} ${source} prompt`, () => {
			const prompt = `## Acceptance Contract\n${valid ? ordering : "Return an acceptance report."}`;
			fs.writeFileSync(path.join(cwd, "prompt.md"), prompt);
			const response = { output: "reviewed", requireAcceptanceStructuredOrder: true, structuredOutput: { ok: true } };
			mock.onCall(response);
			const result = launch(source === "direct" ? prompt : "@prompt.md");
			if (!valid) {
				assert.notEqual(result.status, 0);
				assert.match(result.stderr, /Expected report-then-structured-output ordering sentence\./);
				assert.equal(result.stdout, "");
				assert.equal(fs.existsSync(path.join(cwd, "capture.json")), false);
				return;
			}
			assert.equal(result.status, 0, result.stderr);
			const entries = events(result.stdout);
			assert.equal(entries[0].type, "message_end");
			assert.match(entries[0].message.content[0].text, /```acceptance-report/);
			assert.deepEqual(entries.slice(1).map(entry => [entry.type, entry.toolName ?? entry.message.toolName]), [
				["tool_execution_start", "structured_output"], ["tool_result_end", "structured_output"], ["tool_execution_end", "structured_output"],
			]);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "capture.json"), "utf8")), { ok: true });
		});
	}
}

test("omitted observation and ordering options retain legacy output", () => {
	const response = { output: "legacy", structuredOutput: { value: 1 } };
	mock.onCall(response);
	const result = launch("## Acceptance Contract\nReturn a report.");
	assert.equal(result.status, 0, result.stderr);
	assert.equal(events(result.stdout)[0].message.content[0].text.split("\n")[0], "legacy");
	assert.match(events(result.stdout)[0].message.content[0].text, /```acceptance-report/);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "capture.json"), "utf8")), { value: 1 });
});
