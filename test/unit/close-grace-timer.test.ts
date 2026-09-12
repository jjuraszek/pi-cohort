import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { attachPostExitStdioGuard, trySignalChild } from "../../src/shared/post-exit-stdio-guard.ts";

class FakeStream extends EventEmitter {
	destroyed = false;

	destroy(): void {
		this.destroyed = true;
	}
}

class FakeChild extends EventEmitter {
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
}

function attachGuard(child: FakeChild, idleMs: number, hardMs: number): () => void {
	return attachPostExitStdioGuard(
		child as unknown as Parameters<typeof attachPostExitStdioGuard>[0],
		{ idleMs, hardMs },
	);
}

describe("attachPostExitStdioGuard", () => {
	it("reports whether a termination signal was actually delivered", () => {
		assert.equal(trySignalChild({ kill: () => true }, "SIGTERM"), true);
		assert.equal(trySignalChild({ kill: () => false }, "SIGTERM"), false);
		assert.equal(trySignalChild({ kill: () => { throw new Error("gone"); } }, "SIGTERM"), false);
	});

	it("leaves clean streams open until they end naturally", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const child = new FakeChild();
		attachGuard(child, 2000, 8000);

		child.emit("exit");
		t.mock.timers.tick(1999);
		assert.equal(child.stdout.destroyed, false);
		assert.equal(child.stderr.destroyed, false);

		child.stdout.emit("end");
		child.stderr.emit("end");
		t.mock.timers.tick(6001);
		assert.equal(child.stdout.destroyed, false);
		assert.equal(child.stderr.destroyed, false);
	});

	it("cancels pending stream cutoffs during cleanup", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const child = new FakeChild();
		const cleanup = attachGuard(child, 1000, 2000);

		child.emit("exit");
		cleanup();
		t.mock.timers.tick(2001);

		assert.equal(child.stdout.destroyed, false);
		assert.equal(child.stderr.destroyed, false);
	});

	it("cuts off silent inherited streams after the idle window", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const child = new FakeChild();
		attachGuard(child, 1500, 8000);

		child.emit("exit");
		t.mock.timers.tick(1499);
		assert.equal(child.stdout.destroyed, false);
		assert.equal(child.stderr.destroyed, false);

		t.mock.timers.tick(1);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
	});

	it("cuts off chatty inherited streams at the hard deadline", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const child = new FakeChild();
		attachGuard(child, 1000, 2000);

		child.emit("exit");
		t.mock.timers.tick(900);
		child.stdout.emit("data", Buffer.from("tick"));
		t.mock.timers.tick(900);
		child.stdout.emit("data", Buffer.from("tick"));
		t.mock.timers.tick(199);
		assert.equal(child.stdout.destroyed, false);
		assert.equal(child.stderr.destroyed, false);

		t.mock.timers.tick(1);
		assert.equal(child.stdout.destroyed, true);
		assert.equal(child.stderr.destroyed, true);
	});
});
