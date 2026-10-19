import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { it } from "node:test";
import { createMockPi } from "../support/mock-pi.ts";

const prose = {
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text: "Finished." }], stopReason: "stop" },
};
const settled = { type: "agent_settled", aborted: false };
const ordering = "Write a fenced JSON block tagged `acceptance-report` in your final text message, then call `structured_output` as your final action. Shape:";

for (const scenario of ["step object", "step null", "step error", "legacy object", "legacy null"] as const) {
	it(`supports ${scenario} without implicit settlement`, async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-pi-capture-"));
		const capture = path.join(dir, "capture.json");
		const mock = createMockPi();
		mock.install();
		const legacy = scenario.startsWith("legacy");
		const value = scenario.endsWith("null") ? null : { status: "DONE" };
		const envelope = scenario === "step error"
			? { status: "error", message: "Expected a boolean" }
			: { status: "success", value };
		const marker = { type: "capture_ready" };
		const stepEvents = scenario === "step object" ? [marker, settled] : [marker];
		mock.onCall(legacy
			? { output: "Finished.", structuredOutput: value, requireAcceptanceStructuredOrder: true }
			: { steps: [
				{ jsonl: [prose] },
				{ delay: 150, ...(scenario === "step error" ? { structuredOutputError: "Expected a boolean" } : { structuredOutput: value }), jsonl: stepEvents },
			] });
		const child = spawn(process.execPath, [mock.runtime.piEntryPath, "--mode", "json", "-p", ...(legacy ? [`## Acceptance Contract\n${ordering}`] : [])], {
			env: { ...process.env, PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE: capture },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5000,
		});
		const closed = once(child, "close");
		let stderr = "";
		child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
		try {
			const entries: unknown[] = [];
			let firstEventAt = 0;
			for await (const line of createInterface({ input: child.stdout })) {
				const entry = JSON.parse(line);
				entries.push(entry);
				if (!legacy && entry.type === "message_end") {
					firstEventAt = Date.now();
					assert.equal(fs.existsSync(capture), false, "capture is absent before the step delay");
				}
				if (entry.type === "capture_ready") {
					assert.ok(Date.now() - firstEventAt >= 100, "step delay precedes capture and events");
					assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), envelope, "capture is written before the first step event");
				}
			}
			assert.deepEqual(await closed, [0, null], stderr);
			assert.equal(mock.callCount(), 1);
			assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), envelope);
			if (process.platform !== "win32") assert.equal(fs.statSync(capture).mode & 0o777, 0o600);
			if (legacy) {
				const [message, ...events] = entries as any[];
				assert.equal(message.type, "message_end");
				assert.ok(message.message.content[0].text.startsWith("Finished.\n```acceptance-report\n"));
				assert.deepEqual(events, [
					{ type: "tool_execution_start", toolName: "structured_output", args: { value } },
					{ type: "tool_result_end", message: { role: "toolResult", toolName: "structured_output", content: [{ type: "text", text: "Structured output captured." }] } },
					{ type: "tool_execution_end", toolName: "structured_output" },
				]);
			} else {
				assert.deepEqual(entries, [prose, ...stepEvents]);
			}
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await closed;
			mock.uninstall();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
}
