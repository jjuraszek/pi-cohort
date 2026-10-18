/**
 * Credential-free provider for test/integration/runtime-sdk-host.test.ts.
 * Answers every turn with one fixed text and records which Pi entry the
 * child process actually runs, so the test can compare it with the
 * installation the host loaded.
 */
import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER = "sdk-host-fixture";
const MODEL = "scripted";
export const REPLY = "SDK_HOST_DONE";

function streamScripted(model) {
	const stream = createAssistantMessageEventStream();
	const output = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
	if (process.env.SDK_HOST_LOG) {
		fs.appendFileSync(process.env.SDK_HOST_LOG, `${JSON.stringify({ argv1: fs.realpathSync.native(process.argv[1]), execPath: fs.realpathSync.native(process.execPath) })}\n`);
	}
	setTimeout(() => {
		try {
			stream.push({ type: "start", partial: output });
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			output.content[0].text = REPLY;
			stream.push({ type: "text_delta", contentIndex: 0, delta: REPLY, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: REPLY, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		} finally {
			stream.end();
		}
	}, 0);
	return stream;
}

export default function registerFixtureProvider(pi) {
	pi.registerProvider(PROVIDER, {
		api: "sdk-host-fixture-scripted",
		baseUrl: "http://127.0.0.1:9/sdk-host-fixture-never-contacted",
		apiKey: "fixture-no-credential",
		models: [{ id: MODEL, name: "SDK host fixture (scripted)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_192 }],
		streamSimple: streamScripted,
	});
}
