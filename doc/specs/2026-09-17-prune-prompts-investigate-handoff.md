# Prune packaged prompts: `/investigate`, `/handoff`, schema-residual SKILL.md

**Goal:** replace pi-cohort's six packaged prompts with two user-invoked prompts that use parallel personas where they add information the parent lacks, shrink `skills/pi-cohort/SKILL.md` to what the `subagent` tool description and schema cannot carry, remove the last `interview` (pi-intercom) references, and hand pi-gauntlet the process-resume and brainstorming-rigor sides via tickets (filed: pi-gauntlet#31, #32).

Amends `doc/specs/2026-09-06-gh-11-remove-pi-intercom.md` (shipped): removes the `interview` residue that spec left in `prompts/gather-context-and-clarify.md:11` and `skills/pi-cohort/SKILL.md:46,102,631,658`. Nothing is superseded.

## Problem

- Usage over ~35k local sessions (text match, directional): `subagent` tool 3,708 sessions; named prompts 8-24 each; `/skill:pi-cohort` explicit loads 4. The prompts are near-unused; the tool and the personas (`reviewer` 1,212, `scout` 1,114, `worker` 1,090) are what is used.
- `parallel-review` and `review-loop` duplicate pi-gauntlet `requesting-code-review` and `subagent-driven-development` with conflicting semantics (async loop with 3-round cap vs foreground, spec-review-first). `parallel-cleanup` references `deslop`/`verbosity-cleaner` skills that exist nowhere. `parallel-context-build` and `parallel-handoff-plan` are near-identical and both restated in SKILL.md.
- `gather-context-and-clarify` depends on `interview`, removed with pi-intercom (gh-11).
- SKILL.md is 771 lines; its description summarizes workflow instead of stating triggers; it repeats the tool description, all six prompt bodies, and the agent roster that `{action:"list"}` already returns. `reference/config-fields.md` conflates management `config.steps[].skills` with execution `chain[].skill`.
- The `parallel-` prefix names the mechanism, not the intent.

## Ground truth the design rests on

- The session learns `subagent` from the tool description (`src/extension/index.ts:424-445`) and the JSON schema (`src/extension/schemas.ts`), present in every session. The description routes overflow to "pi-cohort skill reference/config-fields.md" and "details: pi-cohort skill" for CONTROL; the schema's `TaskItem`/`ParallelTaskSchema`/`DynamicParallelTemplateSchema` descriptions (`schemas.ts:146-198`) route per-task overrides to "pi-cohort skill". SKILL.md is that overflow file.
- `context` is invocation-level: `TaskParam` (`src/runs/foreground/subagent-executor.ts:88-101`) has no `context` field; `applyAgentDefaultContext` (`:766-777`) forks the whole invocation when top-level `context` is unset and any task agent has `defaultContext: fork` (`worker`, `oracle`, `reviewer` do).
- `forceTopLevelAsync` (`src/runs/background/top-level-async.ts`) can turn an `async: false` dispatch into a handle.
- pi-gauntlet drives `subagent` by schema and links `doc/configuration.md`. It never invokes `/skill:pi-cohort` and never references a SKILL.md section. `dispatching-parallel-agents/SKILL.md:180-209` tells authors to read the pi-cohort skill for chains/async/roster.
- Consumer repos reference only `packages` and `subagents.agentOverrides` in `.pi/settings.json`; that check stays outside versioned artifacts.
- `package.json` `files` ships `skills/**/*` and `prompts/**/*`, not `doc/`. A fact moved to `doc/` is not in the installed package.
- `phase_tracker status` returns the phase list with active phase and substep; idle gauntlet returns all-pending. `plan_tracker status` returns every task with status, or `No plan active.`; `plan_tracker init` rejects an empty list. The hotfix flow touches neither tracker. Gate history is not exportable.
- `oracle` protects inherited decisions and defaults to fork; at investigation start there is nothing inherited. `reviewer` has `edit`/`write` and `defaultReads: plan.md, progress.md`; `worker` is the implementation persona with `defaultReads: context.md, plan.md`. `scout` has no write tools.
- Pi loads skills either via a user-typed `/skill:name` (a `<skill>` block) or via the model `read`ing a `SKILL.md` (a tool result).

## Design

### Deleted

`prompts/parallel-review.md`, `prompts/review-loop.md`, `prompts/parallel-cleanup.md`, `prompts/gather-context-and-clarify.md`, `prompts/parallel-context-build.md`, `prompts/parallel-handoff-plan.md`. No aliases. pi-cohort ships delegation primitives, not review workflows; the README says once: pair with pi-gauntlet for review and delivery workflows.

### Shared dispatch rules (both prompts)

- `context: "fresh"` sits beside `tasks` at the top level of every dispatch; never inside a task object.
- `async: false` at top level. If the result is an async handle (a `forceTopLevelAsync` configuration), stop and report the incompatible setting; do not poll, relaunch, or advance.
- Every child is read-only against the repository; its only write is its assigned absolute `output` under a `mktemp -d` scratch dir the prompt creates. Task text states this. `reads: false` on every task (persona `defaultReads` name chain files that do not exist here).
- The parent writes nothing into the repo; the brief goes to `--out` or the scratch dir. Shell variables are interpolated into the JSON call as absolute paths.

### `prompts/investigate.md`

Frontmatter `description`: "Use when a request's premises are unverified, the territory is unknown, or the user asks to look into something before planning or brainstorming."

Argument `$@`: the request text, or a path to a file containing it, optionally followed by `--out <path>`. Empty -> stop and ask for the request. A path that does not exist is treated as request text.

Flow:

1. Parent: `DIR=$(mktemp -d)`; detect refs: `http(s)://` URL; `owner/repo#N`; bare `#N` when `git remote get-url origin` is a GitHub URL; `[A-Z][A-Z0-9]+-\d+`.
2. Wave 1 - one `subagent({ async: false, context: "fresh", tasks: [...] })`, `cwd` = repo root, each task `reads: false`, absolute `output` under `$DIR`:
   - `scout`: territory - files with line ranges, patterns and conventions to match, test conventions, integration points, whether the codebase or ecosystem already solves it.
   - `reviewer`: premise critique - for each claim in the request: confirmed by code (cite), contradicted by code (cite), or asserted-not-shown. No design proposals, no edits.
   - `context-builder`: only when refs were detected - acceptance criteria, hard constraints, linked discussion that changes scope, contradictions with the request. Context handoff only, no meta-prompt file. A ref it cannot read yields `unreadable: <ref>`.
3. Parent reads the outputs and writes the brief to `--out` if given, else `$DIR/brief.md`; prints the path and the brief inline.
4. Parent asks once: run the verification tasks? Yes -> wave 2: one `subagent({ async: false, context: "fresh", tasks })`, one `scout` (or `reviewer` when judgement is needed) per task, `reads: false`, task text containing the literal phrase "read-only", absolute `output` under `$DIR`. Results folded into `## Findings` under `### Verified`; brief rewritten at the same path. No -> stop.

Brief template (section names fixed):

```markdown
# Investigation: <slug>
## Request
## Findings            (cited; `### Verified` appended after wave 2)
## External context    (only when context-builder ran; unreadable refs listed)
## Premise check       (Confirmed / Contradicted / Unverified - one line each, cited)
## Open questions      (numbered; each ends with `Recommendation: <answer> - <why>`)
## Verification tasks  (numbered; independent; each: one-paragraph read-only subagent task + `Expected:`; exercises current behaviour only)
## Next steps          (suggestions only; no implementation task decomposition)
```

Rules: a question whose answer is in code, docs, or the tracker is not asked - it is looked up (wave 1 or wave 2). A verification task is rejected at brief-writing time if it would run, build, or validate the proposed change; wave 2 exercises the system as it is today.

### `prompts/handoff.md`

Frontmatter `description`: "Use when the context window is nearly full and the work must continue in a fresh session."

Argument `$@`: optional `--out <path>`.

Flow:

1. Parent: `DIR=$(mktemp -d)`. One `subagent({ async: false, context: "fresh", tasks: [ { agent: "scout", cwd: <cwd>, reads: false, output: "<DIR>/repo.md", task: <snapshot> } ] })`. Snapshot, each field independently, `unavailable` on failure: toplevel (`git rev-parse --show-toplevel`); worktree yes/no and path (`--git-dir` vs `--git-common-dir`); branch (`git branch --show-current`, `detached` when empty); HEAD SHA; base (`origin/HEAD` short name, else `origin/main` or `origin/master` if present, else `unknown`); `git status --porcelain`; `git diff --stat <base>...HEAD` when base is known; test command from `package.json` scripts or AGENTS.md. Not a git repo -> `## Repo state: not a git repo`.
   Before the call and after it returns, the parent writes from its own transcript: intent, decisions incl. rejected alternatives, open questions, skills loaded. No forked child is used for this: forking a near-full transcript is the full-price call the handoff exists to avoid, and the parent already holds the material.
2. `## Process state`: present only when both `phase_tracker` and `plan_tracker` tools exist AND `phase_tracker status` shows a phase `in_progress`. Then: both status outputs verbatim; `Active task: <task name>` (the task the parent is working on; `none` when the plan is absent or no task is active); the line `Gate history not restored - re-validate before advancing.`. Tools absent, idle (all phases pending), or hotfix (no phase started) -> section absent.
3. Write to `--out` or `$DIR/handoff.md`; print path and brief.

Brief template - the contract pi-gauntlet parses, published as `doc/handoff-template.md`:

```markdown
# Handoff: <one line>
## Intent
## Repo state          (toplevel; worktree: yes <path> | no; branch; HEAD; base; dirty: <porcelain or clean>; diff-stat; test cmd; `unavailable` per field)
## Decisions           (bullets; rejected alternatives marked `rejected:`)
## Open questions
## Skills loaded       (frontmatter `name` of every skill whose SKILL.md body is in context - via `<skill>` block or a tool result on a `*/SKILL.md` path - or `none`)
## Process state       (OPTIONAL; present iff both trackers exist and a phase is in_progress; verbatim status outputs; `Active task:` line; gate-history line)
```

Consumer rules (in the template doc): `## Process state` absent means plain handoff - the consumer starts its own process from `## Intent`. A present section with `No plan active.` is phase-only state - the consumer restores no plan. pi-cohort names skills in `## Skills loaded`; loading them is the consumer's job. How to re-enter a gauntlet flow is pi-gauntlet#31's design, not this template's.

### `skills/pi-cohort/SKILL.md` rewrite

Target: under 150 lines plus `reference/config-fields.md`. Description (trigger only, under 500 chars): "Use when a `subagent` call needs a decision the tool schema leaves open - fresh vs fork, which acceptance level, a per-task override, a control action on a running job, or an agent/chain config field."

Body, writing-skills section template: Overview (parent orchestrates, children execute; tool description and schema are the reference), Boundaries (parent writes to repo; children write only to `output` paths or explicitly assigned files; absolute `output` in parallel mode; `context` is invocation-level), When to Use, Fresh vs fork (decision table), Acceptance levels (table: level -> required evidence), Per-task overrides (table: `model`, `label`, `phase`, `output`, `outputMode`, `reads`, `progress`, `skill`, `cwd`, `acceptance`, `as`, `outputSchema` -> `structured_output` rule), Control actions (status/interrupt/resume semantics, attention tracking), Quick Reference (dispatch-shape examples for `tasks`, `chain` with a parallel step, `async` - errors happen in shapes, not prose), Config fields (pointer to `reference/config-fields.md`), Red Flags.

Removed from SKILL.md: everything the tool description states (modes, chain variables, management/doctor), the agent roster (`{action:"list"}` returns it), the six prompt bodies, the oracle workflow narrative, prompt-technique essays, `interview` mentions.

`reference/config-fields.md`: separate management `config.steps[].skills` from execution `chain[].skill` in two labelled sections; scope stated as management `config` and call-time `control` only.

Coverage gate: the implementer produces a coverage table - every heading/fact block of the old SKILL.md mapped to `tool description | schema | new SKILL.md | new SKILL.md reference/ | dropped`. `doc/` is not a retained target (not shipped). Every "pi-cohort skill" pointer in the tool description and `schemas.ts` must resolve to a named section of the new SKILL.md or its `reference/`. Dropped rows are listed in the PR body; anything `dispatching-parallel-agents/SKILL.md:180-209` cites must map to a non-dropped target.

### Docs

- `doc/handoff-template.md` (new): the template above, presence rules, consumer rules.
- `doc/skills-and-companions.md`: prompt table becomes `/investigate` and `/handoff`; delete the `autofix` line; rewrite "What the bundled skill covers" (lines 45-53) to the new Body list and drop "prompt shortcuts encode the same workflows"; add "pair with pi-gauntlet for review and delivery workflows".
- `README.md`: one sentence under the skills/prompts section: "Review and delivery workflows live in pi-gauntlet; pi-cohort ships delegation primitives plus `/investigate` and `/handoff`."
- `AGENTS.md` routing table: row "Consume or produce a handoff brief -> doc/handoff-template.md".
- `CHANGELOG.md` `## [Unreleased]`: Removed (six prompts, `interview` references), Added (two prompts, handoff template), Changed (SKILL.md, config-fields).

### pi-gauntlet tickets (filed during this brainstorm)

1. **gauntlet-resume** - https://github.com/jjuraszek/pi-gauntlet/issues/31. Consumes `doc/handoff-template.md`. Its procedure is gauntlet's brainstorm to design; this spec prescribes nothing beyond the template. Follow-up comment to post on #31 (gate item): phase-arming consequence of a direct `phase_tracker start <later phase>`; phase-only resume skips `plan_tracker init`; `## Skills loaded` wording as defined here; remaining live intercom mentions `skills/brainstorming/SKILL.md:41` and `doc/configuration.md:93` beside `dispatching-parallel-agents/SKILL.md:209`.
2. **brainstorming premise verdict, recommended answers, facts looked up (minimal)** - https://github.com/jjuraszek/pi-gauntlet/issues/32.

## Edge cases

- Wave 1 builder errored or output empty -> its section reads `<agent> failed: <reason>`; brief still written.
- Only one tracker tool present, or trackers idle -> `## Process state` omitted.
- No skill bodies in context -> `## Skills loaded: none`.
- `/handoff` outside a worktree -> `worktree: no`; outside a git repo -> `## Repo state: not a git repo`; no remote -> `base: unknown`, diff-stat `unavailable`.
- Relative `--out` resolves against cwd.

## Testing

- New `test/unit/prompts-inventory.test.ts`: `readdirSync("prompts")` is exactly `handoff.md`, `investigate.md`; each frontmatter `description` starts with "Use" and contains no workflow verbs from a small denylist (`produces`, `runs`, `dispatches`).
- `env -u PI_CODING_AGENT_DIR npm run test:all` green.
- SKILL.md coverage table in the body of the commit that lands the rewrite, and in the PR body when a PR is opened (see coverage gate); `npm pack --dry-run` output confirms `skills/` and `prompts/` are the shipped surfaces.
- writing-skills conformance, all three artifacts: `description` starts "Use when", under 500 chars, no workflow summary; SKILL.md under 150 lines with the section template above; no duplication of the tool description (grep three phrases from the description against SKILL.md -> zero hits).
- Recorded dry runs (ship-phase evidence): `/investigate` on this repo with one deliberately false premise -> `## Premise check` marks it Contradicted with a citation, wave 2 children produce no repo diff; `/handoff` inside a gauntlet flow in progress -> `## Process state` present with `Active task:`; `/handoff` in a fresh session without gauntlet -> section absent, `## Repo state` complete.
- `rg -n "interview|intercom" prompts skills agents src README.md AGENTS.md doc/*.md` returns nothing.

## Out of scope

gauntlet-resume implementation and the brainstorming change (#31, #32); any edit in consumer repos; rewriting historical CHANGELOG or spec mentions of intercom; frontier-batched questioning.

## Documentation impact
- Feature / user-facing docs introduced: `doc/handoff-template.md`
- Materially amended existing docs: `README.md`, `doc/skills-and-companions.md`, `CHANGELOG.md`
- Derived / memory docs invalidated: `AGENTS.md` routing table (one row)

## Open questions

None blocking.
