---
name: handoff
description: Use when the context window is nearly full and the work must continue in a fresh session.
---

# Handoff brief

Write a handoff brief for a fresh session. The brief is the contract in `doc/handoff-template.md` of pi-cohort: section names and order are fixed. This file carries every rule a producer needs; a caller that follows it reads nothing else. Nothing is written into the repository.

## Argument

The argument text, if any, follows this block. Tokenize it shell-like (unquoted tokens end at whitespace; `".."`/`'..'` keep whitespace; `--opt=value` is one token). An option's value is the next token; a next token that is itself `--out`, `--key`, or an `--out=`/`--key=` form, or no next token, or an empty `--opt=` value, means the option has no value. `--out <path>` names the output file (relative resolves against cwd); `--key <stem>` names the file inside the shared mailbox directory; every other token is ignored.

Argument failures end the reply with the line and write nothing:

- an option with an empty or missing value -> `Handoff not written: <option> has no value`
- an option given twice -> `Handoff not written: <option> given twice`
- both options -> `Handoff not written: --out and --key are exclusive`

## Rules

- Scratch dir, invocation-unique so overlapping invocations never read each other's snapshot: `SCRATCH=$(node -p "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'pi-handoff-'))")`. If `node` is missing -> `Handoff not written: cannot resolve tmpdir`.
- The snapshot dispatch: `async: false` and `context: "fresh"` at the top level; `reads: false`; absolute `output` under `$SCRATCH`. If it returns an async handle, a `forceTopLevelAsync` setting is active: report that in the reply, do not poll, relaunch, or continue the child, and write the brief with `## Repo state: unavailable (async handle returned)`.
- The child is read-only against the repository; its only write is its `output` file.
- You write `## Intent`, `## Decisions`, `## Open questions`, and `## Skills loaded` from your own transcript, before the call and after it returns. Do not fork a child for this: forking a near-full transcript is the cost this handoff avoids.

## Run worktree

Before the snapshot dispatch, determine the run worktree from your own transcript and interpolate it into the scout task as `Run worktree: <abs path>` or `Run worktree: none`:

- A flow-level worktree the run created (any `git worktree add <path>` you ran, or a `Worktree ready at <path>` report from the skill that set up the worktree) or was told to work in (a resume brief's `worktree: yes <path>`, or a user instruction).
- Never inferred from the session cwd; a created or assigned worktree still qualifies when it happens to equal the cwd. Never a per-task worktree from `tasks[].worktree: true` or `worktree: true` dispatches - those are ephemeral.
- Two flow-level worktrees in the transcript: the candidate is the one most recently used by later work (a dispatch `cwd`, a `git -C <path>`, or a `cd <path>`); if that does not distinguish them, the most recent creation or assignment. The other goes into `## Open questions` as `Also seen: <path> - not recorded as the run worktree`.
- No flow-level worktree created or named: `Run worktree: none`.

## Repo snapshot

```
subagent({ async: false, context: "fresh", tasks: [
  { agent: "scout", cwd: "<cwd>", reads: false, output: "<SCRATCH>/repo.md",
    task: "Read-only; write only to your output path. Run worktree: <abs path|none>. Steps: (1) linked set: git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' - the first line is the primary checkout, the rest are the linked worktrees; a relative candidate resolves against the primary toplevel, not cwd. (2) candidate `none` or line absent -> target is cwd, go to (4). Otherwise if the candidate is relative, prefix it with the primary toplevel (first linked-set line) first; C=$(git -C <candidate> rev-parse --show-toplevel); valid when that succeeds and C equals one of the linked lines exactly (a line after the first; equality with the first, primary line is invalid); anything else (failure, not listed, the primary itself, prunable) is invalid -> target is cwd and emit the open-question line in (5). (3) valid -> target is $C and `worktree: yes $C`. (4) target cwd -> T=$(git rev-parse --show-toplevel); `worktree: yes $T` when $T equals one of the linked lines exactly (a line after the first; the first, primary line gives `worktree: no`), else `worktree: no`. (5) report each field on its own line, `unavailable` when a command fails, every git command as `git -C <target>`: toplevel (git -C <target> rev-parse --show-toplevel); the worktree line from (3) or (4); branch (git -C <target> branch --show-current, `detached` when empty); HEAD SHA; base (origin/HEAD short name, else origin/main or origin/master if present, else `base: unknown`); dirty (git -C <target> status --porcelain, or `clean`); diff-stat (git -C <target> diff --stat <base>...HEAD; `diff-stat: unavailable` when base is unknown); test command (<target>/package.json scripts or <target>/AGENTS.md). Invalid candidate: after the fields add the single line `open-question: producer named <candidate as submitted> as the run worktree; it is not a linked worktree of this repo`. cwd not a git repo -> the single line `not a git repo`, plus the same open-question line if a candidate was submitted." }
]})
```

Outcomes: the fields become `## Repo state`; any `open-question:` line goes into `## Open questions` without its prefix and never into `## Repo state`; `not a git repo` -> `## Repo state: not a git repo`; child failed, file missing or empty, or async handle -> `## Repo state: unavailable (<one-line reason>)`. The brief is written in every outcome - the transcript-derived sections are the point of a handoff.

## Destination

Resolve after the snapshot (the default key needs its `worktree:` line). Precedence: `--out`, then `--key`, then the default key.

- `--out <path>`: that path, made absolute. Its parent directory must exist, else `Handoff not written: parent directory <dir> does not exist`; never fall back to the default when the caller named a path.
- `--key <stem>`: an exact caller-owned basename stem, written verbatim (no encoding) with `.md` appended - `--key foo.md` gives `foo.md.md`. Valid stem: non-empty after trimming, not `.` or `..`, none of `/`, `\`, NUL, control characters, or `<>:"|?*`, and not starting with `<primary>--` (the default-key prefix). Invalid -> `Handoff not written: --key is not a valid file name stem`; prefixed -> `Handoff not written: --key is reserved for the default key`. Destination `path.join(<tmpdir>, 'pi-handoff', <stem> + '.md')`.
- Default key `<primary>--<leaf>` at `<tmpdir>/pi-handoff/<primary>--<leaf>.md`, overwritten on each run:

  ```bash
  TMP=$(node -p "require('os').tmpdir()")
  PRIMARY=$(basename "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")")
  # LEAF: basename of the run worktree when the snapshot says `worktree: yes <path>`;
  # else `git branch --show-current`; else `detached`
  enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g'; }
  OUT="$TMP/pi-handoff/$(enc "$PRIMARY")--$(enc "$LEAF").md"
  ```

  Outside a git repo the key is `no-repo--<encoded cwd basename>`. The encoder `[^A-Za-z0-9._-]` -> `-` applies to the two generated components only, never to a `--key` value. Examples: primary checkout on `main` with no run worktree -> `pi-cohort--main.md`; run worktree `.worktrees/gh-18-handoff-skill` -> `pi-cohort--gh-18-handoff-skill.md`; branch `feat/x` -> `pi-cohort--feat-x.md`.
- For `--key` and the default, `mkdir -p "$TMP/pi-handoff"` first. Paths are joined with `/`; `os.tmpdir()` covers Windows (`%LOCALAPPDATA%\Temp`).

## Brief

```markdown
# Handoff: <one line>
## Intent
## Repo state
## Decisions
## Open questions
## Skills loaded
```

- `## Repo state`: the snapshot fields, or one of the heading variants above.
- `## Decisions`: bullets; rejected alternatives marked `rejected:`.
- `## Open questions`: bullets, including any copied `open-question:` line and any `Also seen:` line.
- `## Skills loaded`: the frontmatter `name` of every skill whose SKILL.md body is in your context (a `<skill>` block or a tool result on a `*/SKILL.md` path); it always includes `handoff`.

Write nothing after `## Skills loaded`: a caller that follows this skill and continues in the same session may append its own `##` sections there. Then `rm -rf "$SCRATCH"`, echo the brief, and end the reply with the line `Handoff written: <abs path>`.
