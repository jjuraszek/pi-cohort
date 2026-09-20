# Handoff brief template

The fixed contract `/skill:handoff` produces and a consumer (a resume flow, or a human pasting into a fresh session) parses. Section names and order are fixed; a consumer keys on headings, never on prose or position.

```markdown
# Handoff: <one line>
## Intent
## Repo state
## Decisions
## Open questions
## Skills loaded
```

| Section | Content | Presence |
|---|---|---|
| `## Intent` | what the work is for, in the producer's words | always |
| `## Repo state` | one field per line: `toplevel`, `worktree: yes <path>` or `worktree: no`, `branch` (`detached` when none), `HEAD`, `base`, `dirty: <git status --porcelain>` or `dirty: clean`, `diff-stat`, `test cmd`; when `worktree: yes <path>` every field describes that worktree (the path is absolute); when `worktree: no` the fields describe the primary checkout at the session cwd; `base: unknown` when no remote resolves (then `diff-stat: unavailable`); any field `unavailable` when its command failed. Heading variants: `## Repo state: not a git repo`; `## Repo state: unavailable (<one-line reason>)` when the snapshot produced nothing | always |
| `## Decisions` | bullets; rejected alternatives marked `rejected:` | always |
| `## Open questions` | bullets | always |
| `## Skills loaded` | frontmatter `name` of every skill whose SKILL.md body is in the producer's context (a `<skill>` block or a tool result on a `*/SKILL.md` path); always includes `handoff` | always |

A run-worktree candidate the producer named but the scout rejected (its `open-question` line) appears as an `## Open questions` bullet naming the path; the grammar of `## Repo state` does not change.

## Append seam

The producer writes nothing after `## Skills loaded`. A caller that follows the skill and continues in the same session may append its own `##` sections after it, for example `## <caller-owned section>`. A consumer processes the headings it knows and ignores the rest.

A skill in another package cannot expand `/skill:handoff` (pi expands skill commands on typed input only). It reads `skills/handoff/SKILL.md` at the location pi lists for it, follows the procedure with the output option it wants, takes the path from the report line, and appends its sections.

## Report line

The producer's reply ends with `Handoff written: <abs path>` on its own line. On failure it ends with `Handoff not written: <reason>` and no file is written.

## Output path

Precedence: `--out <path>`, then `--key <stem>`, then the default key. Both options -> `Handoff not written: --out and --key are exclusive`.

Argument grammar, shared by the producer and any consumer that derives a name: the text after `/skill:handoff` is split into shell-like tokens - an unquoted token ends at whitespace, a token wrapped in `".."` or `'..'` may contain whitespace, `--opt=value` is one token. An option's value is the next token; a next token that is itself `--out`, `--key`, or an `--out=`/`--key=` form, or no next token, or an empty `--opt=` value, means the option has no value. Only `--out` and `--key` are read; every other token is ignored. An option with an empty or missing value -> `Handoff not written: <option> has no value`; an option given twice -> `Handoff not written: <option> given twice`.

- `--out <path>`: any location; the caller owns the parent directory.
- `--key <stem>`: `<tmpdir>/pi-handoff/<stem>.md`. The stem is written verbatim, no encoding, `.md` always appended (`--key foo.md` -> `foo.md.md`). Valid stem: non-empty after trimming, not `.` or `..`, no `/`, `\`, NUL, control characters, or `<>:"|?*`, and not starting with `<primary>--` (reserved for the default key). Otherwise `Handoff not written: --key is not a valid file name stem` (or `Handoff not written: --key is reserved for the default key`). A consumer looks a custom key up exactly: same convention, same stem, open `<tmpdir>/pi-handoff/<stem>.md`.
- Default: `<tmpdir>/pi-handoff/<primary>--<leaf>.md`, overwritten on each run.
  - `<tmpdir>` = `node -p "require('os').tmpdir()"`.
  - `<primary>` = basename of the directory containing `git rev-parse --path-format=absolute --git-common-dir` (git 2.31+).
  - `<leaf>` = basename of the run worktree when `## Repo state` says `worktree: yes <path>`; else `git branch --show-current` at cwd; else `detached`.
  - Both components pass through the encoder `[^A-Za-z0-9._-]` -> `-`. Outside a git repo: `no-repo--<encoded cwd basename>`.
  - Examples: primary checkout on `main`, no run worktree -> `pi-cohort--main.md`; primary checkout with run worktree `.worktrees/gh-18-handoff-skill` -> `pi-cohort--gh-18-handoff-skill.md`; branch `feat/x` -> `pi-cohort--feat-x.md`.

Consumer derivation of the default: `<primary>` from the consumer's cwd; `<leaf>` from cwd when cwd is a linked worktree; otherwise list `<tmpdir>/pi-handoff/<primary>--*.md` and take the single match or ask. The listing discovers default-key files only, never custom keys.
