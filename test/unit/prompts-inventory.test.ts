import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const promptsDir = path.join(projectRoot, "prompts");
const skillPath = path.join(projectRoot, "skills", "handoff", "SKILL.md");
const templatePath = path.join(projectRoot, "doc", "handoff-template.md");
const workflowVerbs = /\b(produces|runs|dispatches)\b/;
const briefHeadings = ["## Intent", "## Repo state", "## Decisions", "## Open questions", "## Skills loaded"];

function frontmatter(filePath: string): Record<string, string> {
	const source = fs.readFileSync(filePath, "utf-8");
	const match = source.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, `${filePath}: missing frontmatter`);
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) {
			fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^"(.*)"$/, "$1");
		}
	}
	return fields;
}

function assertTriggerDescription(label: string, description: string | undefined): void {
	assert.ok(description, `${label}: missing description`);
	assert.ok(description.startsWith("Use when"), `${label}: description must start with "Use when"`);
	assert.ok(description.length < 500, `${label}: description over 500 chars`);
	assert.ok(!workflowVerbs.test(description), `${label}: description summarizes workflow`);
}

function markdownFences(source: string): string[] {
	return [...source.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function headings(block: string): string[] {
	return block.match(/^## .+$/gm) ?? [];
}

test("packaged prompts are exactly investigate", () => {
	assert.deepEqual(fs.readdirSync(promptsDir).sort(), ["investigate.md"]);
});

test("prompt descriptions are triggers and prompts take the argument", () => {
	for (const file of fs.readdirSync(promptsDir)) {
		const filePath = path.join(promptsDir, file);
		assertTriggerDescription(file, frontmatter(filePath).description);
		assert.ok(fs.readFileSync(filePath, "utf-8").includes("$@"), `${file}: missing $@ argument placeholder`);
	}
});

test("handoff skill has trigger frontmatter named handoff", () => {
	const fields = frontmatter(skillPath);
	assert.equal(fields.name, "handoff");
	assertTriggerDescription("skills/handoff/SKILL.md", fields.description);
});

test("handoff skill carries the producer contract and no flow-specific rules", () => {
	const skill = fs.readFileSync(skillPath, "utf-8");
	for (const token of [
		"Handoff written:",
		"Handoff not written:",
		"pi-handoff",
		"os').tmpdir()",
		"mkdtempSync",
		"--out",
		"--key",
		"[^A-Za-z0-9._-]",
		"given twice",
		"has no value",
		"means the option has no value",
		"reserved for the default key",
		"not a valid file name stem",
	]) {
		assert.ok(skill.includes(token), `SKILL.md: missing token ${token}`);
	}
	for (const token of ["$@", "phase_tracker", "plan_tracker", "hotfix", "using-git-worktrees", "mktemp", "Process state"]) {
		assert.ok(!skill.includes(token), `SKILL.md: forbidden token ${token}`);
	}
});

test("handoff skill brief matches the template contract", () => {
	const skillFences = markdownFences(fs.readFileSync(skillPath, "utf-8"));
	assert.equal(skillFences.length, 1, "SKILL.md must have exactly one ```markdown fence (the brief)");
	const templateFences = markdownFences(fs.readFileSync(templatePath, "utf-8"));
	assert.ok(templateFences.length >= 1, "handoff-template.md must open with a ```markdown fence");
	assert.deepEqual(headings(templateFences[0]), briefHeadings);
	assert.deepEqual(headings(skillFences[0]), briefHeadings);
});

test("handoff template is flow-agnostic and names the seam", () => {
	const template = fs.readFileSync(templatePath, "utf-8");
	for (const token of ["phase_tracker", "plan_tracker", "hotfix", "using-git-worktrees", "Process state"]) {
		assert.ok(!template.includes(token), `handoff-template.md: forbidden token ${token}`);
	}
	for (const token of [
		"describes that worktree",
		"open-question",
		"Handoff written:",
		"pi-handoff",
		"--key",
		"[^A-Za-z0-9._-]",
		"not a valid file name stem",
		"means the option has no value",
	]) {
		assert.ok(template.includes(token), `handoff-template.md: missing token ${token}`);
	}
});

test("handoff skill carries the run-worktree contract", () => {
	const skill = fs.readFileSync(skillPath, "utf-8");
	for (const token of [
		"Run worktree:",
		"git worktree list --porcelain",
		"git -C <candidate> rev-parse --show-toplevel",
		"git -C <target>",
		"open-question:",
		"flow-level",
		"Worktree ready at",
	]) {
		assert.ok(skill.includes(token), `SKILL.md: missing token ${token}`);
	}
});
