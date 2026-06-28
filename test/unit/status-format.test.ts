import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateStepStatus, formatActivityLabel, formatParallelOutcome, STATUS_DIVIDER, wrapStatus } from "../../src/shared/status-format.ts";
import type { AsyncJobStep } from "../../src/shared/types.ts";

describe("status format helpers", () => {
	it("formats activity labels consistently", () => {
		assert.equal(formatActivityLabel(1_000, undefined, 1_500), "active now");
		assert.equal(formatActivityLabel(1_000, "needs_attention", 4_000), "no activity for 3s");
		assert.equal(formatActivityLabel(undefined, "active_long_running", 4_000), "active but long-running");
	});

	it("aggregates step status and parallel outcomes", () => {
		const steps = [{ status: "complete" }, { status: "running" }, { status: "failed" }] satisfies Array<Pick<AsyncJobStep, "status">>;
		assert.equal(aggregateStepStatus(steps), "running");
		assert.equal(formatParallelOutcome(steps, 3), "1 agent running · 1/3 done · 1 failed");
		assert.equal(formatParallelOutcome(steps, 3, { showRunning: false }), "1/3 done · 1 failed");
	});
});

describe("wrapStatus", () => {
	it("prefixes text with a single leading box-drawing divider", () => {
		assert.equal(wrapStatus("Σ$0.042"), "│ Σ$0.042");
	});

	it("STATUS_DIVIDER is the box-drawing vertical (U+2502)", () => {
		assert.equal(STATUS_DIVIDER, "│");
	});
});
