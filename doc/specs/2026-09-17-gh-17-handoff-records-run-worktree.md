# /handoff records the run's worktree, not the session cwd (#17)

> **Superseded by:** [doc/specs/2026-09-20-gh-18-handoff-skill-append-seam.md](./2026-09-20-gh-18-handoff-skill-append-seam.md) - "### Template" and "### Tests" sections only

**Goal:** `/handoff`'s `## Repo state` describes the linked worktree the run works in, even when pi runs in the primary checkout. Supersedes `doc/specs/2026-09-17-prune-prompts-investigate-handoff.md`, "### `prompts/handoff.md`" flow step 1 (the repo snapshot) only.

## Problem

Gauntlet flows run pi in the primary checkout and do their work in a linked worktree under `<primary>/.worktrees/<name>`, created mid-flow by `/skill:using-git-worktrees`. `/handoff` dispatches a fresh scout with `cwd: "<cwd>"` (the session cwd) and decides the `worktree:` field solely from whether `git rev-parse --git-dir` and `--git-common-dir` differ (`prompts/handoff.md:20-24`). From the primary root the two are equal, so every gauntlet handoff reports `worktree: no` plus the primary's `branch`, `HEAD`, `dirty`, and `diff-stat` - a snapshot of a tree nobody worked in. From a primary subdirectory the comparison is wrong the other way: `--git-dir` prints an absolute path and `--git-common-dir` prints `../.git` (verified in `pi-cohort/prompts`), so a raw string compare yields `worktree: yes` for the primary. The consumer (pi-gauntlet's `gauntlet-resume`, installed 5.8.0) reads `worktree:`, `HEAD`, and `dirty` from that section and cannot find the run.

The scout runs `context: "fresh"` and receives only its task text; it cannot inspect the producer's transcript. The producer is the only party that knows which worktree the run used.

## Design

### Producer rule (`prompts/handoff.md`, `## Rules`)

Before the snapshot dispatch the producer determines the **run worktree** from its own transcript:

- a flow-level worktree the run **created** (any `git worktree add <path>` it ran, or a `Worktree ready at <path>` report from `/skill:using-git-worktrees`) or was **told to work in** (a resume brief's `worktree: yes <path>`, or a user instruction);
- never inferred from the session cwd - a created or assigned worktree still qualifies when it happens to equal the cwd; never a per-task worktree from `tasks[].worktree: true` or `worktree: true` dispatches (those are ephemeral);
- two flow-level worktrees in the transcript: the candidate is the one most recently used by later work (a dispatch `cwd`, a `git -C <path>`, or a `cd <path>`); if that does not distinguish them, the most recent creation or assignment; the other is listed under `## Open questions`;
- no flow-level worktree created or named: the candidate is `none`.

The producer interpolates `Run worktree: <abs path>` or `Run worktree: none` into the scout task string.

### Scout task (`prompts/handoff.md`, `## Repo snapshot`)

The dispatch keeps `cwd: "<cwd>"`, `context: "fresh"`, `reads: false`, absolute `output`. The task string gains a validation step before the fields:

1. **Linked-worktree set.** From `<cwd>`: `git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}'`. The first line is the primary checkout; the rest are the linked worktrees. A relative candidate resolves against the primary toplevel (first line), not `<cwd>`.
2. **Validate the candidate.** `Run worktree: none` -> skip to step 4 with target `<cwd>`. Otherwise `C=$(git -C <candidate> rev-parse --show-toplevel)`; the candidate is **valid** when that succeeds and `$C` equals one of the linked lines exactly (both sides come from git, so symlinks and path forms agree). Anything else - command failure, not listed, the primary itself, prunable - is **invalid**; target is `<cwd>` and the scout emits the open-question line in step 5.
3. **Valid:** target is `$C`; `worktree: yes $C`.
4. **Target `<cwd>` (`none` or invalid):** `T=$(git rev-parse --show-toplevel)` at `<cwd>`; `worktree: yes $T` when `$T` is one of the linked lines, else `worktree: no`. This replaces the `--git-dir` / `--git-common-dir` compare, which misreports from a primary subdirectory; a session launched inside a linked worktree still reports that worktree.
5. **Fields against the target.** Git-backed fields (toplevel, branch, HEAD, base, dirty, diff-stat) run as `git -C <target> ...`; the test command is read from `<target>/package.json` and `<target>/AGENTS.md`, not `<cwd>`'s. After the fields, an invalid candidate adds one line: `open-question: producer named <candidate as submitted> as the run worktree; it is not a linked worktree of this repo`. When `<cwd>` is not a git repo the output is `not a git repo` and, if a candidate was submitted, the same `open-question:` line.

Field labels, order, and the `unavailable` / `not a git repo` fallbacks are unchanged. Base resolution keeps today's rule (`origin/HEAD`, else `origin/main`/`origin/master`, else `base: unknown`) evaluated via `git -C <target>`.

### Producer merge rule

After the scout returns, the producer copies any `open-question:` line from `repo.md` into `## Open questions` (without the `open-question:` prefix) and does not include it in `## Repo state`. A second flow-level worktree seen in the transcript is added to `## Open questions` as `Also seen: <path> - not recorded as the run worktree`.

### Template (`doc/handoff-template.md`)

The `## Repo state` row states: when `worktree: yes <path>`, every field describes that worktree (the path is absolute); when `worktree: no`, the fields describe the primary checkout at the session cwd. A sentence under the table: a producer candidate the scout rejected (its `open-question` line) appears as an `## Open questions` bullet naming the path; the grammar of `## Repo state` does not change. Consumer rules are untouched.

### Tests (`test/unit/prompts-inventory.test.ts`)

Structural assertions only, each on a token the change introduces (the existing `worktree: yes <path>` / `worktree: no` strings already appear in both files and prove nothing): `prompts/handoff.md` contains `Run worktree:`, `git worktree list --porcelain`, `rev-parse --show-toplevel`, `git -C <target>`, `open-question:`, and `flow-level`; `doc/handoff-template.md` contains `describes that worktree` and `open-question`. The existing heading-parity test stays. Run: `env -u PI_CODING_AGENT_DIR npm run test:unit`.

### CHANGELOG

`## [Unreleased]` / `### Fixed`: `/handoff` records the run's linked worktree instead of the session cwd; the producer names it, the scout validates it against `git worktree list --porcelain` and snapshots it via `git -C`; a rejected candidate is surfaced under `## Open questions`; the `worktree:` field no longer misreports `yes` from a primary subdirectory. Ends with `([#17](https://github.com/jjuraszek/pi-cohort/issues/17))`, matching existing entries.

## Edge cases

| Case | Behaviour |
|---|---|
| Candidate is the primary checkout (first `worktree` record) | invalid -> `<cwd>` target + open question |
| Relative path, trailing slash, symlink | both sides resolved by git (`rev-parse --show-toplevel` vs porcelain list), relative resolved against the primary toplevel |
| Path does not exist / prunable worktree | `git -C <candidate> rev-parse` fails -> invalid |
| `Run worktree: none` | `<cwd>` target, no open question |
| Producer omits the `Run worktree:` line | scout treats as `none`; no open question (producer defect, fixed by the prompt rule) |
| Session cwd is a primary subdirectory | `worktree: no` (toplevel is the first record), fixing today's false `yes` |
| Session cwd is itself a linked worktree | candidate valid -> candidate wins; `none`/invalid -> `worktree: yes <cwd toplevel>` |
| `<cwd>` is not a git repo | `not a git repo`; plus the `open-question:` line if a candidate was submitted |
| Several linked worktrees exist | scout validates only what it was handed; never chooses |
| Worktree branch has no upstream | irrelevant: base comes from `origin/HEAD`/`origin/main`/`origin/master`; `unknown`/`unavailable` only when none resolves |

## Out of scope

- Consumer-side re-entry from a primary-checkout session (entry check 3 of `gauntlet-resume` stops with `restart pi in <worktree>`): pi-gauntlet#37.
- Pinning the label syntax of `branch`, `HEAD`, `dirty`, `diff-stat` beyond today's prose (#17 excludes it).
- Behavioural or shell-fixture tests of the prompt.
- Any change to `agents/scout.md`; the logic is `/handoff`-specific and lives in the prompt.

## Assumptions

- The installed consumer reads only `worktree:`, `HEAD`, `dirty` from `## Repo state` (`gauntlet-resume/SKILL.md:54-74`, per the context-builder's read of pi-gauntlet 5.8.0); all fields are scoped to the worktree regardless, so this affects nothing here.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/handoff-template.md` (`worktree:` semantics, rejected-candidate note); `CHANGELOG.md` `[Unreleased]` (#17)
- Derived / memory docs invalidated: none

`prompts/handoff.md` is implementation surface. pi-gauntlet docs need no edit (grammar unchanged).

## Verification

- `env -u PI_CODING_AGENT_DIR npm run test:unit` passes with the new structural assertions.
- Manual (post-implementation): in a session launched at the primary checkout, create or be assigned this worktree in the transcript (e.g. `/skill:using-git-worktrees` or a user instruction naming `/Users/jacek/repos/pi-cohort/.worktrees/gh-17-handoff-worktree`), run `/handoff`, and confirm `worktree: yes <that path>` with `branch`, `HEAD`, `dirty`, `diff-stat` equal to independent `git -C <that path>` output. Second run from `pi-cohort/prompts` with no worktree in the transcript: `worktree: no`.
