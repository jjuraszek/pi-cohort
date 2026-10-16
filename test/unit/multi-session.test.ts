import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";
import { RESULTS_DIR, SUBAGENT_ASYNC_COMPLETE_EVENT, type SubagentEventBus } from "../../src/shared/types.ts";

delete process.env[SUBAGENT_CHILD_ENV];
delete process.env[SUBAGENT_FANOUT_CHILD_ENV];

type Sent = { message: unknown; options: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

type FakeRuntime = {
	pi: unknown;
	events: SubagentEventBus;
	sent: Sent[];
	handlers: Map<string, Handler>;
	start(sessionId: string): void;
	shutdown(reason: string): void;
};

function createBus(): SubagentEventBus {
	const emitter = new EventEmitter();
	return {
		on(channel, handler) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel, payload) {
			emitter.emit(channel, payload);
		},
	};
}

function sessionCtx(sessionId: string) {
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: { requestRender() {}, setWidget() {}, setStatus() {} },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => null,
			getEntries: () => [],
			getBranch: () => [],
		},
	};
}

function createRuntime(events: SubagentEventBus = createBus()): FakeRuntime {
	const sent: Sent[] = [];
	const handlers = new Map<string, Handler>();
	const target = {
		events,
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			sent.push({ message, options });
		},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		getSessionName() {
			return undefined;
		},
	};
	const pi = new Proxy(target, {
		get(obj, prop) {
			if (prop in obj) return obj[prop as keyof typeof obj];
			return () => undefined;
		},
	});
	registerSubagentExtension(pi as never);
	return {
		pi,
		events,
		sent,
		handlers,
		start(sessionId) {
			handlers.get("session_start")!({}, sessionCtx(sessionId));
		},
		shutdown(reason) {
			handlers.get("session_shutdown")!({ reason }, sessionCtx("retired"));
		},
	};
}

function publish(sessionId: string): string {
	const id = randomUUID();
	const file = path.join(RESULTS_DIR, `${id}.json`);
	fs.writeFileSync(file, JSON.stringify({
		id,
		sessionId,
		cwd: process.cwd(),
		agent: "worker",
		success: true,
		summary: "done",
	}));
	return file;
}

const SETTLE_MS = 2000;
const STEP_MS = 20;
const REPUBLISH_MS = 250;

async function waitFor(predicate: () => boolean, budgetMs = SETTLE_MS): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, STEP_MS));
	}
	return predicate();
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function assertConsumed(runtime: FakeRuntime, file: string, expectedCount: number, label: string) {
	assert.equal(runtime.sent.length, expectedCount, `${label}: notification count`);
	assert.equal(fs.existsSync(file), false, `${label}: result file still on disk`);
	const last = runtime.sent[expectedCount - 1] as { message: { customType: string }; options: { triggerTurn: boolean } };
	assert.equal(last.message.customType, "subagent-notify", `${label}: customType`);
	assert.deepEqual(last.options, { triggerTurn: true }, `${label}: options`);
}

// macOS FSEvents drops events for files written while libuv re-arms its stream after a new fs.watch;
// re-publishing the same id is idempotent because completion dedupe keys on id.
async function publishAndAwait(runtime: FakeRuntime, sessionId: string, expectedCount: number, label: string): Promise<void> {
	const id = randomUUID();
	const file = path.join(RESULTS_DIR, `${id}.json`);
	const body = JSON.stringify({ id, sessionId, cwd: process.cwd(), agent: "worker", success: true, summary: "done" });
	const deadline = Date.now() + SETTLE_MS;
	for (;;) {
		fs.writeFileSync(file, body);
		const consumed = await waitFor(() => runtime.sent.length >= expectedCount && !fs.existsSync(file), REPUBLISH_MS);
		if (consumed) break;
		assert.ok(Date.now() < deadline, `${label}: not consumed within ${SETTLE_MS} ms`);
		try {
			fs.unlinkSync(file);
		} catch {
			// consumed between the check and the unlink; the next write is deduped
		}
	}
	assertConsumed(runtime, file, expectedCount, label);
}

describe("multi-session cleanup", () => {
	it("keeps session A's watcher and notify alive when session B registers in the same process", async () => {
		const sessionA = `session-A-${randomUUID()}`;
		const sessionB = `session-B-${randomUUID()}`;
		const runtimes: FakeRuntime[] = [];
		try {
			const pi_A = createRuntime();
			runtimes.push(pi_A);
			pi_A.start(sessionA);

			await publishAndAwait(pi_A, sessionA, 1, "A first");

			const pi_B = createRuntime();
			runtimes.push(pi_B);

			await publishAndAwait(pi_A, sessionA, 2, "A second");
			assert.equal(pi_B.sent.length, 0, "B received nothing before its session_start");

			pi_B.start(sessionB);
			await publishAndAwait(pi_A, sessionA, 3, "A third");
			await publishAndAwait(pi_B, sessionB, 1, "B first");
			assert.equal(pi_A.sent.length, 3, "A consumed only its own file");
			assert.equal(pi_B.sent.length, 1, "B consumed only its own file");
		} finally {
			for (const runtime of runtimes) runtime.shutdown("quit");
		}
	});

	it("retires only the reloaded runtime and lets its replacement take over the session", async () => {
		const sessionA = `session-A-${randomUUID()}`;
		const sessionB = `session-B-${randomUUID()}`;
		const runtimes: FakeRuntime[] = [];
		try {
			const pi_A1 = createRuntime();
			const pi_B = createRuntime();
			runtimes.push(pi_A1, pi_B);
			pi_A1.start(sessionA);
			pi_B.start(sessionB);

			pi_A1.shutdown("reload");

			const probe = publish(sessionA);
			await settle();
			assert.equal(pi_A1.sent.length, 0, "retired A1 notifies nothing");
			assert.equal(fs.existsSync(probe), true, "retired A1 leaves the probe file on disk");

			const pi_A2 = createRuntime(pi_A1.events);
			runtimes.push(pi_A2);
			pi_A2.start(sessionA);
			assert.equal(await waitFor(() => pi_A2.sent.length >= 1 && !fs.existsSync(probe)), true, "A2 primes the probe file");
			assertConsumed(pi_A2, probe, 1, "A2 probe");

			await publishAndAwait(pi_A2, sessionA, 2, "A2 second");
			await publishAndAwait(pi_B, sessionB, 1, "B first");
			assert.equal(pi_A1.sent.length, 0, "retired A1 still notifies nothing");

			pi_A2.shutdown("quit");
			runtimes.splice(runtimes.indexOf(pi_A2), 1);
			pi_A1.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id: randomUUID(),
				agent: "worker",
				success: true,
				summary: "orphan",
				timestamp: Date.now(),
			});
			assert.equal(pi_A1.sent.length, 0, "A1's notify listener was removed, not just deduped");
		} finally {
			for (const runtime of runtimes) runtime.shutdown("quit");
		}
	});

	it("leaves no lifetime globals behind", () => {
		const globals = globalThis as Record<string, unknown>;
		assert.equal("__piSubagentRuntimeCleanup" in globals, false);
		assert.equal("__piSubagentEventUnsubscribes" in globals, false);
		assert.equal("__pi_subagents_notify_unsubscribe__" in globals, false);
	});
});
