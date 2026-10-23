import { Type } from "@sinclair/typebox";

export default function registerPingFixture(pi) {
	pi.registerTool({
		name: "ping_fixture",
		label: "Ping fixture",
		description: "Return pong from the inherited fixture",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "pong" }], details: {} };
		},
	});
}
