# Handoff as a flow-agnostic skill with an append seam

**Ticket:** #18 (counterpart: pi-gauntlet#40)
**Goal:** Move `/handoff` from a prompt template to `skills/handoff/SKILL.md`, strip every gauntlet-specific rule from it, give the brief a deterministic default location keyed per repo and run worktree that a consumer can find without a printed path, and define the contract so a caller can append its own sections after the six core headings.

## Problem

`prompts/handoff.md` is a pi prompt template. Pi expands prompt templates and `/skill:<name>` commands only on typed user input (`_expandSkillCommand` in pi's `agent-session.js`; `expandPromptTemplates` defaults to false for programmatic sends), so another package's skill cannot invoke `/handoff` - the text stays literal. pi-gauntlet needs to compose a handoff brief with its own `## Process state` section and cannot, because the only producer is a prompt.

The prompt also carries rules that belong to pi-gauntlet: when to emit `## Process state`, the names `phase_tracker`/`plan_tracker`, the hotfix exemption, and the skill name `/skill:using-git-worktrees` in worktree detection. pi-cohort names no consumer (AGENTS.md, "Part of one platform"); this prompt does.

The brief's location is `$(mktemp -d)/handoff.md`, a fresh random path each run. A resume flow in a new session finds it only if the user pastes the printed path.

## Design

### Files

| Path | Change |
|---|---|
| `skills/handoff/SKILL.md` | new; frontmatter `name: handoff`, `description: Use when the context window is nearly full and the work must continue in a fresh session.` |
| `prompts/handoff.md` | deleted |
| `doc/handoff-template.md` | rewritten as the contract: six core headings, append seam, default path key, report line |
| `test/unit/prompts-inventory.test.ts` | prompt inventory shrinks to `investigate.md`; skill assertions added (below) |
| `README.md` | `/handoff` -> `/skill:handoff [--out <path> \| --key <stem>]`; names the default path |
| `doc/skills-and-companions.md` | `/handoff` row leaves the prompt table; a `handoff` paragraph joins `## Bundled skill` (renamed `## Bundled skills`); no process-state wording |
| `CHANGELOG.md` | `## [Unreleased]` / `### Changed`: "`/handoff` no longer expands; `/skill:handoff [--out <path> | --key <stem>]` replaces it, writes to `<tmpdir>/pi-handoff/<primary>--<leaf>.md` by default and ends with `Handoff written: <path>`; `## Process state` is no longer produced here (#18, pi-gauntlet#40)" |
| `doc/specs/2026-09-17-gh-17-handoff-records-run-worktree.md` | supersession banner, scope `### Template`, `### Tests` |
| `doc/specs/2026-09-17-prune-prompts-investigate-handoff.md` | supersession banner, scope `### prompts/handoff.md` fully and the `/handoff` entries of `### Docs` |

No `src/` change. `package.json` already ships `skills/**/*` with `pi.skills: ["./skills"]`; pi's own loader (`core/skills.js`, `loadSkillFromFile`: name = frontmatter `name`, else parent directory) makes the file `/skill:handoff` on install. pi-cohort's child-side loader (`src/agents/skills.ts`) also lists every package skill except `pi-cohort` as a `skill:` override; `handoff` appearing there is accepted - it is harmless to a child and filtering it is machinery the task does not need. The `prompts/**/*` glob and `pi.prompts` stay for `investigate.md`.

### Contract (`doc/handoff-template.md`)

```markdown
# Handoff: <one line>
## Intent
## Repo state
## Decisions
## Open questions
## Skills loaded
```

- The six headings are fixed in name and order. The producer writes nothing after `## Skills loaded`.
- A caller that follows this skill and then continues in the same session may append its own `##` sections after `## Skills loaded` (example in the doc: `## <caller-owned section>`). A consumer processes the headings it knows and ignores the rest; it keys on headings, never on prose or position. The doc names no consumer and no appended section.
- `## Repo state` field grammar is unchanged from #17: `toplevel`, `worktree: yes <abs path>` or `worktree: no`, `branch` (`detached` when none), `HEAD`, `base` (`unknown` when no remote resolves), `dirty: <porcelain>` or `dirty: clean`, `diff-stat` (`unavailable` when base is unknown), `test cmd`; any field `unavailable` when its command failed. When `worktree: yes` every field describes that worktree. Heading variants: `## Repo state: not a git repo`; `## Repo state: unavailable (<one-line reason>)` when the snapshot child produced nothing. A run-worktree candidate the producer named but the scout rejected appears as an `## Open questions` bullet naming the path.
- `## Skills loaded` lists the frontmatter `name` of every skill whose SKILL.md body is in the producer's context (a `<skill>` block or a tool result on a `*/SKILL.md` path); it always includes `handoff` itself.
- Report line: the producer's reply ends with `Handoff written: <abs path>` on its own line. On failure it ends with `Handoff not written: <reason>` and no file is written.
- Output path, in precedence order: `--out <path>` (any location, caller owns the parent directory); `--key <stem>` -> `<tmpdir>/pi-handoff/<stem>.md` (a caller picks its own convention inside the shared mailbox directory without knowing `<tmpdir>`); otherwise the default key `<primary>--<leaf>`. Both given -> `Handoff not written: --out and --key are exclusive`.
- Argument grammar (shared by producer and any consumer that derives the name): the text after `/skill:handoff` is split into shell-like tokens - an unquoted token ends at whitespace, a token wrapped in `".."` or `'..'` may contain whitespace, `--opt=value` is one token. Only `--out` and `--key` are read; every other token is ignored. An option given twice -> `Handoff not written: <option> given twice`.
- `--key` is an exact caller-owned basename stem: written verbatim, no encoding, `.md` always appended (a supplied `.md` is not stripped: `--key foo.md` -> `foo.md.md`). Valid stem: non-empty after trimming, not `.` or `..`, no `/`, `\`, NUL, control characters, or `<>:"|?*`, and not starting with `<primary>--` (reserved for the default key). Otherwise `Handoff not written: --key is not a valid file name stem` (or `... is reserved for the default key`), and nothing is written. Destination is `path.join(<tmpdir>, 'pi-handoff', <stem> + '.md')`.
- Custom keys are looked up exactly: a consumer that wants to find a `--key` file computes the same stem from the same convention and opens `<tmpdir>/pi-handoff/<stem>.md`; the `<primary>--*.md` listing fallback below discovers default-key files only, never custom keys. `Handoff written:` reports the resolved absolute path.
- Default path: `<tmpdir>/pi-handoff/<primary>--<leaf>.md`.
  - `<tmpdir>` = `node -p "require('os').tmpdir()"`.
  - `<primary>` = basename of the directory containing `git rev-parse --path-format=absolute --git-common-dir` (git 2.31+; `--path-format=absolute` guarantees an absolute result).
  - `<leaf>` = basename of the run worktree when `## Repo state` says `worktree: yes <path>`; else `git branch --show-current` at cwd; else `detached`.
  - Both generated components pass through the encoder `[^A-Za-z0-9._-]` -> `-` (covers `/` in branch names and Windows-reserved characters). The encoder never touches a `--key` value.
  - Outside a git repo: `no-repo--<encoded cwd basename>`.
  - The file is overwritten on each run. Consumer derivation: `<primary>` from the consumer's cwd; `<leaf>` from cwd when cwd is a linked worktree, otherwise the consumer lists `<tmpdir>/pi-handoff/<primary>--*.md` and takes the single match or asks. Worked examples in the doc: primary checkout on `main`, no run worktree -> `pi-cohort--main.md`; primary checkout with run worktree `.worktrees/gh-18-handoff-skill` -> `pi-cohort--gh-18-handoff-skill.md`; branch `feat/x` -> `pi-cohort--feat-x.md`.

The consumer-rules paragraph about process state and pi-gauntlet#31 is deleted; those belong to pi-gauntlet.

### Skill procedure (`skills/handoff/SKILL.md`)

1. **Argument.** Pi appends the text typed after `/skill:handoff` as raw text following the `<skill>` block (no `$@`; pi has no placeholder for skills). The body states: "The argument text, if any, follows this block. Tokenize it shell-like (unquoted tokens end at whitespace; `".."`/`'..'` keep whitespace; `--opt=value` is one token). `--out <path>` names the output file (relative resolves against cwd); `--key <stem>` names the file inside the shared mailbox directory; every other token is ignored." An option with an empty or missing value -> `Handoff not written: <option> has no value`; given twice -> `Handoff not written: <option> given twice`; both options -> `Handoff not written: --out and --key are exclusive`.
2. **Scratch dir.** `SCRATCH=$(node -p "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pi-handoff-'))")` - invocation-unique, so overlapping invocations never read each other's snapshot. Removed after step 6.
3. **Run worktree.** Determine `Run worktree: <abs path>` or `Run worktree: none` from the transcript. The #17 rule, inlined with only the skill name removed:
   - A flow-level worktree the run created (any `git worktree add <path>` you ran, or a `Worktree ready at <path>` report from the skill that set up the worktree) or was told to work in (a resume brief's `worktree: yes <path>`, or a user instruction).
   - Never inferred from the session cwd; a created or assigned worktree still qualifies when it happens to equal the cwd. Never a per-task worktree from `tasks[].worktree: true` or `worktree: true` dispatches - those are ephemeral.
   - Two flow-level worktrees in the transcript: the candidate is the one most recently used by later work (a dispatch `cwd`, a `git -C <path>`, or a `cd <path>`); if that does not distinguish them, the most recent creation or assignment. The other goes into `## Open questions` as `Also seen: <path> - not recorded as the run worktree`.
   - No flow-level worktree created or named: `Run worktree: none`.
4. **Snapshot.** One dispatch, `output: "<SCRATCH>/repo.md"`, the child read-only against the repository:
   ```
   subagent({ async: false, context: "fresh", tasks: [
     { agent: "scout", cwd: "<cwd>", reads: false, output: "<SCRATCH>/repo.md",
       task: "Read-only; write only to your output path. Run worktree: <abs path|none>. Steps: (1) linked set: git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' - the first line is the primary checkout, the rest are the linked worktrees; a relative candidate resolves against the primary toplevel, not cwd. (2) candidate `none` or line absent -> target is cwd, go to (4). Otherwise if the candidate is relative, prefix it with the primary toplevel (first linked-set line) first; C=$(git -C <candidate> rev-parse --show-toplevel); valid when that succeeds and C equals one of the linked lines exactly (a line after the first; equality with the first, primary line is invalid); anything else (failure, not listed, the primary itself, prunable) is invalid -> target is cwd and emit the open-question line in (5). (3) valid -> target is $C and `worktree: yes $C`. (4) target cwd -> T=$(git rev-parse --show-toplevel); `worktree: yes $T` when $T equals one of the linked lines exactly (a line after the first; the first, primary line gives `worktree: no`), else `worktree: no`. (5) report each field on its own line, `unavailable` when a command fails, every git command as `git -C <target>`: toplevel (git -C <target> rev-parse --show-toplevel); the worktree line from (3) or (4); branch (git -C <target> branch --show-current, `detached` when empty); HEAD SHA; base (origin/HEAD short name, else origin/main or origin/master if present, else `base: unknown`); dirty (git -C <target> status --porcelain, or `clean`); diff-stat (git -C <target> diff --stat <base>...HEAD; `diff-stat: unavailable` when base is unknown); test command (<target>/package.json scripts or <target>/AGENTS.md). Invalid candidate: after the fields add the single line `open-question: producer named <candidate as submitted> as the run worktree; it is not a linked worktree of this repo`. cwd not a git repo -> the single line `not a git repo`, plus the same open-question line if a candidate was submitted." }
   ]})
   ```
   Outcomes: fields -> `## Repo state`; `open-question:` lines -> `## Open questions` without the prefix, never in `## Repo state`; `not a git repo` -> `## Repo state: not a git repo`; child failed, file missing or empty, or an async handle returned (`forceTopLevelAsync` active) -> `## Repo state: unavailable (<one-line reason>)`. The brief is written in every outcome, because the transcript-derived sections are the point of a handoff; the async case is reported in the reply as well and the child is never polled or relaunched.
5. **Path.** `--out` given -> that path, absolute; its parent must exist, else `Handoff not written: parent directory <dir> does not exist` (never fall back to the default when the caller named a path). `--key` given -> validate the stem (non-empty after trim; not `.`/`..`; none of `/`, `\`, NUL, control chars, `<>:"|?*`; not starting with `<primary>--`), fail with `Handoff not written: --key is not a valid file name stem` or `... is reserved for the default key`, else `path.join(<tmpdir>, 'pi-handoff', <stem> + '.md')`. Otherwise the default key: `<primary>--<leaf>`, `<primary>` and `<leaf>` as defined in the contract (run worktree basename from step 4's `worktree: yes <path>`, else `git branch --show-current`, else `detached`; `no-repo--<cwd basename>` outside a repo), each component encoded `[^A-Za-z0-9._-]` -> `-`. The skill body carries these rules in full - a caller following the skill reads only this file, so no rule may live only in `doc/handoff-template.md`. For `--key` and the default, run `mkdir -p "<tmpdir>/pi-handoff"` first.
6. **Write.** `# Handoff: <one line>`, then `## Intent`, `## Repo state`, `## Decisions` (bullets; rejected alternatives marked `rejected:`), `## Open questions` (bullets), `## Skills loaded`. Intent, decisions, open questions, and skills come from the producer's own transcript; no child is forked for them (forking a near-full transcript is the cost this skill avoids). Nothing after `## Skills loaded`. Nothing into the repository. Then `rm -rf "$SCRATCH"`.
7. **Report.** Echo the brief, then the final line `Handoff written: <abs path>`.

Removed from the body: the process-state rule, tracker names, hotfix, the worktree skill name, `mktemp`, `$@`.

### Callers

- Human, plain: `/skill:handoff` in the full session. In the fresh session, a paste, or pi-gauntlet's `/skill:gauntlet-resume` reading the default path per the consumer derivation above (pi-gauntlet#40 and its resume follow-up own that half; this spec fixes the producer side and the key so both derive it identically).
- Another skill (pi-gauntlet's `gauntlet-handoff`): it cannot emit `/skill:handoff` - expansion is typed-input only. It `read`s `skills/handoff/SKILL.md` at the location pi lists in `<available_skills>`, follows the procedure with the output option it wants (`--key <its own stem>` to stay in the shared mailbox directory - its resume computes the same stem from the same convention and opens that exact file - or `--out` for a path it owns), reads the path from `Handoff written:`, and appends its sections. The doc states this composition rule without naming the caller. Release order is free; a brief without process state during the window is the accepted transient (#18, #40).

### Edge cases

| Case | Behavior |
|---|---|
| not a git repo | key `no-repo--<cwd basename>`; `## Repo state: not a git repo`; `Run worktree: none` |
| detached HEAD, no run worktree | `<leaf>` = `detached`; branch field `detached` |
| primary-checkout session, run worktree `.worktrees/<name>` (#17) | `worktree: yes <abs path>`, fields from that worktree, key `<primary>--<name>.md`; two such sessions with different worktrees get different files |
| linked worktree whose dir name differs from its branch | `<leaf>` is the dir basename, stable across branch renames; consumer in that worktree derives the same |
| two sessions, same repo, same worktree or same branch | last writer wins; `--out` is the escape; the file is a mailbox, not a log |
| two repos with the same basename on one machine | they share `<primary>--<leaf>.md` when leaf also matches; accepted - `--out` is the escape and a hash disambiguator would make the consumer's listing unreadable |
| branch `feat/x` | encoder yields `feat-x`; no nested directory |
| Windows | `os.tmpdir()` yields `%LOCALAPPDATA%\Temp`; `mkdtempSync`, `mkdir -p` (git bash), `git rev-parse`, `git branch`, `basename` all portable; path joined with `/`; the scout task keeps its `awk`, unchanged from today |
| `--out=<path>`, `--key=<stem>` | accepted, same as the space-separated forms |
| `--key gauntlet-run-7 extra` | stem `gauntlet-run-7`; `extra` ignored; file `<tmpdir>/pi-handoff/gauntlet-run-7.md` |
| `--key "run 7"` | stem `run 7`, verbatim; file `<tmpdir>/pi-handoff/run 7.md` |
| `--key gauntlet+42` vs `--key gauntlet@42` | two distinct files; no aliasing |
| `--key foo.md` | file `foo.md.md`; `.md` is appended, never stripped |
| `--key ..`, `--key a/b` | `Handoff not written: --key is not a valid file name stem`; nothing written |
| `--key ""` | `Handoff not written: --key has no value`; nothing written |
| `--key pi-cohort--x` in repo `pi-cohort` | `Handoff not written: --key is reserved for the default key` |
| `--out` and `--key` together | `Handoff not written: --out and --key are exclusive` |
| `--key a --key b` | `Handoff not written: --key given twice` |
| extra tokens | ignored |
| `node` absent | `Handoff not written: cannot resolve tmpdir` |

### Tests (`test/unit/prompts-inventory.test.ts`)

- prompt inventory is exactly `["investigate.md"]`; the frontmatter, `Use when`, no-workflow-verbs, and `$@` loops run over `prompts/` only.
- `skills/handoff/SKILL.md` exists; frontmatter has `name: handoff` and a `description` that starts with `Use when`, is under 500 chars, and matches no workflow verb (same predicates as the prompt test).
- skill body contains `Handoff written:`, `Handoff not written:`, `pi-handoff`, `os').tmpdir()`, `mkdtempSync`, `--out`, `--key`, `[^A-Za-z0-9._-]`, `given twice`, `reserved for the default key`, `not a valid file name stem`.
- skill body contains none of `$@`, `phase_tracker`, `plan_tracker`, `hotfix`, `using-git-worktrees`, `mktemp`, `Process state`.
- the skill body has exactly one ```` ```markdown ```` fence (the brief); its `##` lines equal the `##` lines of the first ```` ```markdown ```` fence in `doc/handoff-template.md`, in order, and there are exactly five.
- `doc/handoff-template.md` contains none of `phase_tracker`, `plan_tracker`, `hotfix`, `using-git-worktrees`, `Process state`; contains `describes that worktree`, `open-question`, `Handoff written:`, `pi-handoff`, `--key`, `[^A-Za-z0-9._-]`, `not a valid file name stem`.
- #17 tokens present in the skill body: `Run worktree:`, `git worktree list --porcelain`, `git -C <candidate> rev-parse --show-toplevel`, `git -C <target>`, `open-question:`, `flow-level`, `Worktree ready at`.

Verification: `env -u PI_CODING_AGENT_DIR npm run test:unit`; `grep -n -E 'phase_tracker|plan_tracker|Process state|hotfix|using-git-worktrees' skills/handoff/SKILL.md doc/handoff-template.md` returns nothing; manual: from the primary checkout with a `Worktree ready at <primary>/.worktrees/<name>` line in the transcript and no pre-existing `pi-handoff` directory, `/skill:handoff` writes exactly one file at `<tmpdir>/pi-handoff/<primary>--<name>.md` whose `## Repo state` has `worktree: yes <abs path>`, whose last heading is `## Skills loaded`, and whose reply ends `Handoff written: <that path>`; `/skill:handoff --out <tmpdir>/x.md` writes only `<tmpdir>/x.md`. Key matrix, each run against a pre-existing `<tmpdir>/pi-handoff/my-run.md` whose content must be unchanged on every failure row: `--key my-run` overwrites exactly that file and reports its path; `--key "run 7" extra` writes only `run 7.md`; `--key gauntlet+42` then `--key gauntlet@42` leave two files; `--key foo.md` writes `foo.md.md`; `--key ..`, `--key a/b`, `--key <primary>--x`, `--key a --key b`, `--key a --out b` each end with the specified `Handoff not written:` line and write nothing.

## Out of scope

- pi-gauntlet's `gauntlet-handoff` producer and `gauntlet-resume` key derivation (pi-gauntlet#40 and follow-up).
- A `--template <path>` option; deferred until a second consumer needs different core sections (#18).
- Stabilizing scout field labels beyond the #17 grammar.
- Filtering `handoff` from pi-cohort's child-side skill listing.

## Open questions

- pi-gauntlet must adopt the consumer derivation (`<primary>` from cwd, listing `<primary>--*.md` when cwd is the primary) in `gauntlet-resume` for argument-less resume to work; until then resume takes the printed path. Tracked on the pi-gauntlet side; the CHANGELOG entry names it.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `doc/handoff-template.md` (contract owner: seam, output options and default key, consumer derivation, report line, composition rule); `README.md` (`/handoff` -> `/skill:handoff [--out <path> | --key <stem>]`, default path); `doc/skills-and-companions.md` (`/handoff` row out of the prompt table, `handoff` under `## Bundled skills`); `CHANGELOG.md` (`## [Unreleased]` / `### Changed`, #18, pi-gauntlet#40)
- Derived / memory docs invalidated: `AGENTS.md` routing row "Consume or produce a handoff brief" (wording only, path unchanged); supersession banners on `doc/specs/2026-09-17-gh-17-handoff-records-run-worktree.md` and `doc/specs/2026-09-17-prune-prompts-investigate-handoff.md`

Per `reference/documentation-impact.md` (pi-gauntlet brainstorming skill).

## Supersedes

- `doc/specs/2026-09-17-gh-17-handoff-records-run-worktree.md`, scope `### Template`, `### Tests` (producer rule, scout task, merge rule are reproduced above and stay authoritative there).
- `doc/specs/2026-09-17-prune-prompts-investigate-handoff.md`, scope `### prompts/handoff.md` fully and the `/handoff` entries of `### Docs` (`investigate.md` and `skills/pi-cohort/SKILL.md` sections stay authoritative).
