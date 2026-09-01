import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const repoRoot = path.join(import.meta.dirname, "..", "..");

function splitFrontmatter(content: string): { frontmatter: string; body: string; bodyLines: string[] } {
	const lines = content.split("\n");
	assert.equal(lines[0], "---", "file must start with frontmatter fence");
	const closeIndex = lines.indexOf("---", 1);
	assert.ok(closeIndex > 0, "frontmatter must have a closing fence");
	const frontmatter = lines.slice(1, closeIndex).join("\n");
	let bodyStart = closeIndex + 1;
	while (bodyStart < lines.length && lines[bodyStart].trim() === "") bodyStart++;
	const bodyLines = lines.slice(bodyStart);
	const body = bodyLines.join("\n");
	return { frontmatter, body, bodyLines };
}

describe("builtin monitor persona", () => {
	const personaPath = path.join(repoRoot, "agents", "monitor.md");
	const personaContent = fs.readFileSync(personaPath, "utf-8");
	const { frontmatter, body, bodyLines } = splitFrontmatter(personaContent);

	it("declares the expected frontmatter", () => {
		assert.match(frontmatter, /^name: monitor$/m);
		assert.match(frontmatter, /^tools: read, bash$/m);
		assert.match(frontmatter, /^completionGuard: false$/m);
		assert.match(frontmatter, /not for doing the work/i);
	});

	it("opens the body with the role fence", () => {
		assert.match(bodyLines[0], /You observe a job someone else runs\. Never execute, restart, or modify it\./);
	});

	it("encodes the required invariants", () => {
		assert.match(body, /15 minutes/);
		assert.match(body, /chunks of <= 5 minutes/);
		assert.match(body, /\$PI_SUBAGENT_RUN_DIR\/trail\.md/);
		assert.match(body, /mktemp -d/);
		assert.match(body, /never write under the workspace/i);
		assert.match(body, /delta/i);
		assert.match(body, /no growth in the watched log/);
		assert.match(body, /status\.json lastUpdate/);
		assert.match(body, /no output for/);
		assert.match(body, /need_decision/);
		assert.match(body, /24h/);
		assert.match(body, /first check immediately/i);
		assert.match(body, /cannot observe target: <reason>/);
		assert.match(body, /never guess, never loop/i);
	});

	it("orders the Loop block before the Cadence line", () => {
		const loopIndex = body.indexOf("Loop:");
		const cadenceIndex = body.indexOf("Cadence:");
		assert.ok(loopIndex >= 0, "body must contain a Loop: section");
		assert.ok(cadenceIndex >= 0, "body must contain a Cadence: line");
		assert.ok(loopIndex < cadenceIndex, "Loop: must precede Cadence:");
	});

	it("only permits the banned phrasing inside the prohibition sentence", () => {
		assert.doesNotMatch(body, /still working\b(?![^.]*without evidence)/i);
	});

	it("stays within the persona length budget", () => {
		assert.ok(personaContent.split("\n").length <= 40);
	});
});

describe("SKILL.md long-running job pairing guidance", () => {
	const skillPath = path.join(repoRoot, "skills", "pi-cohort", "SKILL.md");
	const skill = fs.readFileSync(skillPath, "utf-8");

	it("documents the monitor pairing rules", () => {
		assert.match(skill, /emit observable progress/);
		assert.match(skill, /A silent long job is a defect/);
		assert.match(skill, /agent: "monitor", async: true/);
		assert.match(skill, /Async dir:/);
		assert.match(skill, /pi-intercom bridge/);
	});

	it("ties the pairing example's monitor task to the start message's async dir placeholder", () => {
		assert.match(skill, /Async dir: <D>/);
		assert.match(skill, /Watch async run R at <D>\./);
	});
});
