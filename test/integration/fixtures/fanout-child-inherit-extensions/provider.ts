import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const PROVIDER = "fanout-fixture";
const MODEL = "scripted";
const API = "fanout-fixture-scripted";

function newAssistantMessage(model) {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function pushText(stream, output, text) {
	const index = output.content.length;
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex: index, partial: output });
	output.content[index].text = text;
	stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
	stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
}

function pushToolCall(stream, output, name, args) {
	const toolCall = { type: "toolCall", id: `fx-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, name, arguments: args };
	const index = output.content.length;
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function textOf(message) {
	if (!message) return "none";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => part.text ?? "").join("\n");
}

function streamScripted(model, context) {
	const stream = createAssistantMessageEventStream();
	const output = newAssistantMessage(model);
	const names = getCurrentTools(context.messages).map((tool) => tool.name);
	const result = (name) => context.messages.find((message) => message.role === "toolResult" && message.toolName === name);
	const ping = result("ping_fixture");
	const worker = result("subagent");
	setTimeout(() => {
		try {
			stream.push({ type: "start", partial: output });
			let call;
			if (process.env.PI_SUBAGENT_CHILD_AGENT === "worker") {
				pushText(stream, output, "WORKER_TOKEN");
			} else if (names.includes("ping_fixture") && !ping) {
				call = ["ping_fixture", {}];
			} else if (names.includes("subagent") && !worker) {
				call = ["subagent", { agent: "worker", task: "Return WORKER_TOKEN." }];
			} else {
				const reply = textOf(worker);
				pushText(stream, output, `FIXTURE_DONE ping=${textOf(ping)} worker=${reply.includes("WORKER_TOKEN") ? "WORKER_TOKEN" : reply} tools=${names.join(",")}`);
			}
			if (call) pushToolCall(stream, output, ...call);
			output.stopReason = call ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} finally {
			stream.end();
		}
	}, 0);
	return stream;
}

export default function registerFixtureProvider(pi) {
	pi.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "http://127.0.0.1:9/fanout-fixture-never-contacted",
		apiKey: "fixture-no-credential",
		models: [
			{
				id: MODEL,
				name: "Fanout fixture (scripted)",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 8_192,
			},
		],
		streamSimple: streamScripted,
	});
}
