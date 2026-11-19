# `investigate` becomes a skill that prints a short plain-words report

**Goal:** After an investigation the terminal shows a report of at most 180 words in plain words under fixed headings, ending with the path to the full cited brief in a temp folder; `investigate` ships as a skill with its report rules in a reference file, and the brief records whether the request fits the codebase's design.
**Amend-grant:** every later spec amendment in this flow (corrected facts, paths, verification lines, and scope, acceptance-criteria, or public-contract edits alike) applies without asking; only a redraw (changed problem statement, component added, removed, or re-bounded) still stops for you, and the grant never stands in for a spec approval.
**Engine:** loop
**Date:** 2026-11-19
**Source bases:** pi-cohort `2dd33c8` (8.4.3); pi 1.5.2; pi-gauntlet as installed beside it (chase-bug, forge-skill).
**Predecessor:** `doc/specs/2026-09-17-prune-prompts-investigate-handoff.md` - supersedes "### Shared dispatch rules (both prompts)" and "### `prompts/investigate.md`" fully, and the `/investigate` entries of "### Docs".

## Problem

`/investigate` is a prompt template (`prompts/investigate.md`, 58 lines, 4,353 bytes). It runs two read-only waves of child agents, writes a cited brief to `$DIR/brief.md` (or `--out`), and its last instruction is "print the path and the brief once" (`prompts/investigate.md:58`). The whole brief - cited findings, the premise check, verification task texts - lands in the terminal. A reader who wants the outcome has to dig it out of evidence written for the next session, not for them.

The request asks for the terminal output to read like pi-gauntlet's chase-bug report: short, sectioned, in the words a product manager would use in an elevator, with the technical detail in a temp markdown file whose path is printed so it can seed a later brainstorm or ticket. It also asks to borrow chase-bug's communication rules, to follow forge-skill, and to split the skill into reference files where that helps.

Two gaps sit behind the output problem:

- A prompt template is one file. pi's loader reads top-level `.md` files in `prompts/` and resolves no sibling file, so report rules cannot be re-read at the report step the way chase-bug re-reads `reference/verdict-report.md`.
- No wave judges whether the request, as framed, goes against an existing design decision, convention, or idiom. The scout lists conventions a change must match; the reviewer classifies the request's claims and is told "No design proposals".

### Request, verbatim

1. `current investigate output is horrible. it should look more like ../pi-gauntlet/ chase-bug output with all technical details in tmp md file. the key is comms like for PM during elevator talk for those stuff which are rendered in TUI. moreover this should be well formated set of sections. the full investigation should be listed as path which might be usefull for brainstorming or shape ticket. make sense? we can borrow good patterns for this skill from pi-gauntlet along with good comms instructions and moreover following forge-skill guidance and 50k limit for skill and split main SKILL.md into ref files if this make sense`
2. Question 1 reply: `B`
3. Question 2 reply: `A, but should we also have conflicting design section or convention and idiomatic assessment or is it part of first "waht I found"?`
4. Question 3 reply: `A`
5. Approach reply: `A, make sure those files are in tmp space only, never in repo. those should be available for this session as source not commited artifacts`
6. Design round 1 reply: `approve`
7. Design round 2 reply: `approve`

### Framing

Framing: kept - the scout's objection ("a new skill and report-file machinery may solve the wrong layer") names the same core change the request asks for (short report inline, full brief in the file, path printed); the container (prompt or skill) was question one, not a framing concern.

### Decisions from the questionary

| Question | Options offered | Answer |
|---|---|---|
| 1. Where does investigate live? | A stay a prompt; B become a skill; C skill plus a `/investigate` prompt pointer | B - `/skill:investigate` replaces `/investigate`; report rules sit in a reference file read right before the report is written; the model can load the skill on its own |
| 2. Which fixed terminal sections? | A `What I found` / `What it means for your request` / `What you need to decide`; B premise-led; C verdict-first | A, plus the follow-up that led to question 3 |
| 3. Where does the design-fit assessment appear? | A brief always, terminal section only on a clash; B folded into `What it means for your request`; C always a fourth section; D leave out | A - conflicting design and convention/idiom are one assessment |
| Approach | A two files, the session writes the report; B three files; C a fresh agent writes the report | A, plus the constraint: investigation files live in temp space only, never in the repo; they are session sources, not committed artifacts |

Assumptions stated in the questions and not objected to: `prompts/investigate.md` and the then-empty `prompts/` folder are removed; the report is capped at 180 words; the report ends with the brief path, not a menu naming pi-gauntlet skills; "those files" in the constraint means the investigation outputs (the brief and each child's output), not the two shipped skill files; `--out` is removed because it is the one way a brief lands in the repo.

### Claims checked

| Claim | Lookup | Result |
|---|---|---|
| The current output is unreadable in the terminal | `prompts/investigate.md:58`, brief template `:42-52` | held - the whole cited brief is echoed; traced to instruction text, no captured transcript exists on this machine |
| Investigate is a skill with a `SKILL.md` | `ls skills prompts`; `package.json` `pi.skills`, `pi.prompts` | corrected - it is a prompt template |
| chase-bug puts all technical detail in a temp md file | pi-gauntlet `skills/chase-bug/SKILL.md:18,142-144,222-223` | corrected - chase-bug prescribes no investigation file and prints no path; investigate already writes the file, so only the short report is borrowed |
| chase-bug's rendered output is a short sectioned report in plain words | pi-gauntlet `skills/chase-bug/reference/verdict-report.md:5-8,41-103`; `SKILL.md:153-156` reads it at the render step | held |
| forge-skill sets a 50k limit | pi-gauntlet `skills/forge-skill/SKILL.md:35`; pi `dist/core/tools/truncate.js:10-11` | corrected - forge-skill's rule is 500 lines; 50KB (or 2000 lines) is where the read tool cuts a file; investigate is under both |
| `SKILL.md` can be split into reference files | pi `dist/core/prompt-templates.js:86-130`; `forge-skill/SKILL.md:27` | corrected - a split is available only to a skill |
| A prompt-to-skill move has precedent here | `doc/specs/2026-09-20-gh-18-handoff-skill-append-seam.md:8-28` | held - `/handoff` became `skills/handoff/SKILL.md` |
| The brief path is usable by a later brainstorm or ticket | pi-gauntlet `skills/brainstorming/gatherer.md:203-218` (the context-builder trigger is a URL, tracker id, or GitHub ref, not a local path), `skills/shape-ticket/SKILL.md:66,72` (line 66 is linked-ticket repair; create mode gathers from the prompt) | corrected - neither workflow is guaranteed to read a local path on its own; the printed path is there for the user to paste into a follow-on session |
| forge-skill governs this edit | `forge-skill/SKILL.md:3,11`; `AGENTS.md` core "Skill, persona, and prompt edits follow `/skill:forge-skill`" | held |
| A reference file ships with the package | `package.json` `files` has `skills/**/*`; `skills/pi-cohort/reference/config-fields.md` ships that way | held |
| The terminal renders `###` as a title | pi-tui `dist/components/markdown.js:426-447` (pi 1.5.2) | corrected - depth 1 and 2 render as styled titles without hashes; depth 3 and deeper keep the `###` prefix, so the report uses `##` |
| Renaming the entry point touches the completion guard | `src/runs/shared/completion-guard.ts:35-39,109` | held as no impact - the research pattern `/\binvestigate\b/` is tested against the dispatched agent name, not the task text or the entry point's name; the dispatched agents stay `scout`, `reviewer`, and `context-builder` |
| No sibling repo names `/investigate` | `rg '/investigate\b|prompts/investigate'` over pi-gauntlet, pi-quiver, pi-condense (specs, plans, CHANGELOG excluded) | held - no hit |

### Constraints

- pi-cohort names no consumer (`AGENTS.md` "Part of one platform"; the gh-18 spec removed gauntlet skill names from handoff). Neither skill file contains a `gauntlet:` marker or a `/skill:` name; the literal `/skill:investigate` invocation appears only in `README.md` and `doc/skills-and-companions.md`.
- pi-cohort installs without pi-gauntlet (the dependency runs gauntlet -> cohort). A shipped skill file cannot link to chase-bug's `reference/verdict-report.md`, so the register rules are written in pi-cohort's own reference file, adapted to investigations.
- Skill arguments arrive as appended user text; a skill has no `$@` substitution (pi `docs/skills.md`; `forge-skill/SKILL.md:28`).
- `src/agents/skills.ts:614` offers every package skill except `pi-cohort` as a child `skill:` override. `investigate` appears there, as `handoff` does.
- The predecessor spec describes a human gate before wave 2; the shipped prompt has none ("No human gate between waves"). The skill carries the shipped prompt's rule.

### Implicit dependencies

| Dependency | Lookup | Result |
|---|---|---|
| Scout, reviewer, context-builder personas and parallel dispatch fields | `agents/{scout,reviewer,context-builder}.md`, `src/extension/schemas.ts:147-167,222,296-321`, `skills/pi-cohort/SKILL.md:57-65,92-95` | found |
| `mktemp`, `git` | `command -v mktemp git` | found |
| Web fetch for linked pages | `agents/context-builder.md:4,20`, `doc/skills-and-companions.md:68-76` | not checkable - depends on the invoking session's extensions; an unreadable ref keeps being listed as `unreadable: <ref>` |
| Ticket lookup | `gh` on PATH | not checkable - network and login are per user and per request |
| Wave-2 inputs and fixtures | written per request at runtime | not checkable - no concrete request to trace |
| A real `/investigate` transcript | `ls $TMPDIR/tmp.*/brief.md` | not found - the report shape is designed from the prompt's instructions |
| Inventory test baseline | `env -u PI_CODING_AGENT_DIR node --import ./test/support/isolate-test-env.mjs --test test/unit/prompts-inventory.test.ts` | found - 8 tests pass at the source base |

## Acceptance criteria

Drafted from the design, no ticket rows:

- [ ] The package ships no prompt templates: `prompts/` does not exist, and `package.json` names it neither under `pi.prompts` nor under `files`.
  in-scope
- [ ] `skills/investigate/SKILL.md` has frontmatter `name: investigate`, a `description` that starts with `Use when`, and no `disable-model-invocation` field.
  in-scope
- [ ] `skills/investigate/SKILL.md` writes every investigation file under one `mktemp -d` folder, the brief as `brief.md` in it, and has no `--out` option.
  in-scope
- [ ] The brief template in `skills/investigate/SKILL.md` has these `##` headings in this order: `Request`, `Findings`, `External context`, `Premise check`, `Design fit`, `Open questions`, `Verification tasks`, `Next steps`.
  in-scope
- [ ] The reviewer task text in `skills/investigate/SKILL.md` asks for a design-fit verdict that ends in `- clash:` lines or the line `no conflict found - checked <what was read>`.
  in-scope
- [ ] A fresh `worker` given the synthetic brief and `skills/investigate/reference/report.md` returns a report whose `##` headings are, in order, `What I found`, `Where it clashes with the current design`, `What it means for your request`, `What you need to decide`, and whose last line is `Full investigation: ` followed by the brief path it was given.
  in-scope
- [ ] That report is at most 180 words, measured with `wc -w` from its first heading through the line before `Full investigation:`.
  in-scope
- [ ] That report, before its `Full investigation:` line, contains none of the file paths and none of the `:<line>` citations that appear in the synthetic brief.
  in-scope
- [ ] `skills/investigate/reference/report.md` renders `## Where it clashes with the current design` only for a brief whose `## Design fit` holds a `- clash:` line, and lists the other three headings as always present.
  in-scope
- [ ] Neither `skills/investigate/SKILL.md` nor `skills/investigate/reference/report.md` contains the text `/skill:`.
  in-scope
- [ ] Neither `skills/investigate/SKILL.md` nor `skills/investigate/reference/report.md` contains the text `gauntlet`.
  in-scope

## Legs

### Leg: jjuraszek/pi-cohort
branch: investigate-report-format
contract:
- create: git worktree add .worktrees/<name> -b <branch>
- destroy: git worktree remove .worktrees/<name> && git worktree prune
- home: .worktrees/<name>
- spec-dir: doc/specs
- plan-dir: doc/plans
- verification: `(cd <worktree> && env -u PI_CODING_AGENT_DIR npm run test:unit)` and `(cd <worktree> && npm run test:integration)` (AGENTS.md Testing; no `## verification-before-completion` or `## PR gate` section in the overrides file, no `piGauntlet.verifyBeforeShip`); ship via `/skill:release` (`release.sh <level>`) per overrides `## Release`
Rules: AGENTS.md
Rules: AGENTS.core.md
Rules: README.md
Rules: CHANGELOG.md
Rules: doc/agents-and-chains.md
Rules: doc/observability.md
Rules: doc/handoff-template.md
Rules: .pi/gauntlet-overrides.md
Rules: .agents/skills/release/SKILL.md
scope: AC 1, AC 2, AC 3, AC 4, AC 5, AC 6, AC 7, AC 8, AC 9, AC 10, AC 11
design: owns `skills/investigate/SKILL.md`, `skills/investigate/reference/report.md`, `prompts/` (removed), `package.json`, `test/unit/prompts-inventory.test.ts`, `README.md`, `doc/skills-and-companions.md`, `doc/orchestration-patterns.md`, `CHANGELOG.md`; an investigation ends with a short plain-words report and the path to the full brief in a temp folder.

## Design

Two files, and the investigating session writes the report. `SKILL.md` owns the procedure; `reference/report.md` owns everything the terminal shows. Both follow `/skill:forge-skill`'s authoring rules (imperative voice, one path per step, one example per rule, ASCII punctuation, compact table separators).

### Remove

- Remove `prompts/investigate.md` and the `prompts/` folder.
- Remove the `"prompts/**/*"` entry from `package.json` `files` and the `"prompts": ["./prompts"]` entry from `package.json` `pi`.
- Remove the `--out <path>` option and the instruction "print the path and the brief once".
- Remove `promptsDir` and the tests `packaged prompts are exactly investigate` and `prompt descriptions are triggers and prompts take the argument` from `test/unit/prompts-inventory.test.ts`.
- Remove the prompt lead-in sentence and the `/investigate <request> [--out path]` row under "## Optional shortcuts" in `doc/skills-and-companions.md`, and the `/investigate` mention in `README.md`.

### Add

- Add `skills/investigate/SKILL.md`.
- Add `skills/investigate/reference/report.md`.
- Add the design-fit sentence to the wave-1 reviewer task text, and `## Design fit` to the brief template.
- Add the investigate tests listed under `## Tests` to `test/unit/prompts-inventory.test.ts` (file name kept; it holds the handoff tests too).
- Add `/skill:investigate <request>` entries to `README.md` and to "## Optional shortcuts" in `doc/skills-and-companions.md`, and an `investigate` entry to that file's "## Bundled skills" inventory.
- Add a `CHANGELOG.md` entry under `## [Unreleased]`: `/investigate` and its `--out` option removed; `/skill:investigate` added; the terminal report shape; the brief's `## Design fit` section.

### `skills/investigate/SKILL.md`

Frontmatter: `name: investigate`; `description` is the prompt's current one, unchanged: `Use when a request's premises are unverified, the territory is unknown, or the user asks to look into something before planning or brainstorming.` No `disable-model-invocation`: the model loads the skill on its own when the description matches.

The body carries six steps, in this order:

1. **Request.** The request is the argument text that follows the skill block. When the model loaded the skill without argument text, the request is the user message that led to the load. When the whole argument text is one path to an existing file, the file's content is the request; a path that does not exist, and prose that mentions a path, stay request text. Nothing is parsed as an option. Three stops come before any folder is created:
   - **Empty request.** A user message that consists only of the skill block, with no trailing request text: stop and ask for the request. The skill files state the condition in those words and never spell the invocation (AC 10).
   - **Authorization.** A triggering user request that asks for an investigation authorizes both read-only waves. When the model loaded the skill on a request that does not ask for one, confirm with the user before dispatching.
   - **Dispatch tool.** When `subagent` is not available in the session, stop and say that investigation needs a session with the dispatch tool.
2. **Temp folder and dispatch rules.** Runs after step 1 passes. Before anything is created, the temp base - the folder `mktemp -d` creates under - is resolved to an absolute path and compared with `git rev-parse --show-toplevel`; a base that is the repository root or sits inside it stops the skill with a message naming the base, and nothing is created. Then `DIR=$(mktemp -d)`; when folder creation fails, stop and print the error. The rules carry over from the prompt unchanged except for the output location and the two storage fields: every dispatch sets `async: false`, `context: "fresh"`, `artifacts: false`, and an absolute `sessionDir` under `$DIR` at the top level (with artifacts left on, the executor writes a full-output copy beside the parent session, and child session storage is resolved separately from a task's `output`); `cwd` is `git rev-parse --show-toplevel`; every task sets `reads: false` and an absolute `output` under `$DIR`; every child is read-only against the repository and each task text says so; an async handle means `forceTopLevelAsync` is active - stop and report, no polling; a question answerable from code, docs, or the tracker is looked up, not asked; a verification task that would run, build, or validate the proposed change is rejected; no human gate between authorized waves. A dispatch call that fails as a whole and returns no child results (for example more tasks than the configured task limit), in either wave, is not a child failure: the evidence already gathered is kept, and the brief names the work that did not run and the reason and marks it unchecked, never verified. The output rule reads: every investigation file - each child's output, each child's session storage, and the brief - is written under `$DIR`, nothing is written into the repository, the brief is `$DIR/brief.md`, and `$DIR` is kept so the session reads `brief.md` and the child outputs from it for follow-up questions.
3. **Wave 1.** One parallel call with `scout`, `reviewer`, and `context-builder` when refs are detected, with the prompt's ref detection, task texts, and outputs (`scout.md`, `premise.md`, `external.md`). The reviewer task text gains the fit judgment before its closing "No design proposals": judge whether the request as framed fits how the codebase is built - its recorded design decisions, conventions, and idiom - and end the output with a `Design fit:` block holding one line `- clash: <what the request asks or assumes> - <the decision, convention, or idiom it goes against> (<path>:<line>)` per clash, or the single line `no conflict found - checked <what was read>`. The session accepts the block in two forms only: `- clash:` lines that each carry a citation, or the clean line naming the sources actually checked. A missing block, a block in any other shape, a clash line without a citation, or a clean line that names nothing checked makes `## Design fit` read `not assessed - <reason>`; the reviewer's valid premise lines still go into `## Premise check`.
4. **Brief draft.** The template keeps its heading notes and gains one heading after `## Premise check`:

   ```markdown
   # Investigation: <slug>
   ## Request
   ## Findings            (cited; `### Verified` holds wave 2 results)
   ## External context    (only when context-builder ran; unreadable refs listed)
   ## Premise check       (Confirmed / Contradicted / Unverified - one line each, cited)
   ## Design fit          (the reviewer's `- clash:` lines, cited; or `no conflict found - checked ...`; or `not assessed - <reason>`)
   ## Open questions      (numbered; each ends with `Recommendation: <answer> - <why>`)
   ## Verification tasks  (numbered; independent; each: one-paragraph read-only subagent task + `Expected:`; current behaviour only)
   ## Next steps          (suggestions only; no implementation task decomposition)
   ```

5. **Wave 2 and write.** Unchanged: one call, one task per verification task, results folded into `## Findings` under `### Verified`; no verification tasks -> the wave is skipped and `### Verified` is omitted. The brief is written to `$DIR/brief.md` and read back; when the write or the read-back fails, the skill prints the error and stops without a `Full investigation:` line.
6. **Report.** A one-line pointer: read `reference/report.md` now and print the report it defines. The brief's body is never printed. Nothing follows the report's closing line. The `Full investigation:` line is printed only for a brief that was written and reads back.

### `skills/investigate/reference/report.md`

| Part | Content |
|---|---|
| Shape | `##` headings in this order: `What I found`, `Where it clashes with the current design`, `What it means for your request`, `What you need to decide`. The clash heading is rendered only when the brief's `## Design fit` holds at least one `- clash:` line; the other three are always present. A blank line separates sections. Each section is one short paragraph or one list, never both. |
| Closing line | `Full investigation: <absolute path to brief.md>` is the last line of the reply. |
| `What I found` | The findings that change what the reader does, each with one concrete value or before/after from the brief. A corrected assumption is stated as the fact. A failed child or a dispatch that did not run is stated as what went unchecked. When `## Design fit` reads `not assessed`, it says that whether the request fits the current design is unknown. |
| `Where it clashes with the current design` | The most consequential clash as what the request asks and what the codebase already decided, in everyday words; when the brief holds more clashes, the count of the others. Every cited clash stays in the brief's `## Design fit`. |
| `What it means for your request` | The consequence for the request: goes ahead as asked, changes, or cannot be told yet, with the reason. |
| `What you need to decide` | One list of at most three open questions from the brief, each with its recommended answer and a because-clause; when the brief holds more, the count of the rest is the last list item. When the brief has none, the section is one sentence that says no decision is needed and what happens next. |
| Register | The reader has neither the code nor the brief open. Each part of the system is named by what it does before its first name. The body carries no file path, no line number, no agent name, and no citation; a literal name the user typed in the request stays, except a path, which is described in plain words by its role. The brief path on the closing line is the only path in the reply. Every sentence comes from a fact in the brief or a consequence of one; an unverified claim is stated as unknown. |
| Translation table | Investigation shorthand in the left column, report wording in the right. It covers at least: `premise`, `Confirmed` / `Contradicted` / `Unverified`, `wave`, the three child names (scout, reviewer, context-builder) as the work each did, `call site`, `fixture`, `convention`. |
| Cap | At most 180 words from the first heading through the line before `Full investigation:`, headings included. Over the cap, `What I found` is cut first; every required section and each listed question's recommendation survive. |
| Example | One worked report in the four-section form, built from made-up content. |

The file borrows chase-bug's report rules by adaptation: its sections become investigation sections, its bug-only gates, menus, and markers are left out.

### Docs

- `doc/skills-and-companions.md` "## Bundled skills": the inventory sentence counts three skills and gains an `investigate` entry beside `handoff` and `pi-cohort`.
- `doc/skills-and-companions.md` "## Optional shortcuts": the lead-in names a packaged skill, the table header `Prompt` becomes `Command`, and the table row reads `/skill:investigate <request>` - parallel read-only recon, premise check, and design-fit check before planning or brainstorming; prints a short plain-words report and the path to the full cited brief in a temp folder. The heading stays, so `#optional-shortcuts` links keep resolving.
- `README.md`: the shipped-commands sentence names `/skill:investigate <request>` in place of `/investigate`.
- The three "prompt shortcuts" phrasings that go stale are reworded to "shortcuts": `doc/skills-and-companions.md` intro line and "## Prompt-template integration", and `doc/orchestration-patterns.md` line 14.

### Paid action

Runner: the implementing session. Action: forge-skill's loaded-versus-baseline check on the report rules (`## Test (optional)` in forge-skill). Inputs: one synthetic brief the session writes to a temp path outside the repository, following the brief template with made-up content, holding one `- clash:` line, five open questions, and cited paths with `:<line>` suffixes; and `skills/investigate/reference/report.md`. Two `worker` dispatches receive the synthetic brief and its path with the instruction to print the terminal report; the loaded worker also receives the body of `reference/report.md`. Both dispatches set `context: "fresh"` explicitly (the worker persona defaults to a forked context) and `reads: false` on the task, and both task texts carry the sentence `Do not edit any file`, so the completion guard does not read a print-only worker as an implementation worker that made no edit.

Before the pair runs, the session writes down in plain words the fixture's finding, the conflicting decision, the practical consequence, and the recommendation. The loaded output passes when it states those four facts correctly, carries no unexplained investigation shorthand, and meets acceptance rows 6-8. The plain-words facts, the loaded output, and the pass or fail result are saved to a temp file outside the repository, beside the synthetic brief. On a fail, the session revises the rule sentence in `reference/report.md` that owns the miss and reruns the loaded worker; the grant below covers the reruns. Every excuse the baseline output shows is folded into the rule sentence it evades. The fixture holds a clash, so no worker observes the three-section no-clash form; that branch is text-checked only (AC 9).

Approving this spec authorizes this named action for the whole flow - seed, rows, repairs, and finish - without per-step permission prompts. The dispatch count above is advisory. A live `/skill:investigate` run is not part of verification.

**Post-deployment housekeeping.** The maintainer names the release level when running `/skill:release`; the CHANGELOG entry marks `/investigate` and `--out` as removed so the level can be judged.

## Errors and edge cases

- **Empty request.** A user message that is only the skill block, with no trailing request text, stops and asks; no temp folder is created.
- **Prose that mentions a file.** Request text; a file is read as the request only when the whole argument is one path to an existing file.
- **Model loaded the skill on a request that does not ask for an investigation.** The skill confirms before dispatching.
- **No `subagent` tool in the session.** The skill stops before creating the temp folder and says investigation needs a session with the dispatch tool.
- **Temp base inside the repository.** The skill stops and names the base; nothing is created.
- **Folder creation fails.** The skill stops and prints the error.
- **Option-like text.** `--out x.md` in the argument is request text; the brief still goes to `$DIR/brief.md`.
- **Async handle returned.** The skill stops and reports it: no polling, no relaunch, no report.
- **A child errors or leaves its output empty.** The brief is still written and that child's section reads `<agent> failed: <reason>`. `What I found` says in plain words what went unchecked.
- **A whole dispatch call fails with no child results (either wave).** The evidence already gathered is kept; the brief names the work that did not run and the reason and marks it unchecked, never verified. `What I found` says in plain words what went unchecked.
- **Reviewer failed, or its design-fit verdict is missing, malformed, or unsupported.** `## Design fit` reads `not assessed - <reason>`; valid premise lines are kept; no clash section is rendered; `What I found` says whether the request fits the current design is unknown.
- **No clash.** `## Design fit` reads `no conflict found - checked <what was read>`; the report has three sections.
- **No open questions.** `What you need to decide` stays and says nothing needs a decision.
- **No verification tasks.** Wave 2 is skipped.
- **Brief write fails or `brief.md` does not read back.** The skill prints the error and no `Full investigation:` line.
- **`reference/report.md` unreadable.** The skill prints the read error and, for a brief that was written and reads back, the `Full investigation:` line, so the brief is not lost.
- **Child skill list.** `investigate` appears among the package skills a child dispatch can name as `skill:`, as `handoff` does; nothing filters it.

## Tests

All text checks live in `test/unit/prompts-inventory.test.ts`; the skill is instructions and has no code path.

- `prompts/` is absent, and `package.json` has no `pi.prompts` entry and no `prompts/**/*` files entry (AC 1) - test `package ships no prompt templates`
- Frontmatter `name` is `investigate`, the description passes the trigger check, and `disable-model-invocation` is absent (AC 2) - test `investigate skill has trigger frontmatter and stays model-invocable`
- `SKILL.md` contains `mktemp -d`, `brief.md`, `artifacts: false`, and `sessionDir`, and contains neither `--out` nor `$@` (AC 3; option-like text edge; dispatch storage fields) - test `investigate skill keeps every investigation file in one temp folder`
- The `##` headings of the brief template's markdown fence equal the eight-heading list (AC 4) - test `investigate brief template headings are fixed`
- The reviewer task text in `SKILL.md`, read apart from the brief template fence, contains `Design fit:`, `- clash:`, and `no conflict found - checked`; the fallback rule outside the template fence contains `not assessed -` (AC 5; reviewer-failed, malformed-verdict, and no-clash edges) - test `investigate reviewer task asks for the design-fit verdict`
- Loaded worker's report has the four headings in order and ends with `Full investigation: <given path>` (AC 6) - none: a model output, observed through the paid action in Design
- Loaded worker's report is at most 180 words by `wc -w` (AC 7) - none: observed through the paid action
- Loaded worker's report body holds none of the synthetic brief's paths or `:<line>` citations (AC 8) - none: observed through the paid action
- `reference/report.md` contains the four headings in order, states the clash heading's `- clash:` condition, and contains `180` and `Full investigation:` (AC 9; cap and closing-line clauses) - test `investigate report reference defines the sections, the cap, and the closing line`
- Neither skill file contains `/skill:` (AC 10) - test `investigate skill files name no consumer`
- Neither skill file contains `gauntlet` (AC 11) - test `investigate skill files name no consumer`
- `SKILL.md` contains `async: false`, `context: "fresh"`, `reads: false`, and `forceTopLevelAsync` (dispatch rules; async-handle edge) - test `investigate skill carries the dispatch rules`
- `SKILL.md` contains `failed:` (failed-child edge) - test `investigate skill carries the dispatch rules`
- `SKILL.md` links `reference/report.md` and the link resolves to an existing file - test `investigate skill links its report reference`
- Both skill files are under 500 lines and under `50 * 1024` bytes - test `investigate skill files stay under the extraction limit`
- Empty request stops with no temp folder - none: only a live model run observes it
- Prose mentioning a file, self-load confirmation, missing dispatch tool, temp base inside the repository, folder-creation failure, whole-dispatch failure, and brief write failure - none: only a live model run observes them
- No open questions, no verification tasks, and the unreadable-reference fallback - none: only a live model run observes them
- `investigate` in the child skill list - none: existing behavior of `src/agents/skills.ts`, unchanged

## Documentation impact

Materiality bar: `reference/documentation-impact.md`.

- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/skills-and-companions.md` ("Bundled skills": the inventory gains `investigate`; "Optional shortcuts": the prompt row becomes the `/skill:investigate` entry under a `Command` column, no `--out` - major procedures / conventions), `README.md` (shipped-commands sentence - major procedures / conventions), `CHANGELOG.md` (Unreleased: `/investigate` and `--out` removed, `/skill:investigate` added, report shape, `## Design fit` - communication contracts)
- Derived / memory docs invalidated: `doc/skills-and-companions.md` intro line and "Prompt-template integration" ("prompt shortcuts" - no prompt ships), `doc/orchestration-patterns.md` ("optional prompt shortcuts" pointer)

## Out of scope

- A fresh agent that writes the report from the brief alone (approach 3). It is the follow-up if reports still read like engineer notes after this ships.
- A second reference file for the brief template (approach 2).
- A compatibility `/investigate` prompt that points at the skill.
- Changes to `agents/scout.md`, `agents/reviewer.md`, `agents/context-builder.md`; only the task text the skill sends changes.
- A next-step menu or any wording that names another package's skill.
- Changes to pi-gauntlet, including chase-bug's report rules.
- A live `/skill:investigate` run as verification.

## Open questions

- Register rules now exist twice: chase-bug's in pi-gauntlet and the adapted set in `skills/investigate/reference/report.md`. `AGENTS.md` asks for a concept to be explained in its owning repo and linked from the others; no link is possible while pi-cohort installs without pi-gauntlet. Recorded as known duplication; no action in this spec.
- No real investigation transcript was available, so the 180-word cap and the section content rules are untested against a large brief. The paid action covers one synthetic brief with one clash; the no-clash form is text-checked only, and the count shown for more than one clash is not observed.
