/**
 * Deterministic local model provider for the fanout-child-own-subagent-history
 * regression (test/integration/fanout-child-own-subagent-history.test.ts).
 *
 * Passed explicitly through each fixture agent's `extensions` allowlist from
 * a disposable pi home: no credentials, no network. Registers provider
 * `fanout-fixture` with one model, `scripted`, served entirely from streamSimple.
 *
 * Decision rule, identical for every agent in the chain (parent, lead,
 * grandchild): if this session has the `subagent` tool AND has not yet seen a
 * `subagent` toolResult in its own context, dispatch one more level down (the
 * next agent name is carried in a `NEXT_AGENT=<name>` marker found anywhere in
 * the message text, which propagates naturally through pi-cohort's task
 * forwarding). Otherwise, finish with a fixed text reply. A session without
 * the `subagent` tool (the grandchild) always finishes immediately.
 *
 * This turns "did the lead's own delegation history survive?" into an
 * observable count: every call is logged to $FANOUT_FIXTURE_LOG. A lead that
 * loses its own subagent toolResult before its next turn will decide to
 * dispatch again instead of finishing, showing up as more than one dispatch
 * decision at the same depth in the log.
 */

import fs from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PROVIDER = "fanout-fixture";
const MODEL = "scripted";
const API = "fanout-fixture-scripted";
const NEXT_AGENT_RE = /NEXT_AGENT=([a-zA-Z0-9_-]+)/;

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
}

function findNextAgent(context) {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		const match = NEXT_AGENT_RE.exec(textOf(message));
		if (match) return match[1];
	}
	return null;
}

function hasSubagentResult(context) {
	return context.messages.some((m) => m.role === "toolResult" && m.toolName === "subagent");
}

function record(row) {
	const file = process.env.FANOUT_FIXTURE_LOG;
	if (!file) return;
	fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

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
	const toolCall = { type: "toolCall", id: `fx-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`, name: "subagent", arguments: args };
	const index = output.content.length;
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

function streamScripted(model, context) {
	const stream = createAssistantMessageEventStream();
	const output = newAssistantMessage(model);
	const hasSubagentTool = (context.tools ?? []).some((tool) => tool.name === "subagent");
	const alreadyDispatched = hasSubagentResult(context);
	const depth = process.env.PI_SUBAGENT_DEPTH ?? "0";
	const decision = !hasSubagentTool ? "finish-no-tool" : alreadyDispatched ? "finish-after-dispatch" : "dispatch";
	record({ ts: Date.now(), depth, decision, msgs: context.messages.length });

	setTimeout(() => {
		try {
			stream.push({ type: "start", partial: output });
			if (decision === "dispatch") {
				const nextAgent = findNextAgent(context);
				pushToolCall(stream, output, "subagent", { agent: nextAgent, task: "Return the fixture response." });
				output.stopReason = "toolUse";
				stream.push({ type: "done", reason: "toolUse", message: output });
			} else {
				pushText(stream, output, `FIXTURE_DONE depth=${depth}`);
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
			}
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
