import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createRuntimeFixture } from "../support/runtime-parent.mjs";

test("deleting consumed notifications and temporary artifacts preserves durable revival after restart", async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const origin = fixture.run("A", [{ agent: "worker", task: "Observe", async: true }]);
		const record = origin.results[0];
		assert.equal(record.status.state, "complete");
		const statusPath = path.join(record.result.details.asyncDir, "status.json");
		const before = fs.readFileSync(statusPath, "utf8");
		const session = record.status.steps[0].sessionFile;
		assert.ok(session.startsWith(fs.realpathSync.native(origin.roots.durable) + path.sep));
		fs.rmSync(origin.roots.results, { recursive: true, force: true });
		fs.rmSync(origin.roots.temp, { recursive: true, force: true });
		assert.equal(fs.readFileSync(statusPath, "utf8"), before);
		assert.ok(fs.existsSync(session));
		const resumed = fixture.run("B", [{ action: "resume", id: record.result.details.runId, message: "Continue", async: true }], { cleanup: true, ageDurable: [record.result.details.asyncDir, statusPath, path.dirname(session), session] });
		assert.equal(fs.readFileSync(statusPath, "utf8"), before);
		assert.ok(fs.statSync(statusPath).mtimeMs < Date.now() - 7 * 24 * 60 * 60 * 1000);
		assert.deepEqual(resumed.cleanup, { chainRemoved: true, artifactRemoved: true });
		assert.equal(resumed.results[0].status.state, "complete");
		assert.deepEqual(resumed.results[0].status.runtime, record.status.runtime);
		assert.equal(resumed.results[0].status.steps[0].sessionFile, session);
		fixture.assertObservedA(2);
	} finally { fixture.close(); }
});

test("existing async directory rejects a new B dispatch without changing the original A record", async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const origin = fixture.run("A", [{ agent: "worker", task: "Original", async: true }]);
		const record = origin.results[0];
		assert.equal(record.status.state, "complete");
		const statusPath = path.join(record.result.details.asyncDir, "status.json");
		const before = fs.readFileSync(statusPath, "utf8");
		const filesBefore = fs.readdirSync(record.result.details.asyncDir).sort();
		const collision = fixture.run("B", [], { collisionId: record.result.details.runId });
		assert.equal(collision.results[0].result.isError, true);
		assert.match(collision.results[0].result.content[0].text, /Failed to create async run directory.*EEXIST/);
		assert.equal(collision.started.length, 0);
		assert.equal(fs.readFileSync(statusPath, "utf8"), before);
		assert.deepEqual(JSON.parse(before).runtime, record.status.runtime);
		assert.deepEqual(fs.readdirSync(record.result.details.asyncDir).sort(), filesBefore);
		fixture.assertObservedA(1);
		fixture.assertObservedRunnerA(1);
	} finally { fixture.close(); }
});

test("nested forked async chain keeps origin root through cleanup and cross-parent revival", async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const origin = fixture.run("A", [{ chain: [{ agent: "worker", task: "First" }, { agent: "worker", task: "Second" }], context: "fork", async: true }], { nested: true, parentSession: true });
		const record = origin.results[0];
		assert.notEqual(record.result.isError, true, JSON.stringify(record.result));
		assert.equal(record.status.state, "complete");
		assert.equal(origin.parentBefore, origin.parentAfter);
		assert.ok(origin.route);
		const owner = origin.registry.children.find(child => child.id === record.result.details.runId);
		assert.deepEqual(owner.runtime, record.status.runtime);
		for (const step of record.status.steps) assert.ok(step.sessionFile.startsWith(owner.sessionRoot + path.sep));
		assert.ok(record.status.sessionDir.startsWith(owner.sessionRoot + path.sep));
		const session = record.status.steps[1].sessionFile;
		fs.rmSync(origin.roots.results, { recursive: true, force: true });
		fs.rmSync(origin.roots.temp, { recursive: true, force: true });
		const resumed = fixture.run("B", [{ action: "resume", id: record.result.details.runId, index: 1, message: "Continue" }], { inheritedRoute: origin.route, cleanup: true });
		assert.notEqual(resumed.results[0].result.isError, true, JSON.stringify(resumed.results[0].result));
		assert.equal(resumed.results[0].status.state, "complete");
		assert.equal(resumed.results[0].status.steps[0].sessionFile, session);
		const revived = resumed.registry.children.find(child => child.id === resumed.results[0].result.details.runId);
		assert.equal(revived.sessionRoot, owner.sessionRoot);
		assert.deepEqual(revived.runtime, owner.runtime);
		fixture.assertObservedA(3);
		fixture.assertObservedRunnerA(2);
	} finally { fixture.close(); }
});

test("explicit and configured session bases keep precedence and user-owned retention", async () => {
	const fixture = await createRuntimeFixture();
	try {
		fixture.assertDistinct();
		const configured = path.join(fixture.root, "configured sessions");
		const explicit = path.join(fixture.root, "explicit sessions");
		for (const base of [configured, explicit]) {
			fs.mkdirSync(base);
			fs.writeFileSync(path.join(base, "existing.jsonl"), "user-owned\n");
			const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			fs.utimesSync(path.join(base, "existing.jsonl"), old, old);
		}
		const response = fixture.run("A", [
			{ agent: "worker", task: "Configured" },
			{ agent: "worker", task: "Explicit", sessionDir: explicit },
		], { config: { defaultSessionDir: configured }, cleanup: true });
		for (const [index, base] of [configured, explicit].entries()) {
			const result = response.results[index].result;
			assert.notEqual(result.isError, true);
			const session = result.details.results[0].sessionFile;
			assert.ok(session.startsWith(fs.realpathSync.native(base) + path.sep));
			assert.notEqual(path.dirname(session), fs.realpathSync.native(base));
			assert.equal(path.basename(path.dirname(session)), "run-0");
			assert.match(path.basename(path.dirname(path.dirname(session))), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
			assert.equal(fs.readFileSync(path.join(base, "existing.jsonl"), "utf8"), "user-owned\n");
		}
		fixture.assertObservedA(2);
	} finally { fixture.close(); }
});
