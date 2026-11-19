import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skillPath = path.join(projectRoot, "skills", "handoff", "SKILL.md");
const investigatePath = path.join(projectRoot, "skills", "investigate", "SKILL.md");
const reportPath = path.join(path.dirname(investigatePath), "reference", "report.md");
const templatePath = path.join(projectRoot, "doc", "handoff-template.md");
const workflowVerbs = /\b(produces|runs|dispatches)\b/;
const briefHeadings = ["## Intent", "## Repo state", "## Decisions", "## Open questions", "## Skills loaded"];

function frontmatter(filePath: string, source = fs.readFileSync(filePath, "utf-8")): Record<string, string> {
	const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
	return [...source.matchAll(/```markdown\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function headings(block: string): string[] {
	return block.replace(/\r\n/g, "\n").match(/^## .+$/gm) ?? [];
}

test("package ships no prompt templates", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8"));
	assert.ok(!fs.existsSync(path.join(projectRoot, "prompts")), "prompts/ still exists");
	assert.ok(!Object.hasOwn(manifest.pi, "prompts"), "pi.prompts still registers templates");
	assert.ok(!manifest.files.includes("prompts/**/*"), "files still includes prompts/**/*");
});

test("investigate skill has trigger frontmatter and stays model-invocable", () => {
	const fields = frontmatter(investigatePath);
	assert.equal(fields.name, "investigate");
	assertTriggerDescription(investigatePath, fields.description);
	assert.ok(!Object.hasOwn(fields, "disable-model-invocation"));
});

test("investigate skill keeps every investigation file in one temp folder", () => {
	const skill = fs.readFileSync(investigatePath, "utf-8");
	for (const token of ["mktemp -d", "$DIR/brief.md", "artifacts: false", "sessionDir"]) {
		assert.ok(skill.includes(token), `investigate: missing ${token}`);
	}
	for (const token of ["--out", "$@"]) assert.ok(!skill.includes(token), `investigate: unexpected ${token}`);
});

test("investigate skill carries the dispatch rules", () => {
	const skill = fs.readFileSync(investigatePath, "utf-8");
	for (const token of ['async: false', 'context: "fresh"', 'reads: false', 'forceTopLevelAsync', 'failed:']) {
		assert.ok(skill.includes(token), `investigate: missing ${token}`);
	}
});

test("investigate brief template headings are fixed", () => {
	const fences = markdownFences(fs.readFileSync(investigatePath, "utf-8"));
	assert.equal(fences.length, 1);
	assert.deepEqual(headings(fences[0]), [
		"## Request", "## Findings", "## External context", "## Premise check", "## Design fit",
		"## Open questions", "## Verification tasks", "## Next steps",
	]);
});

test("investigate reviewer task asks for the design-fit verdict", () => {
	const skill = fs.readFileSync(investigatePath, "utf-8");
	const procedure = skill.replace(/```markdown\r?\n[\s\S]*?```/g, "");
	const task = procedure.match(/^\| `reviewer` \|.*$/m)?.[0];
	assert.ok(task, "missing reviewer task");
	for (const token of ["Design fit:", "- clash:", "(<path>:<line>)", "no conflict found - checked <what was read>"]) {
		assert.ok(task.includes(token), `reviewer task: missing ${token}`);
	}
	assert.ok(procedure.includes("not assessed -"), "missing fallback outside the brief template");
});

test("investigate report reference defines the sections, the cap, and the closing line", () => {
	const report = fs.readFileSync(reportPath, "utf-8");
	const sections = [...report.matchAll(/^\| `(## [^`]+)` \| ([^|]+?) \|/gm)];
	assert.deepEqual(sections.map(([, title]) => title), [
		"## What I found", "## Where it clashes with the current design",
		"## What it means for your request", "## What you need to decide",
	]);
	assert.deepEqual(sections.map(([, , when]) => when === "Always"), [true, false, true, true]);
	assert.match(sections[1][2], /only when.*`## Design fit`.*`- clash:`/i);
	assert.match(report, /at most 180 words/i);
	assert.match(report, /Full investigation: /);
});

test("investigate skill links its report reference", () => {
	const skill = fs.readFileSync(investigatePath, "utf-8");
	assert.match(skill, /\]\(reference\/report\.md\)/);
	assert.ok(fs.statSync(reportPath).isFile());
});

test("investigate skill files stay under the extraction limit", () => {
	for (const file of [investigatePath, reportPath]) {
		const source = fs.readFileSync(file, "utf-8");
		assert.ok(source.trimEnd().split("\n").length < 500, `${file}: exceeds line limit`);
		assert.ok(Buffer.byteLength(source) < 50 * 1024, `${file}: exceeds byte limit`);
	}
});

test("investigate skill files name no consumer", () => {
	for (const file of [investigatePath, reportPath]) {
		const source = fs.readFileSync(file, "utf-8");
		for (const token of ["/skill:", "gauntlet"]) assert.ok(!source.includes(token), `${file}: unexpected ${token}`);
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

test("markdown helpers accept LF and CRLF", () => {
	for (const newline of ["\n", "\r\n"]) {
		assert.deepEqual(frontmatter("synthetic", ["---", "name: handoff", "---"].join(newline)), { name: "handoff" });
		const block = markdownFences(["```markdown", "## Intent", "```"].join(newline));
		assert.equal(block.length, 1);
		assert.deepEqual(headings(block[0]), ["## Intent"]);
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
