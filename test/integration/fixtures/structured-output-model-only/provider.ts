import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

function streamScripted(model, context) {
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
	setTimeout(() => {
		try {
			stream.push({ type: "start", partial: output });
			const result = context.messages.find((message) => message.role === "toolResult" && message.toolName === "codemode");
			const text = result?.content.map((part) => part.text ?? "").join("\n") ?? "";
			const value = { ok: true, note: "direct capture" };
			if (!result || text.includes("does not exist")) {
				const toolCall = !result
					? { type: "toolCall", id: "fixture-script", name: "codemode", arguments: { code: `return await tools.structured_output({ value: ${JSON.stringify(value)} })` } }
					: { type: "toolCall", id: "fixture-direct", name: "structured_output", arguments: { value } };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				output.stopReason = "toolUse";
			} else {
				const diagnostic = `FIXTURE_UNEXPECTED: ${text}`;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0].text = diagnostic;
				stream.push({ type: "text_delta", contentIndex: 0, delta: diagnostic, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: diagnostic, partial: output });
				output.stopReason = "stop";
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} finally {
			stream.end();
		}
	}, 0);
	return stream;
}

export default function registerFixtureProvider(pi) {
	// The persona's extension allowlist also disables CLI built-in extensions.
	createCodemodeExtension()(pi);
	pi.registerProvider("structured-output-fixture", {
		api: "structured-output-fixture-scripted",
		baseUrl: "http://127.0.0.1:9/structured-output-fixture-never-contacted",
		apiKey: "fixture-no-credential",
		models: [{
			id: "scripted",
			name: "Structured output fixture (scripted)",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}],
		streamSimple: streamScripted,
	});
}
