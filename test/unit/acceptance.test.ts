import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	acceptanceFailureMessage,
	aggregateAcceptanceReport,
	evaluateAcceptance,
	formatAcceptancePrompt,
	parseAcceptanceReport,
	resolveEffectiveAcceptance,
	validateAcceptanceInput,
} from "../../src/runs/shared/acceptance.ts";

function report(overrides: Record<string, unknown> = {}): string {
	return [
		"done",
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "verified in test" }],
			changedFiles: ["src/file.ts"],
			testsAddedOrUpdated: ["test/file.test.ts"],
			commandsRun: [{ command: "npm test", result: "passed", summary: "passed" }],
			validationOutput: ["tests passed"],
			residualRisks: [],
			noStagedFiles: true,
			notes: "complete",
			...overrides,
		}),
		"```",
	].join("\n");
}

function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-acceptance-"));
	fs.writeFileSync(path.join(dir, "file.txt"), "hello\n", "utf-8");
	return dir;
}

describe("acceptance gates", () => {
	it("infers different policies for reviewer, writer, async writer, and dynamic contexts", () => {
		assert.equal(resolveEffectiveAcceptance({ agentName: "reviewer", task: "Review-only. Do not edit.", mode: "single" }).level, "attested");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single" }).level, "checked");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Implement the fix", mode: "single", async: true }).level, "reviewed");
		assert.equal(resolveEffectiveAcceptance({ agentName: "worker", task: "Fix each item", mode: "chain", dynamic: true }).level, "reviewed");
	});

	it("explicit acceptance can strengthen inferred policy", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review-only.",
			explicit: { level: "verified", verify: [{ id: "ok", command: "node --version" }] },
		});

		assert.equal(resolved.level, "verified");
		assert.equal(resolved.verify[0]?.id, "ok");
	});

	it("an explicit level below the inferred level is the level that runs", async () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "delegate",
			task: "read-only startup smoke update",
			async: true,
			explicit: "attested",
		});
		assert.equal(acceptance.level, "attested");
		assert.equal(acceptance.explicit, true);
		assert.deepEqual(acceptance.inferredReason, ["async write-capable or risky run"]);
		assert.equal(acceptance.review, undefined);
		assert.deepEqual(acceptance.evidence, ["manual-notes", "residual-risks"]);
		assert.doesNotMatch(formatAcceptancePrompt(acceptance), /Review gate/);
		const ledger = await evaluateAcceptance({ acceptance, output: report({ validationOutput: undefined }), cwd: process.cwd() });
		assert.equal(ledger.status, "attested");
		assert.equal(acceptanceFailureMessage(ledger), undefined);
	});

	it("keeps explicit levels and infers only auto or unset levels", () => {
		for (const explicit of [undefined, "auto", {}, { level: "auto" }] as const) {
			const acceptance = resolveEffectiveAcceptance({ agentName: "delegate", task: "read-only startup smoke update", async: true, explicit });
			assert.equal(acceptance.level, "reviewed");
			assert.equal(acceptance.explicit, explicit !== undefined);
			assert.deepEqual(acceptance.review, { agent: "reviewer", required: true });
		}
		for (const level of ["none", "attested", "checked", "verified", "reviewed"] as const) {
			for (const explicit of [level, { level }] as const) {
				const acceptance = resolveEffectiveAcceptance({ agentName: "reviewer", task: "security review of the diff", explicit });
				assert.equal(acceptance.level, level);
				assert.deepEqual(acceptance.review, level === "reviewed" ? { agent: "reviewer", required: true } : undefined);
			}
		}
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker", dynamic: true,
			explicit: { level: "attested", review: { agent: "custom", required: false }, evidence: ["diff-summary"], criteria: ["custom criterion"], stopRules: ["stop on red"] },
		});
		assert.deepEqual(acceptance.review, { agent: "custom", required: false });
		assert.deepEqual(acceptance.evidence, ["manual-notes", "residual-risks", "diff-summary"]);
		assert.deepEqual(acceptance.criteria.map(criterion => criterion.must), ["custom criterion"]);
		assert.deepEqual(acceptance.stopRules, ["stop on red"]);
	});

	it("explicit verified below inferred reviewed rejects missing runtime verify commands", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({ agentName: "delegate", task: "read-only startup smoke update", async: true, explicit: "verified" });
			assert.equal(acceptance.level, "verified");
			const ledger = await evaluateAcceptance({ acceptance, cwd, output: report({ criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
				{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
			] }) });
			assert.equal(ledger.status, "rejected");
			assert.equal(acceptanceFailureMessage(ledger), "Acceptance rejected: verified acceptance requires runtime verify commands.");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("formats a standardized child prompt section", () => {
		const resolved = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "checked", criteria: ["Patch the bug"], stopRules: ["Do not stop after analysis"] },
		});
		const prompt = formatAcceptancePrompt(resolved);

		assert.match(prompt, /## Acceptance Contract/);
		assert.match(prompt, /Acceptance level: checked/);
		assert.match(prompt, /Patch the bug/);
		assert.match(prompt, /```acceptance-report/);
	});

	it("preserves the prompt unless structured output requires report-first ordering", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "reviewer",
			task: "Review-only.",
			explicit: { level: "attested", criteria: ["Review the change"] },
		});
		const expected = `
## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Review the change

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged \`acceptance-report\` in this shape:
\`\`\`acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [],
  "residualRisks": [],
  "noStagedFiles": true,
  "notes": "anything else the parent should know"
}
\`\`\``;

		assert.equal(formatAcceptancePrompt(acceptance), expected);
		assert.equal(formatAcceptancePrompt(acceptance, { structuredOutput: false }), expected);
		const structuredPrompt = formatAcceptancePrompt(acceptance, { structuredOutput: true });
		assert.equal(structuredPrompt, expected.replace(
			"Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
			"Write a fenced JSON block tagged `acceptance-report` in your final text message, then call `structured_output` as your final action. Shape:",
		));
		assert.doesNotMatch(structuredPrompt, /Finish with a fenced JSON block/);
	});

	it("parses only explicit acceptance-report fences", () => {
		const parsed = parseAcceptanceReport(report());

		assert.ok(parsed.report);
		assert.deepEqual(parsed.report.changedFiles, ["src/file.ts"]);
		assert.equal(parsed.error, undefined);

		const genericJson = parseAcceptanceReport(`done\n\
\
\`\`\`json\n{\"notes\":\"not an acceptance report\"}\n\`\`\``);
		assert.equal(genericJson.report, undefined);
		assert.match(genericJson.error ?? "", /Structured acceptance report not found/);

		const malformed = parseAcceptanceReport("```acceptance-report\n{bad-json\n```");
		assert.equal(malformed.report, undefined);
		assert.match(malformed.error ?? "", /Failed to parse acceptance-report/);
	});

	it("explicit none disables inferred gates when a reason is present", () => {
		const acceptance = resolveEffectiveAcceptance({
			agentName: "worker",
			task: "Implement a fix",
			explicit: { level: "none", reason: "parent is doing manual acceptance" },
		});

		assert.equal(acceptance.level, "none");
		assert.deepEqual(acceptance.evidence, []);
		assert.equal(formatAcceptancePrompt(acceptance), "");
		assert.equal(formatAcceptancePrompt(acceptance, { structuredOutput: false }), "");
		assert.equal(formatAcceptancePrompt(acceptance, { structuredOutput: true }), "");
	});

	it("deprecated false validates and resolves to none", () => {
		assert.deepEqual(validateAcceptanceInput(false), []);
		const acceptance = resolveEffectiveAcceptance({
			explicit: false,
			agentName: "delegate",
			task: "read-only startup smoke update",
			async: true,
		});
		assert.equal(acceptance.level, "none");
		assert.equal(acceptance.reason, "disabled by deprecated false shorthand");
		assert.equal(acceptance.review, undefined);
	});

	it("checked mode rejects missing required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ testsAddedOrUpdated: undefined }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /tests-added evidence missing/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a rejected gate reports only the failed check at an explicit or inferred level", async () => {
		const cwd = tempRepo();
		try {
			for (const explicit of [{ level: "checked" }, undefined] as const) {
				const acceptance = resolveEffectiveAcceptance({ agentName: "delegate", task: "read-only startup smoke update", async: true, explicit });
				const ledger = await evaluateAcceptance({ acceptance, cwd, output: report({
					criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
						{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
					],
					testsAddedOrUpdated: undefined,
				}) });
				assert.equal(ledger.status, "rejected");
				assert.equal(acceptanceFailureMessage(ledger), "Acceptance rejected: tests-added evidence missing from child report.");
			}
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("accepts empty evidence lists as reported for a no-op inferred-reviewed run", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Diagnose the flaky run",
				mode: "single",
				async: true,
			});
			assert.equal(acceptance.level, "reviewed");
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({
					criteriaSatisfied: [
						{ id: "criterion-1", status: "satisfied", evidence: "verified in test" },
						{ id: "criterion-2", status: "satisfied", evidence: "verified in test" },
					],
					changedFiles: [],
					testsAddedOrUpdated: [],
					commandsRun: [],
					validationOutput: [],
				}),
				cwd,
			});

			assert.equal(ledger.status, "checked");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.ok(ledger.runtimeChecks.every((check) => check.status !== "failed"));
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still rejects absent evidence fields per kind", async () => {
		const cases = [
			{ overrides: { changedFiles: undefined }, message: /changed-files evidence missing/ },
			{ overrides: { testsAddedOrUpdated: undefined }, message: /tests-added evidence missing/ },
			{ overrides: { commandsRun: undefined }, message: /commands-run evidence missing/ },
			{ overrides: { validationOutput: undefined }, message: /validation-output evidence missing/ },
		];
		for (const { overrides, message } of cases) {
			const cwd = tempRepo();
			try {
				const acceptance = resolveEffectiveAcceptance({
					agentName: "worker",
					task: "Diagnose the flaky run",
					mode: "single",
					async: true,
				});
				const ledger = await evaluateAcceptance({
					acceptance,
					output: report({
						criteriaSatisfied: [
							{ id: "criterion-1", status: "satisfied", evidence: "verified in test" },
							{ id: "criterion-2", status: "satisfied", evidence: "verified in test" },
						],
						...overrides,
					}),
					cwd,
				});

				assert.equal(ledger.status, "rejected");
				assert.match(acceptanceFailureMessage(ledger) ?? "", message);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		}
	});

	it("accepts a non-empty object-array commandsRun as reported evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });

			assert.equal(ledger.status, "checked");
			assert.equal(ledger.runtimeChecks.find((check) => check.id === "evidence:commands-run")?.status, "passed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rejects empty changedFiles when staged files exist in the working tree", async () => {
		const cwd = tempRepo();
		try {
			assert.equal(spawnSync("git", ["init"], { cwd }).status, 0);
			assert.equal(spawnSync("git", ["add", "file.txt"], { cwd }).status, 0);
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ changedFiles: [], testsAddedOrUpdated: [], commandsRun: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Staged files present/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("checked mode rejects not-satisfied required criteria", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "checked", criteria: [{ id: "regression", must: "Regression is covered" }] },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: report({ criteriaSatisfied: [{ id: "regression", status: "not-satisfied", evidence: "test missing" }] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /Required criterion 'regression' was reported as not-satisfied/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("verified mode records runtime command success and failure separately from child command claims", async () => {
		const cwd = tempRepo();
		try {
			const passing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "pass", command: "node -e \"process.exit(0)\"", timeoutMs: 10_000 }] },
			});
			const passLedger = await evaluateAcceptance({ acceptance: passing, output: report(), cwd });
			assert.equal(passLedger.status, "verified");
			assert.equal(passLedger.verifyRuns[0]?.status, "passed");

			const failing = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: { level: "verified", verify: [{ id: "fail", command: "node -e \"process.exit(7)\"", timeoutMs: 10_000 }] },
			});
			const failLedger = await evaluateAcceptance({ acceptance: failing, output: report(), cwd });
			assert.equal(failLedger.status, "rejected");
			assert.equal(failLedger.childReport?.commandsRun?.[0]?.result, "passed");
			assert.equal(failLedger.verifyRuns[0]?.status, "failed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reviewed mode records no-blocker and blocker reviewer outcomes", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a risky fix",
				explicit: { level: "reviewed", review: { agent: "reviewer", required: true } },
			});
			const noBlockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: { status: "no-blockers", findings: [] },
			});
			assert.equal(noBlockers.status, "reviewed");
			assert.equal(noBlockers.reviewResult?.status, "no-blockers");

			const blockers = await evaluateAcceptance({
				acceptance,
				output: report(),
				cwd,
				reviewResult: {
					status: "blockers",
					findings: [{ severity: "blocker", issue: "Missing test", rationale: "Acceptance requires test evidence." }],
				},
			});
			assert.equal(blockers.status, "rejected");
			assert.equal(blockers.reviewResult?.status, "blockers");

			const unavailable = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(unavailable.status, "rejected");
			assert.equal(unavailable.reviewResult?.status, "needs-parent-decision");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("explicit checked on a dynamic step runs at checked with no review gate", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement each dynamic item",
				dynamic: true,
				explicit: { level: "checked" },
			});

			assert.equal(acceptance.level, "checked");
			assert.equal(acceptance.review, undefined);
			const ledger = await evaluateAcceptance({ acceptance, output: report({ criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "implemented" },
				{ id: "criterion-2", status: "satisfied", evidence: "evidence returned" },
			] }), cwd });
			assert.equal(ledger.status, "checked");
			assert.equal(ledger.reviewResult, undefined);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not mark reviewed without an independent reviewer result", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement a fix",
				explicit: {
					level: "reviewed",
					review: false,
				},
			});
			assert.equal(acceptance.level, "reviewed");

			const ledger = await evaluateAcceptance({ acceptance, output: report(), cwd });
			assert.equal(ledger.status, "rejected");
			assert.equal(ledger.reviewResult?.status, "needs-parent-decision");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /review required/i);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("zero-child aggregate reports do not fabricate required evidence", async () => {
		const cwd = tempRepo();
		try {
			const acceptance = resolveEffectiveAcceptance({
				agentName: "worker",
				task: "Implement dynamic fanout fixes",
				explicit: { level: "checked" },
			});
			const ledger = await evaluateAcceptance({
				acceptance,
				output: "",
				report: aggregateAcceptanceReport({ results: [] }),
				cwd,
			});

			assert.equal(ledger.status, "rejected");
			assert.match(acceptanceFailureMessage(ledger) ?? "", /criterion|changed-files|tests-added|commands-run|validation-output|no-staged-files/);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("validates invalid disable and verify shapes", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "none" }), ["acceptance.reason is required when level is none."]);
		for (const pathLabel of ["acceptance", "tasks[0].acceptance"]) {
			assert.deepEqual(validateAcceptanceInput("none", pathLabel), [`${pathLabel}.reason is required when level is none.`]);
		}
		assert.deepEqual(validateAcceptanceInput({ verify: [{ id: "missing-command" }] }), ["acceptance.verify[0].command is required."]);
		for (const input of ["attested", { level: "none", reason: "probe" }]) {
			assert.deepEqual(validateAcceptanceInput(input), []);
		}
	});

	it("rejects unrecognized acceptance fields", () => {
		assert.deepEqual(
			validateAcceptanceInput({ verifyCommands: [{ id: "v", command: "npm test" }] }),
			["acceptance.verifyCommands is not a recognized acceptance field (known: level, criteria, evidence, verify, review, stopRules, reason)."],
		);
	});

	it("rejects typo levels and non-array verify with the caller's path label", () => {
		assert.deepEqual(validateAcceptanceInput({ level: "verifed" }), ["acceptance.level must be one of auto, none, attested, checked, verified, reviewed."]);
		assert.deepEqual(validateAcceptanceInput("verifed", "tasks[0].acceptance"), ["tasks[0].acceptance has invalid level 'verifed'."]);
		assert.deepEqual(validateAcceptanceInput({ verify: "npm test" }, "chain[0].acceptance"), ["chain[0].acceptance.verify must be an array."]);
	});

	it("accepts an object using every recognized acceptance field", () => {
		assert.deepEqual(
			validateAcceptanceInput({
				level: "checked",
				criteria: ["works", { id: "g1", must: "tests pass", severity: "required" }],
				evidence: ["commands-run"],
				verify: [{ id: "v1", command: "npm test" }],
				review: { agent: "reviewer" },
				stopRules: ["stop on red"],
				reason: "explicit gate",
			}),
			[],
		);
	});
});
