# File-only failure pointer

**Goal:** A file-only subagent run that fails, or that succeeds but cannot write its output path, returns a pointer to the preserved reply instead of the reply itself; `BLOCKED:` handoffs and inline mode keep today's behavior.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Ticket:** jjuraszek/pi-cohort#24
**Date:** 2026-10-19

## Problem

`outputMode: "file-only"` exists so a parent can dispatch a child whose reply is large (a council member critique, a spec summary) and receive only `Output saved to: <path> (...)`. That contract holds only on the happy path. Today:

- Foreground parallel: a failed file-only task's section renders `FAILED (exit code N): <error>` followed by the full `finalOutput`, which is the complete reply (`src/runs/shared/parallel-utils.ts:126-130`; `finalOutput` set to the full reply at `src/runs/foreground/attempt-finalization.ts:285-287` because the reference is only produced when a save succeeded).
- Background (async) single and parallel: `resolveSingleOutput` runs only on exit 0 (`src/runs/background/subagent-runner.ts:985-987`), so a failed run returns `output` = full reply (`:1100`) and the batch summary renders `${agent}:\n${output}` (`:2448`). `finalizeSingleOutput` itself already runs on every exit code there (`:996-1004`); it only has nothing to do on failure.
- Save error on exit 0: `finalizeSingleOutput` appends the full reply plus `Output file error: ...` regardless of `outputMode` (`src/runs/shared/single-output.ts:174-177`).

Foreground single already withholds the reply on failure: the executor returns `r.error || "Failed"` and discards the finalized display text (`src/runs/foreground/subagent-executor.ts:2098-2103`). It still fails the ticket's first row because no file path and, when `error` is stderr text or empty, no exit code is returned. The ticket's Idea, writing the `output` path on failure, is not adopted (Q1 below).

In every mode both runners already write an artifact copy of the full reply on failure when artifacts are enabled (`src/runs/foreground/execution.ts:834-837`, `subagent-runner.ts:1038-1040`; `artifacts` defaults to true, `src/shared/types.ts:889-896`), so the reply is preserved on disk and only the pointer is missing.

Framing: kept. Checked the three finalization paths, both artifact write sites, BLOCKED handling in both runners (`attempt-finalization.ts:214-217`, `subagent-runner.ts:790-825, 923-958`), the chain `{previous}` consumer and both chain failure branches, `doc/programmatic-api.md:171`, and every pi-gauntlet consumer of the dispatch result (`../pi-gauntlet/extensions/telemetry.ts:640-700`, `extensions/phase-tracker.ts:87-145`, `skills/brainstorming/reference/spec-finalization.md:105`, `skills/roasting-the-spec/SKILL.md:85-89`, `skills/subagent-driven-development/SKILL.md:110,170`, `skills/chase-bug/hotfix.md:84-97`).

## Acceptance criteria

Ticket jjuraszek/pi-cohort#24, `## Acceptance Criteria`, rows verbatim:

- [ ] A foreground single run with `output: <path>` and `outputMode: "file-only"` whose child exits non-zero without a `BLOCKED:` first line returns tool content that names the failure (exit code and error) and a file path, and contains none of the child's response text; the child's full final response can be read from that path.
  in-scope
- [ ] A foreground parallel run where one file-only task fails that way shows, in that task's section, the failure status and a file path with none of the child's response text, and the child's full final response can be read from that path; the succeeded file-only tasks still show only their saved-output reference.
  in-scope
- [ ] An async (background) single run with `outputMode: "file-only"` whose child exits non-zero without `BLOCKED:` delivers a result with failure status and a file path, no response text, and the child's full final response readable from that path.
  in-scope
- [ ] A file-only run whose child exits 0 but whose output path cannot be written returns the save error with no response text inline, plus either a different path from which the full response can be read, or a statement that the response could not be preserved.
  in-scope
- [ ] A file-only child whose reply starts with a `BLOCKED:` line still ends with exit code 1 and delivers the full stripped reply in both the result's error field and parent-visible tool content, as #11 specifies.
  in-scope
- [ ] A run with `outputMode` unset or `"inline"` whose child fails, or whose output path cannot be written, returns the child's full response inline together with the failure status or save error.
  in-scope
- [ ] The file-only paragraph in `doc/programmatic-api.md` describes the failure behavior.
  in-scope

Design clauses that fix the reading of ambiguous rows:

- Rows 1-3 "a file path": the path is the artifact copy of the reply (`<artifact dir>/output.md` as written today), and it is named only after that copy has been written. When no artifact copy is written (`artifacts: false`, `includeOutput: false`, no artifacts directory, or the write failed), the content carries a not-preserved line instead of a path; the rows are read with that exception, the same one row 4 states explicitly. The requested `output` path is never written on failure (the exit-0 gate stays).
- Row 1 "names the failure (exit code and error)": the tool content itself carries `FAILED (exit code N)` plus the error when one exists; `details.results[0].exitCode` alone does not satisfy the row.
- Row 6 "returns the child's full response inline": inline mode is unchanged from today on every surface, byte for byte. Foreground single inline failure keeps returning `r.error || "Failed"` (the reply is in `details` and the artifact, as now); parallel and background inline failures keep rendering the full reply; inline `finalOutput` stays the raw reply so parallel sections and chain `{previous}` gain no reference or save-error line.
- Row 5: the `BLOCKED:` exemption applies in both runners and every dispatch shape (single, parallel, chain step), foreground and background.

## Design

One projection, `formatFileOnlyFailure` in `src/runs/shared/single-output.ts`, applied once per run in each runner after the artifact copy has been written, and carried to every renderer through the existing `finalOutput` / `output` string. No new field on `SingleResult`. `finalizeSingleOutput` is unchanged; it stays the inline formatting boundary it is today (foreground single executor and background summary), so inline output is untouched.

### `formatFileOnlyFailure` contract

Pure function. Input: `outputPath?: string`, `saveError?: string`, and exactly one of `preservedAt: string` (the artifact output path, after its write succeeded) or `notPreservedReason: string`. Output, in order:

1. When `saveError` is set: `Output file error: <outputPath>\n<saveError>` followed by a blank line.
2. Exactly one pointer line: `Full reply preserved at <preservedAt>` or `Full reply not preserved (<notPreservedReason>)`.

No reply text, no `truncatedOutput`, no exit code or error text: the surfaces below already render those, and duplicating them would double them in the parallel section.

Not-preserved reasons:

- `artifact output disabled` - `artifacts.enabled === false`, `artifacts.includeOutput === false`, or no artifacts directory for the run (the write sites' gate: `execution.ts:709,834-836`, `subagent-runner.ts:659,1038-1040`).
- `artifact write failed: <message>` - the output artifact write threw.

The pointer never starts with `Output saved to:` - pi-gauntlet's brainstorming gate keys its "read the summary file" decision on that literal shape (`spec-finalization.md:105`) and must take its degrade path on a failed summarizer.

Applicability, decided by the caller with the run's final `exitCode`, `error`, and `outputSaveError`: `outputMode === "file-only"` and (`exitCode !== 0` or `outputSaveError` set) and the first non-empty line of `error` does not start with `BLOCKED:` (`blockedLine`, already used by both runners). An empty reply still yields a valid pointer to an empty `output.md`; there is no special branch.

Output by case (`finalOutput` foreground, `output` background):

| outputMode | exit | saved | result |
|---|---|---|---|
| inline | any | any | unchanged from today |
| file-only | 0 | yes | unchanged: `Output saved to: <path> (<N> KB, <M> lines). Read this file if needed.` |
| file-only | 0 | save error | `Output file error: <path>\n<err>` + blank line + pointer line |
| file-only | != 0 | n/a | pointer line only |
| any | != 0, `error` first non-empty line starts with `BLOCKED:` | n/a | unchanged: the full stripped reply |

### Call sites

Foreground (`src/runs/foreground/execution.ts`, post-loop block `:817-893`):

- `finalizeSingleAttempt` (`attempt-finalization.ts:273-287`) is unchanged: inline `finalOutput` stays `fullOutput`; file-only success stays `outputReference.message`; `artifactOutputByResult` keeps the full reply for the artifact write.
- The output artifact write (`:834-837`) is wrapped locally: on success record `preservedAt = artifactPathsResult.outputPath`; on throw record the message as the not-preserved reason and rethrow after the projection below so today's status path is unchanged (native: `postLoopError` rethrows and the tool call errors; external owner: exit 1 plus the cleanup message, `:907-913`).
- After acceptance evaluation (`:876-891`, the last point that can flip `exitCode`/`error`), when the applicability rule holds, set `result.finalOutput = formatFileOnlyFailure(...)` and clear `result.truncation`: truncation (`:858-866`) ran earlier on the full reply, and parallel aggregation prefers `truncation.text` over `finalOutput` (`subagent-executor.ts:1829`), which would otherwise leak the truncated reply.
- `subagent-executor.ts:2066-2108` (foreground single): the executor selects by mode, which this spec permits. File-only: content is `r.finalOutput` as finalized above, without re-running `finalizeSingleOutput` (a second pass would append `Output saved to:` / `Output file error:` again); on failure prefix `FAILED (exit code ${r.exitCode})${r.error ? `: ${r.error}` : ""}` plus a blank line, matching `aggregateParallelOutputs`. Inline: today's `finalizeSingleOutput` call and `r.error || "Failed"` on failure, unchanged. BLOCKED: `r.error`, unchanged.
- Parallel and chain aggregation sites are unchanged: `subagent-executor.ts:1826`, `chain-execution.ts:797,1033`, `subagent-runner.ts:2001,2269`. They render `getSingleResultOutput(result)` via `aggregateParallelOutputs` (`FAILED (exit code N): <error>\n<output>`), and that output is now the pointer for a failed file-only task.

Background (`src/runs/background/subagent-runner.ts`):

- `resolveSingleOutput` stays behind its exit-0 gate (`:985-987`); the existing `finalizeSingleOutput` call (`:996-1004`) is unchanged, so inline output is unchanged.
- The output artifact write (`:1038-1040`) is already caught (`:1060-1064`: exit flips to 1 and the message is appended to `error`); record `preservedAt` on success or `artifact write failed: <message>` on catch.
- After that catch, when the applicability rule holds for `effectiveFinalExitCode` / `effectiveFinalError` / `resolvedOutput.saveError`, set `outputForSummary = formatFileOnlyFailure(...)` and prepend the attempt notes (`attemptNotes.join("\n")` + blank line) to it again, since the projection replaced the string that carried them. The exit flip on save error (`:1006-1008`) is unchanged. Status, notify, batch summary (`:2448`) and the external-surface `output-N.log` write (`:1066-1070`) render `outputForSummary` and need no change.

### Parent-visible surfaces

`content` is the parent-visible text. `details.results[].finalOutput` carries the same pointer because it is the same string; `details.results[].exitCode`, `error`, `agent`, `model`, `usage`, `savedOutputPath`, `artifactPaths` keep their current values and meaning.

pi-gauntlet consumers (`../pi-gauntlet`), checked for the no-regression constraint:

- `extensions/phase-tracker.ts:87-145` reads `details.results[].agent` and `exitCode` only; unchanged.
- `extensions/telemetry.ts:640-700` reads `agent`, `exitCode`, `model`, `usage`, `savedOutputPath` and also parses tool `content`: `parseChairReport(textOf(content))` for the chair (`:653-654`) with a fallback to reading `savedOutputPath`, and `countFindings(textOf(content))` for reviewer agents (`:698`). Chair: a failed foreground single chair already returns `r.error || "Failed"` as content and leaves `savedOutputPath` unset, so the parse yields null today and after this change; the null-safe fallback is preserved. Reviewers: today a failed file-only reviewer in a parallel wave leaks its reply into `content`, and `countFindings` tallies those findings; after this change the pointer carries no findings, so failed reviewers contribute `nonzero_exit` but no finding counts, the same as a successful file-only reviewer today. That removal is intentional; response text is not restored to keep leak-derived counts.
- Skill prose (`skills/roasting-the-spec/SKILL.md:89`, `doc/configuration.md:45`, `spec-finalization.md:105`) describes today's leak; see Documentation impact.

## Errors and edge cases

- Artifact write fails: foreground native rethrows (`execution.ts:915-916`) and the tool call errors with no result, as today; foreground external owner delivers exit 1 plus the cleanup message with the not-preserved pointer; background delivers exit 1, `error` with the write message appended, and the not-preserved pointer. The pointer is never emitted before the write, so a preserved-at path always names a written file.
- Save error and artifact write failure together (exit 0 child, file-only): `Output file error: <path>\n<err>`, blank line, `Full reply not preserved (artifact write failed: <msg>)`; no reply text. Exit codes keep today's per-mode behavior: foreground save error stays exit 0 with `outputSaveError` set (a foreground artifact write failure then follows the status path above), background flips to 1.
- `artifacts: false`, `includeOutput: false`, or no artifacts directory: `Full reply not preserved (artifact output disabled)`. `finalOutput` is the pointer too, so the reply exists nowhere parent-readable; that is the documented trade-off of disabling artifact output.
- Truncated replies on failure: file-only clears `truncation` and renders the pointer only; inline keeps `truncatedOutput || fullOutput`. The parallel integration test uses a reply longer than the `maxOutput` limit so the truncated-text path is exercised.
- Chains: no change. A failed sequential or parallel step returns `buildChainSummary` (`chain-execution.ts:768,1218`; `src/shared/formatters.ts:105-146`), which renders the step's `error` and the chain artifact directory and never the reply, so chains do not leak today; adding the pointer to the chain summary is not part of this change. A file-only step with an exit-0 save error now hands the next step the save-error line plus pointer as `{previous}` rather than the reply; the next step can read the artifact.
- Dynamic fanout (`dynamic-fanout.ts:265-281`) reads `savedOutputPath`, which stays undefined on failure; unchanged.
- Background external-surface runs persist `outputForSummary` to the run's `output-N.log` (`subagent-runner.ts:1066-1070`); on a file-only failure that log now holds the attempt notes plus pointer, not the reply, and the artifact copy is the full-reply source. Native background runs stream the reply live into that file (`runPiStreaming`) and intermediate progress updates are untouched.

## Tests

Unit, `test/unit/single-output.test.ts`:

- `formatFileOnlyFailure` with `preservedAt` -> exactly the preserved-at line.
- with `notPreservedReason: "artifact output disabled"` -> exactly the not-preserved line.
- with `saveError` and `preservedAt` -> `Output file error: <path>\n<err>`, blank line, preserved-at line.
- with `saveError` and `notPreservedReason: "artifact write failed: EACCES"` -> save error, blank line, not-preserved line.
- output never matches `/^Output saved to:/` and never contains the reply.
- `finalizeSingleOutput` existing tests keep passing unchanged, including "does not add save messaging on failed runs".

Integration, exact-output regressions for inline (byte-equal to today's output, captured before the change):

- `test/integration/single-execution.test.ts`: inline single with `output` and a successful save carries exactly one `Output saved to:` line; inline single with a save error carries the reply and exactly one `Output file error:` line.
- `test/integration/parallel-execution.test.ts`: inline parallel with `output` carries no `Output saved to:` or `Output file error:` line in any section (extends `:341-357`); a failed inline task renders the full reply.
- `test/integration/chain-execution.test.ts`: inline chain step with `output`, save success and save error, hands the next step the raw reply as `{previous}` with no reference or save-error line.

Integration, file-only:

- `single-execution.test.ts`: foreground single file-only child exiting 7 with stderr lacking a code -> content is `FAILED (exit code 7): <stderr>`, blank line, preserved-at line; the same with empty stderr -> `FAILED (exit code 7)`, blank line, pointer; neither contains the reply; the artifact file at the named path equals the full reply.
- `single-execution.test.ts`: file-only exit 0 with an unwritable output path -> content is `Output file error: ...`, blank line, preserved-at line; exit 0; no reply text.
- `single-execution.test.ts`: file-only failure with `artifacts: { includeOutput: false }` -> not-preserved (`artifact output disabled`) line, no reply text.
- `single-execution.test.ts`: file-only `BLOCKED:` reply returns the handoff text in `content` and `error`, exit 1.
- `parallel-execution.test.ts`: one failing file-only task beside one succeeding; the failing section carries `FAILED (exit code 1)` and the preserved-at line and none of the child's reply; the artifact file at that path equals the full reply; the succeeding section carries only its `Output saved to:` reference.
- `test/integration/async-execution.test.ts`: background file-only failure with a model fallback attempt note -> delivered `output` is the attempt note, blank line, preserved-at line, in that order; the summary carries no reply text; the artifact file holds the reply. Background file-only exit 0 with unwritable output path and unwritable artifact directory -> exit 1, `error` carries the artifact write message, `output` is the save-error line plus `Full reply not preserved (artifact write failed: ...)`, no reply text.

Sibling no-regression: `cd ../pi-gauntlet && npm test` passes unchanged (covers `extensions/lib/telemetry-collect.test.ts`, `telemetry-council.test.ts`, and the phase-tracker tests).

Command: `env -u PI_CODING_AGENT_DIR npm run test:all`.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/programmatic-api.md` (file-only paragraph at line 171 - communication contract: replaces "Failed runs and save errors still return normal inline output for debugging" with the failure and save-error behavior above, the preserved-at / not-preserved pointer, and the BLOCKED exemption); `CHANGELOG.md` `## [Unreleased]` entry in this repo; `../pi-gauntlet/CHANGELOG.md` `## Unreleased` entry for the sibling doc change below. Both ride with the same logical change (AGENTS.md "Part of one platform": a cross-repo contract change updates the sibling's docs in the same logical change and lands in both CHANGELOGs).
- Derived / memory docs invalidated: none in this repo (`doc/commands.md:61` does not state the failure exception). In `../pi-gauntlet`, same logical change: `skills/roasting-the-spec/SKILL.md:89` (drop the "upstream nonzero/save-error exception" sentence and the "fail-closed child failure output is a pi-cohort follow-up" sentence; keep the structural-probe-only instruction); `doc/configuration.md:45` (drop "File-only output still has an upstream exception ..."); `skills/brainstorming/reference/spec-finalization.md:105` (the degrade-path trigger stays "not an `Output saved to:` reference"; replace the parenthetical example with "an exit-0 save error returns the save error plus a `Full reply preserved at` / `not preserved` pointer, no inline output"). Those pi-gauntlet edits follow `/skill:forge-skill` and the pinned pi-cohort version in pi-gauntlet's README and its `package.json` peer floor move together to the release carrying this change (7.4.1), as pi-gauntlet's own releases do.

Materiality bar: `reference/documentation-impact.md`.

## Out of scope

- Writing the requested `output` path on failure (the ticket's Idea). The exit-0 gate protects downstream readers of that path from treating a crashed reviewer's partial critique as finished.
- Aligning foreground and background exit codes on save error, or foreground native's rethrow on artifact write failure.
- Any change to inline mode, chain stop semantics, chain failure summaries, or background progress rendering.

## Open questions

- Foreground save error keeps exit 0 while background flips to 1. Pre-existing mismatch, not changed here.
