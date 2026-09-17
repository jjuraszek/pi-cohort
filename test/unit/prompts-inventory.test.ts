import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const promptsDir = path.join(projectRoot, "prompts");
const workflowVerbs = /\b(produces|runs|dispatches)\b/;

function frontmatterDescription(file: string): string {
	const source = fs.readFileSync(path.join(promptsDir, file), "utf-8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, `${file}: missing frontmatter`);
	const line = match[1].split("\n").find((l) => l.startsWith("description:"));
	assert.ok(line, `${file}: missing description`);
	return line.slice("description:".length).trim().replace(/^"(.*)"$/, "$1");
}

test("packaged prompts are exactly handoff and investigate", () => {
	// readdirSync("prompts") relative to the project root
	assert.deepEqual(fs.readdirSync(promptsDir).sort(), ["handoff.md", "investigate.md"]);
});

test("prompt descriptions are triggers, not workflow summaries", () => {
	for (const file of fs.readdirSync(promptsDir)) {
		const description = frontmatterDescription(file);
		assert.ok(description.startsWith("Use when"), `${file}: description must start with "Use when"`);
		assert.ok(description.length < 500, `${file}: description over 500 chars`);
		assert.ok(!workflowVerbs.test(description), `${file}: description summarizes workflow`);
	}
});

test("prompts take the argument and handoff names every template section", () => {
	for (const file of fs.readdirSync(promptsDir)) {
		const source = fs.readFileSync(path.join(promptsDir, file), "utf-8");
		assert.ok(source.includes("$@"), `${file}: missing $@ argument placeholder`);
	}
	const template = fs.readFileSync(path.join(projectRoot, "doc", "handoff-template.md"), "utf-8");
	const templateBlock = template.match(/```markdown\n([\s\S]*?)```/)?.[1] ?? "";
	const sections = templateBlock.match(/^## .+$/gm) ?? [];
	assert.ok(sections.length >= 6, "template block must list the brief sections");
	const handoff = fs.readFileSync(path.join(promptsDir, "handoff.md"), "utf-8");
	for (const section of sections) {
		assert.ok(handoff.includes(section), `handoff.md: missing section ${section}`);
	}
});
