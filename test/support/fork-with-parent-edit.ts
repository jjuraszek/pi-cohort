import assert from "node:assert/strict";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createForkContextResolver } from "../../src/shared/fork-context.ts";

export const editCall = { type: "toolCall" as const, id: "edit-1", name: "edit", arguments: { path: "file.txt", oldText: "old", newText: "new" } };

export function forkWithParentEdit(directory: string, withCompaction = false) {
	const parent = SessionManager.create(directory, path.join(directory, "parent"));
	const user = parent.appendMessage({ role: "user", content: "Edit file.txt", timestamp: 1 });
	if (withCompaction) parent.appendCompaction("parent summary", user, 50, {}, false, {
		input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
	});
	const leafId = parent.appendMessage({
		role: "assistant", model: "parent-model", api: "openai-responses", provider: "openai", timestamp: 2,
		content: [editCall], stopReason: "toolUse",
		usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } },
	});
	const resolver = createForkContextResolver(parent, "fork", { sessionDirForIndex: () => path.join(directory, "child") });
	const sessionFile = resolver.sessionFileForIndex(0, directory);
	assert.ok(sessionFile);
	assert.deepEqual(SessionManager.open(sessionFile).getBranch(), parent.getBranch());
	return { sessionFile, leafId };
}
