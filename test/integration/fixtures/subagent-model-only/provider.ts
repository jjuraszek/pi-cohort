import fs from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-coding-agent";

const PROVIDER = "subagent-model-only-fixture";

function textOf(message) {
	return message.content.map((part) => part.text ?? "").join("\n");
}

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
	const depth = process.env.PI_SUBAGENT_DEPTH;
	const declaredSubagent = getCurrentTools(context.messages).some((tool) => tool.name === "subagent");
	const results = context.messages.filter((message) => message.role === "toolResult");
	let decision = "unexpected";
	if (depth === "2") decision = "leaf";
	else if (depth === "1" && declaredSubagent) {
		if (results.length === 0) decision = "script";
		else if (results.length === 1 && results[0].toolName === "codemode"
			&& results[0].isError && textOf(results[0]).includes("tools.subagent does not exist")) decision = "direct";
		else if (results.length === 2 && results[1].toolName === "subagent" && !results[1].isError) decision = "finish";
	}
	fs.appendFileSync(process.env.SUBAGENT_FIXTURE_LOG, `${JSON.stringify({ depth, decision, declaredSubagent })}\n`);

	setTimeout(() => {
		try {
			stream.push({ type: "start", partial: output });
			if (decision === "script" || decision === "direct") {
				const name = decision === "script" ? "codemode" : "subagent";
				const args = decision === "script"
					? { code: 'await tools.subagent({ agent: "leaf", task: "Return LEAF_DONE." })' }
					: { agent: "leaf", task: "leaf: Return LEAF_DONE." };
				const toolCall = { type: "toolCall", id: `fixture-${name}`, name, arguments: args };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
				output.stopReason = "toolUse";
			} else {
				const text = decision === "leaf" ? "LEAF_DONE" : decision === "finish" ? "FIXTURE_DONE"
					: `FIXTURE_UNEXPECTED: depth=${depth} declaredSubagent=${declaredSubagent} results=${JSON.stringify(results)}`;
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0].text = text;
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
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
	const mode = process.env.SUBAGENT_FIXTURE_CODEMODE_MODE;
	if (mode !== "on" && mode !== "only") throw new Error("Expected fixture codemode mode on or only");
	createCodemodeExtension({ mode })(pi);
	pi.registerProvider(PROVIDER, {
		api: "subagent-model-only-scripted",
		baseUrl: "http://127.0.0.1:9/subagent-fixture-never-contacted",
		apiKey: "fixture-no-credential",
		models: [{
			id: "scripted",
			name: "Subagent model-only fixture",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		}],
		streamSimple: streamScripted,
	});
}
