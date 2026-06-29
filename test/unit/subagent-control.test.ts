import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubagentParams } from "../../src/extension/schemas.ts";
import {
	applyChildEventToLifecycle,
	buildControlEvent,
	claimControlNotification,
	controlNotificationKey,
	deriveActivityState,
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	resolveControlConfig,
	shouldNotifyControlEvent,
	shouldSilenceKill,
} from "../../src/runs/shared/subagent-control.ts";
import { nextLongRunningTrigger } from "../../src/runs/shared/long-running-guard.ts";

const config = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
});

describe("subagent control attention state", () => {
	it("marks a run as needing attention only after the idle threshold", () => {
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 50 }), undefined);
		assert.equal(deriveActivityState({ config, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
		assert.equal(deriveActivityState({ config, startedAt: 0, now: 400 }), "needs_attention");
	});


	it("builds compact needs-attention control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 2,
			ts: 1_000,
			lastActivityAt: 100,
		});
		assert.deepEqual(event, {
			type: "needs_attention",
			to: "needs_attention",
			ts: 1_000,
			runId: "run-1",
			agent: "worker",
			index: 2,
			message: "worker needs attention (no observed activity for 0s)",
			reason: "idle",
			elapsedMs: 900,
		});
	});

	it("supports a specific attention message", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
		});

		assert.equal(event.message, "worker completed without making edits for an implementation task");
	});

	it("builds terminal completion guard control events", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		assert.equal(event.reason, "completion_guard");
	});

	it("defaults notifications to active-long-running and needs attention", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		const activeEvent = buildControlEvent({ type: "active_long_running", to: "active_long_running", runId: "run-1", agent: "worker" });
		assert.equal(shouldNotifyControlEvent(config, event), true);
		assert.equal(shouldNotifyControlEvent(config, activeEvent), true);
		assert.deepEqual(config.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(config.notifyChannels, ["event", "async", "intercom"]);
	});

	it("defaults active-long-running notices to elapsed time only", () => {
		const defaults = resolveControlConfig();

		assert.equal(defaults.activeNoticeAfterMs, 240_000);
		assert.equal(defaults.activeNoticeAfterTurns, undefined);
		assert.equal(defaults.activeNoticeAfterTokens, undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 77_000,
			turns: 50,
			tokens: 800_000,
		}), undefined);
		assert.equal(nextLongRunningTrigger(defaults, {
			startedAt: 0,
			now: 240_000,
			turns: 1,
			tokens: 1,
		}), "time_threshold");
	});

	it("supports opt-in turn and token long-running thresholds", () => {
		const tokenBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTokens: 500_000 });
		const turnBudget = resolveControlConfig(undefined, { activeNoticeAfterMs: 999_999, activeNoticeAfterTurns: 5 });

		assert.equal(nextLongRunningTrigger(tokenBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 1,
			tokens: 500_000,
		}), "token_threshold");
		assert.equal(nextLongRunningTrigger(turnBudget, {
			startedAt: 0,
			now: 77_000,
			turns: 5,
			tokens: 1,
		}), "turn_threshold");
	});

	it("resolves custom notification config", () => {
		const custom = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1234,
			activeNoticeAfterMs: 2345,
			activeNoticeAfterTurns: 7,
			activeNoticeAfterTokens: 8000,
			failedToolAttemptsBeforeAttention: 4,
			notifyOn: ["active_long_running", "needs_attention", "nope" as never],
			notifyChannels: ["event", "intercom", "bad" as never],
		});
		assert.equal(custom.needsAttentionAfterMs, 1234);
		assert.equal(custom.activeNoticeAfterMs, 2345);
		assert.equal(custom.activeNoticeAfterTurns, 7);
		assert.equal(custom.activeNoticeAfterTokens, 8000);
		assert.equal(custom.failedToolAttemptsBeforeAttention, 4);
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "intercom"]);
	});

	it("falls back to defaults for invalid non-empty notification arrays", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: ["bogus" as never],
			notifyChannels: ["bogus" as never],
		});
		assert.deepEqual(custom.notifyOn, ["active_long_running", "needs_attention"]);
		assert.deepEqual(custom.notifyChannels, ["event", "async", "intercom"]);
	});

	it("allows empty notification arrays to disable notifications", () => {
		const custom = resolveControlConfig(undefined, {
			notifyOn: [],
			notifyChannels: [],
		});
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker" });
		assert.deepEqual(custom.notifyOn, []);
		assert.deepEqual(custom.notifyChannels, []);
		assert.equal(shouldNotifyControlEvent(custom, event), false);
	});

	it("formats control notices with a proactive hint and concrete commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /Subagent needs attention: worker/);
		assert.match(message, /Hint: Inspect status first unless the run is clearly blocked/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
		assert.match(message, /Status: subagent\(\{ action: "status", id: "78f659a3" \}\)/);
		assert.match(message, /Interrupt: subagent\(\{ action: "interrupt", id: "78f659a3" \}\)/);
		assert.doesNotMatch(message, /Wait:/);
	});

	it("formats active-long-running notices as informational", () => {
		const event = buildControlEvent({
			type: "active_long_running",
			to: "active_long_running",
			runId: "78f659a3",
			agent: "worker",
			turns: 15,
			tokens: 160000,
			toolCount: 42,
			currentTool: "edit",
			currentPath: "src/runs/background/async-status.ts",
			reason: "turn_threshold",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent active but long-running: worker/);
		assert.match(message, /Inspect status/);
		assert.match(message, /15 turns/);
		assert.match(message, /160000 tokens/);
		assert.match(message, /path src\/runs\/background\/async-status\.ts/);
		assert.doesNotMatch(message, /Subagent needs attention/);
	});

	it("formats terminal completion guard notices without live-run commands", () => {
		const event = buildControlEvent({
			to: "needs_attention",
			runId: "78f659a3",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});

		const message = formatControlNoticeMessage(event, "subagent-worker-78f659a3-1");

		assert.match(message, /Subagent failed: worker/);
		assert.match(message, /read the output artifact or session/);
		assert.match(message, /Run intercom target \(may be inactive\): subagent-worker-78f659a3-1/);
		assert.doesNotMatch(message, /Status:/);
		assert.doesNotMatch(message, /Interrupt:/);
		assert.doesNotMatch(message, /What are you blocked on/);
	});

	it("formats intercom notifications with the same control commands", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "78f659a3", agent: "worker" });

		const message = formatControlIntercomMessage(event, "subagent-worker-78f659a3");

		assert.match(message, /worker needs attention in run 78f659a3/);
		assert.match(message, /Nudge: intercom\(\{ action: "send", to: "subagent-worker-78f659a3"/);
	});

	it("dedupes notifications once per child target and attention state", () => {
		const event = buildControlEvent({ to: "needs_attention", runId: "run-1", agent: "worker", index: 0 });
		const seen = new Set<string>();

		assert.equal(controlNotificationKey(event, "subagent-worker-run-1-1"), "subagent-worker-run-1-1:needs_attention:idle");
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), true);
		assert.equal(claimControlNotification(resolveControlConfig(), event, seen, "subagent-worker-run-1-1"), false);

		const terminalEvent = buildControlEvent({
			to: "needs_attention",
			runId: "run-1",
			agent: "worker",
			index: 0,
			message: "worker completed without making edits for an implementation task",
			reason: "completion_guard",
		});
		assert.equal(claimControlNotification(resolveControlConfig(), terminalEvent, seen, "subagent-worker-run-1-1"), true);
	});
});

const ceilingConfig = resolveControlConfig(undefined, {
	needsAttentionAfterMs: 300,
	inFlightSilenceCeilingMs: 1_000,
});

describe("in-flight turn activity state", () => {
	it("defaults inFlightSilenceCeilingMs to 600000 and parses overrides", () => {
		assert.equal(resolveControlConfig(undefined, undefined).inFlightSilenceCeilingMs, 600_000);
		assert.equal(resolveControlConfig(undefined, { inFlightSilenceCeilingMs: 1_000 }).inFlightSilenceCeilingMs, 1_000);
		assert.equal(resolveControlConfig(undefined, { inFlightSilenceCeilingMs: 0 }).inFlightSilenceCeilingMs, 600_000);
	});

	it("downgrades a silent in-flight turn under the ceiling to active_long_running", () => {
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400,
			inFlightTurn: true, lastProductiveSignalAt: 0,
		}), "active_long_running");
	});

	it("escalates a silent in-flight turn past the ceiling to needs_attention", () => {
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 1_200,
			inFlightTurn: true, lastProductiveSignalAt: 0,
		}), "needs_attention");
	});

	it("a recent productive signal during an in-flight turn keeps it calm (active_long_running)", () => {
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400,
			inFlightTurn: true, lastProductiveSignalAt: 350,
		}), "active_long_running");
	});

	it("treats an in-flight turn with no prior productive signal as calm under the ceiling", () => {
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400,
			inFlightTurn: true,
		}), "active_long_running");
	});

	it("flags genuine idle (no turn open) as needs_attention", () => {
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400,
			inFlightTurn: false,
		}), "needs_attention");
	});

	it("is backward compatible when in-flight inputs are omitted", () => {
		assert.equal(deriveActivityState({ config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400 }), "needs_attention");
	});

	it("reduces child events into turn-lifecycle state", () => {
		const opened = applyChildEventToLifecycle({ turnOpen: false }, { type: "message_start" }, 100);
		assert.equal(opened.turnOpen, true);
		assert.equal(opened.lastProductiveSignalAt, undefined);

		const streamed = applyChildEventToLifecycle(opened, { type: "message_update" }, 200);
		assert.equal(streamed.turnOpen, true);
		assert.equal(streamed.lastProductiveSignalAt, 200);

		const intermediate = applyChildEventToLifecycle(streamed, { type: "message_end", hasToolCall: true }, 300);
		assert.equal(intermediate.turnOpen, true, "tool-call message_end must not close the turn");
		assert.equal(intermediate.lastProductiveSignalAt, 300);

		const closed = applyChildEventToLifecycle(intermediate, { type: "message_end", hasToolCall: false }, 400);
		assert.equal(closed.turnOpen, false);

		const turnEnded = applyChildEventToLifecycle({ turnOpen: true }, { type: "turn_end" }, 500);
		assert.equal(turnEnded.turnOpen, false);
		assert.equal(turnEnded.lastProductiveSignalAt, 500);
	});

	it("composes the way the background watchdog does (in-flight step stays calm)", () => {
		const state = applyChildEventToLifecycle({ turnOpen: false, lastProductiveSignalAt: 0 }, { type: "message_start" }, 0);
		assert.equal(deriveActivityState({
			config: ceilingConfig, startedAt: 0, lastActivityAt: 0, now: 400,
			inFlightTurn: state.turnOpen, lastProductiveSignalAt: state.lastProductiveSignalAt,
		}), "active_long_running");
	});
});

describe("resolveControlConfig inFlightSilenceKillMs", () => {
	it("defaults to 1_800_000", () => {
		const cfg = resolveControlConfig();
		assert.equal(cfg.inFlightSilenceKillMs, 1_800_000);
	});

	it("honors a per-call override above the floor", () => {
		const cfg = resolveControlConfig(undefined, { inFlightSilenceKillMs: 2_400_000 });
		assert.equal(cfg.inFlightSilenceKillMs, 2_400_000);
	});

	it("honors global config when no override", () => {
		const cfg = resolveControlConfig({ inFlightSilenceKillMs: 2_000_000 });
		assert.equal(cfg.inFlightSilenceKillMs, 2_000_000);
	});

	it("clamps a value at or below the needs_attention escalation up to the floor", () => {
		// defaults: needsAttentionAfterMs 60_000 + inFlightSilenceCeilingMs 600_000 = 660_000 floor
		const cfg = resolveControlConfig(undefined, { inFlightSilenceKillMs: 100_000 });
		assert.equal(cfg.inFlightSilenceKillMs, 660_000);
	});

	it("computes the floor from the resolved sibling values, not defaults", () => {
		const cfg = resolveControlConfig(undefined, {
			needsAttentionAfterMs: 1_000,
			inFlightSilenceCeilingMs: 2_000,
			inFlightSilenceKillMs: 1_500,
		});
		assert.equal(cfg.inFlightSilenceKillMs, 3_000); // 1_000 + 2_000
	});

	it("rejects a non-positive override and falls back to default before clamping", () => {
		const cfg = resolveControlConfig(undefined, { inFlightSilenceKillMs: 0 });
		assert.equal(cfg.inFlightSilenceKillMs, 1_800_000);
	});
});

describe("shouldSilenceKill", () => {
	const base = { startedAt: 0, now: 10_000, killMs: 5_000 };

	it("never trips when no turn is open", () => {
		assert.equal(shouldSilenceKill({ ...base, turnOpen: false, lastProductiveSignalAt: 0 }), false);
	});

	it("does not trip when silence is at or under the cap", () => {
		assert.equal(shouldSilenceKill({ ...base, turnOpen: true, lastProductiveSignalAt: 5_000 }), false);
	});

	it("trips when silence exceeds the cap", () => {
		assert.equal(shouldSilenceKill({ ...base, turnOpen: true, lastProductiveSignalAt: 4_000 }), true);
	});

	it("falls back to startedAt when lastProductiveSignalAt is missing", () => {
		assert.equal(shouldSilenceKill({ ...base, turnOpen: true }), true); // 10_000 - 0 > 5_000
	});
});

describe("ControlOverrides schema", () => {
	it("declares inFlightSilenceKillMs as an optional integer", () => {
		const controlProps = (SubagentParams.properties.control as { properties: Record<string, unknown> }).properties;
		assert.ok("inFlightSilenceKillMs" in controlProps);
	});
});
