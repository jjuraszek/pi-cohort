import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRuntimeFixture } from "../support/runtime-parent.mjs";

for (const [name, params, count] of [
	["single", { agent: "worker", task: "Observe runtime" }, 1],
	["parallel", { tasks: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Second" }] }, 2],
	["chain", { chain: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Second {previous}" }] }, 2],
]) {
	test(`foreground ${name} ignores conflicting PATH installation`, async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.assertDistinct();
			const response = fixture.run("A", [params]);
			assert.notEqual(response.results[0].result.isError, true);
			assert.equal(response.results[0].result.details.results.length, count);
			for (const result of response.results[0].result.details.results) {
				assert.equal(result.exitCode, 0);
				assert.match(result.finalOutput, /runtime proof completed/);
			}
			fixture.assertObservedA(count);
		} finally { fixture.close(); }
	});
}

for (const [name, params, index, count] of [
	["single", { agent: "worker", task: "Observe", async: true }, undefined, 1],
	["chain", { chain: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Second" }], async: true }, 1, 2],
]) {
	test(`detached ${name} resumes original session under parent B`, async () => {
		const fixture = await createRuntimeFixture();
		try {
			fixture.assertDistinct();
			const origin = fixture.run("A", [params]);
			const record = origin.results[0];
			assert.equal(record.status.state, "complete");
			assert.equal(origin.started.length, 1);
			const session = record.status.steps[index ?? 0].sessionFile;
			assert.ok(session.split(path.sep).some(part => part.startsWith("async-")));
			const resumed = fixture.run("B", [{ action: "resume", id: record.result.details.runId, index, message: "Continue", async: true }]);
			assert.equal(resumed.started.length, 1);
			assert.equal(resumed.results[0].status.state, "complete");
			assert.equal(resumed.results[0].completion.success, true);
			assert.deepEqual(resumed.results[0].completion.runtime, record.status.runtime);
			assert.match(resumed.results[0].completion.results[0].output, /runtime proof completed/);
			assert.notEqual(resumed.results[0].result.details.runId, record.result.details.runId);
			assert.match(resumed.results[0].result.details.runId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
			assert.equal(resumed.results[0].status.steps[0].sessionFile, session);
			assert.deepEqual(resumed.results[0].status.runtime, record.status.runtime);
			fixture.assertObservedA(count + 1);
			fixture.assertObservedRunnerA(2);
		} finally { fixture.close(); }
	});
}

for (const external of ["foreground", "background"]) test(`supported ${external} external attempt observes A through the real child host despite B on PATH`, async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const response = fixture.run("A", [], { external });
		const record = response.results[0];
		if (process.platform === "win32") {
			assert.match(record.error, /unsupported on win32/);
			fixture.assertObservedA(0);
		} else {
			assert.equal(record.error, undefined);
			assert.equal(record.result.exitCode, 0);
			assert.equal(record.result.finalOutput, "external runtime completed");
			assert.match(fs.readFileSync(record.sessionFile, "utf8"), /external runtime completed/);
			fixture.assertObservedA(1);
		}
	} finally { fixture.close(); }
});

test("missing original Pi entry fails revival without PATH fallback or model retries", async () => {
	const fixture = await createRuntimeFixture();
	const renamed = `${fixture.A.entry}.missing`;
	try {
		fixture.assertDistinct();
		const origin = fixture.run("A", [{ agent: "worker", task: "Observe", async: true }]);
		const record = origin.results[0];
		fs.renameSync(fixture.A.entry, renamed);
		const resumed = fixture.run("B", [false, true].map(async => ({ action: "resume", id: record.result.details.runId, message: "Continue", async })));
		for (const attempt of resumed.results) {
			assert.equal(attempt.result.isError, true);
			assert.match(attempt.result.content[0].text, /ENOENT|no such file/);
		}
		fixture.assertObservedA(1);
	} finally {
		if (fs.existsSync(renamed)) fs.renameSync(renamed, fixture.A.entry);
		fixture.close();
	}
});

test("entry renamed after executor capture fails immediate and detached starts without retries", async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const response = fixture.run("A", [false, true].map(async => ({ agent: "worker", task: "Unavailable", async })), { renameAfterCapture: true });
		for (const record of response.results) {
			assert.equal(record.result.isError, true);
			assert.match(record.result.content[0].text, /ENOENT|no such file/);
		}
		fixture.assertObservedA(0);
		fixture.assertObservedRunnerA(0);
		assert.equal(fixture.A.callCount(), 0);
	} finally { fixture.close(); }
});

test("detached runner rejects its missing entry without an alternate-model attempt", async () => {
	const fixture = await createRuntimeFixture();
	const renamed = `${fixture.A.entry}.missing`;
	try {
		fixture.assertDistinct();
		const response = fixture.run("A", [{ agent: "worker", task: "Unavailable", async: true }], { runnerMissingEntry: true });
		const record = response.results[0];
		assert.equal(response.started.length, 1);
		assert.equal(record.status.state, "failed");
		assert.equal(record.completion.success, false);
		assert.match(record.completion.results[0].error, /ENOENT|no such file/);
		assert.equal(record.completion.results[0].modelAttempts.length, 0);
		assert.ok(!record.completion.results[0].attemptedModels?.includes("mock/fallback"));
		fixture.assertObservedRunnerA(1);
		fixture.assertObservedA(0);
	} finally {
		if (fs.existsSync(renamed)) fs.renameSync(renamed, fixture.A.entry);
		fixture.close();
	}
});

test("missing original copied Node rejects revival with no fallback to current Node", async () => {
	const fixture = await createRuntimeFixture();
	const renamed = `${fixture.B.node}.missing`;
	try {
		fixture.assertDistinct();
		const origin = fixture.run("B", [{ agent: "worker", task: "Observe", async: true }]);
		assert.equal(origin.results[0].status.state, "complete");
		assert.equal(origin.results[0].status.runtime.nodeExecPath, fs.realpathSync.native(fixture.B.node));
		fs.renameSync(fixture.B.node, renamed);
		const response = fixture.run("A", [{ action: "resume", id: origin.results[0].result.details.runId, message: "Continue", async: true }]);
		assert.equal(response.results[0].result.isError, true);
		assert.match(response.results[0].result.content[0].text, /ENOENT|no such file/);
		assert.equal(fixture.A.callCount(), 0);
		assert.equal(fixture.B.callCount(), 1);
	} finally {
		if (fs.existsSync(renamed)) fs.renameSync(renamed, fixture.B.node);
		fixture.close();
	}
});

for (const nested of [false, true]) test(`${nested ? "nested" : "top-level"} symlinked foreground launch revives without an async status and rejects outside-root lookup`, async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const response = fixture.run("A", [
			{ agent: "worker", task: "Observe" },
			{ action: "resume", id: "$last", message: "Continue", async: false },
			{ action: "resume", dir: fixture.root, message: "Outside", async: false },
		], { aliasLaunch: true, nested });
		assert.equal(response.results[0].result.details.results[0].exitCode, 0);
		assert.notEqual(response.results[1].result.isError, true);
		assert.match(response.results[1].result.content[0].text, /Revived (foreground|nested) subagent/);
		assert.equal(response.results[1].status.state, "complete");
		assert.equal(response.results[1].status.steps[0].sessionFile, response.results[0].result.details.results[0].sessionFile);
		assert.equal(response.results[2].result.isError, true);
		assert.match(response.results[2].result.content[0].text, /authorized async root|must be inside/);
		fixture.assertObservedA(2);
	} finally { fixture.close(); }
});
